// 持仓工作区「账本更新时间」（v0.54.0）
//
// 原来更新只藏在「当前持仓」卡片底部一小行灰字，等于没提示。现价是会过期的东西，
// 所以把账本 updated_at 提到「当前账本」标题旁常驻，超过 3 天转琥珀色并带天数。
// 与 ask-view.test.js 同一套路：esbuild 把 TS 打成 CJS 在 node 里直接调 renderHoldings。
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

function loadRenderHoldings() {
  let esbuild
  try {
    const viteEntry = require0.resolve('vite', { paths: [webDir] })
    esbuild = createRequire(viteEntry)('esbuild')
  } catch { return null }
  const out = path.join(os.tmpdir(), `dsh-invest-holdings-${process.pid}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(webDir, 'src', 'holdings.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent',
  })
  const mod = createRequire(import.meta.url)(out)
  try { fs.rmSync(out, { force: true }) } catch { /* 临时文件，删不掉不影响 */ }
  return mod.renderHoldings
}
const require0 = createRequire(import.meta.url)

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString()

function makeState(updatedAt) {
  return {
    holdings: {
      positions: [
        { code: '000823.SZ', name: '超声电子', shares: 1000, cost: 18.855, current_price: 17.43 },
      ],
      account: { total_asset: 1000000 },
      updated_at: updatedAt,
    },
    holdingsLoading: false, holdingsError: '', holdingsDraft: null, holdingsDraftLoading: false,
    holdingsQuotesLoading: false, holdingsImporting: '', holdingsConfirming: false,
    holdingsQuotesInfo: '', holdingsActionError: '',
    ledgerColumns: ['code', 'name', 'shares', 'cost', 'current_price'],
    ledgerSort: null,
    // importSources 会读 jobs 判断分析任务是否占用模型，并渲染手动录入卡片
    jobs: [],
    manualPosition: { code: '', name: '', shares: '', available_shares: '', cost: '', current_price: '', status: '持有', note: '' },
  }
}

const renderHoldings = loadRenderHoldings()
const skip = renderHoldings ? undefined : 'web 依赖未安装（esbuild 不可用），跳过前端渲染测试'

test('账本更新时间：今天写入 → 标牌显示时间、不报陈旧', { skip }, () => {
  const html = renderHoldings(makeState(daysAgo(0)))
  assert.ok(html.includes('ledger-updated'), '要有更新时间标牌')
  // 标牌里先渲染图标再渲染文字，直接用窗口截取断言（别用跨标签的正则）
  const at = html.indexOf('ledger-updated')
  const badge = html.slice(at, at + 400)
  assert.ok(badge.includes('更新于'), '标牌要写「更新于」')
  assert.match(badge, /\d{2}-\d{2} \d{2}:\d{2}/, '标牌要带具体时间（MM-DD HH:mm）：' + badge.slice(0, 160))
  assert.ok(!html.includes('is-stale'), '刚写入不该标陈旧')
  assert.ok(!html.includes('is-unknown'), '有时间就不该走未知分支')
})

test('账本更新时间：超过 3 天 → 标陈旧并带天数，提示刷新现价', { skip }, () => {
  const html = renderHoldings(makeState(daysAgo(6)))
  assert.ok(html.includes('ledger-updated is-stale'), '6 天没写入应标陈旧')
  assert.ok(html.includes('6 天前'), '要写出具体天数')
  assert.match(html, /title="[^"]*建议点「一键刷新现价」/, '陈旧时提示应给出下一步动作')
})

test('账本更新时间：没有 updated_at → 显示「更新于 —」而不是空白或报错', { skip }, () => {
  const html = renderHoldings(makeState(null))
  assert.ok(html.includes('ledger-updated is-unknown'))
  assert.ok(html.includes('更新于 —'))
  assert.ok(html.includes('超声电子'), '账本本身照常渲染，不能因为缺时间就空白')
})

test('账本更新时间：出现在「当前账本」标题区，且不再重复在概览卡片里', { skip }, () => {
  const html = renderHoldings(makeState(daysAgo(0)))
  const ledgerAt = html.indexOf('当前账本')
  const badgeAt = html.indexOf('ledger-updated')
  assert.ok(ledgerAt > -1 && badgeAt > ledgerAt, '标牌应在「当前账本」之后（同一标题区）')
  assert.ok(badgeAt - ledgerAt < 600, '标牌要贴着标题，不能掉到表格底部')
  // 概览卡片里的重复时间已换成指向说明
  assert.ok(html.includes('更新时间见「当前账本」'), '概览卡片应指向新的位置，不重复显示时间')
})
