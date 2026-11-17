// 策略健康只读路由（v0.59.0，2026-11-16）
//
// 走真实 apply(ctx, {}) 注册路由，验证这条跨仓契约的**失败面**比成功面更重要：
// ① 文件缺失 / JSON 损坏 / schema 版本不符 / 不是模拟盘 → 一律 200 + ok:false + 可读 reason
//    （这是状态查询接口，返 500 会让前端只剩白屏，用户看不出到底缺什么）
// ② account_type 护栏：指向实盘账本必须被拒，不能展示 —— 否则模拟盘与实盘会串账
// ③ 路径三级回退：settings.json → query → 默认；不把跨仓路径写死在代码里
// ④ 非 loopback 请求 403，方法不对 405
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-health-'))
fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
process.env.DSH_INVEST_BASE_DIR = base

const registered = []
const fakeFs = {
  resolve: async (p) => p,
  readText: async (p) => fs.readFileSync(p, 'utf8'),
  writeText: async (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) },
}
apply({
  get(name) {
    if (name === 'fs') return fakeFs
    if (name === 'sandboxPolicy') return { resolve: () => ({}) }
    if (name === 'agents') return { roots: () => [], create: async () => { throw new Error('unused') } }
    if (name === 'llm') return { listProviders: () => [], listModels: async () => [], resolveCallConfig: async () => ({}) }
    return undefined
  },
  webServer: { register: (route) => { registered.push(route); return () => {} } },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
  // apply() 把路由注册包在 ctx.effect(() => {...}) 里，桩必须**立即执行**该回调，
  // 否则 routes 永远不会注册（返回 no-op 不够，实测会 7 条全红）
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
}, {})

const ROUTE = '/dsh-invest/api/strategy-health'

async function call(pathAndQuery, opts = {}) {
  const route = registered.find((item) => item.path === ROUTE)
  assert.ok(route, '路由未注册：' + ROUTE)
  const req = {
    method: opts.method || 'GET',
    url: pathAndQuery,
    socket: { remoteAddress: opts.remote || '127.0.0.1' },
    headers: { host: opts.host || 'localhost:3080' },
  }
  let status = 0
  let text = ''
  const res = {
    setHeader() {},
    set statusCode(v) { status = v },
    get statusCode() { return status },
    end(v) { text = v === undefined ? '' : String(v) },
  }
  await route.handler(req, res)
  return { status: status || 200, json: text ? JSON.parse(text) : null }
}

function writeSnapshot(name, payload) {
  const p = path.join(base, name)
  fs.writeFileSync(p, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  return p
}

const GOOD = {
  schema_version: 1,
  source: 'LihuQuantify',
  account_type: 'paper',
  generated_at: '2026-11-16 17:04:05',
  strategy: { main: 'intraday_reversal', shadow_drift: 2 },
  risk: { max_single_position: 0.15, min_concurrent_positions: 3, status: 'warn', n_positions: 1 },
  behavior: { rounds: { n_rounds: 635 } },
  research: { total: 10, passed: 2, failed: 8 },
  findings: [{ level: 'warn', text: '分散度不足' }],
  missing: [],
}

test('缺文件：200 + ok:false + reason=missing，并给出补救提示', async () => {
  const p = path.join(base, 'nope.json')
  const r = await call(`${ROUTE}?path=${encodeURIComponent(p)}`)
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, 'missing')
  assert.match(r.json.hint, /export_strategy_health/)
})

test('正常快照：透传 data 并带 stale_hours', async () => {
  const p = writeSnapshot('good.json', GOOD)
  const r = await call(`${ROUTE}?path=${encodeURIComponent(p)}`)
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.data.account_type, 'paper')
  assert.equal(r.json.data.research.passed, 2)
  assert.equal(typeof r.json.stale_hours, 'number')
})

test('schema 版本：v1~v5 都接受，越界拒绝', async () => {
  // 每加一块就升一版（v2 equity / v3 swing）；旧版必须仍可读，否则 Lihu 一升级工作台就全白
  const v1 = writeSnapshot('v1.json', { ...GOOD, schema_version: 1 })
  assert.equal((await call(`${ROUTE}?path=${encodeURIComponent(v1)}`)).json.ok, true)

  const v2 = writeSnapshot('v2.json', { ...GOOD, schema_version: 2, equity: { points: [] } })
  assert.equal((await call(`${ROUTE}?path=${encodeURIComponent(v2)}`)).json.ok, true)

  const v3 = writeSnapshot('v3.json', { ...GOOD, schema_version: 3, swing: { strategy_status: 'falsified' } })
  assert.equal((await call(`${ROUTE}?path=${encodeURIComponent(v3)}`)).json.ok, true)

  // v4 新增 overview（今日巡检），仍须可读
  const v4 = writeSnapshot('v4.json', { ...GOOD, schema_version: 4, overview: { trade_date: '2026-11-10' } })
  assert.equal((await call(`${ROUTE}?path=${encodeURIComponent(v4)}`)).json.ok, true)

  // v5 新增 backtest（回测 + 网格），仍须可读
  const v5 = writeSnapshot('v5.json', { ...GOOD, schema_version: 5, backtest: { main: null, grid: [] } })
  assert.equal((await call(`${ROUTE}?path=${encodeURIComponent(v5)}`)).json.ok, true)

  const v6 = writeSnapshot('v6.json', { ...GOOD, schema_version: 6 })
  const r6 = await call(`${ROUTE}?path=${encodeURIComponent(v6)}`)
  assert.equal(r6.json.ok, false)
  assert.equal(r6.json.reason, 'schema_mismatch')
  assert.equal(r6.json.found_schema, 6)
  assert.equal(r6.json.supported_schema, 5)

  const v0 = writeSnapshot('v0.json', { ...GOOD, schema_version: 0 })
  assert.equal((await call(`${ROUTE}?path=${encodeURIComponent(v0)}`)).json.reason, 'schema_mismatch')

  // 版本号是字符串（"2"）也一律拒：类型不对说明不是我们的契约
  const vStr = writeSnapshot('vstr.json', { ...GOOD, schema_version: '2' })
  assert.equal((await call(`${ROUTE}?path=${encodeURIComponent(vStr)}`)).json.reason, 'schema_mismatch')
})

test('护栏：不是模拟盘就拒，避免与实盘账本混账', async () => {
  const p = writeSnapshot('real.json', { ...GOOD, account_type: 'real' })
  const r = await call(`${ROUTE}?path=${encodeURIComponent(p)}`)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, 'not_paper_account')
  assert.equal(r.json.found_account_type, 'real')
  assert.equal(r.json.data, null, '被护栏拒绝时不得返回任何数据')
})

test('JSON 损坏：200 + invalid_json，不抛异常', async () => {
  const p = writeSnapshot('bad.json', '{ not json')
  const r = await call(`${ROUTE}?path=${encodeURIComponent(p)}`)
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, 'invalid_json')
})

test('路径三级回退：settings.json 里的 strategyHealth.path 生效', async () => {
  const p = writeSnapshot('via-settings.json', GOOD)
  fs.writeFileSync(
    path.join(base, '.dsh-invest', 'settings.json'),
    JSON.stringify({ strategyHealth: { path: p } }),
    'utf8',
  )
  const r = await call(ROUTE)                      // 不带 query
  assert.equal(r.json.ok, true)
  assert.equal(r.json.path, p)
})

test('非 loopback 403；方法不对 405', async () => {
  const p = writeSnapshot('perm.json', GOOD)
  const forbidden = await call(`${ROUTE}?path=${encodeURIComponent(p)}`, { remote: '10.0.0.8' })
  assert.equal(forbidden.status, 403)
  const wrongHost = await call(`${ROUTE}?path=${encodeURIComponent(p)}`, { host: 'evil.example.com' })
  assert.equal(wrongHost.status, 403)
  const post = await call(`${ROUTE}?path=${encodeURIComponent(p)}`, { method: 'POST' })
  assert.equal(post.status, 405)
})
