// 悟道页自适应守卫（2026-11-24）
//
// 事故：`.dao-stage` 一度用 `height: calc(100vh - 30px)` 定高，只扣掉了 `.content`
// 的上下内边距（18+12），漏掉它上方那条 topbar（实测 58~70px）。于是文档总高恒为
// 「视口高 + topbar」，带来三个错位：
//   ① 页面级纵向滚动条常驻（用户："没必要用滚动条的竟然用了滚动条"）；
//   ② 底部抽屉与把手被顶到折线以下，展开就是"显示不全"；
//   ③ 嵌进 DSH 面板（iframe）或换窗口尺寸时比例全变，1080p 看着正常、高分屏错位。
//
// 修法：舞台不再自己算视口高度，改成从外壳一路拉下来的 flex 填充链——
//   .app-shell:has(.dao-stage) 定高 100dvh
//   → .app-main 纵向 flex
//   → .content  flex: 1 1 auto; min-height: 0
//   → .dao-stage flex: 1 1 auto; min-height: 0
// 四段缺一段，链条就断，高度又会回到"由内容决定"的老路。
//
// 本测试锁住这条链，防止有人图省事把 vh 高度写回去。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const cssPath = path.join(root, 'web', 'src', 'dao.css')
const css = fs.readFileSync(cssPath, 'utf8')

/** 取出某个选择器的声明块（只认第一处定义，够用且够松）
 *  必须按「行首选择器 + {」定位：注释里也会提到选择器名，直接 indexOf 会串到隔壁规则。 */
function block(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const hit = new RegExp('^' + esc + '[ \\t]*\\{([\\s\\S]*?)\\}', 'm').exec(css)
  if (hit) return hit[1]
  const start = css.indexOf(selector)
  assert.ok(start >= 0, `dao.css 里找不到 ${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

test('悟道舞台不许再用视口高度硬算（vh 高度会把 topbar 重复算一遍）', () => {
  const stage = block('.dao-stage {')
  assert.doesNotMatch(stage, /height\s*:\s*calc\(/, '.dao-stage 不许写 calc(100vh - ...)：漏扣 topbar 会让页面永远多出一截')
  assert.doesNotMatch(stage, /height\s*:\s*100vh/, '.dao-stage 不许写 100vh：它不在视口顶部')
  assert.match(stage, /flex:\s*1 1 auto/, '.dao-stage 必须靠 flex 撑开')
  assert.match(stage, /min-height:\s*0/, '.dao-stage 需要 min-height:0 才能被父级压缩')
})

test('自适应填充链的四段必须都在（缺一段高度就退回按内容算）', () => {
  assert.match(block('.app-shell:has(.dao-stage)'), /height:\s*100dvh/, '外壳要定高 100dvh')
  assert.match(block('.app-shell:has(.dao-stage) .app-main'), /flex-direction:\s*column/, '.app-main 要变成纵向 flex 容器')
  assert.match(block('.content:has(.dao-stage)'), /flex:\s*1 1 auto/, '.content 要吃掉 topbar 剩下的高度')
  assert.match(block('.content:has(.dao-stage)'), /min-height:\s*0/, '.content 需要 min-height:0')
})

test('底部抽屉有高度上限，展开不会把对话区挤没', () => {
  const dock = block('.dao-dock {')
  assert.match(dock, /max-height:\s*\d+%/, '.dao-dock 要写百分比上限')
  assert.match(dock, /display:\s*flex/, '.dao-dock 要是 flex 容器，把手/统计/列表才能各就各位')
  assert.match(block('.dao-dock-body'), /min-height:\s*0/, '.dao-dock-body 需要 min-height:0 才能在抽屉内滚动')
})

test('对话区靠内层 min-height 做底部对齐（直接 justify-content:flex-end 会滚不到最早的消息）', () => {
  assert.match(css, /\.dao-thread-inner\s*\{[^}]*min-height:\s*100%/s, '.dao-thread-inner 需要 min-height:100%')
  assert.match(css, /\.dao-thread-inner\s*\{[^}]*justify-content:\s*flex-end/s, '.dao-thread-inner 负责底部对齐')
  assert.match(block('.dao-thread'), /overflow-y:\s*auto/, '.dao-thread 只在内容超高时才滚')
  assert.doesNotMatch(block('.dao-thread'), /max-height:\s*min\(44vh/, '对话区别再写死 44vh 上限——高度交还给填充链')
})

test('对话框钉在舞台正中（三行网格 + 补齐抽屉占掉的底边）', () => {
  // 用户反馈："对话框应该始终保持在中间"、"现在对话框是偏中上的情况了"。
  // 做法：舞台主区切成 1fr / auto / 1fr 三行，对话框独占中间那行，
  // 上下两行等分剩余空间，所以聊多少轮它都不动。
  const main = block('.dao-stage-main')
  assert.match(main, /display:\s*grid/, '.dao-stage-main 要换成网格，靠两段 1fr 把对话框夹在中间')
  assert.match(main, /grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/, '三行：弹性 / 对话框 / 弹性')
  assert.match(block('.dao-composer-wrap'), /grid-row:\s*2/, '对话框要占中间那行')
  assert.match(block('.dao-stage-foot'), /grid-row:\s*3/, '页脚要占第三行，别把对话框挤上去')
  // 抽屉收起时占掉舞台底部一条边，若内边距对称，对话框会被整体抬起 20px（看着"偏中上"）。
  // 这里用上下内边距之差把它补回来，差值来自 --dao-dock-rest。
  assert.match(main, /padding:[^;]*var\(--dao-dock-rest/, '内边距要用 --dao-dock-rest 补掉抽屉占掉的那条底边')
  assert.match(main, /calc\(22px \+ var\(--dao-dock-rest/, '上内边距 = 下内边距 + 抽屉高度，对话框才落在舞台正中')
})

test('产物里能查到这条链（改了 CSS 记得重建前端）', () => {
  const dist = process.env.DSH_INVEST_WEB_DIST || path.join(root, 'packages', 'dsh-invest', 'web-dist')
  const bundle = path.join(dist, 'workbench.css')
  if (!fs.existsSync(bundle)) return // 新克隆没有 dist，跳过
  const built = fs.readFileSync(bundle, 'utf8')
  assert.match(built, /\.app-shell:has\(\.dao-stage\)/, '产物缺少填充链：改完 dao.css 要重新构建')
  assert.match(built, /\.dao-thread-inner/, '产物缺少对话内层容器：改完 dao.ts 要重新构建')
})
