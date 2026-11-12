// 个股知识库的「二次整理」：把散落的报告节选合并成一篇可读的知识库文档。
// 输入 = 既有知识库 + 新增分析材料；输出 = 整篇新的 Markdown（由 LLM 完成，默认 deepseek-v4.1-flash@low）。
// 这里只放纯函数（提示词、清洗、兜底文档），调用与落盘在 lib/index.js 的 curateStock 里。
// 设计约束：① 只允许用材料里的事实，禁止补行情；② 数字原样保留；③ 冲突并排标注日期；④ 结构固定，便于追问时定位。

export const CURATED_HEADINGS = ['## 一句话结论', '## 核心逻辑', '## 关键价位', '## 持仓与纪律', '## 分歧与变化', '## 时间线', '## 待核实']

/** 摘要：单段材料最多喂给整理模型多少字（超长报告只取前段，避免把一次运行塞满上下文） */
const ENTRY_LIMIT = 2600
const MAX_ENTRIES = 12
const MAX_OLD_KB = 9000

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
    '',
    '【硬性规则】',
    '1. 只使用输入材料中出现的事实、数字与结论；禁止补充你自己的行情判断，禁止编造数字、事件或日期。',
    '2. 价格/百分比/仓位/评分原样保留，不得四舍五入或改写；同一指标出现冲突时两个值都保留，并标注各自日期。',
    '3. 重复信息合并成一条，保留最完整、最新的表述；不同角色（深度/总判断/消息）的结论互相矛盾时并列呈现，不擅自取舍。',
    '4. 不做投资推荐，用「建议／可考虑／需确认」措辞；不写免责声明，不写「作为 AI」「本报告」这类自述。',
    '5. 全文控制在 1800 字以内（表格计入）；宁可少写，不可堆砌。',
    '6. 不要调用任何工具，不要联网取数，直接输出 Markdown 正文。',
    '',
    '【输出结构（严格按此顺序，标题文字照抄）】',
    '# ' + label + '（' + code + '）· 个股知识库',
    '> 覆盖 ' + from + ' 至 ' + to + ' ｜ 来源 ' + (reports || list.length) + ' 份报告 ｜ 更新 ' + now,
    '',
    '## 一句话结论',
    '（一句，加粗关键判断，含最新立场与关键价位）',
    '',
    '## 核心逻辑',
    '（3-5 条，每条一行，标注可验证依据；多空论点并列）',
    '',
    '## 关键价位',
    '（表格：现价／支撑／压力／止损／目标／仓位建议；材料没写的写「—」）',
    '',
    '## 持仓与纪律',
    '（材料涉及持仓才写：成本、股数、止损、减仓线；没有写「未涉及」）',
    '',
    '## 分歧与变化',
    '（相对既有知识库新增或改变了的判断，标注日期；无变化写「无实质变化」）',
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

/** 清洗模型输出：去掉代码围栏、保证一级标题、截断超长内容 */
export function sanitizeCurated(text, { code, name }) {
  let out = String(text || '').trim()
  out = out.replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '').trim()
  if (!out) return ''
  if (!/^#\s/.test(out)) out = '# ' + (name || code) + '（' + code + '）· 个股知识库\n\n' + out
  if (out.length > 12000) out = out.slice(0, 12000)
  return out
}

/** 校验整理结果：结构是否齐全、长度是否合理（失败就保留旧文档，不覆盖） */
export function validateCurated(text) {
  const out = String(text || '').trim()
  if (out.length < 200) return '输出过短（' + out.length + ' 字），拒绝覆盖知识库'
  if (out.length > 12000) return '输出过长（' + out.length + ' 字）'
  if (!/^#\s/m.test(out)) return '输出缺少一级标题'
  const hasConclusion = /^##\s*一句话结论/m.test(out)
  if (!hasConclusion) return '输出缺少「一句话结论」段落'
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
