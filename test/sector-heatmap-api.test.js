// 行业热力路由（v0.67.0，Step 2）
//
// 只读 LihuQuantify 的 data/heatmap_snapshot.json，聚合成行业维度并保留逐只明细，
// 供概览页做「持仓行业暴露」。
//
// 为什么单开一个轻量路由而不是塞进 strategy_health 契约：
//   契约已 80KB+，概览页只为一个卡片加载它太亏；这个文件自描述（每行带 trade_date），
//   不需要 schema 版本。失败一律 200 + ok:false + 可读 reason，让卡片显式说明原因。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-heat-'))
fs.mkdirSync(path.join(base, '.dsh-invest'), { recursive: true })
process.env.DSH_INVEST_BASE_DIR = base

const registered = []
// 必须有 fs：readJsonFile 依赖 ctx.get('fs')，缺它会静默返回兜底 {}，
// 于是配置读不到、路由回落到真实快照 —— 表现为「测试读到了 488 行真数据」。
const fakeFs = {
  resolve: async (p) => p,
  readText: async (p) => fs.readFileSync(p, 'utf8'),
  writeText: async (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8') },
}
apply({
  get(name) { return name === 'fs' ? fakeFs : undefined },
  effect(fn) { fn() },
  webServer: { register: (route) => { registered.push(route); return () => {} } },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
}, {})

const ROUTE = '/dsh-invest/api/sector-heatmap'

async function call(pathAndQuery, opts = {}) {
  const route = registered.find((item) => item.path === ROUTE)
  assert.ok(route, '热力路由未注册')
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

function writeSnap(rows) {
  const p = path.join(base, 'heat.json')
  fs.writeFileSync(p, JSON.stringify(rows), 'utf8')
  // 通过 settings.json 指向临时文件，避免依赖仓库外的真实快照
  fs.writeFileSync(path.join(base, '.dsh-invest', 'settings.json'),
    JSON.stringify({ sectorHeatmap: { path: p } }), 'utf8')
  return p
}

const ROWS = [
  { ts_code: '000823.SZ', name: '超声电子', industry: '元器件', close: 17.26, pct_chg: -3.59, amount: 500000, trade_date: '2026-11-17' },
  { ts_code: '600011.SH', name: '华能国际', industry: '火力发电', close: 7.85, pct_chg: 1.2, amount: 900000, trade_date: '2026-11-17' },
  { ts_code: '600118.SH', name: '中国卫星', industry: '航空', close: 52.11, pct_chg: -2.92, amount: 300000, trade_date: '2026-11-17' },
  { ts_code: '600519.SH', name: '贵州茅台', industry: '元器件', close: 1500, pct_chg: 0.8, amount: 100000, trade_date: '2026-11-17' },
]

test('正常聚合：行业均值、涨跌家数、逐只明细', async () => {
  writeSnap(ROWS)
  const r = await call(ROUTE)
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.as_of, '2026-11-17')
  assert.equal(r.json.universe, 4)
  // 元器件两只：(-3.59 + 0.8)/2 = -1.395。服务端用 Math.round(x*100)/100，
  // JS 对 -139.5 是「向 +∞ 取整」→ -1.39（不是 -1.40）。这里钉住的是
  // 「显示层只保留 2 位」，不是数学上的四舍五入方向，避免以后误改口径。
  const yq = r.json.industries.find((i) => i.name === '元器件')
  assert.equal(yq.n, 2)
  assert.equal(yq.up, 1)
  assert.equal(yq.down, 1)
  assert.equal(yq.pct_avg, -1.39)
  // 按成交额降序
  assert.equal(r.json.industries[0].name, '火力发电')
  assert.equal(r.json.by_code['000823.SZ'].industry, '元器件')
  assert.equal(r.json.by_code['000823.SZ'].pct_chg, -3.59)
})

test('缺文件：200 + ok:false + reason=missing + 补救提示', async () => {
  fs.writeFileSync(path.join(base, '.dsh-invest', 'settings.json'),
    JSON.stringify({ sectorHeatmap: { path: path.join(base, 'nope.json') } }), 'utf8')
  const r = await call(ROUTE)
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, 'missing')
  assert.match(r.json.hint, /refresh_heatmap_snapshot/)
})

test('空数组：reason=empty，不当作正常', async () => {
  writeSnap([])
  const r = await call(ROUTE)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, 'empty')
})

test('坏 JSON：reason=invalid_json，不抛', async () => {
  const p = path.join(base, 'bad.json')
  fs.writeFileSync(p, '{oops', 'utf8')
  fs.writeFileSync(path.join(base, '.dsh-invest', 'settings.json'),
    JSON.stringify({ sectorHeatmap: { path: p } }), 'utf8')
  const r = await call(ROUTE)
  assert.equal(r.status, 200)
  assert.equal(r.json.reason, 'invalid_json')
})

test('缺 pct_chg 的行不参与均值，但仍然出现在明细里', async () => {
  writeSnap([
    { ts_code: '000001.SZ', name: 'A', industry: '银行', pct_chg: null, amount: 1, trade_date: '2026-11-17' },
    { ts_code: '000002.SZ', name: 'B', industry: '银行', pct_chg: 2.0, amount: 1, trade_date: '2026-11-17' },
  ])
  const r = await call(ROUTE)
  const bank = r.json.industries.find((i) => i.name === '银行')
  assert.equal(bank.n, 2)
  assert.equal(bank.pct_avg, 2.0, '只有一条有 pct 时均值应等于那条')
  assert.equal(r.json.by_code['000001.SZ'].pct_chg, null)
})

test('权限与方法：非 loopback 403、POST 405', async () => {
  writeSnap(ROWS)
  assert.equal((await call(ROUTE, { remote: '10.0.0.9' })).status, 403)
  assert.equal((await call(ROUTE, { host: 'evil.com' })).status, 403)
  assert.equal((await call(ROUTE, { method: 'POST' })).status, 405)
})
