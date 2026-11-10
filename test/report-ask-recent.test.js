// 报告追问 + 最近任务持久化 路由测试
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const REPORT_NAME = '20261109_144530_3fq4_全市场海选全流程.md'
const REPORT_BODY = [
  '# 投研流水线报告',
  '',
  '- 模式：选股',
  '- 结论：候选池 6 只，首选 601333.SH，目标 8.8，止损 7.9',
  '',
  '## 核心逻辑',
  '主力资金连续 3 日净流入，周线突破 MA20，板块景气度上行。',
].join('\n')

function makeHarness({ agentMode = 'ok' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-ask-'))
  const reportsDir = path.join(base, '.dsh-invest', 'reports')
  fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
  fs.mkdirSync(reportsDir, { recursive: true })
  const reportPath = path.join(reportsDir, REPORT_NAME)
  fs.writeFileSync(reportPath, REPORT_BODY, 'utf8')
  process.env.DSH_INVEST_BASE_DIR = base
  process.env.DSH_INVEST_SKIP_REINDEX = '1'
  delete process.env.DSH_INVEST_JOB_CONCURRENCY

  const prompts = []
  const promptShapes = []
  const registered = []
  const fakeFs = {
    resolve: async (p) => p,
    readText: async (p) => fs.readFileSync(p, 'utf8'),
    writeText: async (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) },
  }
  const fakeSubagents = {
    start: (kind, spec) => {
      promptShapes.push({ array: Array.isArray(spec.prompt), firstType: Array.isArray(spec.prompt) && spec.prompt[0] ? spec.prompt[0].type : null })
      prompts.push(Array.isArray(spec.prompt) ? spec.prompt.map((b) => (b && b.text) || '').join('\n') : String(spec.prompt || ''))
      return { result: Promise.resolve({ stopReason: 'stop', output: [{ type: 'text', text: '报告里说首选 601333.SH，目标 8.8，止损 7.9。' }] }) }
    },
  }
  const parentAgent = { session: { append() {} }, options: { provider: 'p', model: 'm' } }
  const ctx = {
    get(name) {
      if (name === 'fs') return fakeFs
      if (name === 'sandboxPolicy') return { resolve: () => ({}) }
      if (name === 'subagents') return fakeSubagents
      if (name === 'subagent') return undefined
      if (name === 'agents') {
        if (agentMode === 'no-agent') return { roots: () => [], create: async () => { throw new Error('no agents') } }
        return { roots: () => [parentAgent], create: async () => ({ agent: parentAgent, dispose: async () => {} }) }
      }
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
    let status = 0
    let text = ''
    const req = {
      method, url: pathAndQuery,
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost:3080' },
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    }
    const res = {
      setHeader() {}, set statusCode(v) { status = v }, get statusCode() { return status },
      end(v) { text = v === undefined ? '' : String(v) },
    }
    await route.handler(req, res)
    return { status: status || 200, json: text ? JSON.parse(text) : null }
  }

  return {
    base, reportPath, prompts, promptShapes, call,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  }
}

test('报告追问：带报告全文与历史，返回模型答复', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  const { status, json } = await h.call('POST', '/dsh-invest/api/report-ask', {
    path: h.reportPath,
    question: '这份报告的首选标的和止损是多少？',
    history: [{ role: 'user', text: '先说说核心结论' }, { role: 'assistant', text: '核心结论是候选 6 只。' }],
  })
  assert.equal(status, 200)
  assert.match(json.answer, /601333\.SH/)
  assert.ok(json.elapsedMs >= 0)
  const prompt = h.prompts[0]
  assert.ok(prompt, '应调用一次子代理')
  assert.match(prompt, /【报告全文】/)
  assert.match(prompt, /主力资金连续 3 日净流入/, '应把报告正文注入提示词')
  assert.match(prompt, /【本轮问题】这份报告的首选标的和止损是多少？/)
  assert.match(prompt, /【对话历史】/, '多轮追问应带历史')
  assert.ok(h.promptShapes[0] && h.promptShapes[0].array === true, 'spawn 的 prompt 必须是内容块数组（否则宿主报 content.some is not a function）')
  assert.equal(h.promptShapes[0].firstType, 'text')
  assert.match(prompt, /核心结论是候选 6 只/, '历史内容应进入提示词')
})

test('报告追问：路径白名单与空问题校验', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  const outside = await h.call('POST', '/dsh-invest/api/report-ask', {
    path: 'C:/Windows/system.ini', question: '读一下',
  })
  assert.equal(outside.status, 400, '工作区外路径应拒绝')

  const notMd = await h.call('POST', '/dsh-invest/api/report-ask', {
    path: path.join(h.base, '.dsh-invest', 'store', 'watchlist.json'), question: '读一下',
  })
  assert.equal(notMd.status, 400, '非 .md 文件应拒绝')

  const empty = await h.call('POST', '/dsh-invest/api/report-ask', { path: h.reportPath, question: '   ' })
  assert.equal(empty.status, 400, '空问题应拒绝')
})

test('最近任务持久化：任务结束写入 recent，最多保留 5 个', async (t) => {
  const h = makeHarness({ agentMode: 'no-agent' })
  t.after(h.cleanup)

  for (let i = 0; i < 7; i += 1) {
    const res = await h.call('POST', '/dsh-invest/api/run', { templateId: 'market-screen' })
    assert.equal(res.status, 202)
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  const listed = await h.call('GET', '/dsh-invest/api/jobs')
  const recent = listed.json.recent || []
  assert.equal(recent.length, 5, '最近任务只保留 5 个')
  assert.ok(recent.every((item) => item.id && item.templateId === 'market-screen'))
  assert.equal(recent[0].status, 'failed', '无执行 Agent 时应记录失败状态')
  assert.ok(typeof recent[0].question === 'string' && recent[0].question.length > 0)

  // 落盘校验：跨进程重启后仍可读
  const file = path.join(process.env.DSH_INVEST_BASE_DIR, '.dsh-invest', 'store', 'recent-jobs.json')
  assert.ok(fs.existsSync(file), '应写入 recent-jobs.json')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.jobs.length, 5)
})

test('最近任务持久化：不重复记录同一个任务', async (t) => {
  const h = makeHarness({ agentMode: 'no-agent' })
  t.after(h.cleanup)

  await h.call('POST', '/dsh-invest/api/run', { templateId: 'market-screen' })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const listed = await h.call('GET', '/dsh-invest/api/jobs')
  const ids = (listed.json.recent || []).map((item) => item.id)
  assert.equal(new Set(ids).size, ids.length, '同一任务不应重复出现')
})
