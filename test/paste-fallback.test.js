'use strict'

// 悟道输入框（以及工作台里所有输入框）粘贴失灵的问题：
// 工作台是塞在宿主面板里的 iframe，原生粘贴在壳子里不一定到达页面——有人先 preventDefault，
// 或者 Ctrl+V 被外层快捷键吃掉。前端必须自己接管粘贴，不能指望浏览器的默认行为。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'web', 'src', 'main.ts'), 'utf8')
const clientSrc = fs.readFileSync(path.join(root, 'packages', 'dsh-invest', 'lib', 'client.js'), 'utf8')

test('paste 事件自己插入文本（上游 preventDefault 也拦不住）', () => {
  assert.match(mainSrc, /function insertTextAtCaret\(target: PasteTarget, text: string\)/, '要有按光标插入的实现')
  assert.match(mainSrc, /addEventListener\('paste'/, '要接管 paste 事件')
  assert.match(mainSrc, /getData\('text\/plain'\)/, '只取纯文本，别把 HTML 片段塞进输入框')
  assert.match(mainSrc, /event\.preventDefault\(\)\s*;\s*insertTextAtCaret\(/, '先掐掉默认插入再自己写，避免插两次')
  // 草稿与自动长高都挂在既有 input 监听上：手工插入后要补一次 input 事件，否则状态不同步
  assert.match(mainSrc, /dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/, '插入后要补发 input 事件')
})

test('连 paste 事件都收不到时，退到读剪贴板', () => {
  assert.match(mainSrc, /navigator\.clipboard\.readText\(\)/, '要有剪贴板兜底')
  assert.match(mainSrc, /String\(event\.key\)\.toLowerCase\(\) !== 'v'/, '兜底由 Ctrl/⌘+V 触发')
  assert.match(mainSrc, /pasteFallbackTimer = window\.setTimeout\(/, '按 Ctrl+V 后挂一个计时器看 paste 事件来没来')
  assert.match(mainSrc, /typeof 150|150\);/, '计时器窗口要短，别让用户等')
})

test('宿主 iframe 放开剪贴板读取权限', () => {
  assert.match(clientSrc, /allow: "clipboard-read; clipboard-write"/, 'iframe 不放开 clipboard-read，兜底读剪贴板会被挡')
})

test('产物里带着这套粘贴逻辑（改了 main.ts 记得重建前端）', () => {
  const dist = process.env.DSH_INVEST_WEB_DIST || path.join(root, 'packages', 'dsh-invest', 'web-dist')
  const bundle = path.join(dist, 'workbench.js')
  if (!fs.existsSync(bundle)) return   // 新克隆没有 dist，跳过
  const built = fs.readFileSync(bundle, 'utf8')
  assert.match(built, /clipboardData/, '产物缺少粘贴接管：改完要重新构建')
  assert.match(built, /readText/, '产物缺少剪贴板兜底：改完要重新构建')
})
