// 标的档案「基本面评级」卡片（v0.58.0）
//
// 这张卡的定位是「排雷 + 看懂公司质地」，不是买卖信号。两条硬规则在这里被钉死：
// 1. caveat（实证免责：基本面不区分盈亏）必须常驻可见，不许折叠、不许省；
// 2. 维度 score === null 是「数据不足」，绝不能被渲染成 0 分（那会凭空制造一个差评）。
//
// 与 holdings-view.test.js 同一套路：esbuild 把 TS 打成 CJS 在 node 里直接调 renderFundamentalsCard。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const webDir = path.join(root, 'web')

const require0 = createRequire(import.meta.url)

const CAVEAT = '122 波实证：ROE／净利同比／营收同比／毛利率／PB 分位均不区分盈亏（|δ|≤0.19、FDR≥0.51），'
  + '「基本面差」不构成回避理由。本评级用于排雷与理解质地，不构成买卖信号。'

function metric(label, value, pct = null, hint) {
  const out = { label, value, pct }
  if (hint) out.hint = hint
  return out
}

function dim(key, label, score, weight, detail, metrics = []) {
  return { key, label, score, weight, detail, metrics }
}

function makeFundamentals(over = {}) {
  return {
    ok: true,
    code: '600519.SH',
    name: '贵州茅台',
    industry: '白酒',
    peerCount: 34,
    period: '20250630',
    periodLabel: '2025 半年报',
    announceDate: '20250820',
    priceDate: '20251114',
    total: 76.4,
    grade: 'B',
    gradeLabel: '良好',
    coverage: '4/5 维',
    dims: [
      dim('growth', '成长性', 88, 0.25, '净利同比 12.3%（同业 82 分位）',
        [metric('净利同比', '12.3%', 82), metric('营收同比', '9.8%', 76)]),
      dim('valuation', '估值', 62, 0.25, 'PE_TTM 21.4（同业 55 分位）',
        [metric('PE_TTM', '21.4', 55), metric('PB', '7.2', 41)]),
      dim('profitability', '盈利能力', 81, 0.2, '年化ROE 31.2%（同业 90 分位）',
        [metric('年化ROE', '31.2%', 90)]),
      dim('quality', '盈利质量', null, 0.15, '同业样本不足，暂不计分', []),
      dim('health', '财务健康', 54, 0.15, '资产负债率 18.2%（同业 71 分位）',
        [metric('资产负债率', '18.2%', 71)]),
    ],
    flags: [
      { level: 'bad', label: '经营现金流为负（每股 -0.82 元）', note: '利润没有变成现金流入，需核对应收与存货' },
      { level: 'warn', label: '净利同比 -56.2%', note: '利润大幅下滑，需确认是否一次性因素' },
      { level: 'info', label: '商誉 / 大股东质押 / 审计意见', note: '【待核实】批量接口不含这三项' },
    ],
    warnings: ['同业样本仅 12 只（少于 20），分位不可靠，相关维度不计分'],
    history: [],
    delta: { periodLabel: '2025Q1', total: 72.1, change: 4.3 },
    caveat: CAVEAT,
    cachedAt: '2026-11-16 13:40',
    ...over,
  }
}

function makeState(over = {}) {
  return {
    selectedCode: '600519.SH',
    fundamentals: makeFundamentals(),
    fundamentalsLoading: false,
    fundamentalsError: '',
    ...over,
  }
}

function loadModule() {
  let esbuild
  try {
    const viteEntry = require0.resolve('vite', { paths: [webDir] })
    esbuild = createRequire(viteEntry)('esbuild')
  } catch { return null }
  const out = path.join(os.tmpdir(), `dsh-invest-fundamentals-${process.pid}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(webDir, 'src', 'fundamentals.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent',
  })
  const mod = createRequire(import.meta.url)(out)
  try { fs.rmSync(out, { force: true }) } catch { /* 临时文件，删不掉不影响 */ }
  return mod
}

const mod = loadModule()
const renderFundamentalsCard = mod ? mod.renderFundamentalsCard : null
const skip = renderFundamentalsCard ? undefined : 'web 依赖未安装（esbuild 不可用），跳过前端渲染测试'

const render = (state) => renderFundamentalsCard(state)

/** 截出一维的 HTML 片段（从该行的 data-dim 到下一维），避免整卡正则误伤 */
function dimRow(html, key) {
  const at = html.indexOf(`data-dim="${key}"`)
  assert.ok(at > -1, `应渲染维度 ${key}：${html.slice(0, 240)}`)
  const next = html.indexOf('data-dim="', at + 10)
  return html.slice(at, next > -1 ? next : at + 900)
}

test('基本面卡片：等级徽章 + 五维标签 + 分数 + 同业/报告期/缓存时间', { skip }, () => {
  const html = render(makeState())
  assert.ok(html.includes('fund-grade fund-grade-good'), 'B 级应为绿色语义：' + html.slice(0, 400))
  assert.ok(html.includes('data-grade="B"'))
  assert.ok(html.includes('良好'))
  assert.ok(html.includes('综合 76.4 分'), '要显示加权总分')
  for (const label of ['成长性', '估值', '盈利能力', '盈利质量', '财务健康']) {
    assert.ok(html.includes(label), `五个维度标签都要在：${label}`)
  }
  const growth = dimRow(html, 'growth')
  assert.ok(growth.includes('88 分'), '维度要显示分数')
  assert.ok(growth.includes('width:88%'), '进度条宽度＝分数')
  assert.ok(html.includes('同业 34 只'), '要写明同业样本数')
  assert.ok(html.includes('4/5 维有数据'), '要标明几个维度有数据')
  assert.ok(html.includes('2025 半年报'), '要显示报告期')
  assert.ok(html.includes('2025-08-20'), '公告日要转成可读日期')
  assert.ok(html.includes('11-16 13:40'), '要显示快照缓存时间')
  assert.ok(html.includes('data-action="fundamentals-refresh"'), '要有刷新入口')
})

test('基本面卡片：score=null 显示「数据不足」，绝不显示 0 分、不画进度条', { skip }, () => {
  const html = render(makeState())
  const quality = dimRow(html, 'quality')
  assert.ok(quality.includes('数据不足'), '缺数据维度要给明确文字')
  assert.ok(quality.includes('fund-bar is-empty'), '缺数据维度用灰条空槽')
  assert.ok(!/\b0\s*分/.test(quality), 'null 不能被渲染成 0 分：' + quality)
  assert.ok(!quality.includes('width:'), '数据不足不画任何进度（否则会被读成 0%）')
  // 反例校准：真正的 0 分仍然要显示 0，不要被当作缺失
  const zero = render(makeState({
    fundamentals: makeFundamentals({
      dims: [dim('growth', '成长性', 0, 0.25, '同业 0 分位')],
    }),
  }))
  assert.ok(dimRow(zero, 'growth').includes('0 分'), '真实 0 分要如实显示')
})

test('基本面卡片：风险标记按 bad/warn/info 分级，bad 用红色类名', { skip }, () => {
  const html = render(makeState())
  assert.ok(html.includes('fund-flag fund-flag-bad'), 'bad 级要有红色类名')
  assert.ok(html.includes('fund-flag fund-flag-warn'))
  assert.ok(html.includes('fund-flag fund-flag-info'))
  const at = html.indexOf('fund-flag fund-flag-bad')
  const bad = html.slice(at, at + 400)
  assert.ok(bad.includes('经营现金流为负'), 'bad 标记要带 label')
  assert.ok(bad.includes('需核对应收与存货'), 'bad 标记要带说明')
  assert.ok(html.includes('【待核实】'), 'info 级的「待核实」原文不能被吃掉')
})

test('基本面卡片：无风险标记时显示「未发现明显风险」', { skip }, () => {
  const html = render(makeState({ fundamentals: makeFundamentals({ flags: [] }) }))
  assert.ok(html.includes('未发现明显风险'))
  assert.ok(!html.includes('fund-flag fund-flag-bad'))
})

test('基本面卡片：caveat 原文常驻展示，且不可折叠', { skip }, () => {
  const html = render(makeState())
  assert.ok(html.includes(CAVEAT), 'caveat 必须逐字出现在输出里')
  assert.ok(html.includes('fund-caveat'), 'caveat 要有独立样式位')
  assert.ok(!html.includes('<details'), 'caveat 不许放进可折叠容器')
  assert.ok(!html.includes('fund-caveat" hidden'), 'caveat 不许默认隐藏（图标自带 aria-hidden 不算）')
})

test('基本面卡片：有 delta 时显示较上期升降与箭头', { skip }, () => {
  const up = render(makeState())
  assert.ok(up.includes('较上期'))
  assert.match(up, /↑ 4\.3 分/, '上升要带 ↑ 与具体分值')
  const down = render(makeState({
    fundamentals: makeFundamentals({ delta: { periodLabel: '2025Q1', total: 80.1, change: -3.7 } }),
  }))
  assert.match(down, /↓ 3\.7 分/, '下降要带 ↓')
  const none = render(makeState({ fundamentals: makeFundamentals({ delta: null }) }))
  assert.ok(!none.includes('较上期'), '没有上期就不显示升降，更不能画成 0')
})

test('基本面卡片：加载中 → 骨架 + 可重试，且不禁用刷新', { skip }, () => {
  const html = render(makeState({ fundamentals: null, fundamentalsLoading: true }))
  assert.ok(html.includes('fund-card'))
  assert.ok(html.includes('fund-skeleton'), '加载态要有骨架')
  assert.ok(html.includes('立即重试'), '加载卡住时要留一条出路')
  assert.ok(html.includes('data-action="fundamentals-refresh"'))
  assert.ok(html.includes('fund-caveat'), '加载态也要常驻免责')
})

test('基本面卡片：出错 → 一行错误 + 重试按钮，不抛错', { skip }, () => {
  const html = render(makeState({ fundamentals: null, fundamentalsError: '请求超时（120 秒未响应）' }))
  assert.ok(html.includes('请求超时'))
  assert.ok(html.includes('fund-error'))
  assert.ok(html.includes('重试'))
  assert.ok(html.includes('fund-caveat'), '错误态也要常驻免责')
})

test('基本面卡片：无数据 → 空态 + 手动加载入口', { skip }, () => {
  const html = render(makeState({ fundamentals: null }))
  assert.ok(html.includes('暂无基本面评级'))
  assert.ok(html.includes('加载基本面评级'))
  assert.ok(html.includes('fund-caveat'), '空态也要常驻免责')
})

test('基本面卡片：等级配色 A/B 绿、C 中性、D/E 红', { skip }, () => {
  for (const [grade, tone] of [['A', 'good'], ['B', 'good'], ['C', 'neutral'], ['D', 'bad'], ['E', 'bad']]) {
    const html = render(makeState({ fundamentals: makeFundamentals({ grade, gradeLabel: grade }) }))
    assert.ok(html.includes(`fund-grade fund-grade-${tone}`), `${grade} 级配色应为 ${tone}`)
  }
})

test('基本面卡片：total=null 显示「综合分 —」，不折算成 0', { skip }, () => {
  const html = render(makeState({
    fundamentals: makeFundamentals({ total: null, grade: '—', gradeLabel: '数据不足', delta: null }),
  }))
  assert.ok(html.includes('fund-grade fund-grade-unknown'))
  assert.ok(html.includes('综合分 —'))
  assert.ok(!html.includes('综合 0'))
})

test('基本面卡片：切到别的标的后不得显示上一只的评级（防串码）', { skip }, () => {
  const html = render(makeState({ selectedCode: '000001.SZ' }))
  assert.ok(!html.includes('贵州茅台'), '旧标的名称不得残留')
  assert.ok(!html.includes('data-dim="growth"'), '旧标的维度不得残留')
  assert.ok(html.includes('暂无基本面评级'), '应回到空态等待新标的数据')
})

test('基本面卡片：刷新中保留已有数据，按钮显示「刷新中…」且可点击重试', { skip }, () => {
  const html = render(makeState({ fundamentalsLoading: true }))
  assert.ok(html.includes('data-dim="growth"'), '已加载过的卡片刷新时不清空')
  assert.ok(html.includes('刷新中…'))
  assert.ok(!/\bdisabled\b/.test(html), '刷新中不得禁用，否则请求卡住就无路可走')
})

test('基本面卡片：缺字段的旧 state 也能渲染，不抛错', { skip }, () => {
  const html = render({ selectedCode: '600519.SH' })
  assert.ok(html.includes('暂无基本面评级'))
})
