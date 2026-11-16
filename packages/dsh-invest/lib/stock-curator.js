// 个股知识库的「二次整理」：把散落的报告节选合并成一篇可读的知识库文档。
// 输入 = 既有知识库 + 新增分析材料；输出 = 整篇新的 Markdown（由 LLM 完成，默认 deepseek-v4.1-flash@low）。
// 这里只放纯函数（提示词、清洗、兜底文档），调用与落盘在 lib/index.js 的 curateStock 里。
// 设计约束：① 只允许用材料里的事实，禁止补行情；② 数字原样保留；③ 冲突并排标注日期；④ 结构固定，便于追问时定位。

/**
 * 知识库的顶层结构（v0.58.0 两段式）
 *
 * 原来是一份混排文档 7 个章节，基本面与技术面混在一起；前端一次只能从头读到尾。
 * 现在拆成两个平级顶层段，前端用页签分别展示：`## 基本面` / `## 技术面`，
 * `## 时间线` / `## 待核实` 是两段共用的收尾段（时间线页签一起展示）。
 * 注意：这仍是**一次整理**产出的整篇文档，不允许拆成两次模型调用（成本与同步性都不允许）。
 * 顺带对齐前端 web/src/reader.ts 的 parseStockNote —— 那边按同一组标题切页签。
 */
export const CURATED_HEADINGS = ['## 基本面', '## 技术面', '## 时间线', '## 待核实']

/** 两个顶层段各自的固定子项（三级标题），顺序即输出顺序，便于追问时定位 */
export const CURATED_SUBHEADINGS = {
  fundamental: ['### 盈利质量', '### 成长趋势', '### 财务健康', '### 估值位置', '### 风险点', '### 一句话定性'],
  technical: ['### 趋势结构', '### 关键价位', '### 量能与资金', '### 指标背离', '### 止损纪律'],
}

/** 摘要：单段材料最多喂给整理模型多少字（超长报告只取前段，避免把一次运行塞满上下文） */
const ENTRY_LIMIT = 2600
const MAX_ENTRIES = 12
const MAX_OLD_KB = 9000
/** 整理稿长度上限：两段式比原来的单篇多出子项标题，字数上限相应放宽，但仍要求「宁可少写」 */
const MAX_CURATED = 12000

export function entryDigest(entry) {
  const text = String((entry && entry.text) || '').trim()
  return text.length > ENTRY_LIMIT ? text.slice(0, ENTRY_LIMIT) + '\n…（原文过长，已截断）' : text
}

function compactDate(ts) {
  const m = String(ts || '').match(/^\d{4}-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : (String(ts || '') || '未知时间')
}

function dayOnly(ts) {
  const m = String(ts || '').match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : ''
}

/** 每个固定子项后面的写作提示（缺这段说明时统一落到「材料未涉及」） */
const SUBHEADING_HINTS = {
  '### 盈利质量': '毛利率／净利率／ROE 及其变化方向',
  '### 成长趋势': '营收／利润增速、订单与产能变化',
  '### 财务健康': '负债率／经营现金流／应收账款等风险信号',
  '### 估值位置': 'PE／PB／历史分位／同业对比，材料没写的写「—」',
  '### 风险点': '基本面侧风险：业绩、政策、治理、商誉、解禁等',
  '### 一句话定性': '一句，加粗关键判断，只讲基本面侧的定性',
  '### 趋势结构': '均线排列、趋势阶段、量价配合',
  '### 关键价位': '表格：现价／支撑／压力／止损／目标／仓位建议，材料没写的写「—」',
  '### 量能与资金': '成交量变化、主力与北向资金动向',
  '### 指标背离': 'MACD／KDJ／RSI 等背离与钝化',
  '### 止损纪律': '止损位、减仓线、失效条件；材料涉及持仓才写成本与股数',
}

/** 把一段顶层标题 + 它的固定子项渲染成提示词里的骨架（顺序与 CURATED_SUBHEADINGS 一致） */
function sectionSkeleton(heading, subheadings) {
  return [heading].concat(subheadings.flatMap((item) => [
    item,
    '（' + (SUBHEADING_HINTS[item] || '材料没写的写「材料未涉及」') + '；没有就写「材料未涉及」，不要留空标题）',
  ])).join('\n')
}

/**
 * 整理提示词。
 * @param {{code:string,name:string,oldKb:string,entries:Array,reports:number,modelLabel:string,now?:string}} input
 */
export function buildCuratePrompt(input) {
  const { code, name, oldKb, entries, reports } = input
  const list = Array.isArray(entries) ? entries.slice(0, MAX_ENTRIES) : []
  const dates = list.map((entry) => dayOnly(entry.ts)).filter(Boolean).sort()
  const from = dates[0] || '—'
  const to = dates[dates.length - 1] || '—'
  const now = input.now || new Date().toISOString().slice(0, 10)
  const label = name || code

  const material = list.map((entry) => [
    '### ' + compactDate(entry.ts) + ' · ' + (entry.mode || '投研') + ' · 来源：' + String(entry.report || '').split('/').pop(),
    entryDigest(entry),
  ].join('\n')).join('\n\n')

  return [
    '你是「个股知识库」的整理编辑：把新增分析材料并入既有知识库，输出整篇新的知识库 Markdown。',
    '这份知识库固定拆成「基本面」与「技术面」两个顶层段，前端用页签分别展示，所以两段必须在同一次输出里写完。',
    '',
    '【硬性规则】',
    '1. 只使用输入材料中出现的事实、数字与结论；禁止补充你自己的行情判断，禁止编造数字、事件或日期。',
    '2. 价格/百分比/仓位/评分原样保留，不得四舍五入或改写；同一指标出现冲突时两个值都保留，并标注各自日期。',
    '3. 重复信息合并成一条，保留最完整、最新的表述；不同角色（深度/总判断/消息）的结论互相矛盾时并列呈现，不擅自取舍。',
    '4. 不做投资推荐，用「建议／可考虑／需确认」措辞；不写免责声明，不写「作为 AI」「本报告」这类自述。',
    '5. 【两段必须齐】`## 基本面` 与 `## 技术面` 都必须出现且各有正文：缺任一段整篇视为不合格，会被整份退回重写（没有第二次调用，也没人替你补写另一段）。不要只写一段就收尾，不要在结尾问「要不要继续写技术面」。',
    '6. 材料没有覆盖的子项，标题照写、正文写「材料未涉及」，不要留空标题，也不要用行业常识补齐。',
    '7. 【旧结构重排】「既有知识库」可能是旧版单篇结构（一句话结论／核心逻辑／关键价位／持仓与纪律／分歧与变化），一律按下面的新结构重排，不要沿用旧标题。',
    '8. 全文控制在 2400 字以内（表格计入）；宁可少写，不可堆砌。',
    '9. 不要调用任何工具，不要联网取数，直接输出 Markdown 正文。',
    '',
    '【输出结构（严格按此顺序，标题文字照抄；`##` 是两个顶层段，`###` 是固定子项）】',
    '# ' + label + '（' + code + '）· 个股知识库',
    '> 覆盖 ' + from + ' 至 ' + to + ' ｜ 来源 ' + (reports || list.length) + ' 份报告 ｜ 更新 ' + now,
    '',
    sectionSkeleton(CURATED_HEADINGS[0], CURATED_SUBHEADINGS.fundamental),
    '',
    sectionSkeleton(CURATED_HEADINGS[1], CURATED_SUBHEADINGS.technical),
    '',
    '## 时间线',
    '（倒序，每行：MM-DD · 任务类型 · 一句话结论，不超过 40 字）',
    '',
    '## 待核实',
    '（材料中标注待核实／接口受限／数据缺失的项与核实途径；无则写「无」）',
    '',
    '【既有知识库】',
    String(oldKb || '').trim()
      ? String(oldKb).slice(0, MAX_OLD_KB)
      : '（首次整理，没有既有知识库）',
    '',
    '【新增材料（按时间倒序）】',
    material || '（本轮没有新材料，请只做结构梳理与去重）',
    '',
    '直接输出 Markdown 正文，不要任何前言、说明或代码块包裹。',
  ].join('\n')
}

/** 顶层段标题归一化：模型常写成「## 【基本面】」「## 一、基本面」「## 基本面（估值与盈利）」 */
function canonicalSection(title) {
  const clean = String(title || '')
    .replace(/[【】\[\]（）()「」《》\s]/g, '')
    .replace(/^[0-9一二三四五六七八九十]+[、.．：:)）]/, '')
  for (const name of ['基本面', '技术面', '时间线', '待核实']) {
    if (clean.startsWith(name)) return name
  }
  return ''
}

/** 共用收尾段：整篇只该出现一次，重复出现的合并进第一段 */
const SHARED_TAIL = ['时间线', '待核实']

/**
 * 清洗模型输出。
 *
 * 关键是不吞段：两段式文档必须原样保住 `## 基本面` 与 `## 技术面`，
 * 所以这里按二级标题切段、逐段重组，而不是整篇正则替换或从中间截一刀。
 * - 去代码围栏 / 思考块；标题归一化（`## 【基本面】` → `## 基本面`）
 * - `## 时间线` / `## 待核实` 重复出现时合并成一段（前端页签里不该出现两遍）
 * - 超长时在**段边界**截断并明确标注，不把某一段拦腰砍掉
 */
export function sanitizeCurated(text, { code, name }) {
  const cleaned = String(text || '')
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  if (!cleaned) return ''

  const preamble = []
  const sections = []
  for (const line of cleaned.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (!heading) {
      if (sections.length) sections[sections.length - 1].body.push(line)
      else preamble.push(line)
      continue
    }
    const title = heading[1].trim()
    sections.push({ canonical: canonicalSection(title), title: title, body: [] })
  }

  // 共用收尾段去重：同名只留第一段，后续段落的内容合并进来（同文重复行不再追加一遍）
  const merged = []
  const tailAt = new Map()
  for (const section of sections) {
    const shared = SHARED_TAIL.includes(section.canonical)
    if (shared && tailAt.has(section.canonical)) {
      const target = merged[tailAt.get(section.canonical)]
      // 合并时先削掉尾部的空行，否则列表会被空行打断成两个 <ul>
      while (target.body.length && !target.body[target.body.length - 1].trim()) target.body.pop()
      const known = new Set(target.body.map((line) => line.trim()).filter(Boolean))
      let started = false
      for (const line of section.body) {
        if (!line.trim()) { if (started) target.body.push(line); continue }
        started = true
        if (!known.has(line.trim())) { known.add(line.trim()); target.body.push(line) }
      }
      while (target.body.length && !target.body[target.body.length - 1].trim()) target.body.pop()
      continue
    }
    if (shared) tailAt.set(section.canonical, merged.length)
    merged.push(section)
  }

  const pieces = [preamble.join('\n').trim()]
  if (!/^#\s+\S/m.test(pieces[0])) pieces[0] = '# ' + (name || code) + '（' + code + '）· 个股知识库\n\n' + pieces[0]
  for (const section of merged) {
    const title = section.canonical || section.title
    const body = section.body.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    pieces.push(body ? '## ' + title + '\n\n' + body : '## ' + title)
  }

  let out = pieces.filter((piece) => piece.trim()).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  if (out.length > MAX_CURATED) {
    // 只在段边界切：宁可少一段，也不留下半段（半段会被 validate 判为缺段，旧库会保留）
    const cut = out.slice(0, MAX_CURATED - 40)
    const boundary = cut.lastIndexOf('\n## ')
    const kept = (boundary > 0 ? cut.slice(0, boundary) : cut).replace(/\s+$/, '')
    out = kept + '\n\n（输出超长，已按段末截断）'
  }
  return out
}

/**
 * 校验整理结果：结构是否齐全、长度是否合理（失败就保留旧文档，不覆盖）。
 *
 * v0.58.0 起必须同时有 `## 基本面` 与 `## 技术面`：两段式是前端页签的前提，
 * 只吐一半的整理稿宁可整份退回（调用方 lib/index.js 会保留旧版知识库），也不落盘半成品。
 */
export function validateCurated(text) {
  const out = String(text || '').trim()
  if (out.length < 200) return '输出过短（' + out.length + ' 字），拒绝覆盖知识库'
  if (out.length > MAX_CURATED) return '输出过长（' + out.length + ' 字）'
  if (!/^#\s/m.test(out)) return '输出缺少一级标题'
  const fundamentalAt = out.search(/^##\s*基本面\s*$/m)
  const technicalAt = out.search(/^##\s*技术面\s*$/m)
  if (fundamentalAt < 0 && technicalAt < 0) return '输出缺少「基本面」与「技术面」两个顶层段落，拒绝覆盖知识库'
  if (fundamentalAt < 0) return '输出缺少「基本面」段落（只有技术面），拒绝覆盖知识库'
  if (technicalAt < 0) return '输出缺少「技术面」段落（只有基本面），拒绝覆盖知识库'
  if (technicalAt < fundamentalAt) return '输出结构错乱：「技术面」不应排在「基本面」之前'
  return ''
}

/** 兜底文档：整理不可用时，至少给一份按时间倒序的节选视图（明确标注「未整理」） */
export function rawTimelineMarkdown({ code, name, entries, updatedAt }) {
  const list = Array.isArray(entries) ? entries : []
  const label = name || code
  const lines = [
    '# ' + label + '（' + code + '）· 个股知识库',
    '> 尚未二次整理 ｜ 共 ' + list.length + ' 段分析 ｜ 更新 ' + (updatedAt || new Date().toISOString().slice(0, 10)),
    '',
    '## 时间线',
  ]
  list.slice(0, 20).forEach((entry) => {
    const first = String(entry.text || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/[#>*`|]+/g, ' ').replace(/\s+/g, ' ').trim()
    lines.push('- ' + compactDate(entry.ts) + ' · ' + (entry.mode || '投研') + ' · ' + (first.slice(0, 46) || '（无摘要）'))
  })
  if (!list.length) lines.push('- （暂无分析记录）')
  lines.push('', '## 最新一段原文', '')
  if (list[0]) {
    lines.push('**' + compactDate(list[0].ts) + ' · ' + (list[0].mode || '投研') + '**', '', entryDigest(list[0]))
  } else {
    lines.push('（暂无）')
  }
  return lines.join('\n')
}
