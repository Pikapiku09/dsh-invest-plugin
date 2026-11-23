// 持仓确认写入的沙箱策略回归（v0.75.3 起；2026-11-23 适配 DSH 0.2.x 的 agents.list()）
//
// 线上现象：确认/刷新持仓时报
//   FsError: cannot write "...\.dsh-invest\store\holdings_audit.jsonl": file access denied
// 但同一目录下的 持仓.json 已写成功、磁盘也可写 —— 不是权限问题，是「策略取错了会话」。
//
// 本用例锁定两件事：
//   ① 写入遇到一次沙箱拒绝后，必须换下一个候选继续写，而不是直接把整次操作判失败；
//   ② 候选来自真实可用的 agents.list()，且都覆盖目标路径（覆盖不到的候选不该被盲试）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-audit-policy-'))
fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
process.env.DSH_INVEST_BASE_DIR = base
process.env.DSH_INVEST_SKIP_REINDEX = '1'
delete process.env.DSH_INVEST_JOB_CONCURRENCY

const deniedWrites = []
const acceptedWrites = []
// 第一次写入故意拒绝：模拟「策略解析到了不能写这个目录的会话」
let denyRemaining = 1

const fakeFs = {
  resolve: async (p) => ({ displayPath: String(p), targetKey: String(p) }),
  readText: async (target) => fs.readFileSync(String(target && target.displayPath ? target.displayPath : target), 'utf8'),
  writeText: async (target, text, _expected, _signal, _policy) => {
    const file = String(target && target.displayPath ? target.displayPath : target)
    if (denyRemaining > 0) {
      denyRemaining -= 1
      deniedWrites.push(file)
      throw new Error('FsError: cannot write "' + file + '": file access denied under workspace-write mode')
    }
    acceptedWrites.push(file)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text, 'utf8')
  },
}

// DSH 0.2.x 形状：agents.list()，会话 cwd 即 workspace-write 边界
const sessions = [
  { id: 'sess-narrow', header: { cwd: base } },
  { id: 'sess-wide', header: { cwd: path.dirname(base) } },
]
const agentsApi = {
  list: () => sessions.map((session) => ({ id: session.id, session, options: {} })),
  create: async () => { throw new Error('no agent factory in test') },
}
const sandboxPolicy = {
  resolve: (request = {}) => ({
    mode: 'workspace-write',
    workspaceRoot: (request.session && request.session.header && request.session.header.cwd) || path.join(os.tmpdir(), 'deployment-root'),
  }),
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

test('持仓确认：写入被拒一次后换候选继续，账本与审计仍必须落盘', async () => {
  const draft = await post('/dsh-invest/api/holdings/import', { source: 'manual', positions: POSITIONS, account: ACCOUNT })
  assert.equal(draft.status, 200, JSON.stringify(draft.json))
  assert.ok(draft.json.draftId, '手动导入应生成草稿')

  const res = await post('/dsh-invest/api/holdings/confirm', { draftId: draft.json.draftId, positions: POSITIONS, account: ACCOUNT })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  assert.equal(res.json.ok, true)
  assert.equal(res.json.auditWarning, '', '审计写成功时不应回告警：' + res.json.auditWarning)
  assert.ok(res.json.backup, '账本备份必须真的写出来')

  const ledger = JSON.parse(fs.readFileSync(path.join(base, '.dsh-invest', '持仓.json'), 'utf8'))
  assert.equal(ledger.positions.length, 1)
  assert.equal(ledger.positions[0].code, '600011.SH')
  assert.ok(fs.existsSync(res.json.backup), '返回的备份路径必须存在')

  const auditPath = path.join(base, '.dsh-invest', 'store', 'holdings_audit.jsonl')
  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.length, 1, '应恰好追加一行审计')
  assert.equal(lines[0].action, 'confirm')
  assert.equal(lines[0].positions[0].code, '600011.SH')

  assert.equal(deniedWrites.length, 1, '只应被拒一次，之后换候选成功')
  assert.ok(acceptedWrites.length >= 2, '账本/备份/审计都应成功写入')
})

test('持仓确认：审计只追加不覆盖历史（第二次确认后保留两行）', async () => {
  const before = fs.readFileSync(path.join(base, '.dsh-invest', 'store', 'holdings_audit.jsonl'), 'utf8').trim().split('\n').length
  const draft = await post('/dsh-invest/api/holdings/import', { source: 'manual', positions: POSITIONS, account: ACCOUNT })
  const res = await post('/dsh-invest/api/holdings/confirm', { draftId: draft.json.draftId, positions: POSITIONS, account: ACCOUNT })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  const after = fs.readFileSync(path.join(base, '.dsh-invest', 'store', 'holdings_audit.jsonl'), 'utf8').trim().split('\n').length
  assert.equal(after, before + 1, '每次确认只追加一行，不覆盖历史')
})
