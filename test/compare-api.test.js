// 同口径对比路由（v0.77.0）
//
// 为什么必须有这组测试：线上接口经 DSH 鉴权（401），肉眼看不到服务端返回什么；
// 而对比的每个数字都会进用户的决策，不能靠"看界面"验证。这里钉住四件事：
//   1. 事实层：权重/生效止损/赔率全部按 as-of 收盘重算，不采信账本旧值；
//   2. 胜负：六维由规则判、不做加权综合分；无数据的维度不判；
//   3. 硬约束：20% 上限、赔率<3:1、无目标价、止损口径冲突都要报出来；
//   4. 降级：模型不可用仍返回完整事实表（看不到数字比听不到解释严重）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-compare-'))
const store = path.join(base, '.dsh-invest', 'store')
const scripts = path.join(base, 'scripts')
fs.mkdirSync(store, { recursive: true })
fs.mkdirSync(scripts, { recursive: true })
process.env.DSH_INVEST_BASE_DIR = base

const SCRIPT = path.join(scripts, 'compare_pack.js')

// —— 事实层桩：两条真数据（2026-11-24 收盘口径），一持有一观察 ——
const STOCKS = [
  {
    code: '000823.SZ', name: '超声电子', industry: '元器件', market: '主板', list_date: '19971008',
    asof: '20261124', stale: false,
    close: 19.1, chg_pct: -3.97,
    ma5: 18.4, ma10: 18.13, ma20: 17.76, ma60: 19.79, dist_ma20_pct: 7.55,
    pct5: 14.78, pct20: 7.3, pct60: 30.38,
    hi250: 29.77, lo250: 11.6, drawdown_pct: -35.84,
    pe: 51.08, pe_ttm: 28.68, pb: 1.95, total_mv_yi: 113.64, circ_mv_yi: 102.6,
    turnover_rate: 12.3, volume_ratio: 1.8,
    mf5_wan: 21500.5, mf20_wan: 64212.9, mf_latest_date: '20261123',
    fina_end_date: '20260930', roe: 6.57, netprofit_yoy: 97.52, or_yoy: 18.2,
    gpm: 21.4, debt_ratio: 42.1, excess20: 10.04, excess60: 38.97,
  },
  {
    code: '002815.SZ', name: '崇达技术', industry: '元器件', market: '主板', list_date: '20161012',
    asof: '20261124', stale: false,
    close: 14.38, chg_pct: -3.88,
    ma5: 14.02, ma10: 14.47, ma20: 14.95, ma60: 18.15, dist_ma20_pct: -3.81,
    pct5: 7.15, pct20: -12.8, pct60: 7.63,
    hi250: 26.26, lo250: 10.7, drawdown_pct: -45.24,
    pe: 54.92, pe_ttm: 26.94, pb: 1.92, total_mv_yi: 177.94, circ_mv_yi: 111.75,
    turnover_rate: 23.35, volume_ratio: 2.34,
    mf5_wan: 56309.93, mf20_wan: 94818.71, mf_latest_date: '20261123',
    fina_end_date: '20260930', roe: 7.17, netprofit_yoy: 107.33, or_yoy: 35.55,
    gpm: 24.22, debt_ratio: 30.25, excess20: -10.06, excess60: 16.23,
  },
]

function writeStub(payload) {
  fs.writeFileSync(SCRIPT, 'process.stdout.write(' + JSON.stringify(JSON.stringify(payload)) + ' + "\\n")\n', 'utf8')
}
writeStub({ ok: true, asof: '20261124', stale_codes: [], warnings: [], stocks: STOCKS })

// —— 账本：总资产与现金用真值，账本里的 weight_pct 故意写成旧值 ——
fs.writeFileSync(path.join(base, '.dsh-invest', '持仓.json'), JSON.stringify({
  version: 1,
  account: { total_asset: 114763.31, cash: 22228.91, available_cash: 22228.91 },
  positions: [
    { code: '000823.SZ', name: '超声电子', pool: '实盘', shares: 2200, cost: 17.999, current_price: 19.5, weight_pct: 90 },
    { code: '600118.SH', name: '中国卫星', pool: '实盘', shares: 500, cost: 54.197 },
  ],
}), 'utf8')

fs.writeFileSync(path.join(store, 'watchlist.json'), JSON.stringify({
  version: 1,
  items: [
    {
      code: '000823.SZ', name: '超声电子', state: '持有',
      watch: { buy_low: 17.2, buy_high: 18.4, stop: 16.8, stance: '持有' },
      position: { cost: 17.999, shares: 2200, stop: 17.35, target: 22 },
      monitor: { current_price: 19.1 },
    },
    {
      // 观察标的：只有失效价、没有目标价 → 赔率必为 null，且要报 H4
      code: '002815.SZ', name: '崇达技术', state: '观察',
      watch: { buy_low: 13, buy_high: 14, stop: 12.5, stance: '观察', thesis: 'PCB 订单回暖', invalidate_if: '季报毛利率跌破 20%' },
      position: {},
      monitor: { current_price: 14.38 },
    },
  ],
  alerts: [],
}), 'utf8')

fs.writeFileSync(path.join(store, 'conclusions.jsonl'), [
  JSON.stringify({ ts: '2026-11-24T02:14:29.180Z', code: '000823.SZ', stance: '持有', target: 22, stop: 18.45, thesis: '玻纤涨价传导', invalidate_if: '收盘跌破 18.45' }),
].join('\n') + '\n', 'utf8')

const registered = []
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

const ROUTE = '/dsh-invest/api/compare'

async function call(opts = {}) {
  const route = registered.find((item) => item.path === ROUTE)
  assert.ok(route, '对比路由未注册')
  const req = {
    method: opts.method || 'POST',
    url: ROUTE,
    socket: { remoteAddress: opts.remote || '127.0.0.1' },
    headers: { host: opts.host || 'localhost:3080', 'content-type': 'application/json' },
    on() {},
    async *[Symbol.asyncIterator]() {
      if (opts.body !== undefined) yield Buffer.from(JSON.stringify(opts.body), 'utf8')
    },
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

const PAIR = { codes: ['000823.SZ', '002815.SZ'], withAnswer: false }

test('POST：事实层按 as-of 收盘重算，不采信账本旧值', async () => {
  const r = await call({ body: PAIR })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.asof, '20261124')
  assert.equal(r.json.price_basis, 'unadj')
  assert.equal(r.json.stocks.length, 2)

  const u = r.json.stocks.find((s) => s.code === '000823.SZ')
  // 2200 × 19.10 ÷ 114763.31 = 36.61%，账本里写的 90 是旧值
  assert.equal(u.plan.weight_pct, 36.61)
  assert.equal(u.plan.mv, 2200 * 19.1)
  assert.equal(u.plan.pnl_pct, Math.round((19.1 / 17.999 - 1) * 100 * 100) / 100)
  assert.equal(u.plan.eff_stop, 17.35, 'position.stop 优先')
  assert.equal(u.plan.eff_stop_src, '档案')
  // 赔率 =(22−19.10)/(19.10−17.35)=1.66，取最新结论的 target
  assert.equal(u.plan.odds, 1.66)
  // 已超 20% 上限 → 可加仓空间为 0（不是负数）
  assert.equal(u.plan.room_pct, 0)

  const c = r.json.stocks.find((s) => s.code === '002815.SZ')
  assert.equal(c.plan.held, false)
  assert.equal(c.plan.weight_pct, null)
  assert.equal(c.plan.eff_stop, 12.5, 'position 无止损时退回 watch.stop（失效价）')
  assert.equal(c.plan.eff_stop_src, '失效价')
  assert.equal(c.plan.target, null)
  assert.equal(c.plan.odds, null)
  // 空仓标的的可建仓上限 = min(20%, 现金/总资产) = 19.37%
  assert.equal(c.plan.room_pct, 19.37)
})

test('POST：六维胜负由规则判定，不做加权综合分', async () => {
  const v = (await call({ body: PAIR })).json.verdict
  assert.equal(v.dims.length, 6)
  const win = Object.fromEntries(v.dims.map((d) => [d.key, d.winner]))
  assert.equal(win.position, '000823.SZ', '回撤 −35.84 优于 −45.24')
  assert.equal(win.momentum, '000823.SZ', '20 日超额 +10.04 优于 −10.06')
  assert.equal(win.flow, '002815.SZ', '20 日主力净流入更高')
  assert.equal(win.valuation, '002815.SZ', 'PE_TTM 26.94 低于 28.68')
  assert.equal(win.quality, '002815.SZ', 'ROE 7.17 高于 6.57')
  assert.equal(win.plan, null, '两只都没有可比赔率 → 不判胜')
  assert.deepEqual(v.score, { '000823.SZ': 2, '002815.SZ': 3 })
  assert.equal(v.tied, false)
  assert.match(v.summary_hint, /胜场/)
})

test('POST：硬约束逐条报出（20% 上限 / 赔率 / 无目标价 / 止损冲突）', async () => {
  const g = (await call({ body: PAIR })).json.verdict.gates
  const has = (rule, code, re) => g.some((x) => x.rule === rule && x.code === code && re.test(x.text))
  assert.ok(has('H1', '000823.SZ', /36\.6% 超 20% 上限/), '持仓超限必须报')
  assert.ok(has('H3', '000823.SZ', /1\.66:1 < 3:1/), '赔率不足必须报')
  assert.ok(has('H4', '002815.SZ', /没有目标价/))
  assert.ok(has('H2', '002815.SZ', /毛利率跌破 20%/), '失效条件只引用原文')
  // 档案 17.35 vs 最新结论 18.45，按两者较大值 18.45 算相差 6.0% → 口径冲突
  assert.ok(has('STOP', '000823.SZ', /相差 6\.0%/))
  const u0 = (await call({ body: PAIR })).json.stocks.find((s) => s.code === '000823.SZ')
  assert.equal(u0.plan.stop_conflict, true)
  assert.match(u0.plan.stop_conflict_note, /17\.350 与最新结论 18\.450/)
  // 空仓标的是 info 级（能建多少），不该被算进「需先处理」
  assert.ok(g.some((x) => x.rule === 'H1' && x.code === '002815.SZ' && x.level === 'info'))
  assert.match((await call({ body: PAIR })).json.verdict.summary_hint, /硬约束/)
})

test('POST：模型不可用时仍返回完整事实表（降级不炸）', async () => {
  const r = await call({ body: { codes: ['000823.SZ', '002815.SZ'] } })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.stocks.length, 2, '事实表必须照常返回')
  assert.equal(r.json.answer, null)
  assert.ok(r.json.answerError, '要如实告诉前端解释为什么没出来')
  assert.equal(r.json.question.length > 0, true)
})

test('POST：代码校验（少于 2 只 / 超过 3 只 / 去重后只剩 1 只）', async () => {
  const one = await call({ body: { codes: ['000823.SZ'] } })
  assert.equal(one.status, 400)
  assert.match(one.json.error, /至少需要 2 只/)

  const many = await call({ body: { codes: ['000823.SZ', '002815.SZ', '600118.SH', '510500.SH'] } })
  assert.equal(many.status, 400)
  assert.match(many.json.error, /最多对比 3 只/)

  const dup = await call({ body: { codes: ['000823.SZ', '000823', '000823.SZ'] } })
  assert.equal(dup.status, 400)

  const empty = await call({ body: {} })
  assert.equal(empty.status, 400)
})

test('POST：取数脚本失败 → 400 并带出原因（不烧模型）', async () => {
  writeStub({ ok: false, error: 'tushare 权限不足：daily_basic 积分不够' })
  try {
    const r = await call({ body: PAIR })
    assert.equal(r.status, 400)
    assert.equal(r.json.ok, false)
    assert.match(r.json.error, /权限不足/)
  } finally {
    writeStub({ ok: true, asof: '20261124', stale_codes: [], warnings: [], stocks: STOCKS })
  }
})

test('GET：返回最近的对比记录（落盘 compare-log.jsonl）', async () => {
  const r = await call({ method: 'GET' })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.ok(Array.isArray(r.json.log))
  assert.ok(r.json.log.length >= 2, '前面几次 POST 都要留下记录')
  assert.deepEqual(r.json.log[0].codes, ['000823.SZ', '002815.SZ'])
  assert.equal(r.json.log[0].asof, '20261124')
})

test('边界：非环回 403、PUT 405', async () => {
  const remote = await call({ body: PAIR, remote: '10.0.0.9', host: 'evil.example' })
  assert.equal(remote.status, 403)
  const put = await call({ method: 'PUT', body: PAIR })
  assert.equal(put.status, 405)
})
