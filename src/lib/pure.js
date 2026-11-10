// dsh-invest 纯函数集合（无副作用、无外部依赖，可独立单测）
// 双形态共享：dist 由 tools/build.js 内联；packages/lib/pure.js 由 build.js 转换为 ESM 后 import
// 修改后重新执行 `node tools/build.js` 同步到 dist 与 packages/lib

const z2 = (n) => (n < 10 ? '0' : '') + n

const localYmd = () => {
  const d = new Date()
  return '' + d.getFullYear() + z2(d.getMonth() + 1) + z2(d.getDate())
}

// 从子代理 result 提取纯文本与推理过程（容错：非 JSON / 解析失败时原样当作 text）
function extractBoth(raw) {
  let s = raw
  if (typeof raw !== 'string') s = JSON.stringify(raw)
  try {
    const obj = JSON.parse(s)
    if (obj && Array.isArray(obj.output)) {
      const texts = obj.output.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text)
      const reasons = obj.output.filter((b) => b && b.type === 'reasoning' && b.text).map((b) => b.text)
      if (texts.length) return { text: texts.join('\n'), reasoning: reasons.join('\n') }
    }
  } catch (e) { /* ignore */ }
  return { text: s, reasoning: '' }
}

// 从文本中收集完整绝对路径的 SVG 图表（E:/.../xxx.svg，去重、统一正斜杠）
function collectCharts(t) {
  const re = /E:[\\/][^\s"'<>]+?\.svg/gi
  const set = new Set()
  const m = String(t).match(re)
  if (m) m.forEach((x) => set.add(x.replace(/\\/g, '/')))
  return Array.from(set)
}

// 由角色简码数组构建分组：①选股∥消息∥波段 并行 → ②深度 → ③总判断（缺失角色跳过）
// roleMap 形如 { '选股': {name, persona}, '消息': {...}, '深度': {...}, '总判断': {...}, '波段': {...} }
// 显式 sequence 时：每个角色各成一段、严格按该顺序串行；sequence 中不属于本次 roles 的忽略，
// 未被 sequence 覆盖的角色按默认优先级补在末尾（不丢弃）。
function buildGroups(roleCodes, roleMap, sequence) {
  const has = (c) => roleCodes.includes(c)
  const valid = (c) => typeof c === 'string' && has(c) && roleMap[c]
  const seq = Array.isArray(sequence)
    ? sequence.filter((c, i) => valid(c) && sequence.indexOf(c) === i)
    : []
  if (seq.length) {
    const groups = seq.map((c) => [roleMap[c]])
    ;['选股', '消息', '波段', '深度', '总判断'].forEach((c) => {
      if (valid(c) && !seq.includes(c)) groups.push([roleMap[c]])
    })
    return groups
  }
  const groups = []
  // 早盘异动：消息 → 选股 串行接力；其余模式仍沿用选股∥消息∥波段并行
  if (roleCodes.length === 2 && has('消息') && has('选股')) return [[roleMap['消息']], [roleMap['选股']]]
  const a = []
  if (has('选股')) a.push(roleMap['选股'])
  if (has('消息')) a.push(roleMap['消息'])
  if (has('波段')) a.push(roleMap['波段'])
  if (a.length) groups.push(a)
  if (has('深度')) groups.push([roleMap['深度']])
  if (has('总判断')) groups.push([roleMap['总判断']])
  return groups
}

// 仅允许 loopback + 同源浏览器访问（常规插件路由安全围栏）
function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// 耗时格式化（毫秒 → 秒字符串，空值返回空串）
const fmt = (ms) => (ms === undefined || ms === null || ms === '') ? '' : (ms / 1000).toFixed(1) + 's'

// Markdown 表格分隔行判断（| --- | :---: | 等）
const isSepRow = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))

// 把 Markdown 文本拆成 text/table 块（| 开头的连续行视为表格，分隔行丢弃）
function splitBlocks(text) {
  const lines = String(text).split('\n')
  const blocks = []
  let curText = []
  let curTable = []
  const flushText = () => { if (curText.length) { blocks.push({ kind: 'text', text: curText.join('\n') }); curText = [] } }
  const flushTable = () => { if (curTable.length) { blocks.push({ kind: 'table', rows: curTable }); curTable = [] } }
  for (const line of lines) {
    const t = line.trim()
    if (t.length > 2 && t.charAt(0) === '|' && t.charAt(t.length - 1) === '|') {
      const cells = t.slice(1, -1).split('|').map((c) => c.trim())
      if (isSepRow(cells)) continue
      flushText()
      curTable.push(cells)
    } else {
      flushTable()
      curText.push(line)
    }
  }
  flushText()
  flushTable()
  return blocks
}

// 从文本提取 A 股代码（排除时间戳、hex、8 位日期；转债/基金不入索引）
function extractInvestCodes(text) {
  const re = /(?<![\dA-Za-z_])(?:sh|sz|bj)?(\d{6})(?:\.(SH|SZ|BJ))?(?![\dA-Za-z_])/gi
  const out = []
  const seen = new Set()
  let m
  while ((m = re.exec(String(text || '')))) {
    const digits = m[1]
    let suffix = m[2] ? m[2].toUpperCase() : ''
    if (!suffix) {
      if (/^[69]/.test(digits)) suffix = 'SH'
      else if (/^[023]/.test(digits)) suffix = 'SZ'
      else if (/^[48]/.test(digits)) suffix = 'BJ'
      else continue
    }
    const code = digits + '.' + suffix
    if (!seen.has(code)) { seen.add(code); out.push(code) }
  }
  return out
}

// 解析角色报告末尾的【结论结构化】{"code":...} 行；坏行跳过，不影响主流程
function parseConclusionBlocks(text) {
  const out = []
  const s = String(text || '')
  const marker = '【结论结构化】'
  let i = 0
  while ((i = s.indexOf(marker, i)) >= 0) {
    let j = i + marker.length
    while (j < s.length) {
      const cc = s.charCodeAt(j)
      if (cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 42 || cc === 96) j++
      else break
    }
    if (s.charAt(j) !== '{') { i += marker.length; continue }
    let depth = 0, inStr = false, esc = false, end = -1
    for (let k = j; k < s.length; k++) {
      const c = s.charAt(k)
      if (esc) { esc = false; continue }
      if (c.charCodeAt(0) === 92) { esc = true; continue }
      if (inStr) { if (c === '"') { inStr = false } continue }
      if (c === '"') { inStr = true; continue }
      if (c === '{') { depth++ } else if (c === '}') { depth--; if (depth === 0) { end = k; break } }
    }
    if (end > 0) {
      try {
        const obj = JSON.parse(s.slice(j, end + 1))
        if (obj && typeof obj.code === 'string' && obj.code) out.push(obj)
      } catch (e) { /* 坏 JSON 忽略 */ }
    }
    i += marker.length
  }
  return out
}


// 东财交割单 CSV 解析（成交流水）：取每只股票最新「股份余额」，成本按买入加权均价估算
function parseEastmoneyCsv(text) {
  const rows = []
  let row = [], cell = '', quoted = false
  const s = String(text || '').replace(/^\uFEFF/, '')
  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s[i] : '\n'
    if (c === '"') {
      if (quoted && s[i + 1] === '"') { cell += '"'; i++ } else quoted = !quoted
    } else if (c === ',' && !quoted) { row.push(cell); cell = '' }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some((x) => x.trim())) rows.push(row)
      row = []
    } else cell += c
  }
  const clean = (v) => String(v == null ? '' : v).trim().replace(/^=\s*/, '').replace(/"/g, '').trim()
  const num = (v) => { const n = Number(clean(v)); return Number.isFinite(n) ? n : null }
  const codeOf = (v, market) => {
    const d = clean(v).replace(/\D/g, '')
    if (!/^\d{6}$/.test(d)) return ''
    const m = clean(market)
    if (m.includes('沪')) return d + '.SH'
    if (m.includes('深')) return d + '.SZ'
    if (m.includes('北')) return d + '.BJ'
    if (/^[69]/.test(d)) return d + '.SH'
    if (/^[023]/.test(d)) return d + '.SZ'
    if (/^159/.test(d)) return d + '.SZ'
    if (/^[458]/.test(d)) return d + '.SH'
    return ''
  }
  if (!rows.length) return { positions: [], account: {}, warnings: ['CSV 无有效数据'] }
  const header = rows[0].map(clean)
  const col = (names, fallback) => {
    const i = header.findIndex((h) => names.includes(h))
    return i >= 0 ? i : fallback
  }
  const idx = {
    date: col(['发生日期', '交收日期', '成交日期'], 0), time: col(['发生时间', '成交时间'], 2),
    code: col(['证券代码'], 3), name: col(['证券名称'], 4), type: col(['交易类别', '摘要', '业务名称'], 5),
    qty: col(['成交数量'], 6), price: col(['成交均价'], 7),
    balance: col(['股份余额', '股票余额'], 14), cash: col(['资金余额'], 15),
    market: col(['交易市场', '市场'], 19),
  }
  const trades = []
  for (const r of rows.slice(1)) {
    const code = codeOf(r[idx.code], r[idx.market])
    if (!code) continue
    const date = clean(r[idx.date])
    const time = clean(r[idx.time])
    trades.push({
      code, name: clean(r[idx.name]), type: clean(r[idx.type]),
      qty: num(r[idx.qty]) || 0, price: num(r[idx.price]) || 0,
      balance: num(r[idx.balance]), cash: num(r[idx.cash]),
      date, time, sortKey: date.replace(/\D/g, '') + time.replace(/\D/g, ''),
    })
  }
  const groups = new Map()
  for (const t of trades) {
    if (!groups.has(t.code)) groups.set(t.code, [])
    groups.get(t.code).push(t)
  }
  const positions = []
  let cash = null
  let latestSort = ''
  let latestName = ''
  for (const t of trades) if (t.cash !== null && t.sortKey >= latestSort) { latestSort = t.sortKey; cash = t.cash; latestName = t.type }
  for (const [code, list] of groups) {
    list.sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    let qty = 0, cost = 0
    for (const t of list) {
      if (t.type.includes('买入')) {
        const next = qty + t.qty
        cost = next > 0 ? (qty * cost + t.qty * t.price) / next : 0
        qty = next
      } else if (t.type.includes('卖出')) {
        qty = Math.max(0, qty - t.qty)
        if (qty === 0) cost = 0
      }
    }
    const latest = list[list.length - 1]
    const shares = latest.balance !== null ? latest.balance : qty
    if (shares > 0) positions.push({
      code, name: latest.name, pool: '实盘', source: 'eastmoney-csv',
      shares, weight_pct: null, cost: cost > 0 ? Math.round(cost * 1000) / 1000 : latest.price,
      status: '持有', stop: null, target: null, note: '',
    })
  }
  const dates = trades.map((t) => t.date).filter(Boolean).sort()
  const warnings = ['成本价为交割单买入加权均价估算；若导出区间不含完整历史，请在确认页人工修正。']
  if (latestName) warnings.push('现金取最后一笔「' + latestName + '」后的资金余额。')
  return {
    positions,
    account: cash === null ? {} : { cash },
    warnings,
    meta: { trades: trades.length, firstDate: dates[0] || '', lastDate: dates[dates.length - 1] || '' },
  }
}

// 工作台静态服务路径校验：必须位于指定根目录内，且拒绝 .. 目录穿越
function isSafeServePath(p, root) {
  const s = String(p || '')
  return s.length > 0 && !s.includes('..') && s.startsWith(String(root || ''))
}

if (typeof module !== 'undefined' && module.exports) module.exports = { z2, localYmd, extractBoth, collectCharts, buildGroups, isLoopbackRequest, fmt, isSepRow, splitBlocks, isSafeServePath, extractInvestCodes, parseConclusionBlocks, parseEastmoneyCsv }
