// 结论采集口径与审计（v0.45.0）
//
// 背景：旧实现只采集「最后一个含结构化结论的阶段、最多 3 条」，
// 选股模式四阶段里，选股师的候选会被总判断师的 3 条覆盖——这是真实的数据遗漏点。
// 本测试锁定新口径：所有成功阶段的结论都要入库、同标的下游优先、confidence/counter_case 保留。
//
// 另覆盖：采集审计的覆盖率口径（recovered 不算遗漏）、历史报告回溯补录的幂等性。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const block = (obj) => '【结论结构化】' + JSON.stringify(obj)

function makeHarness(options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-audit-'))
  const storeDir = path.join(base, '.dsh-invest', 'store')
  const reportsDir = path.join(base, '.dsh-invest', 'reports')
  fs.mkdirSync(storeDir, { recursive: true })
  fs.mkdirSync(reportsDir, { recursive: true })
  process.env.DSH_INVEST_BASE_DIR = base
  process.env.DSH_INVEST_SKIP_REINDEX = '1'
  process.env.DSH_INVEST_WATCH_DAILY = '0'
  process.env.DSH_INVEST_SKIP_STOCK_NOTES = '1'
  process.env.DSH_INVEST_AUTO_CURATE = '0'

  if (options.runs) fs.writeFileSync(path.join(base, '.dsh-invest', 'runs.jsonl'), options.runs.map((r) => JSON.stringify(r)).join('\n') + '\n')
  if (options.conclusions) fs.writeFileSync(path.join(storeDir, 'conclusions.jsonl'), options.conclusions.map((c) => JSON.stringify(c)).join('\n') + '\n')
  if (options.holdings) fs.writeFileSync(path.join(base, '.dsh-invest', '持仓.json'), JSON.stringify(options.holdings, null, 2))
  for (const [name, body] of Object.entries(options.reports || {})) fs.writeFileSync(path.join(reportsDir, name), body, 'utf8')

  const registered = []
  let capturedTool = null
  const fakeFs = {
    resolve: async (p) => p,
    readText: async (p) => fs.readFileSync(p, 'utf8'),
    writeText: async (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) },
  }
  const fakeSubagents = {
    start: (kind, spec) => {
      const label = String(spec.label || '')
      const text = (options.stageText || (() => '普通输出'))(label)
      return { result: Promise.resolve({ stopReason: 'stop', output: [{ type: 'text', text }] }) }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'fs') return fakeFs
      if (name === 'sandboxPolicy') return { resolve: () => ({}) }
      if (name === 'subagents') return fakeSubagents
      if (name === 'subagent') return undefined
      if (name === 'agents') return { roots: () => [], create: async () => ({ agent: { session: { append() {} }, options: { provider: 'p', model: 'm' } }, dispose: async () => {} }) }
      if (name === 'llm') return { listProviders: () => [], listModels: async () => [], resolveCallConfig: async () => ({}) }
      return undefined
    },
    effect(fn) { fn() },
    webServer: { register: (r) => { registered.push(r); return () => {} } },
    tools: { register: (tool) => { capturedTool = tool; return () => {} } },
    systemPrompt: { section: () => {} },
  }
  apply(ctx, {})

  async function call(method, pathName, body) {
    const route = registered.find((r) => r.path === pathName)
    assert.ok(route, '路由未注册：' + pathName)
    let status = 0
    let text = ''
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method, url: pathName, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' },
      async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
    }
    const res = { setHeader() {}, set statusCode(v) { status = v }, get statusCode() { return status }, end(v) { text = String(v ?? '') } }
    await route.handler(req, res)
    return { status, json: text ? JSON.parse(text) : null }
  }

  const agent = { session: { append() {} }, options: { provider: 'p', model: 'm' } }
  return {
    base,
    call,
    readConclusions: () => {
      const p = path.join(storeDir, 'conclusions.jsonl')
      if (!fs.existsSync(p)) return []
      return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    },
    run: (args) => capturedTool.execute(args, { callId: 'test-run-1', agent, signal: new AbortController().signal }),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  }
}

test('结论采集：所有阶段的结论都入库（旧实现只取最后一阶段的 3 条）', async (t) => {
  const h = makeHarness({
    stageText: (label) => {
      if (label.includes('选股')) {
        return '选股结论\n' + block({ code: '600519.SH', stance: '观察', confidence: 0.6, target: 1500, thesis: '选股理由A' })
          + '\n' + block({ code: '000001.SZ', stance: '观察', confidence: 0.55, thesis: '选股理由B' })
      }
      if (label.includes('深度')) {
        return '深度结论\n' + block({ code: '600519.SH', stance: '看多', confidence: 0.82, target: 1600, thesis: '深度理由', counter_case: '若跌破 1380 则逻辑失效' })
      }
      return '总判断结论\n' + block({ code: '601899.SH', stance: '拒绝', confidence: 0.7, thesis: '总判断理由' })
    },
  })
  t.after(h.cleanup)

  await h.run({ mode: '深度分析', question: '看看 600519 和紫金', roles: ['选股', '深度', '总判断'] })
  const rows = h.readConclusions()
  const codes = rows.map((r) => r.code).sort()
  assert.deepEqual(codes, ['000001.SZ', '600519.SH', '601899.SH'], '三个阶段的不同标的都应入库')

  // 同标的 600519：下游「深度」覆盖选股，且保留 confidence 与 counter_case
  const mt = rows.find((r) => r.code === '600519.SH')
  assert.equal(mt.stance, '看多', '下游阶段覆盖上游')
  assert.equal(mt.stage, '股票深度分析师')
  assert.equal(mt.confidence, 0.82, 'confidence 应被保存')
  assert.match(mt.counter_case, /1380/, 'counter_case 应被保存')

  // 选股独有标的（000001.SZ）不再被丢掉——这正是旧实现的遗漏点
  const pa = rows.find((r) => r.code === '000001.SZ')
  assert.equal(pa.stage, '选股分析师')
  assert.equal(pa.confidence, 0.55)

  // 溯源字段齐备
  for (const r of rows) {
    assert.ok(r.callId, 'callId 必须存在')
    assert.ok(r.report, 'report 必须存在')
    assert.equal(r.source, 'invest_run')
  }
})

test('结论采集：顺从上游噪声的非法代码/越界置信度被丢弃或归零', async (t) => {
  const h = makeHarness({
    stageText: () => [
      block({ code: '600519', stance: '看多', confidence: 0.9 }),          // 缺后缀 → 丢弃
      block({ code: '600519.SH', stance: '看多', confidence: 3.5 }),      // 置信度越界 → null
      block({ code: '600011.SH', stance: '持有', confidence: 0.4 }),
    ].join('\n'),
  })
  t.after(h.cleanup)
  await h.run({ mode: '个股', question: '体检', roles: ['深度'] })
  const rows = h.readConclusions()
  assert.deepEqual(rows.map((r) => r.code).sort(), ['600011.SH', '600519.SH'])
  assert.equal(rows.find((r) => r.code === '600519.SH').confidence, null, '越界置信度应置 null 而不是保留 3.5')
})

test('采集审计：recovered 回填不算遗漏，覆盖率用真实运行作分母', async (t) => {
  const h = makeHarness({
    runs: [
      { ts: '2026-11-12T02:00:00.000Z', mode: '个股', callId: 'r1', ok: true, stages: [{ stage: '股票深度分析师', ok: true, ms: 1000 }] },
      { ts: '2026-11-12T02:10:00.000Z', mode: '个股', callId: 'r2', ok: true, stages: [{ stage: '股票深度分析师', ok: true, ms: 1000 }] },
      { ts: '2026-11-12T02:20:00.000Z', mode: '组合', callId: 'recovered-1', ok: true, recovered: true, stages: [] },
    ],
    conclusions: [{ ts: '2026-11-12T02:00:00.000Z', code: '600519.SH', stance: '看多', callId: 'r1' }],
  })
  t.after(h.cleanup)
  const r = await h.call('GET', '/dsh-invest/api/conclusions-audit')
  assert.equal(r.status, 200)
  const j = r.json
  assert.equal(j.runs.total, 3)
  assert.equal(j.runs.recovered, 1, '识别出 1 条回填记录')
  assert.equal(j.runs.realTotal, 2, '真实运行只有 2 条')
  assert.equal(j.runs.realWith, 1)
  assert.equal(j.runs.realCoverage, 50, '1/2 = 50%')
  assert.ok(j.missing.some((m) => m.reason.includes('未包含【结论结构化】行')), '应给出未进库原因')
  assert.ok(j.lineage && j.lineage.source, '必须暴露采集口径，便于用户核对')
})

test('执行率对账：建议与持仓不一致时会列出来', async (t) => {
  const h = makeHarness({
    holdings: { positions: [{ code: '600011.SH', name: '华能国际', shares: 100, cost: 7.4, status: '持有' }] },
    conclusions: [
      { ts: '2026-11-12T02:00:00.000Z', code: '600011.SH', stance: '减仓', callId: 'r1' },
      { ts: '2026-11-12T02:00:00.000Z', code: '600519.SH', stance: '看多', callId: 'r1' },
    ],
  })
  t.after(h.cleanup)
  const r = await h.call('GET', '/dsh-invest/api/conclusions-audit')
  const ex = r.json.execution
  assert.equal(ex.available, true)
  assert.equal(ex.positions, 1)
  const kinds = ex.notExecuted.map((x) => x.code + ':' + x.kind)
  assert.ok(kinds.some((k) => k.startsWith('600011.SH') && k.includes('减仓')), '持有但建议减仓 → 未执行')
  assert.ok(kinds.some((k) => k.startsWith('600519.SH') && k.includes('无持仓')), '看多但未持仓 → 未执行')
})

test('回溯补录：从历史报告捞结构化行，且可反复执行（幂等）', async (t) => {
  const report = [
    '# 投研流水线报告', '', '- 模式：个股', '',
    block({ code: '600519.SH', stance: '观察', confidence: 0.5, thesis: '历史报告里的结论' }),
    block({ code: '000001.SZ', stance: '拒绝', thesis: '历史报告里的第二条' }),
  ].join('\n')
  const h = makeHarness({ reports: { '20261101_100000_aaaa_历史测试.md': report } })
  t.after(h.cleanup)

  const dry = await h.call('POST', '/dsh-invest/api/conclusions-backfill', { apply: false })
  assert.equal(dry.json.candidates, 2, '预演应识别 2 条候选')
  assert.equal(h.readConclusions().length, 0, '预演不得写盘')

  const applied = await h.call('POST', '/dsh-invest/api/conclusions-backfill', { apply: true })
  assert.equal(applied.json.added, 2)
  const rows = h.readConclusions()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].source, 'backfill')
  assert.match(rows[0].report, /20261101_100000_aaaa/)

  const again = await h.call('POST', '/dsh-invest/api/conclusions-backfill', { apply: true })
  assert.equal(again.json.candidates, 0, '重复执行不应重复录入')
  assert.equal(h.readConclusions().length, 2)
})
