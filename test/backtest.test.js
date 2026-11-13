// 判断质量回测（backtest）测试（v0.44.0）
// 覆盖：① 命中定义（看多/持有→上涨命中；拒绝/回避/减仓→下跌命中；观察不计命中率）；
//      ② 超额收益 = 个股区间收益 − 上证指数同区间收益；
//      ③ 前向窗口不足（结论靠近数据末端）→ ret20 为 null；
//      ④ 分组统计（byStage / byStance）与总体口径一致；
//      ⑤ 无结论时优雅返回 warning；日线缺失不致 500。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

// 构造日线：from 起连续 n 个「交易日」（直接用自然日序列，回测只关心序号不校验日历）
// close 由 base 起按 step 递变
function makeDaily(fromYmd, n, base, step) {
  const rows = []
  const d = new Date(fromYmd.slice(0, 4) + '-' + fromYmd.slice(4, 6) + '-' + fromYmd.slice(6, 8) + 'T00:00:00Z')
  let close = base
  for (let i = 0; i < n; i++) {
    const p2 = (x) => String(x).padStart(2, '0')
    const ymd = '' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate())
    rows.push({ trade_date: ymd, close: Math.round(close * 100) / 100 })
    close += step
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return rows
}

function makeHarness(options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-backtest-'))
  const storeDir = path.join(base, '.dsh-invest', 'store')
  const packDir = path.join(base, '.dsh-invest', 'cache', 'pack')
  fs.mkdirSync(storeDir, { recursive: true })
  fs.mkdirSync(packDir, { recursive: true })
  process.env.DSH_INVEST_BASE_DIR = base
  process.env.DSH_INVEST_SKIP_REINDEX = '1'
  process.env.DSH_INVEST_WATCH_DAILY = '0'
  process.env.DSH_INVEST_SKIP_STOCK_NOTES = '1'
  process.env.DSH_INVEST_AUTO_CURATE = '0'

  if (options.conclusions) {
    fs.writeFileSync(path.join(storeDir, 'conclusions.jsonl'),
      options.conclusions.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8')
  }
  // 日线缓存（btDaily 命中即离线，token 缺失也不会在线拉）
  for (const [code, rows] of Object.entries(options.daily || {})) {
    const last = rows[rows.length - 1].trade_date
    fs.writeFileSync(path.join(packDir, 'daily_' + code.replace(/\./g, '_') + '_' + last + '.json'),
      JSON.stringify({ code, endYmd: last, rows }), 'utf8')
  }
  // 复权因子缓存（btAdj 命中即离线；v0.46.0）
  for (const [code, rows] of Object.entries(options.adj || {})) {
    const last = rows[rows.length - 1].trade_date
    fs.writeFileSync(path.join(packDir, 'adj_' + code.replace(/\./g, '_') + '_' + last + '.json'),
      JSON.stringify({ code, endYmd: last, rows }), 'utf8')
  }

  const registered = []
  const parentAgent = { session: { append() {} }, options: { provider: 'p', model: 'm' } }
  const fakeFs = {
    resolve: async (p) => p,
    readText: async (p) => fs.readFileSync(p, 'utf8'),
    writeText: async (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) },
  }
  const ctx = {
    get(name) {
      if (name === 'fs') return fakeFs
      if (name === 'sandboxPolicy') return { resolve: () => ({}) }
      if (name === 'agents') return { roots: () => [parentAgent], create: async () => ({ agent: null, dispose: async () => {} }) }
      return undefined
    },
    effect(fn) { fn() },
    webServer: { register: (route) => { registered.push(route); return () => {} } },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => {} },
  }
  apply(ctx, {})

  async function call(method, pathAndQuery) {
    const route = registered.find((item) => item.path === pathAndQuery.split('?')[0])
    assert.ok(route, '路由未注册：' + pathAndQuery)
    let status = 0
    let text = ''
    const req = { method, url: pathAndQuery, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' } }
    const res = {
      setHeader() {}, set statusCode(v) { status = v }, get statusCode() { return status },
      end(v) { text = v === undefined ? '' : String(v) },
    }
    await route.handler(req, res)
    return { status: status || 200, json: text ? JSON.parse(text) : null }
  }
  return { base, call, cleanup: () => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

const CONCLUSION = (over) => ({
  ts: '2026-10-08T02:00:00.000Z', mode: '个股', question: '测试', callId: 'test',
  code: '600519.SH', stance: '看多', target: 120, stop: 100, buy_low: 105, buy_high: 110,
  thesis: '测试论据', invalidate_if: '测试失效', stage: '股票深度分析师', report: null, source: 'invest_run',
  ...over,
})

test('回测：命中定义与超额收益（看多→上涨命中；拒绝→下跌命中；观察不计）', async (t) => {
  const daily = {
    // 茅台：100 → +1/天，5 日 +5%
    '600519.SH': makeDaily('20261008', 30, 100, 1),
    // 平安：10 → -0.05/天，5 日 -2.5%
    '000001.SZ': makeDaily('20261008', 30, 10, -0.05),
    // 焦点：8 → +0.02/天（观察，不计命中率）
    '002315.SZ': makeDaily('20261008', 30, 8, 0.02),
    // 上证指数：3000 → +6/天，5 日 +1%
    '000001.SH': makeDaily('20261008', 30, 3000, 6),
  }
  const h = makeHarness({
    conclusions: [
      CONCLUSION({ stance: '看多' }),                                   // 茅台 +5% → hit5
      CONCLUSION({ code: '000001.SZ', stance: '拒绝' }),                // 平安 -2.5% → hit5
      CONCLUSION({ code: '000001.SZ', stance: '持有', stage: '总判断师' }), // 平安 -2.5% → miss5（持有=看多侧）
      CONCLUSION({ code: '002315.SZ', stance: '观察' }),                // 不计命中率
    ],
    daily,
    // 因子恒为 1 → 复权不应改变任何数值，仅用于消除「无因子」告警
    adj: {
      '600519.SH': makeAdj('20261008', 30, 1),
      '000001.SZ': makeAdj('20261008', 30, 1),
      '002315.SZ': makeAdj('20261008', 30, 1),
    },
  })
  t.after(h.cleanup)

  const r = await h.call('GET', '/dsh-invest/api/backtest')
  assert.equal(r.status, 200)
  const j = r.json
  assert.equal(j.total, 4)
  assert.equal(j.matched, 4)
  assert.equal(j.warnings.length, 0)

  const mt = j.rows.find((x) => x.code === '600519.SH')
  assert.equal(mt.hit5, true, '看多 + 上涨 → 命中')
  assert.equal(mt.hit20, true, '20 日同样上涨 → 命中')
  assert.ok(Math.abs(mt.ret5 - 5) < 0.01, 'ret5 = +5%')
  // 超额 = 5% - 1%（指数 3000→3030）
  assert.ok(Math.abs(mt.ex5 - 4) < 0.02, 'ex5 ≈ +4%，实际 ' + mt.ex5)

  const pa = j.rows.find((x) => x.code === '000001.SZ' && x.stance === '拒绝')
  assert.equal(pa.hit5, true, '拒绝 + 下跌 → 命中')
  assert.equal(pa.hit20, true)

  const hold = j.rows.find((x) => x.code === '000001.SZ' && x.stance === '持有')
  assert.equal(hold.hit5, false, '持有 + 下跌 → 未命中')

  const watch = j.rows.find((x) => x.code === '002315.SZ')
  assert.equal(watch.hit5, null, '观察不计命中率')
  // 有方向样本 3（看多/拒绝/持有），命中 2（茅台看多、平安拒绝；平安持有 miss）→ 2/3
  assert.equal(j.overall.hits5, 3)
  assert.equal(Math.round(j.overall.rate5), 67)

  // 分组：byStage 与 byStance 都在；深度组 3 条（持有行已改挂总判断师）
  const deep = j.byStage.find((g) => g.name === '股票深度分析师')
  assert.equal(deep.samples, 3)
  const judge = j.byStage.find((g) => g.name === '总判断师')
  assert.equal(judge.samples, 1)
  assert.equal(judge.rate5, 0, '总判断师的持有建议实际下跌 → 未命中')
  const rej = j.byStance.find((g) => g.name === '拒绝')
  assert.equal(rej.samples, 1)
  assert.equal(rej.rate5, 100)
})

test('回测：结论靠近数据末端 → 前向窗口不足为 null，不误判为命中', async (t) => {
  const rows = makeDaily('20261008', 30, 100, 1)
  const lateYmd = rows[25].trade_date // i=25：i+5=30 越界
  const h = makeHarness({
    conclusions: [{
      ...CONCLUSION(),
      ts: lateYmd.slice(0, 4) + '-' + lateYmd.slice(4, 6) + '-' + lateYmd.slice(6, 8) + 'T02:00:00.000Z',
    }],
    daily: { '600519.SH': rows, '000001.SH': makeDaily('20261008', 30, 3000, 6) },
  })
  t.after(h.cleanup)
  const r = await h.call('GET', '/dsh-invest/api/backtest')
  assert.equal(r.status, 200)
  const row = r.json.rows[0]
  assert.equal(row.ret20, null, 'i+20 越界 → ret20=null')
  assert.equal(row.hit20, null)
  assert.equal(r.json.overall.hits20, 0)
  assert.equal(r.json.overall.rate20, null)
})

test('回测：无结论与缺日线都优雅降级（不 500）', async (t) => {
  const empty = makeHarness({})
  t.after(empty.cleanup)
  const r0 = await empty.call('GET', '/dsh-invest/api/backtest')
  assert.equal(r0.status, 200)
  assert.equal(r0.json.total, 0)
  assert.ok(r0.json.warnings.length >= 1, '空库应提示暂无结论')

  // 有结论但完全没有日线缓存，且无 token（离线环境）→ 行级丢弃 + warning，仍 200
  const h = makeHarness({ conclusions: [CONCLUSION()] })
  t.after(h.cleanup)
  const r1 = await h.call('GET', '/dsh-invest/api/backtest')
  assert.equal(r1.status, 200)
  assert.equal(r1.json.matched, 0)
  assert.ok(r1.json.warnings.some((w) => w.includes('600519.SH')))
})

test('回测：fwd 口径以「结论日后第一个交易日」为基准（周末结论顺延）', async (t) => {
  // 结论 ts=2026-10-10（周六）→ 首个 >= 的交易日是 20261012（周一）
  const rows = makeDaily('20261012', 30, 100, 1)
  const h = makeHarness({
    conclusions: [CONCLUSION({ ts: '2026-10-10T02:00:00.000Z' })],
    daily: { '600519.SH': rows, '000001.SH': makeDaily('20261012', 30, 3000, 6) },
  })
  t.after(h.cleanup)
  const r = await h.call('GET', '/dsh-invest/api/backtest')
  assert.equal(r.status, 200)
  const row = r.json.rows[0]
  assert.equal(row.base, 100, '基准 = 周一收盘 100')
  assert.ok(Math.abs(row.ret5 - 5) < 0.01)
})

// ===== v0.46.0：复权 =====
// 复权因子序列：factor 恒定 = 价格连续，复权不应改变任何结果
function makeAdj(fromYmd, n, f) {
  return makeDaily(fromYmd, n, 0, 0).map((x) => ({ trade_date: x.trade_date, adj_factor: f }))
}
// 构造一次「除权除息」：前 5 天价 110、因子 1.0；第 6 天起价 101、因子 1.1。
// 未复权看是 −8.18% 的「下跌」，按前复权看实为 +1% 的真实上涨 —— 命中判定直接被翻转。
function makeExDivDaily(fromYmd, n) {
  const rows = makeDaily(fromYmd, n, 110, 0)
  for (let i = 5; i < n; i++) rows[i].close = 101
  return rows
}
function makeExDivAdj(fromYmd, n) {
  return makeDaily(fromYmd, n, 0, 0).map((x, i) => ({ trade_date: x.trade_date, adj_factor: i < 5 ? 1 : 1.1 }))
}

test('回测：除权日必须用前复权价，否则「分红」会被误判成「下跌」（v0.46.0）', async (t) => {
  const n = 30
  const h = makeHarness({
    conclusions: [CONCLUSION({ stance: '看多' })],
    daily: { '600519.SH': makeExDivDaily('20261008', n), '000001.SH': makeDaily('20261008', n, 3000, 0) },
    adj: { '600519.SH': makeExDivAdj('20261008', n) },
  })
  t.after(h.cleanup)

  const r = await h.call('GET', '/dsh-invest/api/backtest')
  assert.equal(r.status, 200)
  const row = r.json.rows[0]

  assert.ok(row.ret5Raw < -8, '未复权口径应显示约 -8.18%，实际 ' + row.ret5Raw)
  assert.ok(row.ret5 > 0.9 && row.ret5 < 1.1, '前复权口径应约 +1%，实际 ' + row.ret5)
  assert.equal(row.adjApplied, true, '本条确实用到了复权因子')
  assert.equal(row.hit5, true, '复权后是上涨 → 看多应判命中（未复权会误判为未中）')
  assert.equal(r.json.overall.rate5, 100)
  assert.equal(r.json.adjCoverage, 1)
  assert.equal(r.json.adjUniverse, 1)
})

test('回测：无复权因子时回落未复权并显式告警（不静默降级）', async (t) => {
  const n = 30
  const h = makeHarness({
    conclusions: [CONCLUSION({ stance: '看多' })],
    // 无 adj 缓存 → btAdj 拿不到因子
    daily: { '600519.SH': makeExDivDaily('20261008', n), '000001.SH': makeDaily('20261008', n, 3000, 0) },
  })
  t.after(h.cleanup)

  const r = await h.call('GET', '/dsh-invest/api/backtest')
  assert.equal(r.status, 200)
  const row = r.json.rows[0]
  assert.equal(row.adjApplied, false, '无因子 → 走未复权')
  assert.equal(row.ret5, row.ret5Raw, '复权与未复权应一致（都等于未复权）')
  assert.equal(row.hit5, false, '按未复权算则是下跌 → 未命中')
  assert.equal(r.json.adjCoverage, 0)
  assert.ok(r.json.warnings.some((w) => w.includes('复权因子覆盖')), '必须告警，不能静默按未复权算')
})

// ===== v0.47.0：市场状态（同质样本拆分） =====
test('回测：市场状态按结论基准日的上证判定（上行/下行/震荡），byRegime 分组存在', async (t) => {
  // 上行：一路上涨 → 收盘 > MA20 且 20 日涨跌 > 0
  const h1 = makeHarness({
    conclusions: [CONCLUSION()],
    daily: { '600519.SH': makeDaily('20261008', 30, 100, 1), '000001.SH': makeDaily('20260901', 40, 3000, 6) },
  })
  t.after(h1.cleanup)
  const r1 = await h1.call('GET', '/dsh-invest/api/backtest')
  assert.equal(r1.status, 200)
  assert.equal(r1.json.rows[0].regime, '上行')
  assert.ok(r1.json.byRegime.some((g) => g.name === '上行'))

  // 下行：一路下跌 → 收盘 < MA20 且 20 日涨跌 < 0
  const h2 = makeHarness({
    conclusions: [CONCLUSION()],
    daily: { '600519.SH': makeDaily('20261008', 30, 100, 1), '000001.SH': makeDaily('20260901', 40, 3000, -6) },
  })
  t.after(h2.cleanup)
  const r2 = await h2.call('GET', '/dsh-invest/api/backtest')
  assert.equal(r2.json.rows[0].regime, '下行')

  // 震荡：先涨 35 根，末 3 根压回 MA20 下方，但 20 日涨跌仍为正 → 混合
  const chop = makeDaily('20260901', 40, 3000, 6)
  chop[35].close = 3120; chop[36].close = 3126; chop[37].close = 3132
  const h3 = makeHarness({
    conclusions: [CONCLUSION()],
    daily: { '600519.SH': makeDaily('20261008', 30, 100, 1), '000001.SH': chop },
  })
  t.after(h3.cleanup)
  const r3 = await h3.call('GET', '/dsh-invest/api/backtest')
  assert.equal(r3.json.rows[0].regime, '震荡', '收盘<MA20 但 20 日涨跌>0 → 震荡而非下行')
})

test('回测：指数历史不足 20 根 → 市场状态 null，归入「—」组不冒充结论', async (t) => {
  // 指数与个股同日起步 → 结论基准日 j=0 < 20 → 无状态
  const h = makeHarness({
    conclusions: [CONCLUSION()],
    daily: { '600519.SH': makeDaily('20261008', 30, 100, 1), '000001.SH': makeDaily('20261008', 30, 3000, 6) },
  })
  t.after(h.cleanup)
  const r = await h.call('GET', '/dsh-invest/api/backtest')
  assert.equal(r.status, 200)
  assert.equal(r.json.rows[0].regime, null)
  assert.ok(r.json.byRegime.some((g) => g.name === '—'), 'null 归入「—」组')
})
