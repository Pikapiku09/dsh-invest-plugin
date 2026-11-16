// 个股知识库「基本面 / 技术面」两段式（v0.58.0）
//
// 目标：一份知识库拆成两个顶层段，前端用页签分别展示，但**仍然只整理一次**（不是两次模型调用）。
// 这里盯三件事：
//   ① 提示词必须要求一次写出两段，并把子项骨架写死（提示词与常量不许漂移）；
//   ② 校验必须同时认到 `## 基本面` 与 `## 技术面`，缺一段就报错——调用方据此保留旧库，不落半成品；
//   ③ 清洗/解析不许吞段，`## 时间线` `## 待核实` 这类共用收尾段不许出现两遍。
// 前端解析（reader.ts 的 parseStockNote / isSplitStockNote）用 esbuild 打成 CJS 在 node 里直接调，
// web 依赖没装时整组跳过，不让纯后端环境因为这个可选的 UI 测试变红。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  CURATED_HEADINGS, CURATED_SUBHEADINGS, buildCuratePrompt, sanitizeCurated, validateCurated,
} from '../packages/dsh-invest/lib/stock-curator.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const webDir = path.join(root, 'web')
const require0 = createRequire(import.meta.url)

/** 新两段式整理稿（正文长度刻意超过 200 字，校验的长度门槛才不至于误判） */
const SPLIT_DOC = [
  '# 贵州茅台（600519.SH）· 个股知识库',
  '> 覆盖 2026-11-10 至 2026-11-11 ｜ 来源 2 份报告 ｜ 更新 2026-11-12',
  '',
  '## 基本面',
  '### 盈利质量',
  '毛利率 91.2%，ROE 32%，经营现金流覆盖净利润 1.1 倍。',
  '### 成长趋势',
  '营收同比 +11%，利润同比 +13%；材料仅一期，无法判断趋势拐点。',
  '### 财务健康',
  '资产负债率 18%，应收账款占比低，无有息负债压力。',
  '### 估值位置',
  'PE 28 倍，处于近五年 45% 分位，高于同业中位。',
  '### 风险点',
  '批价下行与渠道库存需持续跟踪；材料未涉及解禁安排。',
  '### 一句话定性',
  '**高质量现金牛**，但增速已回到个位数区间。',
  '',
  '## 技术面',
  '### 趋势结构',
  '周线均线多头，日线站上 60 日线，中期趋势向上。',
  '### 关键价位',
  '| 项目 | 数值 |',
  '|---|---|',
  '| 现价 | 1500 |',
  '| 支撑 | 1450 |',
  '| 止损 | 1420 |',
  '### 量能与资金',
  '成交量温和放大，主力净流入连续 3 日。',
  '### 指标背离',
  'MACD 顶背离尚未确认，需再看一周。',
  '### 止损纪律',
  '跌破 1420 减仓，跌破 1380 清仓观察。',
  '',
  '## 时间线',
  '- 11-11 · 个股 · 现价 1500，支撑 1450',
  '- 11-10 · 深度 · 止损 1420，目标 1620',
  '',
  '## 待核实',
  '批价数据接口受限，需人工核对最新飞天批价。',
].join('\n')

/** 存量旧稿：7 段混排结构，没有基本面/技术面。分页签必须对它是「无感」的 */
const LEGACY_DOC = [
  '# 贵州茅台（600519.SH）· 个股知识库',
  '> 覆盖 2026-11-08 至 2026-11-09 ｜ 来源 1 份报告 ｜ 更新 2026-11-10',
  '',
  '## 一句话结论',
  '**维持持有**，支撑 1450，止损 1420。',
  '',
  '## 核心逻辑',
  '- 现价 1500 位于支撑上方',
  '',
  '## 关键价位',
  '| 项目 | 数值 |',
  '|---|---|',
  '| 现价 | 1500 |',
  '',
  '## 持仓与纪律',
  '成本 1380，止损 1420。',
  '',
  '## 分歧与变化',
  '无实质变化',
  '',
  '## 时间线',
  '- 11-09 · 个股 · 维持持有',
  '',
  '## 待核实',
  '无',
].join('\n')

const ONLY_TECHNICAL_DOC = [
  '# 贵州茅台（600519.SH）· 个股知识库',
  '## 技术面',
  '### 趋势结构',
  '周线均线多头，价格站在 60 日线上方。'.repeat(6),
  '### 止损纪律',
  '跌破 1420 减仓。'.repeat(6),
].join('\n')

const ONLY_FUNDAMENTAL_DOC = ONLY_TECHNICAL_DOC.replace('## 技术面', '## 基本面').replace('### 趋势结构', '### 盈利质量')

function loadReader() {
  let esbuild
  try {
    const viteEntry = require0.resolve('vite', { paths: [webDir] })
    esbuild = createRequire(viteEntry)('esbuild')
  } catch { return null }
  const out = path.join(os.tmpdir(), `dsh-invest-stock-kb-${process.pid}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(webDir, 'src', 'reader.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent',
  })
  const mod = createRequire(import.meta.url)(out)
  try { fs.rmSync(out, { force: true }) } catch { /* 临时文件，删不掉不影响 */ }
  return mod
}

const readerMod = loadReader()
const skip = readerMod ? undefined : 'web 依赖未安装（esbuild 不可用），跳过前端解析测试'

// ===== 结构常量 =====

test('两段式结构：顶层段两段 + 共用收尾段，子项是三级标题', () => {
  assert.deepEqual(CURATED_HEADINGS, ['## 基本面', '## 技术面', '## 时间线', '## 待核实'], '顶层只留两段，时间线/待核实是共用收尾段')
  assert.deepEqual(CURATED_SUBHEADINGS.fundamental, [
    '### 盈利质量', '### 成长趋势', '### 财务健康', '### 估值位置', '### 风险点', '### 一句话定性',
  ])
  assert.deepEqual(CURATED_SUBHEADINGS.technical, [
    '### 趋势结构', '### 关键价位', '### 量能与资金', '### 指标背离', '### 止损纪律',
  ])
})

// ===== 提示词 =====

test('整理提示词：一次产出两段，且把子项骨架写死（与常量不漂移）', () => {
  const prompt = buildCuratePrompt({
    code: '600519.SH', name: '贵州茅台',
    oldKb: '# 旧知识库\n## 一句话结论\n维持持有',
    entries: [{ ts: '2026-11-11 10:00:00', mode: '个股', report: 'reports/a.md', text: '现价 1500，止损 1420。' }],
    reports: 3, now: '2026-11-12',
  })
  for (const heading of CURATED_HEADINGS) assert.ok(prompt.includes(heading), '必须出现顶层段：' + heading)
  for (const heading of [...CURATED_SUBHEADINGS.fundamental, ...CURATED_SUBHEADINGS.technical]) {
    assert.ok(prompt.includes(heading), '提示词必须给出子项：' + heading)
  }
  assert.match(prompt, /缺任一段整篇视为不合格/, '要明确「缺一段即不合格」')
  assert.match(prompt, /同一次输出里写完/, '要明确只能一次写完，不许分两次')
  assert.match(prompt, /不要在结尾问「要不要继续写技术面」/, '要堵住「先写一段再问」的偷懒路径')
  assert.match(prompt, /旧版单篇结构/, '旧结构要明说重排，否则模型会照抄旧标题')
  assert.match(prompt, /【既有知识库】/)
  assert.match(prompt, /现价 1500，止损 1420/, '既有知识库与新增材料要照旧带进提示词')
})

// ===== 校验：缺一段就拒绝（调用方据此保留旧库） =====

test('校验：两段齐 → 通过', () => {
  assert.equal(validateCurated(SPLIT_DOC), '', '规整的两段式文档必须通过')
})

test('校验：只有技术面 → 报缺基本面并说明会保留旧库', () => {
  const error = validateCurated(ONLY_TECHNICAL_DOC)
  assert.match(error, /缺少「基本面」/, '只有技术面必须报缺基本面：' + error)
  assert.match(error, /拒绝覆盖知识库/, '报错要说明不覆盖，调用方才知道该保留旧版')
})

test('校验：只有基本面 → 报缺技术面', () => {
  const error = validateCurated(ONLY_FUNDAMENTAL_DOC)
  assert.match(error, /缺少「技术面」/, '只有基本面必须报缺技术面：' + error)
})

test('校验：两段都没有（旧 7 段结构）→ 报缺两段；顺序颠倒 → 报结构错乱', () => {
  assert.match(validateCurated(LEGACY_DOC), /缺少「基本面」与「技术面」/, '旧结构不能当新结构放行')
  const swapped = SPLIT_DOC
    .replace('## 基本面', '@@TMP@@')
    .replace('## 技术面', '## 基本面')
    .replace('@@TMP@@', '## 技术面')
  assert.match(validateCurated(swapped), /结构错乱/, '技术面排到基本面之前要报错')
})

// ===== 清洗：不吞段、共用收尾段去重 =====

test('清洗：两段都保留，标题归一化，共用收尾段合并成一段', () => {
  const messy = [
    SPLIT_DOC.replace('## 基本面', '## 【基本面】').replace('## 技术面', '## 一、技术面（周线口径）'),
    '',
    '## 时间线',
    '- 11-11 · 个股 · 现价 1500，支撑 1450',
    '',
    '## 待核实',
    '重复出现的待核实。',
  ].join('\n')
  const clean = sanitizeCurated(messy, { code: '600519.SH', name: '贵州茅台' })

  assert.match(clean, /^## 基本面$/m, '【基本面】要归一化成 ## 基本面')
  assert.match(clean, /^## 技术面$/m, '「一、技术面（周线口径）」要归一化成 ## 技术面')
  assert.match(clean, /毛利率 91\.2%/, '基本面正文不许被吞')
  assert.match(clean, /周线均线多头/, '技术面正文不许被吞')
  assert.equal((clean.match(/^## 时间线$/gm) || []).length, 1, '时间线只能出现一段')
  assert.equal((clean.match(/^## 待核实$/gm) || []).length, 1, '待核实只能出现一段')
  // 重复的时间线条目合并后不再重复占两行列表（合并时会被打断成两个 <ul>）
  assert.equal((clean.match(/现价 1500，支撑 1450/g) || []).length, 1, '重复的时间线条目只留一条')
  assert.ok(!/\n\n\n/.test(clean), '段之间不应堆出连续空行')
  assert.equal(validateCurated(clean), '', '清洗后的结果必须能过校验：' + validateCurated(clean))
})

test('清洗：缺一级标题时补齐，且不吞任何一段', () => {
  const clean = sanitizeCurated(SPLIT_DOC.replace(/^# .*\n/, ''), { code: '600519.SH', name: '贵州茅台' })
  assert.match(clean, /^# 贵州茅台（600519\.SH）· 个股知识库/)
  assert.match(clean, /^## 基本面$/m)
  assert.match(clean, /^## 技术面$/m)
})

test('清洗：超长只在段边界截断，宁可少一段也不吐半段', () => {
  const long = [
    '# 贵州茅台（600519.SH）· 个股知识库',
    '',
    '## 基本面',
    '甲'.repeat(11000),
    '',
    '## 技术面',
    '乙'.repeat(3000),
    '',
    '## 时间线',
    '- 11-11 · 个股 · 现价 1500',
  ].join('\n')
  const cut = sanitizeCurated(long, { code: '600519.SH', name: '贵州茅台' })
  assert.ok(cut.length <= 12000, '清洗后不得超过长度上限：' + cut.length)
  assert.ok(cut.endsWith('（输出超长，已按段末截断）'), '截断必须显式标注，别让用户以为是完整稿')
  assert.ok(!/(^|\n)##?\s*$/.test(cut), '不许在标题中间或空标题处截断')
  // 半段是不合格的：校验拒绝 → 调用方保留旧知识库，而不是落一份缺段的稿子
  assert.match(validateCurated(cut), /缺少「技术面」/, '被截掉的段必须让校验失败，从而保住旧库')
})

// ===== 前端解析：页签切分是渐进增强 =====

test('前端解析：按二级标题切成三页签，默认停在基本面，内容不重不漏', { skip }, () => {
  const view = readerMod.parseStockNote(SPLIT_DOC)
  assert.deepEqual(view.tabs.map((tab) => tab.key), ['fundamental', 'technical', 'timeline'], '页签顺序固定')
  assert.deepEqual(view.tabs.map((tab) => tab.label), ['基本面', '技术面', '时间线'])
  assert.match(view.scope, /覆盖 2026-11-10 至 2026-11-11/, '抬头那行覆盖区间要单独提出来，不带进任何页签')

  const fundamental = view.tabs[0].markdown
  const technical = view.tabs[1].markdown
  const timeline = view.tabs[2].markdown
  assert.match(fundamental, /毛利率 91\.2%/, '基本面内容进基本面页签')
  assert.match(fundamental, /高质量现金牛/, '一句话定性属于基本面')
  assert.doesNotMatch(fundamental, /周线均线多头/, '技术内容不能漏进基本面')
  assert.match(technical, /周线均线多头/, '技术面内容进技术面页签')
  assert.match(technical, /跌破 1420 减仓/, '止损纪律属于技术面')
  assert.doesNotMatch(technical, /毛利率 91\.2%/, '基本面内容不能漏进技术面')

  // 每一条正文都必须在且只在一个页签里出现（不丢段）
  for (const line of ['毛利率 91.2%', 'PE 28 倍', '周线均线多头', '跌破 1420 减仓', '11-11 · 个股']) {
    const hits = view.tabs.filter((tab) => tab.markdown.includes(line)).length
    assert.equal(hits, 1, `「${line}」应恰好出现在一个页签里，实际 ${hits} 个`)
  }
})

test('前端解析：「待核实」并入时间线且只出现一次，不单独占页签', { skip }, () => {
  const view = readerMod.parseStockNote(SPLIT_DOC)
  const timeline = view.tabs[2].markdown
  assert.match(timeline, /11-10 · 深度 · 止损 1420/, '时间线条目进时间线页签')
  assert.match(timeline, /批价数据接口受限/, '待核实内容要跟着进来，不能丢')
  assert.equal((timeline.match(/待核实/g) || []).length, 1, '待核实不许出现两遍')
  assert.deepEqual(view.tabs.map((tab) => tab.key), ['fundamental', 'technical', 'timeline'], '不为待核实单开页签')
})

test('前端判定：只有两段同时存在才走页签，旧稿与半截稿照旧原样渲染', { skip }, () => {
  assert.equal(readerMod.isSplitStockNote(SPLIT_DOC), true, '两段齐 → 页签视图')
  assert.equal(readerMod.isSplitStockNote(LEGACY_DOC), false, '存量旧 7 段结构 → 保持原样渲染（渐进增强，不能白屏）')
  assert.equal(readerMod.isSplitStockNote(ONLY_TECHNICAL_DOC), false, '只有一段 → 不出半个页签')
  assert.equal(readerMod.isSplitStockNote(ONLY_FUNDAMENTAL_DOC), false, '只有基本面 → 同样回退整篇渲染')
})

test('前端解析：旧稿不因解析而丢内容（回退渲染依赖原文，解析结果也必须保住全文）', { skip }, () => {
  const view = readerMod.parseStockNote(LEGACY_DOC)
  const joined = view.tabs.map((tab) => tab.markdown).join('\n')
  for (const line of ['维持持有', '现价 1500 位于支撑上方', '成本 1380，止损 1420', '11-09 · 个股']) {
    assert.ok(joined.includes(line), '旧稿内容不许被解析丢掉：' + line)
  }
  assert.equal((joined.match(/无实质变化/g) || []).length, 1, '旧稿的「分歧与变化」也归进时间线，且只出现一次')
})
