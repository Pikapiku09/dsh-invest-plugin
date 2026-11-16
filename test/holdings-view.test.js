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

const require0 = createRequire(import.meta.url)

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString()

function makeState(updatedAt, over = {}) {
  return {
    holdings: {
      positions: [
        { code: '000823.SZ', name: '超声电子', shares: 1000, cost: 18.855, current_price: 17.43 },
      ],
      // 记录值故意写大：模拟「导入时快照」与实时口径的差异
      account: { total_asset: 1000000, available_cash: 31485 },
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
    ...over,
  }
}

function loadModule() {
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
  return mod
}

const holdingsMod = loadModule()
const renderHoldings = holdingsMod ? holdingsMod.renderHoldings : null
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

// ===== v0.54.1：账户总资产改为实时口径 + 刷新账本给反馈 =====

test('账户总资产：随现价变化而变（不再钉在账本记录的快照上）', { skip }, () => {
  const totalOf = (price) => holdingsMod.holdingsTotalAsset(
    [{ code: '000823.SZ', shares: 1000, cost: 18.855, current_price: price }],
    { total_asset: 1000000, available_cash: 31485 },
  )
  // 1000 股：现价 17.43 → 17430 + 31485 = 48915；现价 18.00 → 18000 + 31485 = 49485
  assert.equal(totalOf(17.43), 48915, '实时口径＝可用资金＋持仓市值')
  assert.equal(totalOf(18), 49485, '现价一变，总资产必须跟着变')
  assert.notEqual(totalOf(17.43), totalOf(18), '两次取价结果不能相同——这正是原来的 bug')
})

test('账户总资产：缺现金或全无现价时回退账本记录值，不返回 null', { skip }, () => {
  const noCash = holdingsMod.holdingsTotalAsset(
    [{ code: '000823.SZ', shares: 1000, current_price: 17 }, { code: '600011.SH', shares: 100 }],
    { total_asset: 500000 },
  )
  assert.equal(noCash, 500000, '没有可用资金时用记录值')
  const noPrice = holdingsMod.holdingsTotalAsset(
    [{ code: '000823.SZ', shares: 1000, cost: 18.855 }],
    { total_asset: 500000, available_cash: 1000 },
  )
  assert.equal(noPrice, 500000, '所有持仓都取不到现价时用记录值，不能用现金冒充总资产')
})

test('账户总资产卡片：实时值与账本记录差异大时把差异摆出来', { skip }, () => {
  const html = renderHoldings(makeState(daysAgo(0)))
  assert.ok(html.includes('实时口径'), '卡片要说明计算口径')
  assert.ok(html.includes('账本记录'), '与记录值差异大时要显示记录的快照值')
  assert.ok(html.includes('48,915') || html.includes('48915'), '应显示实时总资产 48915：' + html.slice(0, 300))
})

test('刷新账本：加载中按钮显示「刷新中…」，不再是一闪而过的禁用态', { skip }, () => {
  const html = renderHoldings(makeState(daysAgo(0), { holdingsLoading: true }))
  assert.ok(html.includes('刷新中…'), '加载态要有可见文字，否则用户以为没反应')
  assert.ok(html.includes('spinner'), '加载态要有转圈')
  const idle = renderHoldings(makeState(daysAgo(0)))
  assert.ok(idle.includes('刷新账本'), '空闲时显示正常文案')
})
