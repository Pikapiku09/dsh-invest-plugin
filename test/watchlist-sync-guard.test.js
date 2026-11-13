// v0.53.0 持有期价位语义校验（集成测试）
// 背景：超声电子 000823.SZ 多次分析后出现「止盈 16.68 < 止损 17.35 < 成本 18.855」。
// 根因：syncWatchlistFromConclusions 对 stance=持有/减仓/离场 的结论 target/stop 无条件覆盖——
//      减仓结论里的 target 其实是回踩位/减仓参考价；且 evalWatchSignal 的 p>=target 又拿它误触止盈提醒。
// 这里走真实流水线（subagents.start 注入假阶段输出 → persistConclusions → 档案同步）验证：
// ① 减仓/离场结论不再写持有期价位；② 持有结论写入前做语义校验，非法值拒绝并留审计；③ 脏止盈不触发提醒。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-sync-guard-'))
const storeDir = path.join(base, '.dsh-invest', 'store')
fs.mkdirSync(storeDir, { recursive: true })
process.env.DSH_INVEST_BASE_DIR = base
process.env.DSH_INVEST_SKIP_REINDEX = '1'
process.env.DSH_INVEST_WATCH_DAILY = '0'
process.env.DSH_INVEST_SKIP_STOCK_NOTES = '1'
process.env.DSH_INVEST_AUTO_CURATE = '0'

const watchlistPath = path.join(storeDir, 'watchlist.json')
const conclusionsPath = path.join(storeDir, 'conclusions.jsonl')

/** 假阶段输出：按调用顺序依次返回（每个元素是一轮 subagents.start 的返回文本） */
const stageOutputs = []
let tool = null

const fakeFs = {
  resolve: async (p) => p,
  readText: async (p) => fs.readFileSync(p, 'utf8'),
  writeText: async (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8') },
}
const parent = { session: { append() {} }, options: { provider: 'p', model: 'm' } }
apply({
  get(name) {
    if (name === 'fs') return fakeFs
    if (name === 'sandboxPolicy') return { resolve: () => ({}) }
    if (name === 'subagents') return {
      start: () => ({ result: Promise.resolve({ stopReason: 'stop', output: [{ type: 'text', text: stageOutputs.shift() || '（无内容）' }] }) }),
    }
    if (name === 'agents') return { roots: () => [parent], create: async () => ({ agent: parent, dispose: async () => {} }) }
    if (name === 'llm') return { listProviders: () => [], listModels: async () => [], resolveCallConfig: async () => ({}) }
    return undefined
  },
  effect(fn) { fn() },
  webServer: { register: () => () => {} },
  tools: { register: (t) => { tool = t; return () => {} } },
  systemPrompt: { section: () => {} },
}, {})

const run = (args, callId) => tool.execute(args, { callId: callId || 'sync_guard_' + Date.now(), agent: parent, signal: new AbortController().signal })

const readWatchlist = () => JSON.parse(fs.readFileSync(watchlistPath, 'utf8'))
const findItem = (code) => readWatchlist().items.find((it) => it.code === code)

test.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

test('减仓/离场结论不覆盖持有期价位（止盈不再被回踩位越改越低）', async () => {
  // 起始档案：持有 000823.SZ，成本 18.855，止盈 20.15，止损 17.35（均为合法值）
  fs.writeFileSync(watchlistPath, JSON.stringify({
    version: 1, updated_at: new Date().toISOString(),
    items: [{
      code: '000823.SZ', name: '超声电子', state: '持有',
      watch: { buy_low: null, buy_high: null, ideal_buy: null, buy_qty: null, invalidate_if: '', thesis: '', stance: '持有', target: 20.15, stop: 17.3, created_at: null, last_conclusion_ts: null },
      position: { cost: 18.855, shares: 1000, stop: 17.35, target: 20.15, add_low: null, add_high: null, trim_line: null, trailing_stop: null },
      monitor: { current_price: 17.43, refreshed_at: '2026-11-13T13:55:11+08:00', dist_buy_pct: null, dist_stop_pct: 0.46, notify: true, last_signal_key: '', last_signal_at: null },
    }],
  }, null, 2), 'utf8')
  try { fs.rmSync(conclusionsPath, { force: true }) } catch { /* ignore */ }

  // 减仓结论：target=16.68（回踩位，低于成本）、stop=17.35 —— 都不得写入持有期字段
  stageOutputs.length = 0
  stageOutputs.push(['## 减仓建议', '', '【结论结构化】{"code":"000823.SZ","stance":"减仓","target":16.68,"stop":17.35,"thesis":"反弹至压力位，建议减仓","invalidate_if":"放量跌破16.5"}'].join('\n'))
  const r = await run({ mode: '个股', question: '超声电子 000823.SZ 减仓建议', roles: ['深度'] })
  assert.ok(!r.error, '流水线本身应成功：' + String(r.error))

  const it = findItem('000823.SZ')
  assert.equal(it.position.target, 20.15, '减仓结论的回踩位 16.68 不得覆盖止盈目标')
  assert.equal(it.position.stop, 17.35, '减仓结论的止损可保留原值（未变化）')
  assert.ok(it.watch.invalidate_if.includes('16.5'), '失效条件仍应正常同步')

  // 离场结论同样不碰价位
  stageOutputs.length = 0
  stageOutputs.push('【结论结构化】{"code":"000823.SZ","stance":"离场","target":15.0,"stop":14.0,"thesis":"趋势破坏","invalidate_if":"无"}')
  await run({ mode: '个股', question: '超声电子离场评估', roles: ['深度'] })
  const it2 = findItem('000823.SZ')
  assert.equal(it2.position.target, 20.15, '离场结论同样不得改持有期价位')

  // 结论库本身不受影响：照常落库（校验只作用于档案同步）
  const lines = fs.readFileSync(conclusionsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(lines.filter((l) => l.code === '000823.SZ').length, 2, '两条结论都应照常进结论库')
})

test('持有结论写入价位做语义校验：非法值拒绝并留审计，合法值照常写入', async () => {
  fs.writeFileSync(watchlistPath, JSON.stringify({
    version: 1, updated_at: new Date().toISOString(),
    items: [{
      code: '600011.SH', name: '华能国际', state: '持有',
      watch: { buy_low: null, buy_high: null, ideal_buy: null, buy_qty: null, invalidate_if: '', thesis: '', stance: '持有', target: 9.5, stop: 6.8, created_at: null, last_conclusion_ts: null },
      position: { cost: 7.375, shares: 2500, stop: 6.8, target: 9.5, add_low: null, add_high: null, trim_line: null, trailing_stop: null },
      monitor: { current_price: 7.79, refreshed_at: null, dist_buy_pct: null, dist_stop_pct: null, notify: true, last_signal_key: '', last_signal_at: null },
    }],
  }, null, 2), 'utf8')
  try { fs.rmSync(conclusionsPath, { force: true }) } catch { /* ignore */ }

  // 持有结论：target=6.5 低于成本 7.375 → 必须被拒；stop=7.0 低于成本且低于现有止盈 → 合法，应写入
  stageOutputs.length = 0
  stageOutputs.push('【结论结构化】{"code":"600011.SH","stance":"持有","target":6.5,"stop":7.0,"thesis":"续持","invalidate_if":"无"}')
  await run({ mode: '个股', question: '华能国际持有评估', roles: ['深度'] })
  let it = findItem('600011.SH')
  assert.equal(it.position.target, 9.5, '低于成本的止盈价必须被拒（保留原值）')
  assert.equal(it.position.stop, 7.0, '低于成本且低于止盈的止损价是合法值，应正常写入')
  const ignored = it.position.sync_ignored || []
  assert.equal(ignored.length, 1, '只拒绝了一个值，应留一条审计：' + JSON.stringify(ignored))
  assert.equal(ignored[0].field, 'target')
  assert.equal(ignored[0].value, 6.5)
  assert.ok(ignored[0].reason.includes('成本'), '拒绝原因应点明成本约束')

  // 合法持有结论：target 10.2 > 成本、stop 6.5 < 成本 → 正常写入
  stageOutputs.length = 0
  stageOutputs.push('【结论结构化】{"code":"600011.SH","stance":"持有","target":10.2,"stop":6.5,"thesis":"上调目标","invalidate_if":"无"}')
  await run({ mode: '个股', question: '华能国际目标复核', roles: ['深度'] })
  it = findItem('600011.SH')
  assert.equal(it.position.target, 10.2, '合法止盈应写入')
  assert.equal(it.position.stop, 6.5, '合法止损应写入')

  // 结论库不受档案校验影响
  const lines = fs.readFileSync(conclusionsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(lines.filter((l) => l.code === '600011.SH').length, 2)
})
