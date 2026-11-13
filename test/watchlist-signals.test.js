// 标的档案（模块二）路由集成测试
// 覆盖：① 止盈/止损/买入提醒标注购买仓位数；② 提醒写入 alerts 且带 qty；
//      ③ 持仓工作区确认写入后，标的档案股数/成本/状态机同步。
// 行情用临时目录里的桩脚本替代（python 输出固定价格），不访问网络。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const WATCHLIST_SEED = {
  version: 1,
  updated_at: '2026-11-09T09:00:00.000Z',
  items: [],
}

function watchItem(code, name, state, watch, position) {
  return {
    code, name, state,
    watch: {
      buy_low: null, buy_high: null, ideal_buy: null, buy_qty: null,
      invalidate_if: '', thesis: '', stance: state, target: null, stop: null,
      created_at: null, last_conclusion_ts: null,
      ...watch,
    },
    position: {
      cost: null, shares: null, stop: null, target: null,
      add_low: null, add_high: null, trim_line: null, trailing_stop: null,
      ...position,
    },
    monitor: {
      current_price: null, refreshed_at: null, dist_buy_pct: null, dist_stop_pct: null,
      notify: true, last_signal_key: '', last_signal_at: null,
    },
  }
}

function makeHarness(seedItems) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-watch-'))
  const storeDir = path.join(base, '.dsh-invest', 'store')
  fs.mkdirSync(storeDir, { recursive: true })
  fs.mkdirSync(path.join(base, 'scripts'), { recursive: true })
  process.env.DSH_INVEST_BASE_DIR = base

  // 桩行情脚本：按代码末位数字返回固定价（1→9.0 跌破止损，2→12.0 达止盈，3→10.5 落入买区）
  fs.writeFileSync(path.join(base, 'scripts', 'realtime_quote.py'), [
    'import json, sys',
    'out = []',
    'for c in sys.argv[1:]:',
    '    d = "".join(ch for ch in c if ch.isdigit())[:6]',
    '    price = {"1": 9.0, "2": 12.0, "3": 10.5}.get(d[-1:], 10.0)',
    '    out.append({"code": d, "price": price})',
    'print(json.dumps({"ok": True, "quotes": out, "fetched_at": "2026-11-09T10:00:00+08:00"}))',
  ].join('\n'))

  fs.writeFileSync(
    path.join(storeDir, 'watchlist.json'),
    JSON.stringify({ ...WATCHLIST_SEED, items: seedItems }, null, 2),
  )

  const registered = []
  const fakeFs = {
    resolve: async (p) => p,
    readText: async (p) => fs.readFileSync(p, 'utf8'),
    writeText: async (p, text) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, text)
    },
  }
  const ctx = {
    get(name) {
      if (name === 'fs') return fakeFs
      if (name === 'sandboxPolicy') return { resolve: () => ({}) }
      if (name === 'agents') return { roots: () => [], create: async () => { throw new Error('unused') } }
      if (name === 'llm') return { listProviders: () => [], listModels: async () => [], resolveCallConfig: async () => ({}) }
      return undefined
    },
    effect(fn) { fn() },
    webServer: { register: (route) => { registered.push(route); return () => {} } },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => {} },
  }
  apply(ctx, {})

  async function call(method, pathAndQuery, body) {
    const route = registered.find((item) => item.path === pathAndQuery.split('?')[0])
    assert.ok(route, '路由未注册：' + pathAndQuery)
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url: pathAndQuery,
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost:3080' },
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    }
    let status = 0
    let text = ''
    const res = {
      setHeader() {},
      set statusCode(value) { status = value },
      get statusCode() { return status },
      end(value) { text = value === undefined ? '' : String(value) },
    }
    await route.handler(req, res)
    return { status: status || 200, json: text ? JSON.parse(text) : null }
  }

  const readWatchlistFile = () => JSON.parse(fs.readFileSync(path.join(storeDir, 'watchlist.json'), 'utf8'))
  return { call, readWatchlistFile, cleanup: () => fs.rmSync(base, { recursive: true, force: true }), base }
}

const HOLDINGS_REL = path.join('.dsh-invest', '持仓.json')
const writeHoldings = (base, positions, account = { total_asset: 1000000 }) => {
  fs.writeFileSync(path.join(base, HOLDINGS_REL), JSON.stringify({
    version: 1, updated_at: new Date().toISOString(), account, positions,
  }, null, 2))
}
const readHoldings = (base) => JSON.parse(fs.readFileSync(path.join(base, HOLDINGS_REL), 'utf8'))

test('提醒标注购买仓位数：止损=持仓股数、止盈=持仓股数、买入=计划买入股数', async (t) => {
  const h = makeHarness([
    watchItem('600001.SH', '止损样例', '持有', {}, { cost: 11, shares: 1000, stop: 10, target: 20 }),
    watchItem('600002.SH', '止盈样例', '持有', {}, { cost: 10, shares: 800, stop: 5, target: 12 }),
    watchItem('600003.SH', '买入样例', '观察', { buy_low: 10, buy_high: 11, buy_qty: 500 }, {}),
  ])
  t.after(h.cleanup)

  const { status, json } = await h.call('POST', '/dsh-invest/api/watchlist/refresh', {})
  assert.equal(status, 200)
  assert.equal(json.alerts.length, 3, '三只标的都应触发提醒')

  const byKind = Object.fromEntries(json.alerts.map((alert) => [alert.kind, alert]))
  assert.equal(byKind.stop.qty, 1000, '止损提醒的购买仓位数应为持仓股数')
  assert.match(byKind.stop.message, /持仓仓位数 1000 股/)
  assert.equal(byKind.target.qty, 800)
  assert.match(byKind.target.message, /持仓仓位数 800 股/)
  assert.equal(byKind.buy.qty, 500, '买入提醒的购买仓位数应为计划买入股数')
  assert.match(byKind.buy.message, /购买仓位数 500 股/)

  // 落盘：watchlist_alerts.jsonl 带 qty，且 GET /watchlist 能读到未读提醒
  const listed = await h.call('GET', '/dsh-invest/api/watchlist')
  assert.equal(listed.json.unread, 3)
  assert.ok(listed.json.alerts.every((alert) => typeof alert.qty === 'number'), '每条提醒都应带 qty')

  // 同日同信号不重复提醒
  const again = await h.call('POST', '/dsh-invest/api/watchlist/refresh', {})
  assert.equal(again.json.alerts.length, 0, '同 key 当日不应重复触发')
})

test('提醒仓位数可空：未填计划买入股数时提示「待定」而不是编造数字', async (t) => {
  const h = makeHarness([
    watchItem('600003.SH', '买入样例', '观察', { buy_low: 10, buy_high: 11 }, {}),
  ])
  t.after(h.cleanup)

  const { json } = await h.call('POST', '/dsh-invest/api/watchlist/refresh', {})
  const buy = json.alerts.find((alert) => alert.kind === 'buy')
  assert.ok(buy, '应触发买入提醒')
  assert.equal(buy.qty, null)
  assert.match(buy.message, /购买仓位数 待定/)
})

test('watchlist/update 支持保存计划买入股数 buy_qty', async (t) => {
  const h = makeHarness([watchItem('600003.SH', '买入样例', '观察', {}, {})])
  t.after(h.cleanup)

  const saved = await h.call('POST', '/dsh-invest/api/watchlist/update', { code: '600003.SH', watch: { buy_qty: 1200 } })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.item.watch.buy_qty, 1200)
  assert.equal(h.readWatchlistFile().items[0].watch.buy_qty, 1200)
})

test('持仓确认写入后，标的档案同步股数/成本与状态机', async (t) => {
  const h = makeHarness([
    watchItem('600519.SH', '贵州茅台', '观察', { buy_low: 1500, buy_high: 1550 }, {}),
    watchItem('000001.SZ', '平安银行', '持有', {}, { cost: 11, shares: 1000, stop: 9, target: 15 }),
  ])
  t.after(h.cleanup)

  const imported = await h.call('POST', '/dsh-invest/api/holdings/import', {
    source: 'manual',
    positions: [{ code: '600519.SH', name: '贵州茅台', shares: 200, cost: 1500, current_price: 1600 }],
  })
  assert.equal(imported.status, 200)
  const draftId = imported.json.draftId

  const confirmed = await h.call('POST', '/dsh-invest/api/holdings/confirm', {
    draftId,
    positions: [{ code: '600519.SH', name: '贵州茅台', shares: 200, cost: 1500, current_price: 1600 }],
    account: { total_asset: 1000000 },
  })
  assert.equal(confirmed.status, 200)
  assert.ok(Array.isArray(confirmed.json.watchSync), '确认响应应带回档案同步结果')
  assert.ok(confirmed.json.watchSync.includes('600519.SH 观察→持有'), confirmed.json.watchSync.join(' / '))
  assert.ok(confirmed.json.watchSync.some((line) => line.startsWith('000001.SZ 持有→已清仓')), confirmed.json.watchSync.join(' / '))

  const doc = h.readWatchlistFile()
  const mt = doc.items.find((item) => item.code === '600519.SH')
  assert.equal(mt.state, '持有', '账本中出现的标的应转为持有')
  assert.equal(mt.position.shares, 200, '股数应跟随账本')
  assert.equal(mt.position.cost, 1500, '成本应跟随账本')
  assert.equal(mt.monitor.current_price, 1600, '现价应跟随账本')

  const pa = doc.items.find((item) => item.code === '000001.SZ')
  assert.equal(pa.state, '已清仓', '账本中消失的持仓应标记已清仓')
  assert.equal(pa.position.shares, 0)
})

test('持仓股数被修改后，档案股数随之更新（同日二次确认）', async (t) => {
  const h = makeHarness([watchItem('600519.SH', '贵州茅台', '持有', {}, { cost: 1500, shares: 200 })])
  t.after(h.cleanup)

  const imported = await h.call('POST', '/dsh-invest/api/holdings/import', {
    source: 'manual',
    positions: [{ code: '600519.SH', name: '贵州茅台', shares: 500, cost: 1480, current_price: 1600 }],
  })
  const confirmed = await h.call('POST', '/dsh-invest/api/holdings/confirm', {
    draftId: imported.json.draftId,
    positions: [{ code: '600519.SH', name: '贵州茅台', shares: 500, cost: 1480, current_price: 1600 }],
  })
  assert.equal(confirmed.status, 200)
  const mt = h.readWatchlistFile().items.find((item) => item.code === '600519.SH')
  assert.equal(mt.position.shares, 500)
  assert.equal(mt.position.cost, 1480)
})

// ===== 档案 → 持仓 的反向同步（2026-11-11）=====

test('档案点「已清仓」→ 持仓账本同步移除该票', async (t) => {
  const h = makeHarness([watchItem('600519.SH', '贵州茅台', '持有', {}, { cost: 1500, shares: 200 })])
  t.after(h.cleanup)
  writeHoldings(h.base, [{ code: '600519.SH', name: '贵州茅台', shares: 200, cost: 1500, current_price: 1600 }])

  const saved = await h.call('POST', '/dsh-invest/api/watchlist/update', { code: '600519.SH', state: '已清仓' })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.holdingSync.changed, true)
  assert.equal(saved.json.holdingSync.action, '清仓')
  assert.equal(saved.json.item.position.shares, 0, '清仓后档案股数应归零')
  assert.deepEqual(readHoldings(h.base).positions, [], '清仓后账本不应再有该票')
})

test('档案填买入（观察→持有 + 股数成本）→ 持仓账本自动建仓', async (t) => {
  const h = makeHarness([watchItem('600519.SH', '贵州茅台', '观察', { buy_low: 1500, buy_high: 1550 }, {})])
  t.after(h.cleanup)
  writeHoldings(h.base, [])

  const saved = await h.call('POST', '/dsh-invest/api/watchlist/update', {
    code: '600519.SH', state: '持有', position: { cost: 1500, shares: 200 },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.holdingSync.changed, true)
  assert.equal(saved.json.holdingSync.action, '建仓')
  const pos = readHoldings(h.base).positions.find((p) => p.code === '600519.SH')
  assert.ok(pos, '账本应新增该票')
  assert.equal(pos.shares, 200)
  assert.equal(pos.cost, 1500)
})

test('档案置为持有但没填股数 → 不写账本，只回提示', async (t) => {
  const h = makeHarness([watchItem('600519.SH', '贵州茅台', '观察', {}, {})])
  t.after(h.cleanup)
  writeHoldings(h.base, [])

  const saved = await h.call('POST', '/dsh-invest/api/watchlist/update', { code: '600519.SH', state: '持有' })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.holdingSync.changed, false)
  assert.match(String(saved.json.holdingSync.warnings[0]), /股数为空/)
  assert.deepEqual(readHoldings(h.base).positions, [], '缺股数时不得凭空写仓')
})

test('档案改为观察但账本仍持仓 → 不误删，只回提示', async (t) => {
  const h = makeHarness([watchItem('600519.SH', '贵州茅台', '持有', {}, { cost: 1500, shares: 200 })])
  t.after(h.cleanup)
  writeHoldings(h.base, [{ code: '600519.SH', name: '贵州茅台', shares: 200, cost: 1500, current_price: 1600 }])

  const saved = await h.call('POST', '/dsh-invest/api/watchlist/update', { code: '600519.SH', state: '观察' })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.holdingSync.changed, false)
  assert.match(String(saved.json.holdingSync.warnings[0]), /持仓账本里仍有该标的/)
  assert.equal(readHoldings(h.base).positions.length, 1, '不得因为改观察就删掉真实持仓')
})

test('持仓工作区新增股票 → 自动建「持有」档案', async (t) => {
  const h = makeHarness([watchItem('000001.SZ', '平安银行', '观察', {}, {})])
  t.after(h.cleanup)

  const imported = await h.call('POST', '/dsh-invest/api/holdings/import', {
    source: 'manual',
    positions: [{ code: '600519.SH', name: '贵州茅台', shares: 100, cost: 1500, current_price: 1600 }],
  })
  const confirmed = await h.call('POST', '/dsh-invest/api/holdings/confirm', {
    draftId: imported.json.draftId,
    positions: [{ code: '600519.SH', name: '贵州茅台', shares: 100, cost: 1500, current_price: 1600 }],
    account: { total_asset: 1000000 },
  })
  assert.equal(confirmed.status, 200)
  const created = h.readWatchlistFile().items.find((item) => item.code === '600519.SH')
  assert.ok(created, '账本里的新票应自动建档')
  assert.equal(created.state, '持有')
  assert.equal(created.position.shares, 100)
  assert.ok(confirmed.json.watchSync.some((line) => line.includes('新建档案')), confirmed.json.watchSync.join(' / '))
})

test('已清仓标的重新买入 → 档案回到持有', async (t) => {
  const h = makeHarness([watchItem('600519.SH', '贵州茅台', '已清仓', {}, { shares: 0 })])
  t.after(h.cleanup)

  const imported = await h.call('POST', '/dsh-invest/api/holdings/import', {
    source: 'manual',
    positions: [{ code: '600519.SH', name: '贵州茅台', shares: 300, cost: 1400, current_price: 1600 }],
  })
  const confirmed = await h.call('POST', '/dsh-invest/api/holdings/confirm', {
    draftId: imported.json.draftId,
    positions: [{ code: '600519.SH', name: '贵州茅台', shares: 300, cost: 1400, current_price: 1600 }],
    account: { total_asset: 1000000 },
  })
  assert.equal(confirmed.status, 200)
  const it = h.readWatchlistFile().items.find((item) => item.code === '600519.SH')
  assert.equal(it.state, '持有', '重新买入后档案应回到持有')
  assert.equal(it.position.shares, 300)
})

// ===== v0.53.0：持有期价位语义校验 =====

test('脏止盈（低于成本/低于止损）不触发止盈提醒（超声电子事故回归）', async (t) => {
  // 复刻线上事故形态：止盈 16.68 < 止损 17.35 < 成本 18.855。
  // 桩行情：代码末位 4 → 现价 17.43 ≥ 16.68，若无屏蔽必触发止盈提醒。
  const h = makeHarness([
    watchItem('600004.SH', '超声电子', '持有', {}, { cost: 18.855, shares: 1000, stop: 17.35, target: 16.68 }),
  ])
  t.after(h.cleanup)

  const { json } = await h.call('POST', '/dsh-invest/api/watchlist/refresh', {})
  const targetAlert = (json.alerts || []).find((alert) => alert.kind === 'target')
  assert.equal(targetAlert, undefined, '价格倒挂的止盈目标不得触发止盈提醒')
})

test('合法止盈（高于成本与止损）照常触发提醒，行为不回归', async (t) => {
  // 代码末位 2 → 现价 12.0 ≥ 目标 12；成本 10、止损 9 → 全部语义合法
  const h = makeHarness([
    watchItem('600002.SH', '止盈样例', '持有', {}, { cost: 10, shares: 800, stop: 9, target: 12 }),
  ])
  t.after(h.cleanup)

  const { json } = await h.call('POST', '/dsh-invest/api/watchlist/refresh', {})
  const targetAlert = (json.alerts || []).find((alert) => alert.kind === 'target')
  assert.ok(targetAlert, '合法止盈目标仍应触发提醒')
  assert.match(targetAlert.message, /止盈提醒/)
})
