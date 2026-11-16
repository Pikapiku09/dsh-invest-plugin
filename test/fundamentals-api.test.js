// 基本面评级路由集成测试（v0.58.0）
//
// 走真实 apply(ctx, {}) 注册路由，用桩 fetch 顶替 Tushare，验证：
// ① 端到端能算出评级；② 全市场快照被缓存（第二次请求不重复打网络）；
// ③ 同业分位用的是同一 industry 分类；④ 取数失败时返回契约完整的降级响应。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-fund-'))
fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
fs.mkdirSync(path.join(base, '.dsh-invest', 'cache', 'pack'), { recursive: true })
fs.writeFileSync(path.join(base, '.dsh-invest', 'tushare.token'), 'stub-token', 'utf8')
process.env.DSH_INVEST_BASE_DIR = base

// 造 40 只「元器件」同业 + 1 只「银行」用来验证行业隔离
const INDUSTRY_CODES = Array.from({ length: 40 }, (_, i) => `T${String(i).padStart(5, '0')}.SZ`)
const finaItems = (codes, roeBase) => codes.map((c, i) => ([
  c, '20261028', '20260930',
  5 + i * 0.4,                 // roe
  5 + i * 0.4,                 // roe_yearly
  15 + i * 0.3,                // grossprofit_margin
  3 + i * 0.2,                 // netprofit_margin
  -10 + i * 2,                 // netprofit_yoy
  -10 + i * 2,                 // dt_netprofit_yoy
  i,                           // or_yoy
  30 + (i % 30),               // debt_to_assets
  1 + (i % 20) * 0.1,          // current_ratio
  0.3 + (i % 10) * 0.05,       // ocfps
  0.5,                         // eps
  1e8,                         // profit_dedt
  8,                           // bps
]))
const ME_ROW = [
  '000823.SZ', '20261028', '20260930',
  6.57, 8.76, 19.47, 7.34, 97.5, 95.9, 15.2, 32.04, 2.3, 0.7, 0.63, 3.4e8, 9.79,
]
const BANK_ROW = ['600001.SH', '20261025', '20260930', 1, 1, 99, 40, 5, 5, 5, 95, 0.9, -1, 1, 1e9, 5]

const calls = []
function stubFetch(handlers) {
  return async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body.api_name)
    const handler = handlers[body.api_name]
    if (!handler) return { text: async () => JSON.stringify({ code: 40001, msg: 'unknown api ' + body.api_name }) }
    return { text: async () => JSON.stringify(handler(body)) }
  }
}

const realFetch = globalThis.fetch
test.after(() => {
  globalThis.fetch = realFetch
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

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
  effect(fn) { fn() },
  webServer: { register: (route) => { registered.push(route); return () => {} } },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
}, {})

async function call(pathAndQuery) {
  const route = registered.find((item) => item.path === pathAndQuery.split('?')[0])
  assert.ok(route, '路由未注册：' + pathAndQuery)
  const req = { method: 'GET', url: pathAndQuery, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' } }
  let status = 0
  let text = ''
  const res = {
    setHeader() {}, set statusCode(v) { status = v }, get statusCode() { return status },
    end(v) { text = v === undefined ? '' : String(v) },
  }
  await route.handler(req, res)
  return { status: status || 200, json: text ? JSON.parse(text) : null }
}

/** 标准桩：全市场三张表都能正常返回 */
function installHappyStubs() {
  const fieldsFina = 'ts_code,ann_date,end_date,roe,roe_yearly,grossprofit_margin,netprofit_margin,netprofit_yoy,dt_netprofit_yoy,or_yoy,debt_to_assets,current_ratio,ocfps,eps,profit_dedt,bps'
  globalThis.fetch = stubFetch({
    stock_basic: () => ({
      code: 0,
      data: {
        fields: ['ts_code', 'name', 'industry', 'market'],
        items: [
          ...INDUSTRY_CODES.map((c) => [c, '同业' + c, '元器件', '主板']),
          ['000823.SZ', '超声电子', '元器件', '主板'],
          ['600001.SH', '某银行', '银行', '主板'],
        ],
      },
    }),
    fina_indicator_vip: () => ({
      code: 0,
      data: {
        fields: fieldsFina.split(','),
        items: [
          // 同一股票两条公告版本：验证去重取最新
          ME_ROW,
          ['000823.SZ', '20261020', '20260930', 6.0, 8.0, 19.0, 7.0, 90, 90, 15, 32, 2.2, 0.6, 0.6, 3e8, 9.7],
          ...finaItems(INDUSTRY_CODES, 5),
          BANK_ROW,
        ],
      },
    }),
    daily_basic: () => ({
      code: 0,
      data: {
        fields: ['ts_code', 'pe_ttm', 'pb', 'total_mv', 'dv_ttm'],
        items: [
          ...INDUSTRY_CODES.map((c, i) => [c, 20 + i, 2 + i * 0.1, 1e6, 1]),
          ['000823.SZ', 26.14, 1.78, 1.1e6, 0.95],
          ['600001.SH', 5, 0.6, 1e7, 5],
        ],
      },
    }),
    fina_indicator: (body) => {
      // 近几期：给本股两期，用于趋势与连亏判定
      const code = body.params.ts_code
      if (code !== '000823.SZ') return { code: 0, data: { fields: fieldsFina.split(','), items: [] } }
      return {
        code: 0,
        data: {
          fields: fieldsFina.split(','),
          items: [
            ME_ROW,
            ['000823.SZ', '20260830', '20260630', 3.1, 6.2, 18.0, 5.0, -1.2, 0, 10, 33, 2.1, 0.5, 0.4, 1.6e8, 9.2],
          ],
        },
      }
    },
  })
}

test('基本面接口：端到端算出评级，契约字段齐全', async () => {
  installHappyStubs()
  calls.length = 0
  const r = await call('/dsh-invest/api/fundamentals?code=000823.SZ')
  assert.equal(r.status, 200)
  const j = r.json
  assert.equal(j.ok, true, JSON.stringify(j).slice(0, 300))
  assert.equal(j.code, '000823.SZ')
  assert.equal(j.name, '超声电子')
  assert.equal(j.industry, '元器件')
  assert.equal(j.peerCount, 41, '同业＝40 只造的同业 + 本股')
  assert.equal(j.period, '20260930')
  assert.equal(j.periodLabel, '2026Q3')
  assert.equal(j.announceDate, '20261028', '多条公告版本应取最新那条')
  assert.equal(j.dims.length, 5)
  assert.ok(j.total !== null && j.grade >= 'A' && j.grade <= 'E', '总分与等级应可算：' + j.total + '/' + j.grade)
  assert.match(j.coverage, /^\d\/5 维$/)
  assert.ok(j.caveat.includes('不构成买卖信号'), '免责声明必须原样带出')
  assert.ok(Array.isArray(j.flags) && j.flags.length > 0, '至少要有【待核实】那条')
  assert.equal(j.priceDate, j.priceDate)
})

test('基本面接口：行业隔离——银行同业不参与元器件分位', async () => {
  installHappyStubs()
  const j = (await call('/dsh-invest/api/fundamentals?code=000823.SZ')).json
  assert.equal(j.peerCount, 41, '银行那只不属于元器件，不能算进同业')
  const val = j.dims.find((d) => d.key === 'valuation')
  assert.ok(val, '估值维度应存在')
})

test('基本面接口：全市场快照命中缓存，第二次不再打网络', async () => {
  installHappyStubs()
  await call('/dsh-invest/api/fundamentals?code=000823.SZ')
  const first = calls.length
  assert.ok(first > 0, '第一次应发生网络调用')
  calls.length = 0
  await call('/dsh-invest/api/fundamentals?code=000823.SZ')
  const second = calls.length
  assert.equal(second, 0, '30 分钟内重复查询应全部命中内存/磁盘缓存，实际又打了 ' + second + ' 次')
})

test('基本面接口：refresh=1 绕过缓存重新取数', async () => {
  installHappyStubs()
  await call('/dsh-invest/api/fundamentals?code=000823.SZ')
  calls.length = 0
  await call('/dsh-invest/api/fundamentals?code=000823.SZ&refresh=1')
  assert.ok(calls.length > 0, 'refresh=1 应重新拉取')
})

test('基本面接口：取数失败时返回契约完整的降级响应（不 500）', async () => {
  globalThis.fetch = async () => { throw new Error('network down') }
  const r = await call('/dsh-invest/api/fundamentals?code=000823.SZ&refresh=1')
  assert.equal(r.status, 200, '取数失败不应回 500')
  const j = r.json
  assert.equal(j.ok, false)
  assert.match(j.error, /network down|Tushare/)
  assert.equal(j.grade, '—')
  assert.deepEqual(j.dims, [])
  assert.ok(j.caveat, '降级响应也必须带 caveat，前端才能稳定渲染')
})

test('基本面接口：代码格式非法直接 400', async () => {
  installHappyStubs()
  assert.equal((await call('/dsh-invest/api/fundamentals?code=abc')).status, 400)
  assert.equal((await call('/dsh-invest/api/fundamentals?code=600519')).status, 400, '必须带交易所后缀')
})

// ===== 真实数据暴露出来的两个边界：小行业、ETF =====

test('基本面接口：细分行业样本不足时退回全市场分位，并明确换基准', async () => {
  // 白酒这类行业全市场只有二十来只，硬套行业分位会让整片行业拿不到评级。
  // 构造：000823 属于「小行业」，同业只有 4 只（< MIN_PEERS=20）
  const fieldsFina = 'ts_code,ann_date,end_date,roe,roe_yearly,grossprofit_margin,netprofit_margin,netprofit_yoy,dt_netprofit_yoy,or_yoy,debt_to_assets,current_ratio,ocfps,eps,profit_dedt,bps'
  const smallPeers = INDUSTRY_CODES.slice(0, 3)
  globalThis.fetch = stubFetch({
    stock_basic: () => ({
      code: 0,
      data: {
        fields: ['ts_code', 'name', 'industry', 'market'],
        items: [
          ...smallPeers.map((c) => [c, '小同业' + c, '小众行业', '主板']),
          ['000823.SZ', '超声电子', '小众行业', '主板'],
          // 其余进「其他」行业，构成全市场分母
          ...INDUSTRY_CODES.slice(3).map((c) => [c, '别的' + c, '其他行业', '主板']),
        ],
      },
    }),
    fina_indicator_vip: () => ({
      code: 0,
      data: {
        fields: fieldsFina.split(','),
        items: [ME_ROW, ...finaItems(smallPeers, 5), ...finaItems(INDUSTRY_CODES.slice(3), 5)],
      },
    }),
    daily_basic: () => ({
      code: 0,
      data: {
        fields: ['ts_code', 'pe_ttm', 'pb', 'total_mv', 'dv_ttm'],
        items: [
          ...INDUSTRY_CODES.map((c, i) => [c, 20 + i, 2 + i * 0.1, 1e6, 1]),
          ['000823.SZ', 26.14, 1.78, 1.1e6, 0.95],
        ],
      },
    }),
    fina_indicator: () => ({ code: 0, data: { fields: fieldsFina.split(','), items: [ME_ROW] } }),
  })
  const r = await call('/dsh-invest/api/fundamentals?code=000823.SZ&refresh=1')
  assert.equal(r.status, 200)
  const j = r.json
  assert.equal(j.peerBaseline, 'market', '同业不足 20 只应退回全市场分位')
  assert.ok(j.warnings.some((w) => /同业仅 \d+ 只/.test(w)), '必须说明换基准的原因：' + JSON.stringify(j.warnings))
  assert.ok(j.warnings.some((w) => /退回全市场分位/.test(w)))
  assert.ok(j.total !== null, '退回全市场后仍应给出评级，而不是整片行业空白')
  assert.equal(j.grade >= 'A' && j.grade <= 'E', true, '等级应为 A-E，实际 ' + j.grade)
})

test('基本面接口：ETF / 基金明确不适用，不给空评级', async () => {
  installHappyStubs()
  const r = await call('/dsh-invest/api/fundamentals?code=510500.SH')
  assert.equal(r.status, 200)
  const j = r.json
  assert.equal(j.ok, true)
  assert.equal(j.grade, '—')
  assert.equal(j.gradeLabel, '不适用')
  assert.deepEqual(j.dims, [], 'ETF 不应硬凑五个维度')
  assert.ok(j.flags.some((f) => /ETF \/ 基金不适用/.test(f.label)), '必须说明为什么不适用')
  assert.ok(j.caveat, '降级路径也要带 caveat')
  // 深市 ETF 同样识别
  const sz = (await call('/dsh-invest/api/fundamentals?code=159813.SZ')).json
  assert.equal(sz.gradeLabel, '不适用')
})
