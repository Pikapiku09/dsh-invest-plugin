// 观察仓日检（watch-daily）测试
// 覆盖：① 规则层无触发时绝不排队 LLM；② 只有触发买区的标的进入 LLM 队列；
//      ③ 开关 / 收盘后定时时刻的持久化与校验；④ 观察仓只数统计；
//      ⑤ 模板替换：全市场海选已下线、观察仓日检已上线。
// 行情用临时目录里的桩脚本替代（python 输出固定价格），不访问网络；索引重建被显式跳过。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

function watchItem(code, name, state, watch) {
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
    },
    monitor: {
      current_price: null, refreshed_at: null, dist_buy_pct: null, dist_stop_pct: null,
      notify: true, last_signal_key: '', last_signal_at: null,
    },
  }
}

function makeHarness(seedItems) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-daily-'))
  const storeDir = path.join(base, '.dsh-invest', 'store')
  fs.mkdirSync(storeDir, { recursive: true })
  fs.mkdirSync(path.join(base, 'scripts'), { recursive: true })
  process.env.DSH_INVEST_BASE_DIR = base
  // 测试环境不调度自动日检、不重建索引（避免定时器与 python 拖住临时目录）
  process.env.DSH_INVEST_WATCH_DAILY = '0'
  process.env.DSH_INVEST_SKIP_REINDEX = '1'

  // 桩行情脚本：代码末位 3 → 10.5（可落进 [10,11] 买区），其余 → 10.0
  fs.writeFileSync(path.join(base, 'scripts', 'realtime_quote.py'), [
    'import json, sys',
    'out = []',
    'for c in sys.argv[1:]:',
    '    d = "".join(ch for ch in c if ch.isdigit())[:6]',
    '    price = {"3": 10.5}.get(d[-1:], 10.0)',
    '    out.append({"code": d, "price": price})',
    'print(json.dumps({"ok": True, "quotes": out, "fetched_at": "2026-11-11T15:10:00+08:00"}))',
  ].join('\n'))

  fs.writeFileSync(
    path.join(storeDir, 'watchlist.json'),
    JSON.stringify({ version: 1, updated_at: '2026-11-11T09:00:00.000Z', items: seedItems }, null, 2),
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

  const readDailyFile = () => JSON.parse(fs.readFileSync(path.join(storeDir, 'watch-daily.json'), 'utf8'))
  return { call, readDailyFile, base, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) }
}

test('无触发时不排队 LLM，只落 no-trigger 状态', async (t) => {
  const h = makeHarness([
    // 现价 10.0 远低于买区 [100,110] → 规则层不触发
    watchItem('600004.SH', '不触发样例', '观察', { buy_low: 100, buy_high: 110 }),
  ])
  t.after(h.cleanup)
  const { status, json } = await h.call('POST', '/dsh-invest/api/watch-daily/run', {})
  assert.equal(status, 200)
  assert.equal(json.status, 'no-trigger')
  assert.equal(json.watchCount, 1)
  assert.equal(json.lastJobId, '')
  assert.equal(h.readDailyFile().lastStatus, 'no-trigger')
  assert.deepEqual(h.readDailyFile().lastTriggered, [])
})

test('只有进入买区的标的进入 LLM 队列', async (t) => {
  const h = makeHarness([
    // 末位 3 → 现价 10.5，落在 [10,11] → 买入提醒
    watchItem('600003.SH', '触发样例', '观察', { buy_low: 10, buy_high: 11 }),
    watchItem('600004.SH', '不触发样例', '观察', { buy_low: 100, buy_high: 110 }),
    // 已清仓不参与
    watchItem('600005.SH', '已清仓样例', '已清仓', { buy_low: 10, buy_high: 11 }),
  ])
  t.after(h.cleanup)
  const { json } = await h.call('POST', '/dsh-invest/api/watch-daily/run', {})
  assert.equal(json.status, 'fired')
  assert.deepEqual(json.triggered, ['600003.SH'])
  assert.equal(json.watchCount, 2)
  assert.ok(json.jobId, '应返回入队任务 id')
  const saved = h.readDailyFile()
  assert.equal(saved.lastJobId, json.jobId)
  assert.deepEqual(saved.lastTriggered, ['600003.SH'])
  assert.equal(saved.lastStatus, 'fired')

  // 再次查询状态：能看到上次结论与观察仓只数
  const listed = await h.call('GET', '/dsh-invest/api/watch-daily')
  assert.equal(listed.json.watchCount, 2)
  assert.equal(listed.json.lastStatus, 'fired')
})

test('开关与收盘后定时时刻可持久化，非法时刻被拒绝', async (t) => {
  const h = makeHarness([])
  t.after(h.cleanup)
  const off = await h.call('POST', '/dsh-invest/api/watch-daily/settings', { enabled: false, at: '16:30' })
  assert.equal(off.status, 200)
  assert.equal(off.json.enabled, false)
  assert.equal(off.json.at, '16:30')

  const reread = await h.call('GET', '/dsh-invest/api/watch-daily')
  assert.equal(reread.json.enabled, false)
  assert.equal(reread.json.at, '16:30')

  const bad = await h.call('POST', '/dsh-invest/api/watch-daily/settings', { at: '25:00' })
  assert.equal(bad.status, 400)
  assert.match(String(bad.json.error), /HH:MM/)
})

test('模板替换：全市场海选下线、观察仓日检上线', async (t) => {
  const h = makeHarness([])
  t.after(h.cleanup)
  const removed = await h.call('POST', '/dsh-invest/api/run', { templateId: 'market-screen' })
  assert.equal(removed.status, 400)
  assert.match(String(removed.json.error), /unknown templateId/)

  const added = await h.call('POST', '/dsh-invest/api/run', { templateId: 'watch-daily' })
  assert.equal(added.status, 202)
  assert.ok(added.json.jobId)
})
