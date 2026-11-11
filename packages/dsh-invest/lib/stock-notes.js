// 个股分析知识库（stock notes）
// 目标：把每份投研报告按「个股」切段，归集到 .dsh-invest/store/stocks/<代码>.md，
// 报告追问页按股票名排序、首字母索引导航。
//
// 归因三级（优先级从高到低）：
//   ① 显式标记：<!--stock:600011.SH|华能国际--> … <!--/stock-->（新报告由提示词强制输出）
//   ② 标题兜底：## 股票深度分析：华能国际（600011.SH） 这类含代码的小标题
//   ③ 提及兜底：按行收集提到该代码/名称的句子（历史报告未分段，标为「节选」）
// 纯字符串处理，不依赖 OCR：报告本身就是 Markdown 文本，直接按分隔符切分比图像识别可靠得多。
import fs from 'node:fs/promises'
import path from 'node:path'

const CODE_ANY = /(?<!\d)(\d{6})\s*[.．]?\s*(SH|SZ|BJ)(?![A-Z0-9])/i

/** 6 位代码 + 交易所后缀（缺后缀时按首位推断），返回 600011.SH 形式；非法返回空串 */
export function normalizeCode(raw) {
  const s = String(raw || '').toUpperCase()
  const m = s.match(/(\d{6})\s*[.．]?\s*(SH|SZ|BJ)?/)
  if (!m) return ''
  const suffix = m[2] || guessSuffix(m[1])
  return suffix ? m[1] + '.' + suffix : ''
}

export function guessSuffix(digits) {
  const d = String(digits || '')[0]
  if (d === '6' || d === '5' || d === '9') return 'SH'
  if (d === '0' || d === '1' || d === '2' || d === '3') return 'SZ'
  if (d === '4' || d === '8') return 'BJ'
  return ''
}

const START_RE = /^\s*<!--\s*stock\s*[:：]\s*(.+?)\s*-->\s*$/i
const END_RE = /^\s*<!--\s*\/\s*stock\s*-->\s*$/i

function parseStartLine(line) {
  const m = String(line || '').match(START_RE)
  if (!m) return null
  const payload = m[1].trim()
  const cm = payload.match(/^(\d{6})\s*[.．]?\s*(SH|SZ|BJ)?\s*(?:[|｜,，:：、\s]+)?([\s\S]*)$/i)
  if (!cm) return null
  const code = normalizeCode(cm[1] + (cm[2] || ''))
  if (!code) return null
  const name = String(cm[3] || '').replace(/^[-—–\s]+/, '').trim().slice(0, 24)
  return { code, name }
}

/** 显式标记切段：返回 [{code, name, heading, text}] */
export function parseMarkedSections(text) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  let open = null
  let buf = []
  for (const line of lines) {
    if (open && END_RE.test(line)) {
      const body = buf.join('\n').trim()
      if (body) out.push({ code: open.code, name: open.name, heading: open.heading, text: body })
      open = null
      buf = []
      continue
    }
    if (!open) {
      const start = parseStartLine(line)
      if (start) {
        open = { code: start.code, name: start.name, heading: start.name || start.code }
        buf = []
      }
      continue
    }
    buf.push(line)
  }
  // 未闭合的标记：容错收尾（模型偶尔漏写结束行），保留已收集内容
  if (open && buf.join('\n').trim()) {
    out.push({ code: open.code, name: open.name, heading: open.heading, text: buf.join('\n').trim() })
  }
  return out
}

const HEADING_RE = /^(#{2,4})\s+(.+?)\s*#*\s*$/

/** 标题兜底：找含代码的小标题（2-4 级），内容到下一个同级或更高级标题为止 */
export function parseHeadingSections(text) {
  const lines = String(text || '').split(/\r?\n/)
  const heads = []
  lines.forEach((line, index) => {
    const m = line.match(HEADING_RE)
    if (!m) return
    if (!CODE_ANY.test(m[2])) return
    const code = normalizeCode(m[2].match(CODE_ANY)[0])
    if (!code) return
    const title = m[2].replace(/^股票深度分析\s*[:：]\s*/, '').replace(/^个股\s*[:：]\s*/, '').trim()
    heads.push({ level: m[1].length, index, code, heading: title })
  })
  const out = []
  heads.forEach((head, i) => {
    let end = lines.length
    for (let j = i + 1; j < heads.length; j += 1) {
      if (heads[j].level <= head.level) { end = heads[j].index; break }
    }
    if (end === lines.length) {
      // 同级的普通 ## 标题也要截断（例如 ## 风险提示）
      for (let k = head.index + 1; k < lines.length; k += 1) {
        const m = lines[k].match(HEADING_RE)
        if (m && m[1].length <= head.level) { end = k; break }
      }
    }
    const body = lines.slice(head.index + 1, end).join('\n').trim()
    if (body.length >= 12) out.push({ code: head.code, name: '', heading: head.heading, text: body })
  })
  return out
}

const MENTION_SKIP = [
  /^#\s/, /^-?\s*模式[:：]/, /^-?\s*时间[:：]/, /^-?\s*问题[:：]/, /^-?\s*上下文[:：]/,
  /^-?\s*模型路由[:：]/, /^-?\s*路由提示[:：]/, /^-?\s*报告处理[:：]/, /^>\s*\*\*各分析师完整原文/,
  /^\|?\s*-{2,}/, /^\|?\s*标的\/事项/, /^来源[:：]/, /^>?\s*仅供参考，不构成投资建议/,
]

/** 提及兜底：按行收集提到该代码/名称的句子（过滤报告抬头噪声） */
export function mentionSnippet(text, code, name, limit = 2600) {
  const digits = String(code || '').replace(/[^0-9]/g, '')
  const lines = String(text || '').split(/\r?\n/)
  const picked = []
  let chars = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.length < 4) continue
    if (MENTION_SKIP.some((re) => re.test(line))) continue
    const hit = (digits && line.includes(digits)) || (name && name.length >= 2 && line.includes(name))
    if (!hit) continue
    if (picked.includes(line)) continue
    if (chars + line.length > limit) break
    picked.push(line)
    chars += line.length
  }
  return picked.join('\n')
}

/**
 * 把一份报告拆成「个股条目」。
 * @param {string} text 报告全文
 * @param {{codes?: string[], names?: Record<string,string>}} meta 索引里该报告涉及的代码与名称表
 * @returns {{entries: Array<{code,name,kind,heading,text}>, kind: string}}
 *   kind: marker | heading | report | mention | none
 */
export function splitReport(text, meta = {}) {
  const codes = Array.isArray(meta.codes)
    ? meta.codes.map(normalizeCode).filter(Boolean)
    : []
  const names = meta.names && typeof meta.names === 'object' ? meta.names : {}
  const nameOf = (code) => names[code] || ''

  const marked = parseMarkedSections(text)
  if (marked.length) {
    const entries = marked.map((s) => ({
      code: s.code, name: s.name || nameOf(s.code), kind: 'marker', heading: s.heading, text: s.text,
    }))
    const covered = new Set(entries.map((e) => e.code))
    // 标记外的其它提及（例如总判断表格里的第 4 只票）补节选，数量受限避免噪声
    codes.filter((code) => !covered.has(code)).slice(0, 6).forEach((code) => {
      const snippet = mentionSnippet(text, code, nameOf(code), 900)
      if (snippet.length >= 20) entries.push({ code, name: nameOf(code), kind: 'mention', heading: '节选', text: snippet })
    })
    return { entries, kind: 'marker' }
  }

  const headed = parseHeadingSections(text)
  if (headed.length) {
    const entries = headed.map((s) => ({
      code: s.code, name: s.name || nameOf(s.code), kind: 'heading', heading: s.heading || nameOf(s.code), text: s.text,
    }))
    const covered = new Set(entries.map((e) => e.code))
    codes.filter((code) => !covered.has(code)).slice(0, 6).forEach((code) => {
      const snippet = mentionSnippet(text, code, nameOf(code), 900)
      if (snippet.length >= 20) entries.push({ code, name: nameOf(code), kind: 'mention', heading: '节选', text: snippet })
    })
    return { entries, kind: 'heading' }
  }

  const body = String(text || '').trim()
  if (codes.length === 1) {
    return {
      entries: [{ code: codes[0], name: nameOf(codes[0]), kind: 'report', heading: '整份报告', text: body.slice(0, 8000) }],
      kind: 'report',
    }
  }
  const entries = []
  codes.slice(0, 12).forEach((code) => {
    const snippet = mentionSnippet(text, code, nameOf(code))
    if (snippet.length >= 20) entries.push({ code, name: nameOf(code), kind: 'mention', heading: '节选', text: snippet })
  })
  return { entries, kind: entries.length ? 'mention' : 'none' }
}

/** 从报告抬头读元信息：时间戳（文件名/抬头）、模式、问题 */
export function readReportMeta(fileName, text) {
  const s = String(text || '')
  const m = String(fileName || '').match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/)
  const ts = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : ''
  const mode = (s.match(/^-?\s*模式[:：]\s*(.+?)\s*$/m) || [])[1] || ''
  const question = ((s.match(/^-?\s*问题[:：]\s*(.+?)\s*$/m) || [])[1] || '').slice(0, 120)
  return { ts, mode: mode.slice(0, 20), question }
}

const KIND_LABEL = { marker: '分段原文', heading: '分段原文', report: '整份报告', mention: '节选' }

/** 是否为可交易证券代码（排除 801xxx/95xxxx 这类 Tushare 行业与风格指数：它们不是个股） */
export function isStockCode(code) {
  const m = String(code || '').toUpperCase().match(/^(\d{6})\.(SH|SZ|BJ)$/)
  if (!m) return false
  const digits = m[1]
  if (m[2] === 'SH') return /^[56]\d{5}$/.test(digits)
  if (m[2] === 'SZ') return /^(000|001|002|003|300|301|302)\d{3}$/.test(digits) || /^(15|16|18)\d{4}$/.test(digits)
  return /^(43|83|87|88|92)\d{4}$/.test(digits)
}

/** 单只个股的知识库 Markdown（人可读；每次重建覆盖，改它没用） */
export function stockFileMarkdown(code, name, entries, builtAt) {
  const head = [
    `# ${name || code}（${code}）· 个股分析知识库`,
    '',
    `- 最近更新：${builtAt}`,
    `- 收录：${entries.length} 段分析，来自 ${new Set(entries.map((e) => e.report)).size} 份报告`,
    '- 生成方式：自动从 `.dsh-invest/reports/*.md` 按「个股分段标记」归集；本文件每次重建会覆盖，手工改动不保留',
    '- 查看入口：工作台「报告追问」左侧按个股名/首字母索引；标记外的内容不归属任何个股',
    '',
  ]
  const body = entries.map((entry) => [
    `## ${entry.ts || '未知时间'} · ${entry.mode || '投研'} · ${KIND_LABEL[entry.kind] || entry.kind}`,
    '',
    `> 来源：\`${entry.report}\` ｜ 标题：${entry.heading || entry.report_title || '—'}`,
    '',
    entry.text,
    '',
    '---',
    '',
  ].join('\n'))
  return head.concat(body).join('\n')
}

/** 代码 → 稳定文件名（去掉路径非法字符） */
export function stockFileName(code) {
  return String(code || '').replace(/[^0-9A-Za-z.]/g, '_') + '.md'
}

const MANIFEST_VERSION = 2

/**
 * 构建/增量更新个股知识库。
 * @returns {{manifest, stocks, orphans, stats}}
 */
export async function buildStockNotes(opts = {}) {
  const reportsDir = opts.reportsDir
  const storeFile = opts.storeFile
  const stocksDir = opts.stocksDir
  const names = opts.names || {}
  const force = opts.force === true
  const started = Date.now()

  let manifest = { version: MANIFEST_VERSION, built_at: '', files: {}, hashes: {} }
  if (!force) {
    try {
      const prev = JSON.parse(await fs.readFile(storeFile, 'utf8'))
      if (prev && prev.version === MANIFEST_VERSION && prev.files) manifest = prev
    } catch (e) { /* 首次构建 */ }
  }

  let files = []
  try {
    files = (await fs.readdir(reportsDir, { withFileTypes: true }))
      .filter((d) => d.isFile() && /\.md$/i.test(d.name))
      .map((d) => d.name)
  } catch (e) { files = [] }

  const nextFiles = {}
  let parsedCount = 0
  let reused = 0
  for (const name of files.sort()) {
    const full = path.join(reportsDir, name)
    let stat
    try { stat = await fs.stat(full) } catch (e) { continue }
    const cached = manifest.files[name]
    if (!force && cached && cached.size === stat.size && cached.mtime === Math.round(stat.mtimeMs)) {
      nextFiles[name] = cached
      reused += 1
      continue
    }
    let text = ''
    try { text = await fs.readFile(full, 'utf8') } catch (e) { continue }
    if (!text.trim()) continue
    const meta = readReportMeta(name, text)
    const codes = Array.isArray(opts.codesByPath && opts.codesByPath[name]) ? opts.codesByPath[name] : []
    let split = splitReport(text, { codes, names })
    // 主报告是二次总结、模型没保留标记时，回退到 `_raw/<同名>.md`（各阶段完整原文）里找回分段标记
    if (split.kind === 'mention' || split.kind === 'none') {
      try {
        const rawText = await fs.readFile(path.join(reportsDir, '_raw', name), 'utf8')
        const marked = parseMarkedSections(rawText)
        const seen = new Set()
        const entries = []
        for (const section of marked) {
          const body = String(section.text || '').trim()
          if (!body) continue
          const key = section.code + '|' + body.length + '|' + body.slice(0, 80)
          if (seen.has(key)) continue
          seen.add(key)
          entries.push({
            code: section.code, name: section.name || names[section.code] || '',
            kind: 'marker', heading: section.heading || '分段', text: body.slice(0, 8000),
          })
        }
        if (entries.length) split = { entries, kind: 'marker' }
      } catch (e) { /* 没有详版原文时保持主报告的三级归因结果 */ }
    }
    nextFiles[name] = {
      size: stat.size,
      mtime: Math.round(stat.mtimeMs),
      path: (opts.pathsByFile && opts.pathsByFile[name]) || path.join(reportsDir, name).replace(/\\/g, '/'),
      ts: meta.ts,
      mode: meta.mode,
      question: meta.question,
      kind: split.kind,
      entries: split.entries.map((e) => ({
        code: e.code, name: e.name || names[e.code] || '', kind: e.kind, heading: e.heading,
        text: String(e.text || '').slice(0, 8000),
      })),
    }
    parsedCount += 1
  }

  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const builtAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const stocks = new Map()
  for (const [, file] of Object.entries(nextFiles)) {
    for (const entry of file.entries) {
      if (!isStockCode(entry.code)) continue
      const item = stocks.get(entry.code) || []
      item.push({
        id: file.path + '#' + item.length,
        ts: file.ts,
        mode: file.mode,
        question: file.question,
        kind: entry.kind,
        heading: entry.heading,
        text: entry.text,
        chars: entry.text.length,
        report: file.path || file,
        report_title: file.question || file.path,
      })
      stocks.set(entry.code, item)
    }
  }
  stocks.forEach((list) => list.sort((a, b) => String(b.ts).localeCompare(String(a.ts))))

  // 写单只个股知识库文件（内容哈希未变则跳过，避免 235 个文件反复重写）
  const hashes = {}
  try { await fs.mkdir(stocksDir, { recursive: true }) } catch (e) { /* ignore */ }
  for (const [code, list] of stocks) {
    const name = names[code] || (list[0] && list[0].name) || ''
    const md = stockFileMarkdown(code, name, list.slice(0, 80), builtAt)
    const hash = String(md.length) + ':' + hashCode(md)
    hashes[code] = hash
    if (!force && manifest.hashes && manifest.hashes[code] === hash) continue
    try { await fs.writeFile(path.join(stocksDir, stockFileName(code)), md, 'utf8') } catch (e) { /* 写失败不阻断 */ }
  }

  // 清理已不在清单里的旧知识库文件（例如早先把行业指数误当个股留下的 801053.BJ.md）；
  // 报告目录为空时跳过，避免 BASE_DIR 配错把整目录清空
  if (files.length && stocks.size) {
    const keep = new Set(Array.from(stocks.keys()).map(stockFileName))
    try {
      for (const name of await fs.readdir(stocksDir)) {
        if (!/\.md$/i.test(name) || keep.has(name)) continue
        try { await fs.unlink(path.join(stocksDir, name)) } catch (e) { /* 单个删除失败不阻断 */ }
      }
    } catch (e) { /* 目录不存在等 */ }
  }

  const next = { version: MANIFEST_VERSION, built_at: builtAt, files: nextFiles, hashes }
  try {
    await fs.mkdir(path.dirname(storeFile), { recursive: true })
    await fs.writeFile(storeFile, JSON.stringify(next), 'utf8')
  } catch (e) { /* 持久化失败不阻断本次返回 */ }

  const orphans = Object.entries(nextFiles).filter(([, f]) => !f.entries.some((e) => isStockCode(e.code))).map(([, f]) => f.path)
  return {
    manifest: next,
    stocks,
    orphans,
    stats: {
      reports: Object.keys(nextFiles).length,
      parsed: parsedCount,
      reused,
      stocks: stocks.size,
      entries: Array.from(stocks.values()).reduce((sum, list) => sum + list.length, 0),
      ms: Date.now() - started,
    },
  }
}

/** 轻量哈希（djb2 变体），仅用于「内容是否变化」判断 */
export function hashCode(text) {
  let h = 5381
  const s = String(text || '')
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
