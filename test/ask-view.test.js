// 个股知识库视图（v0.52.0）：左侧高亮在管标的、右侧追问为主体、知识库收进放大层
//
// 前端是 TS + Vite，这里用 esbuild 把 ask.ts 打成 CJS 在 node 里直接调 renderAsk(state)，
// 对输出 HTML 做断言。esbuild 借道 vite 的依赖解析（pnpm 布局）；web 依赖没装时整组跳过，
// 不让纯后端环境因为这个可选的 UI 测试变红。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const webDir = path.join(root, 'web')

function loadRenderAsk() {
  let esbuild
  try {
    const viteEntry = require0.resolve('vite', { paths: [webDir] })
    esbuild = createRequire(viteEntry)('esbuild')
  } catch { return null }
  const out = path.join(os.tmpdir(), `dsh-invest-ask-${process.pid}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(webDir, 'src', 'ask.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent',
  })
  const mod = createRequire(import.meta.url)(out)
  try { fs.rmSync(out, { force: true }) } catch { /* 临时文件，删不掉也不影响 */ }
  return mod.renderAsk
}
const require0 = createRequire(import.meta.url)

function makeState() {
  return {
    askQuery: '', askStocksLoading: false, askStocksError: '', askStocksBuiltAt: '2026-11-13 10:53',
    askLetterCollapsed: {}, askStock: '600118.SH', askNoteLoading: false, askNoteError: '',
    askError: '', askDraft: '', askLoading: false, askSuggestionsEditing: false,
    askSuggestions: ['这个结论什么情况下会失效？'], askThreads: {},
    askStocks: [
      { code: '600118.SH', name: '中国卫星', count: 7, curated_at: '2026-11-12 14:47' },
      { code: '600011.SH', name: '华能国际', count: 3 },
      { code: '000823.SZ', name: '超声电子', count: 2 },
      { code: '000001.SZ', name: '平安银行', count: 9 },
    ],
    watchlist: {
      updated_at: '', alerts: [], unread: 0,
      items: [
        { code: '600118.SH', name: '中国卫星', state: '持有' },
        { code: '600011.SH', name: '华能国际', state: '持有' },
        { code: '000823.SZ', name: '超声电子', state: '观察' },
        { code: '600519.SH', name: '贵州茅台', state: '已清仓' },
        { code: '000001.SZ', name: '平安银行', state: '已移除' },
      ],
    },
    askNote: {
      code: '600118.SH', name: '中国卫星', updated_at: '2026-11-12 14:47', count: 7,
      model: 'deepseek-v4.1-flash@low', markdown: '## 一句话结论\n测试内容。',
      status: 'ready', new_entries: 0, entries: [{ ts: '2026-11-12', kind: 'report', snippet: 'x' }],
    },
  }
}

const renderAsk = loadRenderAsk()
const skip = renderAsk ? undefined : 'web 依赖未安装（esbuild 不可用），跳过前端渲染测试'

test('个股知识库：左侧只高亮「持有 / 观察」，已清仓与已移除不打标', { skip }, () => {
  const html = renderAsk(makeState())
  assert.match(html, /ask-stock-row-held[\s\S]*?ask-watch-tag held[^>]*>持有/, '持仓标的应有行高亮 + 标签')
  assert.match(html, /ask-stock-row-watching[\s\S]*?ask-watch-tag watching[^>]*>观察/, '观察标的应有行高亮 + 标签')
  // 已清仓 / 已移除的票根本不在 askStocks 里也不该出现任何标签；库内两只在管票之外不应有第三个标签
  assert.equal((html.match(/ask-watch-tag /g) || []).length, 3, '只给 3 只在管标的打标')
  assert.ok(html.includes('在管 3 只'), '左栏汇总应显示在管数量')
})

test('个股知识库：右侧以追问为主体，知识库收进右上角入口、原始记录移除', { skip }, () => {
  const html = renderAsk(makeState())
  assert.ok(html.includes('class="ask-thread" id="ask-thread"'), '追问区必须存在')
  assert.ok(html.includes('data-action="ask-kb-expand"'), '右上角要有放大查看知识库的入口')
  assert.ok(html.includes('ask-kb-collapsed'), '要有一行说明告诉用户知识库收在哪')
  assert.ok(html.includes('重新整理') && html.includes('更新数据'), '原有操作按钮不能丢')
  assert.ok(!html.includes('id="ask-kb"') && !html.includes('ask-kb-wrap'), '内联知识库应移除')
  assert.ok(!html.includes('原始记录') && !html.includes('ask-raw'), '原始记录栏应移除')
})

test('个股知识库：watchlist 未加载时不高亮，且不报错', { skip }, () => {
  const state = makeState()
  state.watchlist = null
  const html = renderAsk(state)
  assert.equal((html.match(/ask-watch-tag /g) || []).length, 0, '没有档案数据时不应打标')
  assert.ok(!html.includes('在管 '), '汇总里也不该出现在管计数')
  assert.ok(html.includes('ask-thread'), '页面其余部分照常渲染')
})
