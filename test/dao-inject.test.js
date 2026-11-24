// 悟道注入测试：捕获真实阶段提示词，验证
// ① 每个角色只收到「自己标签 + 通用」的条目，不串味；
// ② 二次总结另带总判断口径的条目；
// ③ 报告头留下「悟道注入」条数痕迹，事后可复盘纪律是否生效。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const STAMP = '2026-11-20T02:00:00.000Z'

function daoItem(id, title, body, kind, tags, pinned) {
  return { id, title, body, kind, tags, pinned, created_at: STAMP, updated_at: STAMP }
}

const STORE = {
  version: 1,
  updated_at: STAMP,
  items: [
    daoItem('d1', '深度不追高', '涨幅超过 7% 的票当天不追，等回踩五日线再看。', '纪律', ['深度'], true),
    daoItem('d2', '单票不超两成', '任何一只票加到 20% 仓位就停手，不找理由破例。', '纪律', [], false),
    daoItem('d3', '海选只看放量', '海选只留近三日放量、且不在高位的票。', '心得', ['选股'], false),
    daoItem('d4', '总判断先看赔率', '赔率不到 3:1 的机会，宁可空仓也不做。', '反思', ['总判断'], false),
  ],
}

function makeHarness() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-dao-'))
  fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
  fs.mkdirSync(path.join(base, '.dsh-invest', 'reports'), { recursive: true })
  fs.writeFileSync(path.join(base, '.dsh-invest', 'store', 'dao.json'), JSON.stringify(STORE, null, 2))
  process.env.DSH_INVEST_BASE_DIR = base
  delete process.env.DSH_INVEST_JOB_CONCURRENCY

  const prompts = []
  let capturedTool = null
  const fakeFs = {
    resolve: async (p) => p,
    readText: async (p) => fs.readFileSync(p, 'utf8'),
    writeText: async (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) },
  }
  const fakeSubagents = {
    start: (kind, spec) => {
      const text = Array.isArray(spec.prompt) ? spec.prompt.map((b) => (b && b.text) || '').join('\n') : String(spec.prompt || '')
      prompts.push({ label: String(spec.label || ''), text })
      return { result: Promise.resolve({ stopReason: 'stop', output: [{ type: 'text', text: '阶段输出：测试用文本。' }] }) }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'fs') return fakeFs
      if (name === 'sandboxPolicy') return { resolve: () => ({}) }
      if (name === 'subagents') return fakeSubagents
      if (name === 'subagent') return undefined
      if (name === 'agents') {
        return {
          roots: () => [],
          create: async () => ({
            agent: { session: { append() {} }, options: { provider: 'p', model: 'm' } },
            dispose: async () => {},
          }),
        }
      }
      if (name === 'llm') return { listProviders: () => [], listModels: async () => [], resolveCallConfig: async () => ({}) }
      return undefined
    },
    effect(fn) { fn() },
    webServer: { register: () => () => {} },
    tools: { register: (tool) => { capturedTool = tool; return () => {} } },
    systemPrompt: { section: () => {} },
  }
  apply(ctx, {})
  const agent = { session: { append() {} }, options: { provider: 'p', model: 'm' } }
  return {
    base,
    prompts,
    run: (args) => capturedTool.execute(args, { callId: 'test-dao', agent, signal: new AbortController().signal }),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  }
}

test('悟道注入：角色各自只收自己的标签 + 通用，报告头留条数', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  const result = await h.run({ mode: '个股', question: '分析 600519.SH 现在能不能买', roles: ['选股', '深度'] })
  assert.ok(Array.isArray(result.outputs) && result.outputs.length >= 2)

  const screener = h.prompts.find((p) => p.label.includes('选股'))
  const deep = h.prompts.find((p) => p.label.includes('深度'))
  assert.ok(screener, '应有选股阶段提示词')
  assert.ok(deep, '应有深度阶段提示词')

  // ① 选股：拿到「选股」标签 + 通用，不拿深度专属
  assert.match(screener.text, /【我的悟道·交易纪律/)
  assert.match(screener.text, /海选只看放量/)
  assert.match(screener.text, /单票不超两成/)
  assert.doesNotMatch(screener.text, /深度不追高/)
  assert.doesNotMatch(screener.text, /总判断先看赔率/)

  // ② 深度：拿到「深度」标签 + 通用，不拿选股专属
  assert.match(deep.text, /【我的悟道·交易纪律/)
  assert.match(deep.text, /深度不追高/)
  assert.match(deep.text, /单票不超两成/)
  assert.doesNotMatch(deep.text, /海选只看放量/)

  // ③ 二次总结：带总判断口径（专属标签 + 通用）
  const summary = h.prompts.find((p) => p.label === '报告二次总结')
  assert.ok(summary, '应有二次总结提示词')
  assert.match(summary.text, /总判断先看赔率/)
  assert.match(summary.text, /单票不超两成/)
  assert.doesNotMatch(summary.text, /深度不追高/)

  // ④ 报告头：能看出这次注入了什么
  const reportPath = (result.reports || [])[0]
  assert.ok(reportPath, '应生成报告')
  const report = fs.readFileSync(reportPath.split('（')[0], 'utf8')
  assert.match(report, /- 悟道注入：选股=2 条 ｜ 深度=2 条 ｜ 二次总结=2 条/)
})

test('悟道库为空时不产生空块，也不写注入行', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)
  fs.writeFileSync(path.join(h.base, '.dsh-invest', 'store', 'dao.json'), JSON.stringify({ version: 1, items: [] }))

  const result = await h.run({ mode: '个股', question: '分析 600519.SH', roles: ['深度'] })
  const deep = h.prompts.find((p) => p.label.includes('深度'))
  assert.doesNotMatch(deep.text, /【我的悟道/)

  const report = fs.readFileSync((result.reports || [])[0].split('（')[0], 'utf8')
  assert.doesNotMatch(report, /悟道注入/)
})
