// 模型设置（宿主模型）路由集成测试
// 直接加载真实的 packages/dsh-invest/lib/index.js，用假 ctx 调用 /dsh-invest/api/model-settings
// 与 /dsh-invest/api/templates；BASE_DIR 指向临时目录，绝不读写真实 settings.json。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const SESSION_PROVIDER = 'deepseek-official'
const SESSION_MODEL = 'deepseek-v4-pro'
const SESSION_LABEL = SESSION_PROVIDER + '/' + SESSION_MODEL

/** 建一个临时工作区 + 假 ctx，返回路由调用器与清理函数 */
function makeHarness() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-model-settings-'))
  fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
  process.env.DSH_INVEST_BASE_DIR = base

  const registered = []
  const fakeFs = {
    resolve: async (p) => p,
    readText: async (p) => fs.readFileSync(p, 'utf8'),
    writeText: async (p, text) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, text)
    },
  }
  const ctx = {
    get(name) {
      if (name === 'fs') return fakeFs
      if (name === 'agents') {
        return {
          roots: () => [{ options: { provider: SESSION_PROVIDER, model: SESSION_MODEL } }],
          create: async () => { throw new Error('agents.create 不应在模型设置测试里被调用') },
        }
      }
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'zai-coding-cn', name: 'Z.ai' }],
          listModels: async (providerId) => (providerId === 'deepseek-official'
            ? [{ id: 'deepseek-v4-pro', name: 'V4 Pro' }, { id: 'deepseek-v4-flash', name: 'V4 Flash' }]
            : [{ id: 'glm-5.3', name: 'GLM 5.3' }]),
          resolveCallConfig: async () => ({}),
        }
      }
      if (name === 'sandboxPolicy') return { resolve: () => ({}) }
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
      method,
      url: pathAndQuery,
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

  const cleanup = () => fs.rmSync(base, { recursive: true, force: true })
  return { call, cleanup, base, settingsPath: path.join(base, '.dsh-invest', 'settings.json') }
}

test('model-settings：返回宿主模型与会话模型', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)
  const { json } = await h.call('GET', '/dsh-invest/api/model-settings')

  assert.equal(json.hostModel.label, SESSION_LABEL)
  assert.equal(json.hostModel.source, 'session', '未设置覆盖时应跟随会话宿主')
  assert.equal(json.sessionModel.model, SESSION_MODEL)
  assert.equal(json.presets.find((p) => p.id === 'inherit').name, '继承宿主')
  assert.match(json.presets.find((p) => p.id === 'inherit').description, new RegExp(SESSION_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.ok(json.modelOptions[0].label.includes('跟随会话宿主'), 'modelOptions 首项应为跟随会话宿主')
})

test('templates：每个模板回显 preset / 生效模型 / 宿主模型', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)
  const { json } = await h.call('GET', '/dsh-invest/api/templates')

  const inheritTpl = json.templates.find((item) => item.id === 'stock-review')
  assert.equal(inheritTpl.preset, 'inherit')
  assert.equal(inheritTpl.hostModel, SESSION_LABEL)
  assert.ok(inheritTpl.effectiveModels.length >= 1)
  assert.ok(inheritTpl.effectiveModels.every((m) => m.resolved === SESSION_LABEL), 'inherit 预设应解析到宿主模型')

  const balancedTpl = json.templates.find((item) => item.id === 'watch-daily')
  assert.equal(balancedTpl.preset, 'balanced')
  const deep = balancedTpl.effectiveModels.find((m) => m.role === '深度')
  assert.equal(deep.resolved, 'deepseek-official/deepseek-v4-pro@high', 'balanced 深度应为 v4-pro@high')
})

test('host 覆盖：保存后落盘、正确拆 model/effort，并同步到模板解析', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  const saved = await h.call('POST', '/dsh-invest/api/model-settings', { scope: 'host', value: 'zai-coding-cn/glm-5.3@max' })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.settings.hostModel.label, 'zai-coding-cn/glm-5.3@max')
  assert.equal(saved.json.settings.hostModel.source, 'override')
  assert.equal(saved.json.settings.hostModel.model, 'glm-5.3', 'model 不应带 @effort')
  assert.equal(saved.json.settings.hostModel.reasoningEffort, 'max')
  assert.equal(JSON.parse(fs.readFileSync(h.settingsPath, 'utf8')).defaultModel, 'zai-coding-cn/glm-5.3@max')

  const templates = await h.call('GET', '/dsh-invest/api/templates')
  const inheritTpl = templates.json.templates.find((item) => item.id === 'stock-review')
  assert.ok(inheritTpl.effectiveModels.every((m) => m.resolved === 'zai-coding-cn/glm-5.3@max'), '覆盖后模板应解析到新宿主')
  assert.match(
    saved.json.settings.presets.find((p) => p.id === 'inherit').description,
    /zai-coding-cn\/glm-5\.3@max/,
  )
})

test('host 覆盖：非法格式返回 400 且不改写配置', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  const bad = await h.call('POST', '/dsh-invest/api/model-settings', { scope: 'host', value: 'not-a-route' })
  assert.equal(bad.status, 400)
  assert.ok(!fs.existsSync(h.settingsPath) || !('defaultModel' in JSON.parse(fs.readFileSync(h.settingsPath, 'utf8'))))
})

test('host 覆盖：inherit 撤销覆盖并回到跟随会话', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  await h.call('POST', '/dsh-invest/api/model-settings', { scope: 'host', value: 'zai-coding-cn/glm-5.3@max' })
  const reset = await h.call('POST', '/dsh-invest/api/model-settings', { scope: 'host', value: 'inherit' })
  assert.equal(reset.status, 200)
  assert.equal(reset.json.settings.hostModel.source, 'session')
  assert.equal(reset.json.settings.hostModel.label, SESSION_LABEL)
  assert.ok(!('defaultModel' in JSON.parse(fs.readFileSync(h.settingsPath, 'utf8'))))
})

test('回归：角色路由与模板预设保存仍然可用', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  const role = await h.call('POST', '/dsh-invest/api/model-settings', { scope: 'role', role: '深度', route: 'deepseek-official/deepseek-v4-flash@low' })
  assert.equal(role.status, 200)
  assert.match(role.json.settings.roles.find((item) => item.code === '深度').route, /deepseek-v4-flash@low/)

  const preset = await h.call('POST', '/dsh-invest/api/model-settings', { scope: 'template', templateId: 'stock-quick', preset: 'quality' })
  assert.equal(preset.status, 200)
  assert.equal(preset.json.settings.templates.find((item) => item.id === 'stock-quick').preset, 'quality')

  const unknownScope = await h.call('POST', '/dsh-invest/api/model-settings', { scope: 'nope' })
  assert.equal(unknownScope.status, 400)
})
