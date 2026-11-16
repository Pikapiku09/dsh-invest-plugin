// 基本面评级引擎（v0.58.0）
//
// 设计原则（三条，改之前先读）：
// 1) **纯函数**：无网络、无文件、无时间依赖（时间由调用方传入）。这样每个分数都能单测断言，
//    而不是「跑一次看看像不像」。
// 2) **行业横向分位而不是绝对阈值**：毛利率 19% 放在消费股是灾难、放在元器件是常态。
//    绝对阈值会系统性冤枉整个行业里的普通公司。分位口径自带行业基准。
// 3) **评级只用于排雷与理解质地，不是买卖信号**。插件自己的实证（122 波 PIT 归因）显示
//    基本面指标不区分盈亏（|Cliff's δ|≤0.19、BH-FDR≥0.51），所以界面必须常驻这条免责，
//    绝不能把等级做成"该不该买"的开关。`CAVEAT` 就是为此存在的，不许删。

/** 同业样本下限：低于这个数算出来的分位不可信，直接不给分（也绝不假装有分） */
export const MIN_PEERS = 20

/**
 * 分位 → 分数 的分档映射
 *
 * 为什么不直接用分位当分数：五个维度的分位取加权平均后会向 50 集中（标准差的中心极限），
 * 于是几乎所有股票都落在 C，评级失去分辨力。分档拉伸后再加权，才能区分出「同业前 10%」。
 */
const PCT_BANDS = [
  [90, 96], [75, 88], [60, 74], [40, 58], [25, 42], [10, 30], [-1, 16],
]

/** 等级：阈值作用在加权总分上 */
const GRADES = [
  [85, 'A', '优秀'], [70, 'B', '良好'], [55, 'C', '中等'], [40, 'D', '偏弱'], [-1, 'E', '较差'],
]

/** 实证免责：每条基本面输出都必须带上，界面常驻展示 */
export const CAVEAT = '122 波实证：ROE／净利同比／营收同比／毛利率／PB 分位均不区分盈亏（|δ|≤0.19、FDR≥0.51），'
  + '「基本面差」不构成回避理由。本评级用于排雷与理解质地，不构成买卖信号。'

/** 数值规范化：Tushare 大量返回 null / "" / 字符串数字 */
export function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : null
}

const round2 = (n) => Math.round(n * 100) / 100

/**
 * 推导「当前已披露」的最新报告期
 *
 * A 股披露截止日：一季报 0430、半年报 0831、三季报 1031、年报次年 0430。
 * 用日期推导而不是写死，是因为这个函数会被历史回放和数据修复复用。
 *
 * 注意 4/30 这个交叉点：年报（上年 1231）与一季报（本年 0331）的截止日同为 4/30，
 * 此时应取**报告期更新**的那个（一季报），而不是年报。
 * @param {Date} now
 * @returns {{ period: string, label: string, deadline: string }}
 */
export function latestDisclosedPeriod(now = new Date()) {
  const y = now.getUTCFullYear()
  const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
  const candidates = []
  for (const yy of [y, y - 1]) {
    candidates.push({ period: `${yy}1231`, label: `${yy}年报`, deadline: new Date(Date.UTC(yy + 1, 3, 30)) })
    candidates.push({ period: `${yy}0930`, label: `${yy}Q3`, deadline: new Date(Date.UTC(yy, 9, 31)) })
    candidates.push({ period: `${yy}0630`, label: `${yy}半年报`, deadline: new Date(Date.UTC(yy, 7, 31)) })
    candidates.push({ period: `${yy}0331`, label: `${yy}Q1`, deadline: new Date(Date.UTC(yy, 3, 30)) })
  }
  // 报告期由新到旧，取第一个「截止日已到」的
  candidates.sort((a, b) => b.period.localeCompare(a.period))
  const hit = candidates.find((c) => c.deadline.getTime() <= now.getTime())
  if (hit) return { period: hit.period, label: hit.label, deadline: ymd(hit.deadline) }
  // 理论上不会走到这里（上年 Q3 早已过截止），留个确定性的兜底
  return { period: `${y - 1}0930`, label: `${y - 1}Q3`, deadline: `${y - 1}1031` }
}

/**
 * 同一报告期同一股票可能有多条记录（业绩快报 / 修正版 / 重复入库）。
 * 不去重会把分位算歪——超声电子 2026Q3 就有 15 条。按 ann_date 取最新，缺失时保留首条。
 */
export function dedupeByCode(rows) {
  const map = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    const code = String((r && r.ts_code) || '').toUpperCase()
    if (!code) continue
    const prev = map.get(code)
    if (!prev) { map.set(code, r); continue }
    const a = String(r.ann_date || '0')
    const b = String(prev.ann_date || '0')
    if (a > b) map.set(code, r)
  }
  return map
}

/**
 * 分位排名：返回 0-100，表示「优于同业多少比例的样本」
 * @param {number[]} values 同业样本（含自己）
 * @param {number} value 自己的值
 * @param {boolean} higherIsBetter false 表示越小越好（负债率、PE、PB 这类）
 */
export function percentileRank(values, value, higherIsBetter = true) {
  const mine = num(value)
  if (mine === null) return null
  const vals = (Array.isArray(values) ? values : []).map(num).filter((v) => v !== null)
  if (vals.length < MIN_PEERS) return null
  let below = 0
  for (const v of vals) if (v < mine) below += 1
  const pct = (below / vals.length) * 100
  return round2(higherIsBetter ? pct : 100 - pct)
}

/** 分位 → 分档分数 */
export function bandScore(pct) {
  const p = num(pct)
  if (p === null) return null
  for (const [floor, score] of PCT_BANDS) if (p > floor) return score
  return 16
}

/** 总分 → 等级 */
export function gradeOf(total) {
  const t = num(total)
  if (t === null) return { grade: '—', label: '数据不足' }
  for (const [floor, grade, label] of GRADES) if (t >= floor) return { grade, label }
  return { grade: 'E', label: '较差' }
}

/** 加权平均（跳过 null，并按实际参与权重归一化——不把缺失当 0） */
function weightedMean(pairs) {
  let sum = 0
  let weight = 0
  for (const [value, w] of pairs) {
    if (value === null || value === undefined) continue
    sum += value * w
    weight += w
  }
  if (weight <= 0) return null
  return round2(sum / weight)
}

/**
 * 单个指标的分位与得分
 * @returns {{ label: string, value: string, pct: number|null, score: number|null, sample: number }}
 */
function metricOf(peers, field, me, opts = {}) {
  const { label, format = (v) => String(v), higherIsBetter = true, derive = null } = opts
  const read = (row) => {
    const raw = derive ? derive(row) : row[field]
    return num(raw)
  }
  const mine = me ? read(me) : null
  const vals = []
  for (const p of peers) {
    const v = read(p)
    if (v !== null) vals.push(v)
  }
  const pct = mine === null ? null : percentileRank(vals, mine, higherIsBetter)
  return {
    label,
    value: mine === null ? '—' : format(mine),
    pct,
    score: bandScore(pct),
    sample: vals.length,
  }
}

/** 经营现金流 / EPS：衡量利润里有多少是真金白银 */
const ocfRatio = (row) => {
  const ocf = num(row.ocfps)
  const eps = num(row.eps)
  if (ocf === null || eps === null || eps === 0) return null
  return ocf / eps
}

/** 扣非增速相对归母增速的落差点：越大说明增长越依赖非经常性损益 */
const deductionGap = (row) => {
  const net = num(row.netprofit_yoy)
  const dt = num(row.dt_netprofit_yoy)
  if (net === null || dt === null) return null
  return net - dt
}

/**
 * 六维打分
 * @param {{ me: object, peers: object[], meDb: object, peerDb: object[] }} input
 */
export function computeDimensions({ me, peers, meDb, peerDb }) {
  const dims = []

  // 1) 成长性：净利同比 60% + 营收同比 40%，近三期方向再 ±8
  const growthNet = metricOf(peers, 'netprofit_yoy', me, { label: '净利同比', format: (v) => `${round2(v)}%` })
  const growthRev = metricOf(peers, 'or_yoy', me, { label: '营收同比', format: (v) => `${round2(v)}%` })
  let growthScore = weightedMean([[growthNet.score, 0.6], [growthRev.score, 0.4]])
  const trend = num(me && me.__trend)
  if (growthScore !== null && trend !== null) {
    growthScore = Math.max(0, Math.min(95, round2(growthScore + (trend > 0 ? 8 : trend < 0 ? -8 : 0))))
  }
  dims.push({
    key: 'growth', label: '成长性', weight: 0.25, score: growthScore,
    detail: describe(growthNet, growthRev, trend),
    metrics: strip(growthNet, growthRev),
  })

  // 2) 估值：PE_TTM 50% + PB 50%，都是越低越好；亏损（PE<=0）整维不计分
  const pe = meDb ? num(meDb.pe_ttm) : null
  const loss = pe !== null && pe <= 0
  if (loss) {
    dims.push({
      key: 'valuation', label: '估值', weight: 0.25, score: null,
      detail: '报告期亏损，PE 为负，估值分位不适用（亏损股不参与估值评分）',
      metrics: [
        { label: 'PE_TTM', value: String(pe), pct: null },
        { label: 'PB', value: meDb && num(meDb.pb) !== null ? String(round2(num(meDb.pb))) : '—', pct: null },
      ],
    })
  } else {
    const peM = metricOf(peerDb, 'pe_ttm', meDb, { label: 'PE_TTM', format: (v) => round2(v), higherIsBetter: false })
    const pbM = metricOf(peerDb, 'pb', meDb, { label: 'PB', format: (v) => round2(v), higherIsBetter: false })
    dims.push({
      key: 'valuation', label: '估值', weight: 0.25,
      score: weightedMean([[peM.score, 0.5], [pbM.score, 0.5]]),
      detail: describe(peM, pbM, null, '越低越好，分位已反转'),
      metrics: strip(peM, pbM),
    })
  }

  // 3) 盈利能力：年化 ROE 50% + 毛利率 25% + 净利率 25%
  const roe = metricOf(peers, 'roe_yearly', me, { label: '年化ROE', format: (v) => `${round2(v)}%` })
  const gross = metricOf(peers, 'grossprofit_margin', me, { label: '毛利率', format: (v) => `${round2(v)}%` })
  const netMargin = metricOf(peers, 'netprofit_margin', me, { label: '净利率', format: (v) => `${round2(v)}%` })
  dims.push({
    key: 'profitability', label: '盈利能力', weight: 0.2,
    score: weightedMean([[roe.score, 0.5], [gross.score, 0.25], [netMargin.score, 0.25]]),
    detail: describe(roe, gross),
    metrics: strip(roe, gross, netMargin),
  })

  // 4) 盈利质量：现金流覆盖利润 60% + 扣非相对归母的落差点 40%
  const ocf = metricOf(peers, null, me, {
    label: '经营现金流/EPS', higherIsBetter: true, derive: ocfRatio, format: (v) => `${round2(v)} 倍`,
  })
  const gap = metricOf(peers, null, me, {
    label: '归母-扣非增速差', higherIsBetter: false, derive: deductionGap, format: (v) => `${round2(v)} 个百分点`,
  })
  dims.push({
    key: 'quality', label: '盈利质量', weight: 0.15,
    score: weightedMean([[ocf.score, 0.6], [gap.score, 0.4]]),
    detail: describe(ocf, gap),
    metrics: strip(ocf, gap),
  })

  // 5) 财务健康：资产负债率 50%（越低越好）+ 流动比率 50%
  const debt = metricOf(peers, 'debt_to_assets', me, {
    label: '资产负债率', format: (v) => `${round2(v)}%`, higherIsBetter: false,
  })
  const current = metricOf(peers, 'current_ratio', me, { label: '流动比率', format: (v) => `${round2(v)}` })
  dims.push({
    key: 'health', label: '财务健康', weight: 0.15,
    score: weightedMean([[debt.score, 0.5], [current.score, 0.5]]),
    detail: describe(debt, current),
    metrics: strip(debt, current),
  })

  return dims
}

/** 把 metric 组装成前端契约（去掉内部字段） */
function strip(...metrics) {
  return metrics.filter(Boolean).map((m) => ({
    label: m.label,
    value: m.value,
    pct: m.pct === null || m.pct === undefined ? null : round2(m.pct),
  }))
}

/** 一句话摘要：挑分位最高/最低的那个指标说事，比罗列全部更有信息量 */
function describe(m1, m2, trend = null, suffix = '') {
  const parts = []
  if (m1 && m1.pct !== null) parts.push(`${m1.label} ${m1.value}（同业 ${m1.pct} 分位）`)
  if (m2 && m2.pct !== null) parts.push(`${m2.label} ${m2.value}（${m2.pct} 分位）`)
  if (trend !== null && trend !== 0) parts.push(trend > 0 ? '近三期方向向上' : '近三期方向向下')
  if (suffix) parts.push(suffix)
  return parts.join('；') || '同业样本不足，暂不计分'
}

/**
 * 风险标记（排雷）：这部分比评分更值得看
 * 取不到的数据一律标【待核实】，绝不默认"没问题"
 */
export function detectFlags({ me, name, periodRows = [] }) {
  const flags = []
  const nm = String(name || '')
  if (/^\*?ST/i.test(nm) || nm.includes('退')) {
    flags.push({ level: 'bad', label: 'ST / 退市风险', note: '股票简称带 ST 标记，退市与流动性风险显著高于同业' })
  }
  const eps = num(me && me.eps)
  if (eps !== null && eps <= 0) {
    flags.push({ level: 'bad', label: `报告期亏损（EPS ${round2(eps)}）`, note: '亏损股的 PE 分位不适用，估值维度已跳过' })
  }
  const ocf = num(me && me.ocfps)
  if (ocf !== null && ocf < 0) {
    flags.push({ level: 'bad', label: `经营现金流为负（每股 ${round2(ocf)} 元）`, note: '利润没有变成现金流入，需核对应收与存货' })
  }
  const debt = num(me && me.debt_to_assets)
  if (debt !== null && debt >= 70) {
    flags.push({ level: 'warn', label: `资产负债率 ${round2(debt)}%`, note: '高于 70%，偿债压力偏大' })
  }
  const current = num(me && me.current_ratio)
  if (current !== null && current < 1) {
    flags.push({ level: 'warn', label: `流动比率 ${round2(current)}`, note: '低于 1，短期偿债能力偏紧' })
  }
  const netYoy = num(me && me.netprofit_yoy)
  if (netYoy !== null && netYoy <= -50) {
    flags.push({ level: 'warn', label: `净利同比 ${round2(netYoy)}%`, note: '利润大幅下滑，需确认是否一次性因素' })
  }
  // 连续两期为负：单季为负可能只是季节性，连着亏才值得标
  if (periodRows.length >= 2) {
    const epsList = periodRows.map((r) => num(r && r.eps)).filter((v) => v !== null)
    if (epsList.length >= 2 && epsList[0] <= 0 && epsList[1] <= 0) {
      flags.push({ level: 'bad', label: '连续两个报告期亏损', note: '需要重点复核主业是否恶化' })
    }
  }
  flags.push({
    level: 'info',
    label: '商誉 / 大股东质押 / 审计意见',
    note: '【待核实】批量接口不含这三项，需用 balancesheet / pledge_stat / fina_audit 单独查；未核实不代表没有风险',
  })
  return flags
}

/**
 * 主入口：把原始行组装成前端契约
 * @param {object} input
 * @param {object} input.me 本股最新报告期行（已去重）
 * @param {object[]} input.peers 同行业全部行（含本股）
 * @param {object} input.meDb 本股最新交易日估值行
 * @param {object[]} input.peerDb 同行业估值行
 * @param {string} input.code / input.name / input.industry / input.peerCount
 * @param {string} input.period / input.periodLabel / input.announceDate / input.priceDate
 * @param {object[]} input.history 历史快照
 * @param {object[]} input.periodRows 本股近几期行（用于趋势与连续亏损判定）
 * @param {string} input.cachedAt
 */
export function buildFundamentals(input) {
  const {
    code, name, industry, peerCount = 0, period, periodLabel, announceDate, priceDate,
    me, peers = [], meDb, peerDb = [], history = [], periodRows = [], cachedAt = '',
  } = input
  const warnings = []
  if (peerCount < MIN_PEERS) warnings.push(`同业样本仅 ${peerCount} 只（少于 ${MIN_PEERS}），分位不可靠，相关维度不计分`)
  if (!me) warnings.push(`未取到 ${periodLabel || period} 的财务数据：可能尚未披露或接口权限不足`)

  const dims = computeDimensions({ me: me || {}, peers, meDb: meDb || {}, peerDb })
  const scored = dims.filter((d) => d.score !== null)
  const total = scored.length
    ? round2(scored.reduce((sum, d) => sum + d.score * d.weight, 0) / scored.reduce((sum, d) => sum + d.weight, 0))
    : null
  const { grade, label } = gradeOf(total)
  const flags = detectFlags({ me: me || {}, name, periodRows })
  // 滚动亏损（PE 为负）：detectFlags 看的是报告期 EPS，这里补上估值口径的亏损提示，
  // 避免「报告期微利但 TTM 亏损」这种组合被漏掉
  const mePe = meDb ? num(meDb.pe_ttm) : null
  if (mePe !== null && mePe <= 0) {
    flags.unshift({
      level: 'bad',
      label: 'PE_TTM 为负（滚动亏损）',
      note: '估值分位不适用于亏损股，已跳过估值维度；亏损本身不构成买卖建议，但需确认亏损原因',
    })
  }

  // 与上一期比较：变化比绝对值更有信息量
  const prev = history.find((h) => h && h.period !== period) || null
  const delta = prev && prev.total !== null && total !== null
    ? { periodLabel: prev.periodLabel || prev.period, total: prev.total, change: round2(total - prev.total) }
    : null

  return {
    ok: true,
    code, name, industry, peerCount,
    period, periodLabel, announceDate: announceDate || '', priceDate: priceDate || '',
    total, grade, gradeLabel: label,
    coverage: `${scored.length}/${dims.length} 维`,
    dims, flags, warnings,
    history: Array.isArray(history) ? history.slice(0, 8) : [],
    delta,
    caveat: CAVEAT,
    cachedAt,
  }
}
