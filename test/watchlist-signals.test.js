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
