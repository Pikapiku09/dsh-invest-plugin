// 悟道模型设置 + 固定提示词（2026-11-25）
//
// 线上现象：悟道对话直接红字「模型暂不可用：悟道对话失败（stopReason=error）」——
// 插件替用户选了一个宿主不认的思考档位，且没有任何地方能改。
//
// 这里钉住三件事：
//   ① 模型设置里必须有 dao 块，且能读写（模型 / 思考程度 / 输出上限 / 超时）；
//   ② 设置真的会流进 agentOptions，不是写进 json 就完事；
//   ③ 固定提示词优先读工作区覆盖副本，删掉后回到内置那份。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-dao-settings-'))
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

const sessions = [{ id: 'sess-settings', header: { cwd: base } }]
const agentsApi = {
  list: () => sessions.map((session) => ({ id: session.id, session, options: {} })),
  get: (id) => sessions.filter((s) => s.id === id).map((session) => ({ id: session.id, session }))[0],
  create: async () => { throw new Error('no agent factory in test') },
}

const calls = []
const subagents = {
  startActivation(spec) {
    calls.push(spec)
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

async function request(method, pathname, payload) {
  const route = registered.find((item) => item.path === pathname)
  assert.ok(route, '路由未注册：' + pathname)
  let status = 0
  let text = ''
  const body = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]
  const req = {
    method, url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' },
    async *[Symbol.asyncIterator]() { for (const chunk of body) yield chunk },
  }
  const res = {
    setHeader() {},
    set statusCode(v) { status = v },
    get statusCode() { return status },
    end(v) { text = v === undefined ? '' : String(v) },
  }
  await route.handler(req, res)
  return { status: status || 200, json: text ? JSON.parse(text) : null }
}

const getSettings = () => request('GET', '/dsh-invest/api/model-settings')
const saveDao = (payload) => request('POST', '/dsh-invest/api/model-settings', { scope: 'dao', ...payload })
const chat = (text) => request('POST', '/dsh-invest/api/dao/chat', { persona: '教练', messages: [{ role: 'user', text }] })
const promptOf = (spec) => spec.prompt.map((block) => block.text).join('\n')

test.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

test('模型设置里有 dao 块，默认值可用且给出可选项', async () => {
  const r = await getSettings()
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const dao = r.json.dao
  assert.ok(dao, '模型设置必须包含悟道配置')
  assert.equal(dao.model, 'inherit')
  assert.equal(dao.effort, 'low', '默认低思考：快且兼容')
  assert.equal(dao.maxTokens, 2000)
  assert.equal(dao.timeoutMs, 90000)
  assert.equal(dao.promptSource, 'bundled', '没写覆盖副本时应该用内置那份')
  assert.match(dao.promptPath.replace(/\\/g, '/'), /prompts\/dao-coach\.md$/)
  assert.ok(fs.existsSync(dao.promptPath), '内置提示词必须随包分发，路径要真实存在')
  const values = dao.effortOptions.map((item) => item.value)
  assert.deepEqual(values, ['default', 'off', 'low', 'medium', 'high', 'max'])
})

test('保存思考程度 / 输出上限 / 超时后，下一次对话真的用新值', async () => {
  const saved = await saveDao({ effort: 'off', maxTokens: 1200, timeoutMs: 60000 })
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  assert.equal(saved.json.settings.dao.effort, 'off')
  assert.equal(saved.json.settings.dao.maxTokens, 1200)
  assert.equal(saved.json.settings.dao.timeoutMs, 60000)

  calls.length = 0
  const r = await chat('我老是追高')
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agentOptions.reasoningEffort, 'off')
  assert.equal(calls[0].agentOptions.maxTokens, 1200)
})

test('非法值一律拒绝，不写进 settings', async () => {
  assert.equal((await saveDao({ effort: 'turbo' })).status, 400)
  assert.equal((await saveDao({ maxTokens: 10 })).status, 400)
  assert.equal((await saveDao({ timeoutMs: 100 })).status, 400)
  assert.equal((await saveDao({ model: '不是路由' })).status, 400)
  const after = await getSettings()
  assert.equal(after.json.dao.effort, 'off', '被拒的写入不该改动已有配置')
})

test('工作区放一份 dao-coach.md 就覆盖内置准则，删掉后回到内置', async () => {
  const override = path.join(base, '.dsh-invest', 'dao-coach.md')
  fs.writeFileSync(override, '我的准则：每句话都不超过十个字。', 'utf8')

  const withOverride = await getSettings()
  assert.equal(withOverride.json.dao.promptSource, 'override')
  assert.equal(path.resolve(withOverride.json.dao.promptPath), path.resolve(override))

  calls.length = 0
  await chat('仓位怎么管')
  const text = promptOf(calls[0])
  assert.match(text, /每句话都不超过十个字/, '覆盖副本必须真的进 prompt')
  assert.doesNotMatch(text, /表格是最后手段/, '覆盖之后不该再拼内置准则')

  const reset = await saveDao({ resetPrompt: true })
  assert.equal(reset.status, 200, JSON.stringify(reset.json))
  assert.equal(reset.json.settings.dao.promptSource, 'bundled')
  assert.equal(fs.existsSync(override), false, '恢复默认要删掉覆盖文件')

  calls.length = 0
  await chat('仓位怎么管')
  assert.match(promptOf(calls[0]), /表格是最后手段/)
})
