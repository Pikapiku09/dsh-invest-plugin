#!/usr/bin/env node
// 磁盘卫生清理（v0.44.0）
//
// 背景：实测 .dsh-invest/scratch 3427 个文件 160MB 从未清理、cache 里 1179 个 30 天前的
// 过期文件 44MB 没被后台清理清掉、根目录 94 个临时脚本 3.9MB。前者会一直涨。
//
// 安全设计（删文件不可逆，所以做了三层保护）：
//   1) 默认 dry-run：只报告，不动手；加 --apply 才执行。
//   2) 执行时是**移入** .dsh-invest/trash/<时间戳>/<原相对路径>，不是删除——随时可以手动取回。
//   3) .dsh-invest/trash 自身超过 30 天才会被清掉（同样 --apply）。
//
// 用法:
//   node tools/cleanup.js              # 预演（默认）
//   node tools/cleanup.js --apply      # 真正执行
//   node tools/cleanup.js --apply --keep-days=60
'use strict'
const fs = require('fs')
const path = require('path')

// 工作区根目录：与插件其他部分保持同一口径（默认 E:/Dsh_WorkSapce/Dify_Agents，可用环境变量覆盖）。
// 注意不能用 path.resolve(__dirname,'..')：本文件在插件仓库 tools/ 下，那个路径指向仓库而不是工作区。
const DEFAULT_BASE = 'E:/Dsh_WorkSapce/Dify_Agents'
const BASE = process.env.DSH_INVEST_BASE_DIR || DEFAULT_BASE
const ROOT = path.join(BASE, '.dsh-invest')
const TRASH = path.join(ROOT, 'trash')
const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const keepArg = args.find((a) => a.startsWith('--keep-days='))
const KEEP_DAYS = keepArg ? Math.max(1, Number(keepArg.split('=')[1]) || 30) : 30
const TMP_KEEP_DAYS = 7
const DAY = 86400000

const stamp = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
})()

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB'
const olderThan = (file, days) => {
  try { return fs.statSync(file).mtimeMs < Date.now() - days * DAY } catch (e) { return false }
}

function walk(dir, out) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return out }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (full === TRASH) continue
      walk(full, out)
    } else if (ent.isFile()) {
      try { out.push({ path: full, size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs }) } catch (e) { /* skip */ }
    }
  }
  return out
}

const buckets = []
const addBucket = (name, reason, files, keepDays) => {
  const hit = files.filter((f) => Date.now() - f.mtime > keepDays * DAY)
  buckets.push({ name, reason, keepDays, count: hit.length, size: hit.reduce((a, f) => a + f.size, 0), files: hit })
}

// 1) cache：30 天未访问（reindex 与取数缓存过期即无用）
addBucket('cache', '取数/索引缓存，超过 ' + KEEP_DAYS + ' 天未更新', walk(path.join(ROOT, 'cache'), []), KEEP_DAYS)

// 2) scratch：30 天未更新（子代理调试残留，含历史 asar/acceptance 目录）
addBucket('scratch', '调试工作区残留，超过 ' + KEEP_DAYS + ' 天未更新', walk(path.join(ROOT, 'scratch'), []), KEEP_DAYS)

// 3) .dsh-invest 根目录的临时脚本/备份：7 天未更新（这类文件只服务一次性的排查）
const rootTmp = []
try {
  for (const ent of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!ent.isFile()) continue
    if (!/^(tmp|_|scan|chart|hs_test|deep_raw|analysis_|runs\.jsonl\.bak)/i.test(ent.name)) continue
    const full = path.join(ROOT, ent.name)
    try { rootTmp.push({ path: full, size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs }) } catch (e) { /* skip */ }
  }
} catch (e) { /* 目录不存在 */ }
addBucket('.dsh-invest 根目录临时文件', '一次性排查脚本/备份，' + TMP_KEEP_DAYS + ' 天未更新', rootTmp, TMP_KEEP_DAYS)

// 4) runs.jsonl.bak-*：只保留最近 1 个（自愈改写前的备份，留最新即可）
const runBaks = []
try {
  for (const ent of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!ent.isFile() || !/^runs\.jsonl\.bak-\d+$/.test(ent.name)) continue
    const full = path.join(ROOT, ent.name)
    try { runBaks.push({ path: full, size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs }) } catch (e) { /* skip */ }
  }
} catch (e) { /* ignore */ }
if (runBaks.length > 1) {
  runBaks.sort((a, b) => b.mtime - a.mtime)
  const drop = runBaks.slice(1)
  buckets.push({ name: 'runs.jsonl 旧备份', reason: '只保留最近 1 个备份', keepDays: 0, count: drop.length, size: drop.reduce((a, f) => a + f.size, 0), files: drop })
}

// 5) trash 自身：30 天前移入的，真正清掉
addBucket('trash', '回收站内超过 ' + KEEP_DAYS + ' 天的内容（各条 --apply 已执行过）', walk(TRASH, []), KEEP_DAYS)

const totalCount = buckets.reduce((a, b) => a + b.count, 0)
const totalSize = buckets.reduce((a, b) => a + b.size, 0)

console.log('清理范围：' + ROOT)
console.log('模式：' + (APPLY ? '执行（移入 trash，可回滚）' : '预演（不动文件，加 --apply 执行）'))
console.log('')
for (const b of buckets) {
  console.log(`  ${b.count > 0 ? '●' : '○'} ${b.name.padEnd(24, ' ')} ${String(b.count).padStart(5)} 个  ${mb(b.size).padStart(10)}   ${b.reason}`)
}
console.log('')
console.log(`合计可清理：${totalCount} 个文件，${mb(totalSize)}`)

if (!APPLY) {
  console.log('\n以上为预演结果。确认无误后执行：node tools/cleanup.js --apply')
  process.exit(0)
}
if (!totalCount) {
  console.log('\n没有需要清理的内容。')
  process.exit(0)
}

const target = path.join(TRASH, stamp)
let moved = 0
let failed = 0
for (const b of buckets) {
  for (const f of b.files) {
    // trash 桶内的是「真删」语义：已经在回收站里放够 30 天
    const isTrash = b.name === 'trash'
    const rel = path.relative(ROOT, f.path)
    const dest = isTrash ? '' : path.join(target, rel)
    try {
      if (isTrash) {
        fs.rmSync(f.path, { force: true })
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.renameSync(f.path, dest)
      }
      moved += 1
    } catch (e) {
      failed += 1
    }
  }
}
// 顺带清掉 trash 里留下的空目录
try {
  for (const ent of fs.readdirSync(TRASH, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const sub = path.join(TRASH, ent.name)
    try {
      const rest = fs.readdirSync(sub)
      if (!rest.length) fs.rmdirSync(sub)
    } catch (e) { /* ignore */ }
  }
} catch (e) { /* ignore */ }

console.log(`\n完成：已处理 ${moved} 个文件，失败 ${failed} 个。`)
if (moved) console.log('被移入：' + target + '\n需要恢复时按原相对路径挪回 .dsh-invest/ 即可。')
