// 版本一致性守卫（v0.42.0）
//
// 背景：v0.41.0 交付时代码已经跑到 0.41.0，但 README 顶部仍写 v0.25.1、
// 根 package.json 还是 0.23.0、package-lock.json 还是 0.7.1、使用指南还停在 v0.14.3。
// 用户打开 GitHub 看到的是几个月前的版本，且 origin 落后 5 个提交未推送。
//
// 此测试把「版本号只有一个事实来源」变成硬约束：
// 事实来源 = packages/dsh-invest/package.json（被 profile 实际挂载的那个包）。
// 任何一处漏改，node --test 直接失败，而不是等到用户发现。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const readJson = (p) => JSON.parse(read(p))

const pkg = readJson(path.join('packages', 'dsh-invest', 'package.json'))
const rootPkg = readJson('package.json')
const lock = readJson('package-lock.json')

test('事实来源版本号格式合法', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'packages/dsh-invest/package.json 的 version 不合法')
})

test('根 package.json 版本与插件包一致', () => {
  assert.equal(rootPkg.version, pkg.version,
    '根 package.json 版本落后：应同步为 ' + pkg.version + '（两个包都是本插件的发布形态）')
})

test('package-lock.json 两处版本与插件包一致', () => {
  assert.equal(lock.version, pkg.version, 'package-lock.json 顶层 version 落后')
  assert.ok(lock.packages && lock.packages[''], 'package-lock.json 缺少 root packages 条目')
  assert.equal(lock.packages[''].version, pkg.version, 'package-lock.json root 条目 version 落后')
})

test('README 顶部「当前版本」与插件包一致', () => {
  const m = read('README.md').match(/当前版本[:：]\s*\*{0,2}v?([0-9]+\.[0-9]+\.[0-9]+)\*{0,2}/)
  assert.ok(m, 'README 顶部必须包含「当前版本：vX.Y.Z」')
  assert.equal(m[1], pkg.version, 'README 顶部版本落后：应改为 v' + pkg.version)
})

test('README「版本与变更」段落与插件包一致', () => {
  const m = read('README.md').match(/见 \[CHANGELOG\.md\][^\n]*?当前 \*\*v?([0-9]+\.[0-9]+\.[0-9]+)\*\*/)
  assert.ok(m, 'README「版本与变更」段落必须写「当前 **vX.Y.Z**」')
  assert.equal(m[1], pkg.version, 'README 版本段落的版本落后：应改为 v' + pkg.version)
  assert.ok(/维护约定/.test(read('README.md')), 'README 应保留「维护约定」提示，说明版本同步义务')
})

test('CHANGELOG 最新条目与插件包版本一致', () => {
  const m = read('CHANGELOG.md').match(/^## v([0-9]+\.[0-9]+\.[0-9]+)/m)
  assert.ok(m, 'CHANGELOG.md 必须以「## vX.Y.Z」开头第一个版本条目')
  assert.equal(m[1], pkg.version, 'CHANGELOG 缺少当前版本 v' + pkg.version + ' 的条目')
})

test('docs 不再硬编码「当前版本」数字或表尾标记', () => {
  const docsDir = path.join(root, 'docs')
  if (!fs.existsSync(docsDir)) return
  const files = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md'))
  const offenders = []
  for (const f of files) {
    // 历史验收报告/落地方案允许保留其成文时的版本号
    if (/验收|方案|复盘/.test(f)) continue
    const s = read(path.join('docs', f))
    if (/当前版本\s*[:：]?\s*\*{0,2}v?\d+\.\d+\.\d+/.test(s) || /；当前版本\s*\|/.test(s)) offenders.push(f)
  }
  assert.deepEqual(offenders, [],
    'docs 里不要再硬编码当前版本号：' + offenders.join(', ') + '（改为指向 CHANGELOG / package.json）')
})
