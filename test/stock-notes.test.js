// 个股分析知识库（stock-notes）测试
// 覆盖：① 三段归因（显式标记 / 含代码小标题 / 行级提及节选）；
//      ② 单代码报告整份归属；③ 路由返回清单与单股详情；④ 强制重建写出每只股票的知识库文件。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'
import { splitReport, parseMarkedSections, parseHeadingSections, stockFileName, isStockCode } from '../packages/dsh-invest/lib/stock-notes.js'

const MARKED_REPORT = [
  '# 投研流水线报告',
  '',
  '- 模式：深度分析',
  '- 时间：20261111_100000_test',
  '- 问题：看看茅台和紫金',
  '',
  '## 一、总体判断',
  '两票一守一攻，注意仓位。',
  '',
  '<!--stock:600519.SH|贵州茅台-->',
  '### 贵州茅台',
  '现价 1500，支撑 1450，止损 1420。',
  '<!--/stock-->',
  '',
  '<!--stock:601899.SH|紫金矿业-->',
  '### 紫金矿业',
  '现价 18.2，目标 21，止损 16.9。',
  '<!--/stock-->',
].join('\n')

const HEADING_REPORT = [
  '# 投研流水线报告',
  '',
  '- 模式：个股',
  '',
  '## 股票深度分析：华能国际（600011.SH）',
  '六维诊断：均线多头，量能温和放大，止损 7.42，目标 8.30。',
  '',
  '## 风险提示',
  '行业电价下行风险需持续跟踪。',
].join('\n')

const MULTI_REPORT = [
  '# 投研流水线报告',
  '',
  '- 模式：选股',
  '- 问题：全市场海选',
  '',
  '| 代码 | 名称 | 评级 | 理由 |',
  '|---|---|---|---|',
  '| 002315.SZ | 焦点科技 | A | 跨境电商放量 |',
  '| 603606.SH | 东方电缆 | B | 海风订单落地 |',
].join('\n')

function makeHarness() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-stock-notes-'))
  const reportsDir = path.join(base, '.dsh-invest', 'reports')
  const storeDir = path.join(base, '.dsh-invest', 'store')
  fs.mkdirSync(reportsDir, { recursive: true })
  fs.mkdirSync(storeDir, { recursive: true })
  process.env.DSH_INVEST_BASE_DIR = base
  process.env.DSH_INVEST_SKIP_REINDEX = '1'
  process.env.DSH_INVEST_WATCH_DAILY = '0'
  process.env.DSH_INVEST_SKIP_STOCK_NOTES = '1'

  const files = {
    '20261111_100000_test_a.md': MARKED_REPORT,
    '20261110_090000_test_b.md': HEADING_REPORT,
    '20261109_080000_test_c.md': MULTI_REPORT,
  }
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(reportsDir, name), body, 'utf8')

  const index = {
    codes: {
      '600519.SH': { name: '贵州茅台' },
      '601899.SH': { name: '紫金矿业' },
      '600011.SH': { name: '华能国际' },
      '002315.SZ': { name: '焦点科技' },
      '603606.SH': { name: '东方电缆' },
    },
    reports: Object.keys(files).map((name, id) => ({
      id, path: path.join(reportsDir, name).replace(/\\/g, '/'), primary: true,
      codes: name.includes('_a') ? ['600519.SH', '601899.SH'] : name.includes('_b') ? ['600011.SH'] : ['002315.SZ', '603606.SH'],
    })),
    runs: [],
  }
  fs.writeFileSync(path.join(storeDir, 'index.json'), JSON.stringify(index), 'utf8')

  const registered = []
  const fakeFs = {
    resolve: async (p) => p,
    readText: async (p) => fs.readFileSync(p, 'utf8'),
    writeText: async (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) },
  }
  const ctx = {
    get(name) {
      if (name === 'fs') return fakeFs
      if (name === 'sandboxPolicy') return { resolve: () => ({}) }
      if (name === 'agents') return { roots: () => [], create: async () => ({ agent: null, dispose: async () => {} }) }
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
    let status = 0
    let text = ''
    const req = {
      method, url: pathAndQuery,
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost:3080' },
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    }
    const res = {
      setHeader() {}, set statusCode(v) { status = v }, get statusCode() { return status },
      end(v) { text = v === undefined ? '' : String(v) },
    }
    await route.handler(req, res)
    return { status: status || 200, json: text ? JSON.parse(text) : null }
  }

  return {
    base, reportsDir, storeDir, call,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  }
}

// ===== 解析层 =====

test('分段解析：显式标记按股票切开，标记外内容不归属任何个股', () => {
  const marked = parseMarkedSections(MARKED_REPORT)
  assert.equal(marked.length, 2)
  assert.deepEqual(marked.map((s) => s.code), ['600519.SH', '601899.SH'])
  assert.match(marked[0].text, /现价 1500/)
  assert.doesNotMatch(marked[0].text, /紫金矿业/)

  const split = splitReport(MARKED_REPORT, { codes: ['600519.SH', '601899.SH'], names: { '600519.SH': '贵州茅台', '601899.SH': '紫金矿业' } })
  assert.equal(split.kind, 'marker')
  assert.equal(split.entries.length, 2)
  assert.equal(split.entries[0].name, '贵州茅台')
  assert.equal(split.entries[0].kind, 'marker')
})

test('分段解析：没有标记时按含代码的小标题切段', () => {
  const headed = parseHeadingSections(HEADING_REPORT)
  assert.equal(headed.length, 1)
  assert.equal(headed[0].code, '600011.SH')
  assert.match(headed[0].text, /止损 7\.42/)
  assert.doesNotMatch(headed[0].text, /行业电价下行/, '同级的下一个标题应截断')

  const split = splitReport(HEADING_REPORT, { codes: ['600011.SH'], names: { '600011.SH': '华能国际' } })
  assert.equal(split.kind, 'heading')
  assert.equal(split.entries.length, 1)
})

test('分段解析：单代码报告没有小标题时整份归属该股', () => {
  const split = splitReport(HEADING_REPORT.replace('## 股票深度分析：华能国际（600011.SH）', '## 深度分析'), {
    codes: ['600011.SH'], names: { '600011.SH': '华能国际' },
  })
  assert.equal(split.kind, 'report')
  assert.equal(split.entries[0].code, '600011.SH')
  assert.match(split.entries[0].text, /六维诊断/)
})

test('分段解析：多代码且无分段时，按行提及生成节选（不再整份塞进每只股票）', () => {
  const split = splitReport(MULTI_REPORT, { codes: ['002315.SZ', '603606.SH'], names: { '002315.SZ': '焦点科技', '603606.SH': '东方电缆' } })
  assert.equal(split.kind, 'mention')
  assert.equal(split.entries.length, 2)
  const focus = split.entries.find((e) => e.code === '002315.SZ')
  assert.match(focus.text, /跨境电商放量/)
  assert.doesNotMatch(focus.text, /东方电缆/, '不串到别的股票')
  assert.doesNotMatch(focus.text, /投研流水线报告/, '报告抬头噪声应过滤')
})

// ===== 路由层 =====

test('个股知识库：只收可交易证券，指数代码不进个股清单', () => {
  assert.equal(isStockCode('600519.SH'), true)
  assert.equal(isStockCode('510500.SH'), true, 'ETF 是用户可持有的标的')
  assert.equal(isStockCode('002315.SZ'), true)
  assert.equal(isStockCode('300750.SZ'), true)
  assert.equal(isStockCode('832000.BJ'), true)
  assert.equal(isStockCode('801053.BJ'), false, '申万行业指数不是个股')
  assert.equal(isStockCode('950801.SH'), false, '中证风格指数不是个股')
  assert.equal(isStockCode('202609.SZ'), false)
  assert.equal(isStockCode(''), false)
})

test('个股知识库：清单按股票聚合段数，详情返回摘录与知识库路径', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  const list = await h.call('GET', '/dsh-invest/api/stock-notes')
  assert.equal(list.status, 200)
  assert.equal(list.json.stats.reports, 3)
  const codes = list.json.stocks.map((s) => s.code).sort()
  assert.deepEqual(codes, ['002315.SZ', '600011.SH', '600519.SH', '601899.SH', '603606.SH'])
  const maotai = list.json.stocks.find((s) => s.code === '600519.SH')
  assert.equal(maotai.name, '贵州茅台')
  assert.equal(maotai.count, 1)
  assert.equal(maotai.last_ts, '2026-11-11 10:00:00')
  assert.ok(maotai.modes.includes('深度分析'))

  const detail = await h.call('GET', '/dsh-invest/api/stock-note?code=600519.SH')
  assert.equal(detail.status, 200)
  assert.equal(detail.json.entries.length, 1)
  assert.match(detail.json.entries[0].text, /现价 1500/)
  assert.equal(detail.json.file, path.join(h.storeDir, 'stocks', stockFileName('600519.SH')).replace(/\\/g, '/'))
})

test('个股知识库：主报告被二次总结抹掉标记时，回退 _raw 详版里的分段', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  const name = '20261111_120000_test_d.md'
  const mainBody = [
    '# 投研流水线报告', '', '- 模式：个股', '- 时间：20261111_120000_test', '', '## 一、一句话结论', '茅台守、紫金攻。', '',
    '| 标的/事项 | 立场 |', '|---|---|', '| 600519.SH 贵州茅台 | 持有 |', '| 601899.SH 紫金矿业 | 买入 |',
  ].join('\n')
  const rawBody = [
    '# 各分析师完整原文（归档详版）', '',
    '## 股票深度分析师', '',
    '<!--stock:600519.SH|贵州茅台-->',
    'RAW 分段原文：茅台支撑 1450，止损 1420。',
    '<!--/stock-->', '',
    '<!--stock:601899.SH|紫金矿业-->',
    'RAW 分段原文：紫金目标 21，止损 16.9。',
    '<!--/stock-->',
  ].join('\n')
  fs.writeFileSync(path.join(h.reportsDir, name), mainBody, 'utf8')
  fs.mkdirSync(path.join(h.reportsDir, '_raw'), { recursive: true })
  fs.writeFileSync(path.join(h.reportsDir, '_raw', name), rawBody, 'utf8')
  const indexFile = path.join(h.storeDir, 'index.json')
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  index.reports.push({ id: 99, path: path.join(h.reportsDir, name).replace(/\\/g, '/'), primary: true, codes: ['600519.SH', '601899.SH'] })
  fs.writeFileSync(indexFile, JSON.stringify(index), 'utf8')

  await h.call('POST', '/dsh-invest/api/stock-notes/rebuild?full=1')
  const detail = await h.call('GET', '/dsh-invest/api/stock-note?code=600519.SH')
  assert.equal(detail.json.count, 2, '原标记报告 1 段 + 新报告 _raw 分段 1 段')
  const fromRaw = detail.json.entries.find((entry) => entry.report.includes('_d.md'))
  assert.ok(fromRaw, '新报告应归入该股')
  assert.equal(fromRaw.kind, 'marker')
  assert.match(fromRaw.text, /RAW 分段原文/)
})

test('个股知识库：非法代码 400，未归集的标的不返回条目', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  const bad = await h.call('GET', '/dsh-invest/api/stock-note?code=abc')
  assert.equal(bad.status, 400)

  const missing = await h.call('GET', '/dsh-invest/api/stock-note?code=000001.SZ')
  assert.equal(missing.status, 404)

  const rebuild = await h.call('POST', '/dsh-invest/api/stock-notes/rebuild')
  assert.equal(rebuild.status, 200)
  assert.equal(rebuild.json.ok, true)
  assert.equal(rebuild.json.stats.reused, 3, '报告没变时重建应复用解析结果')
  assert.equal(rebuild.json.stats.entries, 5)

  const khFile = path.join(h.storeDir, 'stocks', stockFileName('600519.SH'))
  assert.ok(fs.existsSync(khFile), '重建应写出单只股票的知识库文件')
  const md = fs.readFileSync(khFile, 'utf8')
  assert.match(md, /贵州茅台/)
  assert.match(md, /个股分析知识库/)
  assert.match(md, /现价 1500/)

  // 再建一次：报告没变 → 复用解析结果（不再读文件正文）
  const again = await h.call('POST', '/dsh-invest/api/stock-notes/rebuild')
  assert.equal(again.status, 200)
  assert.equal(again.json.stats.parsed, 0)
  assert.equal(again.json.stats.reused, 3, '增量重建应复用未变化的报告解析结果')
  assert.equal(again.json.stats.entries, 5, '复用后条目总数不变')})
