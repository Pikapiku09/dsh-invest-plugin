// 选股阶段「只找新标的」测试：捕获真实阶段提示词，验证
// ① 选股阶段注入持仓排除清单、且不注入完整持仓表；
// ② 深度阶段仍注入完整持仓表（仓位/加减仓需要）；
// ③ 两个海选模板的问题文本都写明排除当前持仓。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const HOLDINGS = {
  version: 1,
  updated_at: '2026-11-09T02:00:00.000Z',
  account: { total_asset: 1148969.5, cash: 100000, available_cash: 100000 },
  positions: [
    { code: '603606.SH', name: '东方电缆', shares: 500, cost: 27.787, current_price: 29, status: '持有' },
    { code: '600011.SH', name: '华能国际', shares: 3000, cost: 7.418, current_price: 7.65, status: '持有' },
  ],
}

function makeHarness() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-screen-'))
  fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
  fs.mkdirSync(path.join(base, '.dsh-invest', 'reports'), { recursive: true })
  fs.writeFileSync(path.join(base, '.dsh-invest', '持仓.json'), JSON.stringify(HOLDINGS, null, 2))
  process.env.DSH_INVEST_BASE_DIR = base
  delete process.env.DSH_INVEST_JOB_CONCURRENCY

  const prompts = []
  const registered = []
  let capturedTool = null
  const fakeFs = {
    resolve: async (p) => p,
    readText: async (p) => fs.readFileSync(p, 'utf8'),
    writeText: async (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) },
  }
  const fakeSubagents = {
    start: (kind, spec) => {
      const text = Array.isArray(spec.prompt) ? spec.prompt.map((b) => (b && b.text) || '').join('\n') : String(spec.prompt || '')
      prompts.push({ label: String(spec.label || ''), persona: String(spec.persona || ''), text })
      return { result: Promise.resolve({ stopReason: 'stop', output: [{ type: 'text', text: '阶段输出：测试用文本。' }] }) }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'fs') return fakeFs
      if (name === 'sandboxPolicy') return { resolve: () => ({}) }
      if (name === 'subagents') return fakeSubagents
      if (name === 'subagent') return undefined
      if (name === 'agents') {
        return {
          roots: () => [],
          create: async () => ({
            agent: { session: { append() {} }, options: { provider: 'p', model: 'm' } },
            dispose: async () => {},
          }),
        }
      }
      if (name === 'llm') return { listProviders: () => [], listModels: async () => [], resolveCallConfig: async () => ({}) }
      return undefined
    },
    effect(fn) { fn() },
    webServer: { register: (route) => { registered.push(route); return () => {} } },
    tools: { register: (tool) => { capturedTool = tool; return () => {} } },
    systemPrompt: { section: () => {} },
  }
  apply(ctx, {})
  const agent = { session: { append() {} }, options: { provider: 'p', model: 'm' } }
  return {
    prompts,
    registered,
    run: (args) => capturedTool.execute(args, { callId: 'test-run', agent, signal: new AbortController().signal }),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  }
}

test('选股阶段只收到持仓排除清单，深度阶段仍收到完整持仓表', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  const result = await h.run({ mode: '选股', question: '做一次全市场海选，找新机会', roles: ['选股', '深度'] })
  assert.ok(Array.isArray(result.outputs) && result.outputs.length >= 2, '应跑完选股与深度两个阶段')

  const screener = h.prompts.find((p) => p.label.includes('选股'))
  const deep = h.prompts.find((p) => p.label.includes('深度'))
  assert.ok(screener, '应有选股阶段提示词')
  assert.ok(deep, '应有深度阶段提示词')

  // ① 选股：有硬排除清单 + 持仓代码，且不再注入完整持仓表
  assert.match(screener.text, /【选股硬约束：只找新标的】/)
  assert.match(screener.text, /603606\.SH/)
  assert.match(screener.text, /600011\.SH/)
  assert.match(screener.text, /严禁出现在候选名单中/)
  assert.doesNotMatch(screener.text, /【当前持仓账本/, '选股阶段不应再注入完整持仓表')

  // ② 深度：仍应拿到完整持仓表（成本/仓位/止损）
  assert.match(deep.text, /【当前持仓账本/)
  assert.match(deep.text, /600011\.SH/)
  assert.match(deep.text, /【账本使用规则】/)
})

test('持仓为空时不注入排除清单（不产生空约束）', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)
  fs.writeFileSync(path.join(process.env.DSH_INVEST_BASE_DIR, '.dsh-invest', '持仓.json'), JSON.stringify({ version: 1, positions: [] }))

  await h.run({ mode: '选股', question: '全市场海选', roles: ['选股'] })
  const screener = h.prompts.find((p) => p.label.includes('选股'))
  assert.ok(screener)
  assert.doesNotMatch(screener.text, /【选股硬约束：只找新标的】/)
})

test('海选模板的问题文本要求排除当前持仓，且全市场海选已下线', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)
  const route = h.registered.find((r) => r.path === '/dsh-invest/api/templates')
  assert.ok(route, '应注册 templates 路由')

  let body = ''
  const req = { method: 'GET', url: '/dsh-invest/api/templates', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' }, async *[Symbol.asyncIterator]() {} }
  const res = { setHeader() {}, statusCode: 0, end(v) { body = String(v || '') } }
  await route.handler(req, res)
  const json = JSON.parse(body)
  const full = json.templates.find((x) => x.id === 'market-screen-full')
  const quick = json.templates.find((x) => x.id === 'market-screen')
  assert.ok(full)
  // 全市场海选快版已下线：一键任务里由「观察仓日检」取代
  assert.equal(quick, undefined, 'market-screen 不应再出现在模板列表')
  // templates 接口只返回元信息，问题文本在 /api/run 的 job 上；这里直接校验 TASK_TEMPLATES 经 run 后的 question
  const quickRun = await h.run({ mode: '选股', question: 'x', roles: ['选股'] })
  assert.ok(quickRun)

  const runRoute = h.registered.find((r) => r.path === '/dsh-invest/api/run')
  const jobsRoute = h.registered.find((r) => r.path === '/dsh-invest/api/jobs')
  const post = async (route, payload) => {
    let out = ''
    const rq = {
      method: 'POST', url: route.path, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)) },
    }
    const rs = { setHeader() {}, statusCode: 0, end(v) { out = String(v || '') } }
    await route.handler(rq, rs)
    return JSON.parse(out)
  }
  await post(runRoute, { templateId: 'market-screen' })
  await post(runRoute, { templateId: 'market-screen-full' })
  let jobsBody = ''
  const jr = { method: 'GET', url: '/dsh-invest/api/jobs', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' }, async *[Symbol.asyncIterator]() {} }
  const js = { setHeader() {}, statusCode: 0, end(v) { jobsBody = String(v || '') } }
  await jobsRoute.handler(jr, js)
  const jobs = JSON.parse(jobsBody).jobs || []
  const fullJob = jobs.find((j) => j.templateId === 'market-screen-full')
  assert.ok(fullJob, '全流程海选应能入队')
  assert.match(fullJob.question, /排除账户当前持仓/)
})
