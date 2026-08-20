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

// 由角色简码数组构建分组：①选股∥②消息 并行 → ③深度 → ④总判断（缺失角色跳过）
// roleMap 形如 { '选股': {name, persona}, '消息': {...}, '深度': {...}, '总判断': {...} }
function buildGroups(roleCodes, roleMap) {
  const has = (c) => roleCodes.includes(c)
  const groups = []
  const a = []
  if (has('选股')) a.push(roleMap['选股'])
  if (has('消息')) a.push(roleMap['消息'])
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

if (typeof module !== 'undefined' && module.exports) module.exports = { z2, localYmd, extractBoth, collectCharts, buildGroups, isLoopbackRequest, fmt, isSepRow, splitBlocks }
