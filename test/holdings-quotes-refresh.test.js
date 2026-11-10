// 一键刷新现价（直接落账本）路由测试：无账本/无有效代码时应 400，且不产生草稿
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-quotes-'))
fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
process.env.DSH_INVEST_BASE_DIR = base
process.env.DSH_INVEST_SKIP_REINDEX = '1'
delete process.env.DSH_INVEST_JOB_CONCURRENCY

const registered = []
const fakeFs = {
  resolve: async (p) => p,
  readText: async (p) => fs.readFileSync(p, 'utf8'),
  writeText: async (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8') },
}
apply({
  get(name) {
    if (name === 'fs') return fakeFs
    if (name === 'sandboxPolicy') return { resolve: () => ({}) }
    if (name === 'agents') return { roots: () => [], create: async () => { throw new Error('no agent') } }
    if (name === 'llm') return { listProviders: () => [], listModels: async () => [], resolveCallConfig: async () => ({}) }
    return undefined
  },
  effect(fn) { fn() },
  webServer: { register: (route) => { registered.push(route); return () => {} } },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
}, {})

async function post(pathname) {
  const route = registered.find((item) => item.path === pathname)
  assert.ok(route, '路由未注册：' + pathname)
  let status = 0
  let text = ''
  const req = {
    method: 'POST', url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}') },
  }
  const res = { setHeader() {}, set statusCode(v) { status = v }, get statusCode() { return status }, end(v) { text = v === undefined ? '' : String(v) } }
  await route.handler(req, res)
  return { status: status || 200, json: text ? JSON.parse(text) : null }
}

test.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

test('一键刷新现价：空账本应明确报错，不生成草稿', async () => {
  const res = await post('/dsh-invest/api/holdings/quotes/refresh')
  assert.equal(res.status, 400)
  assert.match(String(res.json.error || ''), /没有可刷新的有效证券代码/)
})

test('一键刷新现价：路由已注册且只接受 POST', async () => {
  const route = registered.find((item) => item.path === '/dsh-invest/api/holdings/quotes/refresh')
  assert.ok(route)
  let status = 0
  const req = { method: 'GET', url: route.path, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' }, async *[Symbol.asyncIterator]() {} }
  const res = { setHeader() {}, set statusCode(v) { status = v }, get statusCode() { return status }, end() {} }
  await route.handler(req, res)
  assert.equal(status, 405)
})
