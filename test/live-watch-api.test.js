// 盘中盯盘路由（v0.76.0）
//
// 为什么必须有这组测试：重启 DSH 后接口 401（那是 DSH 自己的鉴权），肉眼看不到
// 服务端到底返回什么。这里按仓库既有做法（fake ctx + 直接调 handler）钉住三件事：
//   1. 快照口径：用 watchlist 的实时价重算市值/权重/浮盈，不信账本里的旧 current_price；
//   2. 生效止损：position.stop 优先、watch.stop 兜底，并与最新结论的 stop 比对给出冲突；
//   3. 三档预设是节奏的唯一来源：选预设就写死间隔，手改间隔则降级为「自定义」。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-live-'))
const store = path.join(base, '.dsh-invest', 'store')
fs.mkdirSync(store, { recursive: true })
process.env.DSH_INVEST_BASE_DIR = base

const registered = []
const fakeFs = {
  resolve: async (p) => p,
  readText: async (p) => fs.readFileSync(p, 'utf8'),
  writeText: async (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8') },
}
apply({
  get(name) { return name === 'fs' ? fakeFs : undefined },
  effect(fn) { fn() },
  webServer: { register: (route) => { registered.push(route); return () => {} } },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
}, {})

function ymd(d) {
  const t = d || new Date()
  const p = (n) => String(n).padStart(2, '0')
  return String(t.getFullYear()) + p(t.getMonth() + 1) + p(t.getDate())
}
const TODAY = ymd()

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

// —— 夹具：4 只实盘持仓（其中一只是非实盘，必须被过滤）+ 3 只观察 ——
writeJson(path.join(base, '.dsh-invest', '持仓.json'), {
  version: 1,
  updated_at: '2026-11-24T01:00:00.000Z',
  account: { available_cash: 22228.91, cash: 22228.91, total_asset: 999 },
  positions: [
    // 账本里的 current_price / weight_pct 故意写成旧值：快照必须用 watchlist 的实时价重算
    { code: '000823.SZ', name: '超声电子', pool: '实盘', shares: 2200, cost: 17.999, current_price: 19.5, weight_pct: 90 },
    { code: '600118.SH', name: '中国卫星', pool: '实盘', shares: 500, cost: 54.197, current_price: 52.0, weight_pct: 50 },
    { code: '159813.SZ', name: '半导体ETF鹏华', pool: '实盘', shares: 28700, cost: 0.553, current_price: 0.56 },
    { code: '510500.SH', name: '中证500ETF南方', pool: '实盘', shares: 1500, cost: 6.668, current_price: 6.4 },
    { code: '600011.SH', name: '华能国际', pool: '观察池', shares: 2000, cost: 7.1 },
  ],
})

const ITEMS = [
  {
    code: '000823.SZ', name: '超声电子', state: '持有',
    watch: { buy_low: 17.2, buy_high: 18.4, stop: 16.8, thesis: '', stance: '持有', target: 22, created_at: '2026-11-20T00:00:00.000Z' },
    position: { cost: 17.999, shares: 2200, stop: 17.35, target: 22 },
    monitor: { current_price: 20.58, prev_close: 20.12, change_pct: 2.29, refreshed_at: '2026-11-24T01:19:20.000Z', dist_stop_pct: 18.62, notify: true },
  },
  {
    code: '600118.SH', name: '中国卫星', state: '持有',
    watch: { buy_low: 44, buy_high: 46, stop: 54.3, thesis: '', stance: '观察' },
    position: { cost: 54.197, shares: 500, stop: 55.7, target: 60.17 },
    monitor: { current_price: 48.58, prev_close: 49.9, change_pct: -2.65, dist_stop_pct: -12.78, last_signal_key: '600118.SH|stop|' + TODAY, last_signal_at: '2026-11-24T01:20:00.000Z' },
  },
  {
    code: '159813.SZ', name: '半导体ETF鹏华', state: '持有',
    watch: { buy_low: 0.5, buy_high: 0.52, stop: 0.48 },
    position: { cost: 0.553, shares: 28700, stop: 0.504, target: 0.567 },
    monitor: { current_price: 0.555, prev_close: 0.552, change_pct: 0.54, dist_stop_pct: 10.12 },
  },
  {
    code: '510500.SH', name: '中证500ETF南方', state: '持有',
    watch: { buy_low: 6, buy_high: 6.2, stop: 6.1 },
    position: { cost: 6.668, shares: 1500, stop: 6.28, target: 6.86 },
    monitor: { current_price: 6.25, prev_close: 6.31, change_pct: -0.95, dist_stop_pct: -0.48, last_signal_key: '510500.SH|stop|' + TODAY },
  },
  {
    // 观察：|dist| 1.2，价格在买区下方（未进买区）
    code: '603596.SH', name: '伯特利', state: '观察',
    watch: { buy_low: 40, buy_high: 42, stop: 37 }, position: {},
    monitor: { current_price: 39.52, dist_buy_pct: -1.2 },
  },
  {
    // 观察：|dist| 5.0
    code: '002472.SZ', name: '双环传动', state: '观察',
    watch: { buy_low: 30, buy_high: 32, stop: 27 }, position: {},
    monitor: { current_price: 31.5, dist_buy_pct: -5.0 },
  },
  {
    // 观察：|dist| 2.0，且已进买区
    code: '002414.SZ', name: '高德红外', state: '观察',
    watch: { buy_low: 8, buy_high: 9, stop: 7 }, position: {},
    monitor: { current_price: 8.4, dist_buy_pct: 2.0 },
  },
  {
    // 已清仓：不进快照
    code: '000636.SZ', name: '风华高科', state: '已清仓',
    watch: {}, position: {}, monitor: { current_price: 12 },
  },
]
writeJson(path.join(store, 'watchlist.json'), { version: 1, updated_at: '2026-11-24T01:19:20.000Z', items: ITEMS, alerts: [] })

// 600118 最新结论止损 44.50，与档案 55.70 相差 20.1% → 必须报冲突
fs.writeFileSync(path.join(store, 'conclusions.jsonl'), [
  JSON.stringify({ ts: '2026-11-23T02:00:00.000Z', code: '600118.SH', stance: '减仓', stop: 50.0 }),
  JSON.stringify({ ts: '2026-11-24T01:19:13.908Z', code: '600118.SH', stance: '减仓', stop: 44.5 }),
  JSON.stringify({ ts: '2026-11-24T02:14:29.180Z', code: '000823.SZ', stance: '持有', stop: 18.45 }),
].join('\n') + '\n', 'utf8')

fs.writeFileSync(path.join(store, 'live-log.jsonl'), [
  JSON.stringify({ ts: '2026-11-24T01:10:00.000Z', ymd: TODAY, kind: 'broadcast', level: 'info', text: '旧播报' }),
  JSON.stringify({ ts: '2026-11-24T01:20:00.000Z', ymd: TODAY, kind: 'event', level: 'bad', code: '600118.SH', message: '中国卫星 48.58 跌破止损 55.70' }),
].join('\n') + '\n', 'utf8')

const BASE_ROUTE = '/dsh-invest/api/live-watch'

async function call(pathAndQuery, opts = {}) {
  const route = registered.find((item) => item.path === pathAndQuery)
  assert.ok(route, '路由未注册：' + pathAndQuery)
  const req = {
    method: opts.method || 'GET',
    url: pathAndQuery,
    socket: { remoteAddress: opts.remote || '127.0.0.1' },
    headers: { host: opts.host || 'localhost:3080', 'content-type': 'application/json' },
    on() {},
    async *[Symbol.asyncIterator]() {
      if (opts.body !== undefined) yield Buffer.from(JSON.stringify(opts.body), 'utf8')
    },
  }
  let status = 0
  let text = ''
  const res = {
    setHeader() {},
    set statusCode(v) { status = v },
    get statusCode() { return status },
    end(v) { text = v === undefined ? '' : String(v) },
  }
  await route.handler(req, res)
  return { status: status || 200, json: text ? JSON.parse(text) : null }
}

test('GET：默认关闭、标准档、三档预设齐全', async () => {
  const r = await call(BASE_ROUTE)
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.settings.enabled, false, '盯盘默认必须关闭，不能偷跑')
  assert.equal(r.json.settings.preset, '标准')
  assert.equal(r.json.settings.intervalSec, 60)
  assert.equal(r.json.settings.broadcastEveryMin, 30)
  assert.deepEqual(Object.keys(r.json.presets).sort(), ['极简', '标准', '盯盘'].sort())
  assert.equal(r.json.presets['盯盘'].intervalSec, 30)
  assert.equal(r.json.presets['极简'].broadcastEveryMin, 0)
  assert.equal(typeof r.json.session.label, 'string')
})

test('GET：市值/权重/浮盈一律用 watchlist 实时价重算，且只含实盘持仓', async () => {
  const r = await call(BASE_ROUTE)
  const s = r.json.snapshot
  // 非实盘（华能国际）必须被过滤掉；已清仓的观察条目不得出现在持仓里
  assert.equal(s.holdings.length, 4)
  assert.equal(s.holdings.find((h) => h.code === '600011.SH'), undefined)

  const expectMv = 20.58 * 2200 + 48.58 * 500 + 0.555 * 28700 + 6.25 * 1500
  assert.equal(s.account.market_value, Math.round(expectMv * 100) / 100)
  assert.equal(s.account.total_asset, Math.round((expectMv + 22228.91) * 100) / 100)
  // 账本里写的 current_price 19.5 / weight_pct 90 是旧值，不能被采信
  const u = s.holdings.find((h) => h.code === '000823.SZ')
  assert.equal(u.price, 20.58)
  assert.equal(u.market_value, Math.round(20.58 * 2200 * 100) / 100)
  assert.equal(u.weight_pct, Math.round((20.58 * 2200 / (expectMv + 22228.91)) * 100 * 100) / 100)
  assert.equal(u.pnl_pct, Math.round(((20.58 - 17.999) / 17.999) * 100 * 100) / 100)
  assert.equal(u.prev_close, 20.12, '今日涨跌要带出昨收')
  assert.equal(u.change_pct, 2.29)
  assert.equal(s.account.position_pct, Math.round((expectMv / (expectMv + 22228.91)) * 100 * 100) / 100)
})

test('GET：生效止损 position 优先，watch.stop 兜底，并与最新结论比对冲突', async () => {
  const s = (await call(BASE_ROUTE)).json.snapshot
  const st = s.holdings.find((h) => h.code === '600118.SH')
  assert.equal(st.eff_stop, 55.7)
  assert.equal(st.eff_stop_src, '档案')
  assert.equal(st.dist_stop_pct, Math.round(((48.58 - 55.7) / 55.7) * 100 * 100) / 100)
  assert.equal(st.stop_state, '已破 12.78%')
  assert.equal(st.concl_stop, 44.5, '取 ts 最大的那条结论，不是 50.0')
  assert.equal(st.stop_conflict, true)
  // 600118（20.1%）与 000823（6.3%）两条都超 3% 阈值；159813 无结论不算冲突
  assert.equal(s.conflicts.length, 2)
  assert.ok(s.conflicts.some((c) => /600118/.test(c)))
  assert.ok(s.conflicts.some((c) => /000823/.test(c)))
  // 000823 最新结论 18.45 与档案 17.35 相差 6.3% → 也超阈值，同样要报
  const u = s.holdings.find((h) => h.code === '000823.SZ')
  assert.equal(u.concl_stop, 18.45)
  assert.equal(u.stop_conflict, true)
  // 159813 无最新结论 → 不报冲突，且不能把缺数据当成冲突
  const etf = s.holdings.find((h) => h.code === '159813.SZ')
  assert.equal(etf.concl_stop, null)
  assert.equal(etf.stop_conflict, false)
  assert.equal(etf.stop_state, '缓冲 10.12%')
})

test('GET：今日信号从 last_signal_key 还原，跨日的不算', async () => {
  const s = (await call(BASE_ROUTE)).json.snapshot
  assert.deepEqual(s.holdings.find((h) => h.code === '600118.SH').signal, { kind: 'stop', at: '2026-11-24T01:20:00.000Z' })
  assert.equal(s.holdings.find((h) => h.code === '000823.SZ').signal, null)
})

test('GET：观察池只列 state=观察、按偏离买区绝对值升序、标注是否进买区', async () => {
  const s = (await call(BASE_ROUTE)).json.snapshot
  assert.deepEqual(s.watch.map((w) => w.code), ['603596.SH', '002414.SZ', '002472.SZ'])
  const near = s.watch.find((w) => w.code === '002414.SZ')
  assert.equal(near.in_buy_zone, true, '8.4 落在 8~9 之间')
  assert.equal(s.watch.find((w) => w.code === '603596.SH').in_buy_zone, false, '39.52 低于买区下沿 40')
})

test('GET：时间线新的在前；缺价只计数不抛错', async () => {
  const r = await call(BASE_ROUTE)
  assert.equal(r.json.log.length, 2)
  assert.equal(r.json.log[0].kind, 'event', '最新的排最前')
  assert.equal(r.json.log[1].kind, 'broadcast')
  assert.equal(r.json.snapshot.missing_prices, 0)
})

test('POST：选预设同时写死节奏；未知预设 400', async () => {
  const r = await call(BASE_ROUTE, { method: 'POST', body: { preset: '盯盘' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.settings.preset, '盯盘')
  assert.equal(r.json.settings.intervalSec, 30)
  assert.equal(r.json.settings.broadcastEveryMin, 15)
  // 落盘后再读一次，确认不是只在响应里改
  const back = await call(BASE_ROUTE)
  assert.equal(back.json.settings.intervalSec, 30)

  const bad = await call(BASE_ROUTE, { method: 'POST', body: { preset: '狂暴' } })
  assert.equal(bad.status, 400)
  assert.match(bad.json.error, /未知预设/)
})

test('POST：手改间隔 → 预设降级为「自定义」，避免显示与实跑不一致', async () => {
  const r = await call(BASE_ROUTE, { method: 'POST', body: { intervalSec: 45 } })
  assert.equal(r.json.settings.preset, '自定义')
  assert.equal(r.json.settings.intervalSec, 45)
  // 再改一次仍是自定义，不会因为凑巧等于某个预设值就被"认领"
  const back = await call(BASE_ROUTE, { method: 'POST', body: { intervalSec: 45, broadcastEveryMin: 15 } })
  assert.equal(back.json.settings.preset, '自定义')
  // 重新点预设仍然能回到预设档
  const again = await call(BASE_ROUTE, { method: 'POST', body: { preset: '标准' } })
  assert.equal(again.json.settings.preset, '标准')
  assert.equal(again.json.settings.intervalSec, 60)
})

test('POST：越界数值拒绝；非法 notifyLevel 忽略', async () => {
  const bad = await call(BASE_ROUTE, { method: 'POST', body: { confirmTicks: 0 } })
  assert.equal(bad.status, 400)
  assert.match(bad.json.error, /confirmTicks/)
  const r = await call(BASE_ROUTE, { method: 'POST', body: { notifyLevel: 'loud' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.settings.notifyLevel, 'bad', '非法值不应被写入')
})

test('POST：开关与 sessionOnly 可写', async () => {
  const r = await call(BASE_ROUTE, { method: 'POST', body: { enabled: true, sessionOnly: false } })
  assert.equal(r.json.settings.enabled, true)
  assert.equal(r.json.settings.sessionOnly, false)
  await call(BASE_ROUTE, { method: 'POST', body: { enabled: false } })
})

test('守卫：非环回 403、方法不对 405', async () => {
  const r = await call(BASE_ROUTE, { remote: '10.250.13.9' })
  assert.equal(r.status, 403)
  const m = await call(BASE_ROUTE, { method: 'PUT' })
  assert.equal(m.status, 405)
  // tick / ask 同样只认本机环回
  const t = await call('/dsh-invest/api/live-watch/tick', { method: 'POST', remote: '192.168.1.9' })
  assert.equal(t.status, 403)
  const a = await call('/dsh-invest/api/live-ask', { method: 'POST', remote: '192.168.1.9' })
  assert.equal(a.status, 403)
})
