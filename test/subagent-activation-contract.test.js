// 宿主子代理激活接口契约回归（2026-11-23）
//
// 线上现象（用户 m00532）：标的档案点「个股体检」一键任务，弹
//   「任务进度中断：TypeError: Cannot read properties of undefined (reading 'id')」
// runs.jsonl 里同一任务 3 个阶段在 14–22ms 内全部失败、错误一模一样 → 不是模型/网络问题。
//
// 根因：DSH 0.2.x 的 `subagents.startActivation(spec)` 在 **spec 顶层** 读 parent——
//   dsh-subagent/lib/index.js:3024
//   `if (this.ctx.get("agents")?.get(spec.parent.id) !== spec.parent) throw new SubagentError(...)`
// 插件（2026-10-29「第三版」改造）把 parent 塞进了 `spec.request.parent`，于是
// `spec.parent === undefined` → 每个阶段子代理都在第一次 await 前抛 TypeError。
// 0.1.x 宿主有 `start()`，那条老路一直走的是平铺 spec，所以这个洞在 0.2.x 才暴露。
//
// 本用例照抄宿主语义：
//   ① 直接校验 activationSpecFor() 产出的 spec 形状（parent 在顶层、无 request 字段）；
//   ② 用只暴露 startActivation 的假宿主（没有 start，模拟 0.2.x）真跑一遍流水线阶段。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, activationSpecFor } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-subagent-contract-'))
fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
process.env.DSH_INVEST_BASE_DIR = base
process.env.DSH_INVEST_SKIP_REINDEX = '1'
process.env.DSH_INVEST_SUMMARY = '0'
delete process.env.DSH_INVEST_JOB_CONCURRENCY

// 宿主 Agent 的形态：id + session（header 带 cwd，供沙箱策略决议）
const parent = {
  id: 'agent-parent',
  session: { header: { id: 'session-parent', cwd: base, origin: 'user' }, append() {} },
  options: { provider: 'test-provider', model: 'test-model' },
}

const started = []
// 照抄 @deepseek-ai/dsh-subagent 0.2.x 的 startActivation：
// 第一件事就是 spec.parent.id（parent 不在顶层 → 抛用户看到的那句 TypeError）。
const activationHost = {
  async startActivation(spec) {
    if (spec.parent === undefined) {
      throw new TypeError("Cannot read properties of undefined (reading 'id')")
    }
    if (spec.parent.id !== parent.id) {
      throw new Error('subagent creation requires the exact live parent agent')
    }
    if (!Array.isArray(spec.prompt) || typeof spec.prompt[0]?.text !== 'string') {
      throw new Error('prompt 必须是 [{type:"text",text}] 内容块数组')
    }
    started.push(spec)
    return {
      childId: 'child-' + started.length,
      name: 'lead/agent-' + started.length,
      result: Promise.resolve({ stopReason: 'stop', output: [{ type: 'text', text: '阶段输出：技术面中性。' }] }),
      dispose: async () => {},
    }
  },
}

let tool = null
const fakeFs = {
  resolve: async (p) => p,
  readText: async (p) => fs.readFileSync(p, 'utf8'),
  writeText: async (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8') },
}

// 0.2.x 的 agents 只有 list()/get()/create()，没有 roots()
const agents = {
  list: () => [parent],
  get: (id) => (id === parent.id ? parent : undefined),
  create: async () => ({ agent: parent, dispose: async () => {} }),
}

apply({
  get(name) {
    if (name === 'fs') return fakeFs
    if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: base }) }
    if (name === 'subagents') return activationHost
    if (name === 'subagent') return undefined
    if (name === 'agents') return agents
    if (name === 'llm') return { listProviders: () => [], listModels: async () => [], resolveCallConfig: async () => ({}) }
    return undefined
  },
  effect(fn) { fn() },
  webServer: { register: () => () => {} },
  tools: { register: (t) => { tool = t; return () => {} } },
  systemPrompt: { section: () => {} },
}, {})

test.after(() => { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch (e) { /* ignore */ } })

test('activationSpecFor：parent 在顶层、没有 request 字段、prompt 是内容块', () => {
  const spec = activationSpecFor({ label: '阶段A', parent, signal: undefined }, '正文', 'caller')
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, '阶段A')
  assert.equal(spec.parent, parent, 'parent 必须在 spec 顶层（0.2.x 读的是 spec.parent.id）')
  assert.equal(spec.request, undefined, '不能把 parent 包进 request——那正是 TypeError 的来源')
  assert.deepEqual(spec.prompt, [{ type: 'text', text: '正文' }])
  assert.equal(spec.delivery, 'caller')
  assert.equal('agentOptions' in spec, false, '未指定路由时不应下发空 agentOptions')
  assert.equal('signal' in spec, false, 'signal 为 undefined 时不下发')

  const routed = activationSpecFor({ label: 'B', parent, agentOptions: { provider: 'p', model: 'm' }, signal: { aborted: false } }, 'x', 'parent')
  assert.deepEqual(routed.agentOptions, { provider: 'p', model: 'm' })
  assert.deepEqual(routed.signal, { aborted: false })
  assert.equal(routed.delivery, 'parent')
})

test('activationSpecFor：缺 parent 时抛可读错误，而不是让宿主抛 TypeError', () => {
  assert.throws(() => activationSpecFor({ label: 'C' }, 'x', 'caller'), /缺少父 Agent/)
})

test('旧形状（request.parent）确实复现宿主那句 TypeError——作为回归锚点', async () => {
  // 2026-10-29「第三版」的错误形状：把 parent/agentOptions 包进 request
  const legacy = { provider: 'spawn', label: '旧形状', request: { prompt: [{ type: 'text', text: 'x' }], parent }, signal: undefined, delivery: 'caller' }
  await assert.rejects(
    () => activationHost.startActivation(legacy),
    (err) => err instanceof TypeError && /reading 'id'/.test(err.message),
    '旧形状应当复现线上那句 TypeError（若宿主改契约，这条用例会提醒我们重新核对）',
  )
})

test('个股体检阶段子代理：0.2.x 宿主下能正常起子代理并返回阶段输出', async () => {
  assert.ok(tool, '工具未注册')
  started.length = 0
  const res = await tool.execute(
    { mode: '个股', question: '对 600118 做深度体检：技术面/估值/财务六维诊断', roles: ['深度'] },
    { callId: 'job_contract_1', agent: parent, signal: new AbortController().signal },
  )
  assert.equal(String(res.error || ''), '', '不应再出现中断错误：' + String(res.error || ''))
  const outs = Array.isArray(res.outputs) ? res.outputs : []
  assert.equal(outs.length, 1)
  assert.equal(outs[0].ok, true, '阶段应成功：' + String(outs[0].error || ''))
  assert.match(String(outs[0].text || ''), /阶段输出/)

  assert.ok(started.length >= 1, '宿主应收到至少一次 startActivation')
  const spec = started[0]
  assert.equal(spec.parent, parent, '下发给宿主的 spec.parent 必须是活的父 Agent 本体')
  assert.ok(spec.prompt[0].text.length > 50, '阶段提示词应包含角色职责与问题')
  assert.equal(spec.request, undefined)
})
