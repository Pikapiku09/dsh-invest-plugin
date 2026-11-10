// 运行日志：写入兜底 + 回读校验 + 自愈补写
// 说明：BASE_DIR 在插件模块加载时绑定，故整个文件共用一个 harness（每个用例前重置状态）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-runlog-'))
fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
fs.mkdirSync(path.join(base, '.dsh-invest', 'reports'), { recursive: true })
process.env.DSH_INVEST_BASE_DIR = base
process.env.DSH_INVEST_SKIP_REINDEX = '1'
delete process.env.DSH_INVEST_JOB_CONCURRENCY

const runsLog = path.join(base, '.dsh-invest', 'runs.jsonl')
const indexPath = path.join(base, '.dsh-invest', 'store', 'index.json')
const registered = []
const failRunsWrite = { value: false }
let tool = null

const fakeFs = {
  resolve: async (p) => p,
  readText: async (p) => fs.readFileSync(p, 'utf8'),
  writeText: async (p, text) => {
    if (failRunsWrite.value && String(p).includes('runs.jsonl')) throw new Error('EPERM: sandbox policy rejected')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text, 'utf8')
  },
}
const parent = { session: { append() {} }, options: { provider: 'p', model: 'm' } }
apply({
  get(name) {
    if (name === 'fs') return fakeFs
    if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
    if (name === 'subagents') return { start: () => ({ result: Promise.resolve({ stopReason: 'stop', output: [{ type: 'text', text: '阶段输出。' }] }) }) }
    if (name === 'subagent') return undefined
    if (name === 'agents') return { roots: () => [parent], create: async () => ({ agent: parent, dispose: async () => {} }) }
    if (name === 'llm') return { listProviders: () => [], listModels: async () => [], resolveCallConfig: async () => ({}) }
    return undefined
  },
  effect(fn) { fn() },
  webServer: { register: (route) => { registered.push(route); return () => {} } },
  tools: { register: (t) => { tool = t; return () => {} } },
  systemPrompt: { section: () => {} },
}, {})

function resetState() {
  try { fs.rmSync(runsLog, { force: true }) } catch (e) { /* ignore */ }
  try { fs.rmSync(indexPath, { force: true }) } catch (e) { /* ignore */ }
  failRunsWrite.value = false
}

async function call(method, pathname, body) {
  const route = registered.find((item) => item.path === pathname)
  assert.ok(route, '路由未注册：' + pathname)
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  let status = 0
  let text = ''
  const req = {
    method, url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  const res = { setHeader() {}, set statusCode(v) { status = v }, get statusCode() { return status }, end(v) { text = v === undefined ? '' : String(v) } }
  await route.handler(req, res)
  return { status: status || 200, json: text ? JSON.parse(text) : null }
}

const run = (args, callId) => tool.execute(args, { callId: callId || 'job_test_' + Date.now(), agent: parent, signal: new AbortController().signal })

test.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

test('运行日志：宿主 fs 抛错时用 node:fs 兜底，并留下错误痕迹', async () => {
  resetState()
  failRunsWrite.value = true

  await run({ mode: '选股', question: '测试兜底写入', roles: ['选股'] })

  assert.ok(fs.existsSync(runsLog), '即使宿主 fs 失败，日志也应落盘')
  const lines = fs.readFileSync(runsLog, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1, '应写入 1 行运行日志')
  const rec = JSON.parse(lines[0])
  assert.equal(rec.mode, '选股')
  assert.equal(rec.ok, true)

  const jobs = await call('GET', '/dsh-invest/api/jobs')
  assert.match(String(jobs.json.runLogError || ''), /宿主 fs 写入失败[\s\S]*node:fs 兜底写入成功/, '应暴露兜底原因而不是静默成功')
})

test('运行日志：正常路径写入后回读校验通过，无错误', async () => {
  resetState()
  await run({ mode: '个股', question: '正常写入', roles: ['深度'] })

  const lines = fs.readFileSync(runsLog, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  const jobs = await call('GET', '/dsh-invest/api/jobs')
  assert.equal(String(jobs.json.runLogError || ''), '', '正常写入不应报错')
})

test('运行日志自愈：把有报告无日志的历史任务补写进 runs.jsonl，且幂等', async () => {
  resetState()
  const reportPath = path.join(base, '.dsh-invest', 'reports', '20261109_101010_ab12_全市场海选.md')
  fs.writeFileSync(reportPath, '# 报告\n', 'utf8')
  fs.writeFileSync(indexPath, JSON.stringify({
    stats: {}, runs: [], codes: {}, records: [],
    reports: [{ id: 7, path: reportPath, codes: [], charts: [] }],
  }), 'utf8')

  const first = await call('POST', '/dsh-invest/api/run-log/repair')
  assert.equal(first.status, 200)
  assert.equal(first.json.appended, 1)

  const lines = fs.readFileSync(runsLog, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  const rec = JSON.parse(lines[0])
  assert.equal(rec.recovered, true, '补写行应标记 recovered')
  assert.equal(rec.mode, '选股')
  assert.equal(rec.reportPath, reportPath)
  assert.ok(rec.ts.startsWith('2026-11-09T02:10:10'), '时间应取自报告文件名（本地 10:10:10 → UTC 02:10:10）')

  const second = await call('POST', '/dsh-invest/api/run-log/repair')
  assert.equal(second.json.appended, 0, '重复调用不应重复补写')
  assert.equal(fs.readFileSync(runsLog, 'utf8').split('\n').filter(Boolean).length, 1)
})

test('运行日志清理：重复补写行被合并，与真实埋点同秒的补写行被丢弃', async () => {
  resetState()
  const primary = path.join(base, '.dsh-invest', 'reports', '20261109_101010_ab12_海选.md')
  const secondary = path.join(base, 'invest-outputs', '20261109_101010_zz99_海选', '报告.md')
  const real = { ts: '2026-11-09T02:00:00.000Z', mode: '个股', question: '真实任务', callId: 'real_1', ok: true, elapsedMs: 1000, stages: [] }
  const recover = (ts, reportPath, mode) => ({ ts, mode, question: '自愈任务', callId: 'rec_1', ok: true, elapsedMs: 0, stages: [], recovered: true, reportPath })
  const collided = recover('2026-11-09T02:00:00.000Z', path.join(base, '.dsh-invest', 'reports', '20261109_100000_aa11_旧报告.md'), '选股')
  fs.writeFileSync(runsLog, [
    JSON.stringify(real),
    JSON.stringify(collided),
    JSON.stringify(recover('2026-11-09T02:10:10.000Z', secondary, '选股')),
    JSON.stringify(recover('2026-11-09T02:10:10.000Z', primary, '选股')),
  ].join('\n') + '\n', 'utf8')

  const res = await call('POST', '/dsh-invest/api/run-log/repair')
  assert.equal(res.status, 200, JSON.stringify(res.json))
  assert.ok(res.json.compact && res.json.compact.removed >= 2, '应清理同任务重复与同秒冲突行')

  const lines = fs.readFileSync(runsLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.equal(lines.length, 2, '应只剩 1 条真实 + 1 条自愈')
  assert.equal(lines.filter((line) => line.recovered).length, 1)
  assert.equal(lines.find((line) => line.recovered).reportPath, primary, '重复时应保留 reports/ 下的主报告')
})