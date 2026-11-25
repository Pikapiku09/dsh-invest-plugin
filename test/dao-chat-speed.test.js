// 悟道对话的响应速度契约（2026-11-25）
//
// 线上现象：用户在悟道里问一句，要等十几秒才出字。根因不是模型慢，而是
// runPromptSubagent 完全继承宿主会话的推理档位——一个 300 字的回答先「想」掉大半时间。
//
// 这里钉住两件事：
//   ① 对话与沉淀必须显式下发 agentOptions（关思考 + 输出封顶），别再静默继承宿主；
//   ② 宿主模型不认这个组合时必须能退回去，而不是把对话直接打死。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-dao-speed-'))
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

const sessions = [{ id: 'sess-speed', header: { cwd: base } }]
const agentsApi = {
  list: () => sessions.map((session) => ({ id: session.id, session, options: {} })),
  get: (id) => sessions.filter((s) => s.id === id).map((session) => ({ id: session.id, session }))[0],
  create: async () => { throw new Error('no agent factory in test') },
}

// 宿主 0.2.x 的形状：只有 startActivation，返回 { result }
const calls = []
let rejectAgentOptions = false
const subagents = {
  startActivation(spec) {
    calls.push(spec)
    if (rejectAgentOptions && spec.agentOptions) {
      return Promise.reject(new Error('unsupported reasoningEffort: off'))
    }
    return { result: Promise.resolve({ output: [{ type: 'text', text: '先把「想冲」和判断分开。' }] }) }
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

async function post(pathname, payload) {
  const route = registered.find((item) => item.path === pathname)
  assert.ok(route, '路由未注册：' + pathname)
  let status = 0
  let text = ''
  const req = {
    method: 'POST', url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload || {})) },
  }
  const res = { setHeader() {}, set statusCode(v) { status = v }, get statusCode() { return status }, end(v) { text = v === undefined ? '' : String(v) } }
  await route.handler(req, res)
  return { status: status || 200, json: text ? JSON.parse(text) : null }
}

test.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

test('悟道对话：显式下发快档 agentOptions（关思考 + 输出封顶），并回传耗时', async () => {
  calls.length = 0
  rejectAgentOptions = false
  const r = await post('/dsh-invest/api/dao/chat', { persona: '教练', messages: [{ role: 'user', text: '我老是追高' }] })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.match(r.json.answer, /判断/)
  assert.equal(typeof r.json.elapsedMs, 'number')

  assert.equal(calls.length, 1, '一次对话只该起一个子代理')
  const spec = calls[0]
  assert.ok(spec.agentOptions, '必须显式给 agentOptions，不能静默继承宿主的推理档位')
  // 默认低思考：比 off 兼容性好，比继承宿主快得多；具体值可在模型设置里改
  assert.equal(spec.agentOptions.reasoningEffort, 'low')
  assert.ok(spec.agentOptions.maxTokens > 0 && spec.agentOptions.maxTokens <= 2000, '输出要封顶，否则慢在生成上')
  // prompt 里的字数上限同样是速度开关：600 字比 400 字多一半的生成时间
  const promptText = spec.prompt.map((block) => block.text).join('\n')
  assert.match(promptText, /400 字以内/)
  assert.doesNotMatch(promptText, /600 字以内/)
  // 固定提示词（回答准则）必须真的进了 prompt，否则「不要罗列表格」只是写在文件里没人看
  assert.match(promptText, /回答准则/)
  assert.match(promptText, /表格是最后手段/)
})

test('沉淀条目同样走快档，且不继承宿主推理档位', async () => {
  calls.length = 0
  const r = await post('/dsh-invest/api/dao/distill', { persona: '教练', messages: [{ role: 'assistant', text: '仓位别一次打满' }] })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agentOptions.reasoningEffort, 'low')
  assert.equal(calls[0].label, '悟道沉淀')
})

test('宿主模型不认 effort=off 时自动退回继承宿主，对话不因此不可用', async () => {
  calls.length = 0
  rejectAgentOptions = true
  const r = await post('/dsh-invest/api/dao/chat', { persona: '教练', messages: [{ role: 'user', text: '在吗' }] })
  rejectAgentOptions = false
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.match(r.json.answer, /判断/)
  const last = calls[calls.length - 1]
  assert.ok(calls.length >= 2, '应该先试快档，失败后退回')
  assert.equal(last.agentOptions, undefined, '退回时不再带 agentOptions')
})
