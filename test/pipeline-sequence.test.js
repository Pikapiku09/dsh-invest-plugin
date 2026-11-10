// 流水线顺序（A）与逐层收窄（C）测试
// A：buildGroups 支持显式 sequence → 各角色一段严格串行；不传时行为与旧版完全一致。
// C：新增「海选·全流程」模板把候选宽度写死（8 → 3-4 → 3）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildGroups } from '../packages/dsh-invest/lib/pure.js'
import { apply } from '../packages/dsh-invest/lib/index.js'

const ROLE_MAP = {
  选股: { code: '选股', name: '选股分析师' },
  消息: { code: '消息', name: '市场重点消息获取师' },
  深度: { code: '深度', name: '股票深度分析师' },
  总判断: { code: '总判断', name: '总判断师' },
  波段: { code: '波段', name: '波段池管理师' },
}
const names = (groups) => groups.map((group) => group.map((role) => role.code).join('∥'))

test('不传 sequence：保持旧默认分组（选股∥消息 → 深度 → 总判断）', () => {
  const groups = buildGroups(['选股', '消息', '深度', '总判断'], ROLE_MAP)
  assert.deepEqual(names(groups), ['选股∥消息', '深度', '总判断'])
})

test('早盘异动（消息+选股）仍是串行特例', () => {
  assert.deepEqual(names(buildGroups(['消息', '选股'], ROLE_MAP)), ['消息', '选股'])
})

test('显式 sequence：四角色各成一段严格串行', () => {
  const groups = buildGroups(['选股', '消息', '深度', '总判断'], ROLE_MAP, ['选股', '消息', '深度', '总判断'])
  assert.deepEqual(names(groups), ['选股', '消息', '深度', '总判断'])
})

test('sequence 中不属于本次 roles 的角色被忽略', () => {
  const groups = buildGroups(['选股', '深度'], ROLE_MAP, ['总判断', '选股', '深度'])
  assert.deepEqual(names(groups), ['选股', '深度'])
})

test('sequence 漏掉的 role 不会被丢弃（补在末尾）', () => {
  const groups = buildGroups(['选股', '消息', '深度'], ROLE_MAP, ['选股', '深度'])
  assert.deepEqual(names(groups), ['选股', '深度', '消息'])
})

// ---- 模板层：海选·全流程 ----
function makeHarness() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-pipeline-'))
  fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
  process.env.DSH_INVEST_BASE_DIR = base
  const registered = []
  const fakeFs = {
    resolve: async (p) => p,
    readText: async (p) => fs.readFileSync(p, 'utf8'),
    writeText: async (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) },
  }
  const ctx = {
    get(name) {
      if (name === 'fs') return fakeFs
      if (name === 'sandboxPolicy') return { resolve: () => ({}) }
      if (name === 'agents') return { roots: () => [], create: () => new Promise(() => {}) }
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
  return { call, cleanup: () => { fs.rmSync(base, { recursive: true, force: true }); delete process.env.DSH_INVEST_JOB_CONCURRENCY } }
}

test('templates API 暴露「海选·全流程」及其串行顺序与逐层收窄约束', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)
  const { json } = await h.call('GET', '/dsh-invest/api/templates')
  const full = (json.templates || []).find((item) => item.id === 'market-screen-full')
  assert.ok(full, '应存在 market-screen-full 模板')
  assert.deepEqual(full.sequence, ['选股', '消息', '深度', '总判断'])
  assert.deepEqual(full.roles, ['选股', '消息', '深度', '总判断'])
  const quick = (json.templates || []).find((item) => item.id === 'market-screen')
  assert.equal(quick.sequence, null, '快版仍走默认并行分组')

  // C：逐层宽度约束 —— 全流程 question 里写死 8 / 3-4 / 3
  const { json: runJson } = await h.call('POST', '/dsh-invest/api/run', { templateId: 'market-screen-full' })
  assert.ok(runJson.jobId)
  const listed = await h.call('GET', '/dsh-invest/api/jobs')
  const job = listed.json.jobs.find((item) => item.id === runJson.jobId)
  assert.deepEqual(job.sequence, ['选股', '消息', '深度', '总判断'], 'job 应携带串行顺序')
  assert.match(job.question, /候选池 ≤8 只/)
  assert.match(job.question, /评分最高的 3-4 只/)
  assert.match(job.question, /最终 ≤3 只/)
})

test('快版海选 question 也带逐层收窄约束（C）', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)
  const { json } = await h.call('POST', '/dsh-invest/api/run', { templateId: 'market-screen' })
  const listed = await h.call('GET', '/dsh-invest/api/jobs')
  const job = listed.json.jobs.find((item) => item.id === json.jobId)
  assert.equal(job.sequence, null, '快版不应带串行顺序')
  assert.match(job.question, /候选池 ≤8 只/)
  assert.match(job.question, /评分最高的 3-5 只/)
})
