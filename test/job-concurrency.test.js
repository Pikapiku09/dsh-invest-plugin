// 一键任务并发池测试：验证默认并发 2、超出的任务排队、可用环境变量调整为串行。
// 用「永不 resolve 的 agents.create」把任务钉在 running 态，便于观察 运行中/排队 计数。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

function makeHarness() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-jobs-'))
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
      if (name === 'agents') {
        return {
          roots: () => [],
          // 永不 resolve：任务停在 running，用来观察并发度
          create: () => new Promise(() => {}),
        }
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

  const cleanup = () => {
    fs.rmSync(base, { recursive: true, force: true })
    delete process.env.DSH_INVEST_JOB_CONCURRENCY
  }
  return { call, cleanup }
}

test('默认并发 2：同时提交 3 个任务 → 2 个运行、1 个排队', async (t) => {
  delete process.env.DSH_INVEST_JOB_CONCURRENCY
  const h = makeHarness()
  t.after(h.cleanup)

  for (let i = 0; i < 3; i += 1) {
    const res = await h.call('POST', '/dsh-invest/api/run', { templateId: 'watch-daily' })
    assert.equal(res.status, 202, '提交应成功：' + JSON.stringify(res.json))
  }
  await new Promise((resolve) => setTimeout(resolve, 200))

  const listed = await h.call('GET', '/dsh-invest/api/jobs')
  const jobs = listed.json.jobs || []
  assert.equal(listed.json.concurrency, 2, '并发上限应为 2')
  assert.equal(listed.json.running, 2, '应有 2 个运行中')
  assert.equal(listed.json.queued, 1, '应有 1 个排队')
  assert.equal(jobs.filter((job) => job.status === 'running').length, 2)
  assert.equal(jobs.filter((job) => job.status === 'queued').length, 1)
})

test('DSH_INVEST_JOB_CONCURRENCY=1 时退回串行：1 个运行、2 个排队', async (t) => {
  const h = makeHarness()
  process.env.DSH_INVEST_JOB_CONCURRENCY = '1'
  t.after(h.cleanup)

  for (let i = 0; i < 3; i += 1) {
    const res = await h.call('POST', '/dsh-invest/api/run', { templateId: 'watch-daily' })
    assert.equal(res.status, 202)
  }
  await new Promise((resolve) => setTimeout(resolve, 200))

  const listed = await h.call('GET', '/dsh-invest/api/jobs')
  assert.equal(listed.json.concurrency, 1)
  assert.equal(listed.json.running, 1, '串行模式下只应有 1 个运行中')
  assert.equal(listed.json.queued, 2)
})

test('并发上限受环境变量钳制（>=1 且 <=6）', async (t) => {
  const h = makeHarness()
  process.env.DSH_INVEST_JOB_CONCURRENCY = '99'
  t.after(h.cleanup)

  await h.call('POST', '/dsh-invest/api/run', { templateId: 'watch-daily' })
  const listed = await h.call('GET', '/dsh-invest/api/jobs')
  assert.equal(listed.json.concurrency, 6, '超过 6 应钳制到 6')
})
