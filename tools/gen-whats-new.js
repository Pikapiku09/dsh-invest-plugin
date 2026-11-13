// 从仓库根的 CHANGELOG.md 生成 packages/dsh-invest/lib/whats-new.json
//
// 为什么生成而不是手写：更新说明的唯一事实来源必须是 CHANGELOG.md。
// 手抄一份到前端，迟早和 CHANGELOG 漂移；而 npm/github 安装只打包 packages/dsh-invest
// 目录下的文件（package.json 的 files 字段），仓库根的 CHANGELOG.md 不会随包分发，
// 所以必须在发布前把最近几个版本摘出来，落到 lib/ 里随包走。
//
// 输出结构：
//   { "latest": "0.50.0", "releases": [ { version, date, title, items: [...] }, ... ] }
// items 只取正文里以 "- " 开头的要点，去掉 Markdown 粗体标记，保留可读文本。
// 用法：node tools/gen-whats-new.js [--keep N]（默认保留最近 6 个版本）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const CHANGELOG = path.join(root, 'CHANGELOG.md')
const OUT = path.join(root, 'packages', 'dsh-invest', 'lib', 'whats-new.json')

const keepArg = process.argv.indexOf('--keep')
const KEEP = keepArg > -1 ? Math.max(1, parseInt(process.argv[keepArg + 1], 10) || 6) : 6
const MAX_ITEMS = 8
/** 单条要点的展示上限：到句号/分号处收口，实在没有才硬截 */
const MAX_LEN = 220

function clip(t) {
  if (t.length <= MAX_LEN) return t
  const cut = t.slice(0, MAX_LEN)
  for (const mark of ['。', '；', '！', '？']) {
    const p = cut.lastIndexOf(mark)
    if (p > MAX_LEN * 0.5) return cut.slice(0, p + 1) + '…'
  }
  return cut.slice(0, MAX_LEN - 1).replace(/[，,、]$/, '') + '…'
}

const text = fs.readFileSync(CHANGELOG, 'utf8')

// 按 "## vX.Y.Z（日期）" 切段
const sections = []
const re = /^##\s+v?([0-9]+\.[0-9]+\.[0-9]+)\s*[（(]([^）)]*)[）)]\s*$/gm
let m
const heads = []
while ((m = re.exec(text)) !== null) heads.push({ version: m[1], date: m[2], start: m.index, end: m.index + m[0].length })
for (let i = 0; i < heads.length; i++) {
  const body = text.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].start : text.length)
  sections.push({ version: heads[i].version, date: heads[i].date, body })
}

/** 清洗一段 Markdown 行内标记，保留可读文本 */
function clean(s) {
  return String(s)
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** CJK 与全角标点：中文折行是排版换行，不是词间空格 */
const CJK = /[\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u3001\u3002\u3008-\u3011\u3014-\u301f\uff01-\uff60\uffe0-\uffe6\u4e00-\u9fff]/

/**
 * 把一段 CHANGELOG 正文压成可展示的要点（正确处理多行折行与缩进子项）
 *
 * 折行拼接规则：两侧都是中文/全角标点时直接相连，否则补一个空格。
 * 中文 Markdown 折行纯粹是源码排版，若一律补空格会得到「内容时 随手一点」这种断词。
 */
function toItems(body) {
  const items = []
  let cur = null
  const join = (prev, next) => {
    if (!prev) return next
    const a = prev.slice(-1)
    // 行首的 Markdown 标记（**加粗**、`代码`）不参与判断，否则中文会被误加空格
    const b = next.replace(/^[*_`]+/, '').slice(0, 1)
    return CJK.test(a) && CJK.test(b) ? prev + next : prev + ' ' + next
  }
  const flush = () => {
    if (cur !== null) {
      const t = clean(cur)
      if (t.length >= 4) items.push(clip(t))
    }
    cur = null
  }
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    // 缩进子项：单独计，不与父要点合并
    if (/^\s{2,}-\s+/.test(line)) { flush(); continue }
    // 顶级要点
    if (/^\s*-\s+/.test(line)) { flush(); cur = line.replace(/^\s*-\s+/, ''); continue }
    if (cur === null) continue
    const t = line.trim()
    if (!t) { flush(); continue }
    // 标题/表格/引用/代码块：视为要点结束
    if (t.startsWith('#') || t.startsWith('|') || t.startsWith('>') || t.startsWith('```')) { flush(); continue }
    cur = join(cur, t)
  }
  flush()
  return items.slice(0, MAX_ITEMS)
}

const releases = sections.slice(0, KEEP).map((s) => {
  const items = toItems(s.body)
  // 标题取正文第一行粗体「**...**」作为一句话主题
  const firstLine = s.body.split(/\r?\n/).map((x) => x.trim()).find((x) => x.startsWith('**')) || ''
  const title = firstLine.replace(/\*\*/g, '').trim()
  return { version: s.version, date: s.date, title, items }
}).filter((r) => r.items.length > 0)

if (!releases.length) {
  console.error('gen-whats-new: CHANGELOG.md 里没解析出任何版本段落，拒绝写出空文件')
  process.exit(1)
}

const payload = { latest: releases[0].version, generatedAt: new Date().toISOString(), releases }
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n')
console.log(`whats-new ok → ${path.relative(root, OUT)}（${releases.length} 个版本，最新 v${payload.latest}）`)
