// 宿主 Agent 接口契约回归（2026-11-23）
//
// 线上现象（DSH 0.2.x，2026-11-23）：标的档案点「已清仓」、持仓工作区确认账本，全部报
//   cannot write "...\.dsh-invest\store\watchlist.json": file access denied under workspace-write mode
// 磁盘可写、目录里别的文件也能被宿主写，说明不是权限问题。
//
// 根因：DSH 0.2.x 的 ctx.agents 只有 list()/get()/create()，**没有 roots()**（0.1.x 时代的方法）。
// 插件到处写 `agents.roots()`，在 0.2.x 上恒为 []，于是：
//   ① fsPolicyCandidates() 恒为空 → fs.writeText 不带策略 → 宿主按「无会话」的部署默认根判定
//      → 目标不在该根下 → FS_SANDBOX_DENIED（就是上面那句）；
//   ② runPromptSubagent 拿不到 parent → 抛「没有可用的顶层 Agent」→ 视觉识别不可用，退本地 OCR；
//   ③ 会话宿主模型继承失效。
//
// 本用例把宿主语义照实拟出来：agents 只暴露 list()、sandboxPolicy.resolve 按
// session.header.cwd 决议、fs.writeText 在「无策略或在根外」时抛 FS_SANDBOX_DENIED。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-agents-contract-'))
fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
process.env.DSH_INVEST_BASE_DIR = base
process.env.DSH_INVEST_SKIP_REINDEX = '1'
delete process.env.DSH_INVEST_JOB_CONCURRENCY

const DEPLOYMENT_ROOT = path.join(os.tmpdir(), 'not-the-workspace')
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// 照抄 @deepseek-ai/dsh-sandbox-policy：resolve({session}) 用 session.header.cwd，否则退回部署根
const sandboxPolicy = {
  resolve(request = {}) {
    const session = request.session
    return {
      mode: 'workspace-write',
      workspaceRoot: (session && session.header && session.header.cwd) || DEPLOYMENT_ROOT,
    }
  },
}

const deniedWrites = []
const fakeFs = {
  resolve: async (p) => ({ displayPath: String(p), targetKey: String(p) }),
  // 宿主 fs.readText 接收的是 resolve() 返回的 target 对象，不是字符串
  readText: async (target) => fs.readFileSync(String(target && target.displayPath ? target.displayPath : target), 'utf8'),
  writeText: async (target, text, _expected, _signal, policy) => {
    const file = String(target && target.displayPath ? target.displayPath : target)
    // 照抄 @deepseek-ai/dsh-fs-sandbox.checkedTarget：没带策略时用部署默认（无会话）策略
    const effective = policy || sandboxPolicy.resolve()
    const roots = [effective.workspaceRoot].concat(Array.isArray(effective.additionalWritableRoots) ? effective.additionalWritableRoots : [])
    const contained = roots.some((root) => {
      const r = norm(root)
      return r && (norm(file) === r || norm(file).startsWith(r + '/'))
    })
    if (!contained) {
      deniedWrites.push(file)
      throw new Error('FsError: cannot write "' + file + '": file access denied under ' + effective.mode + ' mode')
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text, 'utf8')
  },
}

// DSH 0.2.x 的真实形状：只有 list()/get()/create()，没有 roots()
const liveSessions = [{ id: 'sess-1', header: { cwd: base } }]
const agentsApi = {
  list: () => liveSessions.map((session) => ({ id: session.id, session, options: {} })),
  get: (id) => liveSessions.filter((s) => s.id === id).map((session) => ({ id: session.id, session }))[0],
  create: async () => { throw new Error('no agent factory in test') },
}

const registered = []
apply({
  get(name) {
    if (name === 'fs') return fakeFs
    if (name === 'sandboxPolicy') return sandboxPolicy
    if (name === 'agents') return agentsApi
    if (name === 'attachments') return undefined
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

const POSITIONS = [{ code: '600011.SH', name: '华能国际', shares: 3000, cost: 7.42 }]
const ACCOUNT = { total_asset: 110503.46, available_cash: 6841.76 }

test.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

test('只有 agents.list() 的宿主（DSH 0.2.x）上，持仓确认仍必须写进账本与审计', async () => {
  const draft = await post('/dsh-invest/api/holdings/import', { source: 'manual', positions: POSITIONS, account: ACCOUNT })
  assert.equal(draft.status, 200, JSON.stringify(draft.json))

  const res = await post('/dsh-invest/api/holdings/confirm', { draftId: draft.json.draftId, positions: POSITIONS, account: ACCOUNT })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  assert.equal(res.json.ok, true)

  const ledger = JSON.parse(fs.readFileSync(path.join(base, '.dsh-invest', '持仓.json'), 'utf8'))
  assert.equal(ledger.positions[0].code, '600011.SH')
  const auditLines = fs.readFileSync(path.join(base, '.dsh-invest', 'store', 'holdings_audit.jsonl'), 'utf8').trim().split('\n')
  assert.equal(JSON.parse(auditLines[auditLines.length - 1]).action, 'confirm')
  assert.ok(deniedWrites.length === 0, '不应出现任何沙箱拒绝：' + deniedWrites.slice(0, 3).join(' | '))
})

test('标的档案状态更新（已清仓）必须写进 watchlist.json', async () => {
  const before = await post('/dsh-invest/api/holdings/import', { source: 'manual', positions: POSITIONS, account: ACCOUNT })
  assert.equal(before.status, 200, JSON.stringify(before.json))
  // 先把当前持仓确认入账，让档案里有「持有」项
  const confirmed = await post('/dsh-invest/api/holdings/confirm', { draftId: before.json.draftId, positions: POSITIONS, account: ACCOUNT })
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json))

  const route = registered.find((item) => item.path === '/dsh-invest/api/watchlist/update')
  assert.ok(route, '标的档案更新路由未注册')
  const body = { code: '600011.SH', state: '已清仓' }
  let status = 0
  let text = ''
  const req = {
    method: 'POST', url: '/dsh-invest/api/watchlist/update', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
  const res = { setHeader() {}, set statusCode(v) { status = v }, get statusCode() { return status }, end(v) { text = v === undefined ? '' : String(v) } }
  await route.handler(req, res)
  assert.equal(status || 200, 200, text)
  const watch = JSON.parse(fs.readFileSync(path.join(base, '.dsh-invest', 'store', 'watchlist.json'), 'utf8'))
  const item = (watch.items || []).find((it) => it.code === '600011.SH')
  assert.equal(item && item.state, '已清仓')
  assert.ok(deniedWrites.length === 0, '不应出现任何沙箱拒绝：' + deniedWrites.slice(0, 3).join(' | '))
})
