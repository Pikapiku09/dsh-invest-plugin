// 「最近任务」取消任务（v0.75.6）：排队中直接摘出队列、运行中立刻中断。
// 用可控的 agents.create 把任务钉在 running（还没走到 tool.execute）与排队两种状态。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

function makeHarness(options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-cancel-'))
  fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
  process.env.DSH_INVEST_BASE_DIR = base
  process.env.DSH_INVEST_SKIP_REINDEX = '1'
  process.env.DSH_INVEST_SKIP_STOCK_NOTES = '1'

  const registered = []
  const lifecycle = { created: 0, disposed: 0 }
  const fakeFs = {
    resolve: async (p) => p,
    readText: async (p) => fs.readFileSync(p, 'utf8'),
    writeText: async (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) },
  }
  const fakeAgent = {
    id: 'agent-task-cancel',
    options: { provider: 'test-provider', model: 'test-model' },
    session: { header: { id: 'session-task-cancel', cwd: base }, append() {}, requestHeader: () => undefined },
  }
  const agents = {
    list: () => [fakeAgent],
    get: (id) => (id === fakeAgent.id ? fakeAgent : undefined),
    create: options.create || (async () => ({ agent: fakeAgent, dispose: async () => { lifecycle.disposed += 1 } })),
  }
  const ctx = {
    get(name) {
      if (name === 'fs') return fakeFs
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: base }) }
      if (name === 'agents') return agents
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
      method, url: pathAndQuery,
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

  const submit = () => call('POST', '/dsh-invest/api/run', { templateId: 'watch-daily' })
  const jobs = () => call('GET', '/dsh-invest/api/jobs')
  const job = (id) => call('GET', '/dsh-invest/api/job?id=' + encodeURIComponent(id))
  const cancel = (id) => call('POST', '/dsh-invest/api/job/cancel', { id })

  const cleanup = () => {
    fs.rmSync(base, { recursive: true, force: true })
    delete process.env.DSH_INVEST_BASE_DIR
    delete process.env.DSH_INVEST_JOB_CONCURRENCY
    delete process.env.DSH_INVEST_SKIP_REINDEX
    delete process.env.DSH_INVEST_SKIP_STOCK_NOTES
  }
  return { base, call, submit, jobs, job, cancel, lifecycle, cleanup }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('排队中的任务可以直接取消：摘出队列、状态记为已取消、不占用并发位', async (t) => {
  const h = makeHarness({
    // 第一个任务钉在 running（create 永不 resolve），第二个必然排队
    create: () => new Promise(() => {}),
  })
  process.env.DSH_INVEST_JOB_CONCURRENCY = '1'
  t.after(h.cleanup)

  const first = await h.submit()
  const second = await h.submit()
  await wait(150)

  const before = (await h.jobs()).json
  assert.equal(before.running, 1)
  assert.equal(before.queued, 1)

  const cancelled = await h.cancel(second.json.jobId)
  assert.equal(cancelled.status, 200, '取消排队任务应成功：' + JSON.stringify(cancelled.json))
  assert.equal(cancelled.json.ok, true)
  assert.equal(cancelled.json.status, 'cancelled')

  const after = (await h.jobs()).json
  assert.equal(after.queued, 0, '取消后不应再占用排队位')
  assert.equal(after.running, 1, '不能影响正在运行的任务')
  const target = after.jobs.find((item) => item.id === second.json.jobId)
  assert.equal(target.status, 'cancelled')
  assert.equal(target.error.includes('取消'), true)
  const survivor = after.jobs.find((item) => item.id === first.json.jobId)
  assert.equal(survivor.status, 'running')

  // 已取消的任务不能被取消第二次
  const again = await h.cancel(second.json.jobId)
  assert.equal(again.status, 409)

  // 不存在的任务
  const missing = await h.cancel('job_does_not_exist')
  assert.equal(missing.status, 404)
})

test('运行中的任务取消后立刻中断：不会再进入 tool.execute，执行 Agent 正常释放', async (t) => {
  const h = makeHarness({
    // create 延迟返回：任务处在 running 但还没走到 tool.execute，正好用来验证中断闸门
    create: async () => {
      await wait(400)
      return { agent: { id: 'agent-late', options: {}, session: { header: { cwd: hBase() }, append() {}, requestHeader: () => undefined } }, dispose: async () => { h.lifecycle.disposed += 1 } }
    },
  })
  process.env.DSH_INVEST_JOB_CONCURRENCY = '1'
  t.after(h.cleanup)

  function hBase() { return h.base }

  const submitted = await h.submit()
  await wait(120)

  const mid = (await h.job(submitted.json.jobId)).json
  assert.equal(mid.status, 'running', '取消前应处于运行中')

  const cancelled = await h.cancel(submitted.json.jobId)
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json))
  assert.equal(cancelled.json.status, 'cancelled')

  // 立刻可读：不必等 create 返回，状态就该是已取消
  const immediate = (await h.job(submitted.json.jobId)).json
  assert.equal(immediate.status, 'cancelled')

  await wait(700)
  const settled = (await h.job(submitted.json.jobId)).json
  assert.equal(settled.status, 'cancelled', '结束后不能被工具结果覆盖成 done/failed：' + JSON.stringify(settled))
  assert.equal(settled.result, undefined, '取消的任务不应产生分析结果')
  assert.equal(h.lifecycle.disposed, 1, '专用执行 Agent 必须释放，不能泄漏')
})
