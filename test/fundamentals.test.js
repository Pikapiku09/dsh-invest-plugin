// 基本面评级引擎单测（v0.58.0）
//
// 这个文件只测纯函数：不联网、不读盘。取数与缓存由路由层负责，
// 分数逻辑必须能被这样逐条断言，否则「评级」就是不可验证的口径。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MIN_PEERS, CAVEAT, num, latestDisclosedPeriod, dedupeByCode, percentileRank,
  bandScore, gradeOf, computeDimensions, detectFlags, buildFundamentals,
} from '../packages/dsh-invest/lib/fundamentals.js'

// ---------- 报告期推导 ----------

test('报告期：按披露截止日推导，不写死', () => {
  const at = (y, m, d) => new Date(Date.UTC(y, m - 1, d))
  assert.equal(latestDisclosedPeriod(at(2026, 11, 16)).period, '20260930', '11 月应拿到三季报')
  assert.equal(latestDisclosedPeriod(at(2026, 9, 1)).period, '20260630', '9 月初应拿到半年报')
  assert.equal(latestDisclosedPeriod(at(2026, 5, 5)).period, '20260331', '5 月应拿到一季报')
  assert.equal(latestDisclosedPeriod(at(2026, 2, 10)).period, '20250930', '2 月年报未出，退回上年三季报')
  assert.equal(latestDisclosedPeriod(at(2026, 4, 20)).period, '20250930', '4/20 年报还没到披露截止日')
  // 4/30 是年报与一季报的共同截止日，此时一季报报告期更新，应取一季报
  assert.equal(latestDisclosedPeriod(at(2026, 4, 30)).period, '20260331', '4/30 起一季报报告期更新，优先于年报')
  assert.equal(latestDisclosedPeriod(at(2027, 1, 20)).period, '20260930', '1 月只能拿到上年三季报')
})

// ---------- 去重 ----------

test('去重：同一股票多版本行按公告日取最新（超声电子 Q3 有 15 条）', () => {
  const rows = [
    { ts_code: '000823.SZ', ann_date: '20261028', eps: 0.6288 },
    { ts_code: '000823.SZ', ann_date: '20261030', eps: 0.64 },
    { ts_code: '000823.SZ', ann_date: '20261020', eps: 0.60 },
    { ts_code: '600011.SH', ann_date: '20261025', eps: 0.5 },
  ]
  const map = dedupeByCode(rows)
  assert.equal(map.size, 2, '两只股票各一条')
  assert.equal(map.get('000823.SZ').eps, 0.64, '应保留公告日最新的 20261030 那条')
})

test('去重：缺 ann_date 时保留首条，不丢数据', () => {
  const map = dedupeByCode([{ ts_code: 'X.SH', eps: 1 }, { ts_code: 'X.SH', eps: 2 }])
  assert.equal(map.get('X.SH').eps, 1)
})

// ---------- 分位 ----------

test('分位：越大越好时，排在中位就是 50 分位', () => {
  const vals = Array.from({ length: 41 }, (_, i) => i) // 0..40，中位 20
  assert.equal(percentileRank(vals, 20, true), 48.78)
  assert.equal(percentileRank(vals, 40, true), 97.56, '最大值应接近 100')
})

test('分位：越小越好时自动反转（负债率、PE 这类）', () => {
  const vals = Array.from({ length: 41 }, (_, i) => i)
  assert.equal(percentileRank(vals, 5, false), 87.8, '负债率低 → 分位高')
  assert.equal(percentileRank(vals, 35, false), 14.63, '负债率高 → 分位低')
})

test('分位：样本不足 MIN_PEERS 直接返回 null，不硬算', () => {
  assert.equal(MIN_PEERS, 20)
  assert.equal(percentileRank([1, 2, 3], 2, true), null, '3 个样本算分位毫无意义')
  assert.equal(percentileRank([], 2, true), null)
  assert.equal(percentileRank(Array.from({ length: 20 }, (_, i) => i), null, true), null)
})

// ---------- 分档与等级 ----------

test('分档：分位拉伸后不再全部堆在 50 分', () => {
  assert.equal(bandScore(95), 96)
  assert.equal(bandScore(80), 88)
  assert.equal(bandScore(65), 74)
  assert.equal(bandScore(50), 58)
  assert.equal(bandScore(30), 42)
  assert.equal(bandScore(15), 30)
  assert.equal(bandScore(5), 16)
  assert.equal(bandScore(null), null, '没有分位就没有分数，不能当 0')
})

test('等级：阈值作用在总分上', () => {
  assert.deepEqual(gradeOf(92), { grade: 'A', label: '优秀' })
  assert.deepEqual(gradeOf(85), { grade: 'A', label: '优秀' })
  assert.deepEqual(gradeOf(70), { grade: 'B', label: '良好' })
  assert.deepEqual(gradeOf(55), { grade: 'C', label: '中等' })
  assert.deepEqual(gradeOf(40), { grade: 'D', label: '偏弱' })
  assert.deepEqual(gradeOf(39.9), { grade: 'E', label: '较差' })
  assert.equal(gradeOf(null).grade, '—', '没有总分就不是 E，是「数据不足」')
})

// ---------- 组装一个真实形状的样本 ----------

/** 造同行业样本：让本股在每项上都落在指定名次 */
function makePeers(count, overrides = {}) {
  const peers = []
  for (let i = 0; i < count; i++) {
    peers.push({
      ts_code: `T${i}.SZ`,
      roe_yearly: 5 + i, grossprofit_margin: 15 + i, netprofit_margin: 3 + i * 0.5,
      netprofit_yoy: -10 + i * 2, or_yoy: 0 + i, dt_netprofit_yoy: -10 + i * 2,
      debt_to_assets: 30 + i, current_ratio: 1 + i * 0.05,
      ocfps: 0.3 + i * 0.05, eps: 0.5,
      ...overrides,
    })
  }
  return peers
}

const ME = {
  ts_code: '000823.SZ', ann_date: '20261028',
  roe: 6.5728, roe_yearly: 8.7637, grossprofit_margin: 19.4712, netprofit_margin: 7.3351,
  netprofit_yoy: 97.516, dt_netprofit_yoy: 95.89, or_yoy: 15.2145,
  debt_to_assets: 32.0401, current_ratio: 2.2983, ocfps: 0.6988, eps: 0.6288,
}

function makeInput(over = {}) {
  const peers = makePeers(40)
  peers.push(ME) // 同业集合包含自己
  const peerDb = Array.from({ length: 40 }, (_, i) => ({ ts_code: `T${i}.SZ`, pe_ttm: 20 + i, pb: 2 + i * 0.1 }))
  const meDb = { ts_code: '000823.SZ', pe_ttm: 26.141, pb: 1.7779 }
  peerDb.push(meDb)
  return {
    code: '000823.SZ', name: '超声电子', industry: '元器件', peerCount: 41,
    period: '20260930', periodLabel: '2026Q3', announceDate: '2026-10-28', priceDate: '2026-11-13',
    me: ME, peers, meDb, peerDb, history: [], periodRows: [ME], cachedAt: '2026-11-16 13:40',
    ...over,
  }
}

test('组装：六维齐全、总分与等级可算、免责常驻', () => {
  const r = buildFundamentals(makeInput())
  assert.equal(r.ok, true)
  assert.equal(r.dims.length, 5, '五个计分维度（风险标记单独走 flags）')
  assert.deepEqual(r.dims.map((d) => d.key), ['growth', 'valuation', 'profitability', 'quality', 'health'])
  assert.ok(r.total !== null && r.total > 0 && r.total <= 100, '总分应在 0-100：' + r.total)
  assert.match(r.grade, /^[A-E]$/)
  assert.equal(r.coverage, '5/5 维')
  assert.equal(r.caveat, CAVEAT, '实证免责必须原样带出')
  assert.ok(r.caveat.includes('不构成买卖信号'))
})

test('组装：每个维度都带指标明细，分位已反转的维度要能对上直觉', () => {
  const r = buildFundamentals(makeInput())
  const val = r.dims.find((d) => d.key === 'valuation')
  const pe = val.metrics.find((m) => m.label === 'PE_TTM')
  // 本股 PE 26.14，同业 20..59 → 比约 15% 的同业贵 → 反转后应是「便宜于 85%」附近
  assert.ok(pe.pct > 70, 'PE 分位应反映"比多数同业便宜"：' + pe.pct)
  const health = r.dims.find((d) => d.key === 'health')
  const debt = health.metrics.find((m) => m.label === '资产负债率')
  assert.ok(debt.pct > 50, '负债率 32% 在同业 30..69 里偏低 → 反转后分位应偏高：' + debt.pct)
})

test('组装：亏损股不参与估值评分，且明确说明原因', () => {
  const input = makeInput({ meDb: { ts_code: '000823.SZ', pe_ttm: -15, pb: 2 } })
  const r = buildFundamentals(input)
  const val = r.dims.find((d) => d.key === 'valuation')
  assert.equal(val.score, null, '亏损时估值维度不计分')
  assert.match(val.detail, /亏损/)
  assert.equal(r.coverage, '4/5 维', '覆盖率要如实降低')
  assert.ok(r.flags.some((f) => f.level === 'bad' && /亏损/.test(f.label)))
})

test('组装：缺财务数据时全维为空，等级显示数据不足而不是 E', () => {
  const r = buildFundamentals(makeInput({ me: null, peers: [], peerDb: [], peerCount: 0 }))
  assert.equal(r.total, null)
  assert.equal(r.grade, '—')
  assert.equal(r.gradeLabel, '数据不足')
  assert.ok(r.warnings.some((w) => /未取到/.test(w)))
  assert.ok(!r.flags.some((f) => f.label === '报告期亏损（EPS 0）'), '没有数据不等于亏损，不能凭空报雷')
})

test('组装：同业样本不足要降级并写进 warnings', () => {
  const peers = makePeers(5)
  peers.push(ME)
  const r = buildFundamentals(makeInput({ peers, peerDb: [], peerCount: 6 }))
  assert.ok(r.warnings.some((w) => /同业样本仅 6 只/.test(w)))
  assert.equal(r.total, null, '样本不足时不应给出总分')
})

// ---------- 风险标记 ----------

test('风险标记：ST / 负现金流 / 高负债 / 连续亏损各自命中', () => {
  const flags = detectFlags({ me: ME, name: '*ST超声', periodRows: [ME] })
  assert.ok(flags.some((f) => f.level === 'bad' && /ST/.test(f.label)))

  const bad = detectFlags({ me: { ...ME, ocfps: -0.2, debt_to_assets: 78, current_ratio: 0.8 }, name: '普通股' })
  assert.ok(bad.some((f) => /经营现金流为负/.test(f.label)))
  assert.ok(bad.some((f) => /资产负债率 78/.test(f.label)))
  assert.ok(bad.some((f) => /流动比率 0\.8/.test(f.label)))

  const twoLosses = detectFlags({
    me: { ...ME, eps: -0.1 }, name: '普通股',
    periodRows: [{ eps: -0.1 }, { eps: -0.2 }],
  })
  assert.ok(twoLosses.some((f) => /连续两个报告期亏损/.test(f.label)))

  const single = detectFlags({ me: { ...ME, eps: -0.1 }, name: '普通股', periodRows: [{ eps: -0.1 }, { eps: 0.2 }] })
  assert.ok(!single.some((f) => /连续两个报告期亏损/.test(f.label)), '只有一期亏损不算连亏')
})

test('风险标记：取不到的项必须标【待核实】，不能默认通过', () => {
  const flags = detectFlags({ me: ME, name: '超声电子', periodRows: [ME] })
  const pending = flags.find((f) => f.level === 'info')
  assert.ok(pending, '必须有一条待核实提示')
  assert.match(pending.note, /待核实/)
  assert.match(pending.note, /未核实不代表没有风险/)
})

// ---------- 升降 ----------

test('升降：有上一期快照时给出变化分数', () => {
  const r = buildFundamentals(makeInput({
    history: [{ period: '20260630', periodLabel: '2026半年报', total: 60, grade: 'C', at: '2026-08-31' }],
  }))
  assert.ok(r.delta, '应算出 delta')
  assert.equal(r.delta.periodLabel, '2026半年报')
  assert.ok(typeof r.delta.change === 'number')
})

test('升降：没有上期快照时不编造 delta', () => {
  assert.equal(buildFundamentals(makeInput()).delta, null)
})

test('数值规范化：逗号、空串、字符串数字都要能吃', () => {
  assert.equal(num('1,234.5'), 1234.5)
  assert.equal(num(''), null)
  assert.equal(num(null), null)
  assert.equal(num('abc'), null)
  assert.equal(num(0), 0, '0 是有效值，不能当空')
})
