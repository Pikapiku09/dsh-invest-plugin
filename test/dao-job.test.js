// 悟道对话任务（v0.81.0）
//
// 线上现象：正在悟道里问问题，切到 DSH 的对话面板再切回来，工作台像被重启了，
// 刚才那轮对话的答案也没了——因为工作台是主面板里的 iframe，切走时整块被卸载，
// 在途的 fetch 被掐断，而模型那头其实还在算。
//
// 这里钉住新的契约：对话先登记成一个后端任务，立刻回 jobId；前端凭 jobId 取答案。
// 页面被卸载、重载都不影响结果。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-dao-job-'))
fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
process.env.DSH_INVEST_BASE_DIR = base

const fakeFs = {
  resolve: async (p) => p,
  readText: async (p) => fs.readFileSync(p, 'utf8'),
  writeText: async (p, text) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text, 'utf8')
  },
}

const sessions = [{ id: 'sess-job', header: { cwd: base } }]
const agentsApi = {
  list: () => sessions.map((session) => ({ id: session.id, session, options: {} })),
  get: (id) => sessions.filter((s) => s.id === id).map((session) => ({ id: session.id, session }))[0],
  create: async () => { throw new Error('no agent factory in test') },
}

const calls = []
let pendingResolve = null
const subagents = {
  startActivation(spec) {
    calls.push(spec)
    if (pendingResolve) {
      // 让测试自己决定什么时候把答案吐出来
      return { result: new Promise((resolve) => { pendingResolve = resolve }) }
    }
    return { result: Promise.resolve({ output: [{ type: 'text', text: '答案：先把「想冲」和判断分开。' }] }) }
  },
}

const registered = []
apply({
  get(name) {
    if (name === 'fs') return fakeFs
    if (name === 'agents') return agentsApi
    if (name === 'subagents') return subagents
    if (name === 'llm') return { listProviders: () => [], listModels: async () => [], resolveCallConfig: async () => ({}) }
    return undefined
  },
  effect(fn) { fn() },
  webServer: { register: (route) => { registered.push(route); return () => {} } },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
}, {})

const fakeRes = () => {
  let status = 0
  let text = ''
  return {
    res: {
      setHeader() {},
      set statusCode(v) { status = v },
      get statusCode() { return status },
      end(v) { text = v === undefined ? '' : String(v) },
    },
    read: () => ({ status: status || 200, json: text ? JSON.parse(text) : null }),
  }
}

async function call(method, pathname, payload) {
  const route = registered.find((item) => item.path === pathname)
  assert.ok(route, '路由未注册：' + pathname)
  const hold = fakeRes()
  const req = {
    method,
    url: pathname,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost:3080' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload || {})) },
  }
  await route.handler(req, hold.res)
  return hold.read()
}

test.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

test('异步对话：立刻回 jobId，答案留在后端等前端来取', async () => {
  calls.length = 0
  const started = await call('POST', '/dsh-invest/api/dao/chat', {
    persona: '教练', messages: [{ role: 'user', text: '我老是追高' }], async: true,
  })
  assert.equal(started.status, 200, JSON.stringify(started.json))
  assert.match(started.json.jobId, /^job_/, '要回一个任务号，前端凭它回来看答案')
  assert.equal(started.json.status, 'running', '登记完立刻返回，不阻塞在这个请求上')

  // 任务在后台跑，答案算完写回任务里
  let job = null
  for (let i = 0; i < 100; i += 1) {
    const route = registered.find((item) => item.path === '/dsh-invest/api/dao/job')
    const hold = fakeRes()
    await route.handler({
      method: 'GET', url: '/dsh-invest/api/dao/job', query: { id: started.json.jobId },
      socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' },
    }, hold.res)
    job = hold.read()
    if (job.json && job.json.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(job.status, 200, JSON.stringify(job.json))
  assert.equal(job.json.status, 'done')
  assert.match(job.json.answer, /判断/)
  assert.equal(typeof job.json.elapsedMs, 'number')
})

test('异步对话：空问题当场 400，不留下悬空任务', async () => {
  const r = await call('POST', '/dsh-invest/api/dao/chat', { persona: '教练', messages: [], async: true })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /聊天|内容/)
})

test('查不存在的任务 → 404（前端据此重新发起，而不是死等）', async () => {
  const route = registered.find((item) => item.path === '/dsh-invest/api/dao/job')
  const hold = fakeRes()
  await route.handler({
    method: 'GET', url: '/dsh-invest/api/dao/job', query: { id: 'job_not_exist' },
    socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' },
  }, hold.res)
  const r = hold.read()
  assert.equal(r.status, 404)
})

test('同步路径保留：不带 async 仍然一次性返回答案（老调用方不受影响）', async () => {
  const r = await call('POST', '/dsh-invest/api/dao/chat', {
    persona: '教练', messages: [{ role: 'user', text: '在吗' }],
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.match(r.json.answer, /判断/)
  assert.equal(typeof r.json.elapsedMs, 'number')
})
