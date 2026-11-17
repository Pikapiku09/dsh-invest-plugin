// 两条只读数据路由的测试（v0.68.0）
//
// ① /dsh-invest/api/strategy-trials —— 影子交易，只回 summary/rules/真正建仓的几笔，
//    不回 91 条原始记录（其中 76 条是「非买入」，对页面无信息量）。
// ② /dsh-invest/api/real-performance —— 实盘绩效，曲线降采样到 250 点，
//    口径限制与估值跳变原样透传（这两项是这份数据最容易被误读的地方）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-data-'))
fs.mkdirSync(path.join(base, '.dsh-invest'), { recursive: true })
process.env.DSH_INVEST_BASE_DIR = base

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

async function call(routePath, opts = {}) {
  const route = registered.find((item) => item.path === routePath)
  assert.ok(route, '路由未注册：' + routePath)
  const req = {
    method: opts.method || 'GET',
    url: routePath,
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

function pointSettings(key, filePath) {
  fs.writeFileSync(path.join(base, '.dsh-invest', 'settings.json'),
    JSON.stringify({ [key]: { path: filePath } }), 'utf8')
}

const TRIALS = {
  generated_at: '2026-11-17 22:00:00',
  rules: { entry: '结论日后第一个交易日的收盘价', shares: 100, max_hold_days: 20, exit: 'target/stop/time', long_stances: ['看多', '买入', '增持'], adj_covered_codes: 6 },
  summary: { total: 3, long_trials: { n: 1, open: 1, closed: 0, pnl_total: 26, wins: 1 }, skipped: { not_long: 2 } },
  portfolio: {
    initial_capital: 100000, final_equity: 99375, total_return: -0.0062, max_drawdown: -0.0139,
    n_trades: 0, n_open: 3, skipped: { no_slot: 2 },
    rules: { max_positions: 3, max_single_position: 0.15, entry: 'T+1 收盘', lot: 100 },
    costs: {
      commission_rate: 0.00025, min_commission: 5, stamp_tax_rate: 0.0005, slippage: 0.001,
      source: 'backtest.broker.SimulatedBroker',
      total_commission: 15, total_stamp_tax: 0, total_slippage: 44.23, total_fees: 59.23,
    },
    equity_curve: [{ d: '2026-11-04', v: 100000 }, { d: '2026-11-17', v: 99375 }],
    trades: [],
  },
  records: [
    { id: 'a', code: '002727.SZ', status: 'open', pnl_ratio: 0.0193, basis: 'raw_fallback' },
    { id: 'b', code: '600519.SH', status: 'skipped', skip_reason: 'not_long' },
    { id: 'c', code: '600118.SH', status: 'skipped', skip_reason: 'no_quote' },
  ],
}

test('影子交易：只回建仓的几笔，过滤掉非买入记录', async () => {
  const p = path.join(base, 'trials.json')
  fs.writeFileSync(p, JSON.stringify(TRIALS), 'utf8')
  pointSettings('strategyTrials', p)
  const r = await call('/dsh-invest/api/strategy-trials')
  assert.equal(r.json.ok, true)
  assert.equal(r.json.trials.length, 1, '3 条记录里只有 1 条真正建仓')
  assert.equal(r.json.trials[0].code, '002727.SZ')
  assert.equal(r.json.summary.long_trials.n, 1)
  assert.equal(r.json.rules.shares, 100)
  // 撮合模拟必须透传：它是「加回资金约束」后的结果，单笔影子交易无法替代
  assert.equal(r.json.portfolio.final_equity, 99375)
  assert.equal(r.json.portfolio.rules.max_positions, 3)
  assert.equal(r.json.portfolio.skipped.no_slot, 2)
  // 成本必须透传：没有成本就是「理论收益」，不是到手收益
  assert.equal(r.json.portfolio.costs.total_fees, 59.23)
  assert.equal(r.json.portfolio.costs.min_commission, 5)
})

test('影子交易：缺文件与坏 JSON 都给可操作提示', async () => {
  pointSettings('strategyTrials', path.join(base, 'nope.json'))
  const miss = await call('/dsh-invest/api/strategy-trials')
  assert.equal(miss.json.ok, false)
  assert.equal(miss.json.reason, 'missing')
  assert.match(miss.json.hint, /run_strategy_trials/)

  const bad = path.join(base, 'bad.json')
  fs.writeFileSync(bad, '{oops', 'utf8')
  pointSettings('strategyTrials', bad)
  assert.equal((await call('/dsh-invest/api/strategy-trials')).json.reason, 'invalid_json')
})

const PERF = {
  generated_at: '2026-11-17 12:00:00',
  totals: { equity_end: 123656.63, total_return_pct: 12.4151, annualized_pct: 5.8169, n_months: 26, monthly_win_rate_pct: 53.85 },
  max_drawdown: { pct: -39.751, peak_date: '2025-09-25', trough_date: '2026-08-03', recovered_date: null, pct_ex_valuation_jumps: -34.7984 },
  benchmark: { code: '000001.SH', spearman: 0.6485 },
  monthly: [{ month: '2024-10', return_pct: 6.2895 }],
  equity_curve: Array.from({ length: 600 }, (_, i) => ({ date: `2026-01-${i}`, equity: 100000 + i })),
  limitations: ['初始资金为假设值', '不含银证转账'],
  valuation_jumps: [{ ts_code: '600584.SH', date: '2026-08-03', jump_yuan: -8688 }],
  assumptions: { initial_capital: 110000 },
}

test('实盘绩效：曲线降采样到 250 点且保留首末', async () => {
  const p = path.join(base, 'perf.json')
  fs.writeFileSync(p, JSON.stringify(PERF), 'utf8')
  pointSettings('realPerformance', p)
  const r = await call('/dsh-invest/api/real-performance')
  assert.equal(r.json.ok, true)
  assert.equal(r.json.equity_curve.length, 250)
  assert.equal(r.json.equity_points_total, 600)
  assert.equal(r.json.equity_curve[0].equity, 100000)
  assert.equal(r.json.equity_curve[r.json.equity_curve.length - 1].equity, 100599)
})

test('实盘绩效：口径限制与估值跳变必须透传（最容易被误读的两项）', async () => {
  const p = path.join(base, 'perf2.json')
  fs.writeFileSync(p, JSON.stringify(PERF), 'utf8')
  pointSettings('realPerformance', p)
  const r = await call('/dsh-invest/api/real-performance')
  assert.equal(r.json.limitations.length, 2)
  assert.equal(r.json.valuation_jumps.length, 1)
  assert.equal(r.json.max_drawdown.pct_ex_valuation_jumps, -34.7984)
  assert.equal(r.json.max_drawdown.recovered_date, null, '未修复必须如实为 null')
})

test('实盘绩效：缺 totals 视为不可用，不冒充空数据', async () => {
  const p = path.join(base, 'perf3.json')
  fs.writeFileSync(p, JSON.stringify({ generated_at: 'x' }), 'utf8')
  pointSettings('realPerformance', p)
  const r = await call('/dsh-invest/api/real-performance')
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, 'empty')
})

test('两条路由都只许 GET 且仅 loopback', async () => {
  for (const route of ['/dsh-invest/api/strategy-trials', '/dsh-invest/api/real-performance']) {
    assert.equal((await call(route, { method: 'POST' })).status, 405, route + ' POST')
    assert.equal((await call(route, { remote: '10.0.0.7' })).status, 403, route + ' 非 loopback')
  }
})


test('影子交易：缺 portfolio 时字段为 null，不让前端崩', async () => {
  const p = path.join(base, 'trials-noport.json')
  const copy = { ...TRIALS }
  delete copy.portfolio
  fs.writeFileSync(p, JSON.stringify(copy), 'utf8')
  pointSettings('strategyTrials', p)
  const r = await call('/dsh-invest/api/strategy-trials')
  assert.equal(r.json.ok, true)
  assert.equal(r.json.portfolio, null)
})
