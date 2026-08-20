// dsh-invest 纯函数单元测试（Node 内置 node:test，零依赖）
// 运行：npm test 或 node --test test/
const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  z2, localYmd, extractBoth, collectCharts, buildGroups, isLoopbackRequest, fmt, isSepRow, splitBlocks,
} = require('../src/lib/pure.js')

test('z2 补零', () => {
  assert.equal(z2(0), '00')
  assert.equal(z2(5), '05')
  assert.equal(z2(10), '10')
  assert.equal(z2(23), '23')
})

test('localYmd 输出 YYYYMMDD', () => {
  const s = localYmd()
  assert.match(s, /^\d{8}$/)
  const d = new Date()
  assert.equal(s, '' + d.getFullYear() + z2(d.getMonth() + 1) + z2(d.getDate()))
})

test('extractBoth：纯文本字符串直接返回', () => {
  const r = extractBoth('hello 分析')
  assert.deepEqual(r, { text: 'hello 分析', reasoning: '' })
})

test('extractBoth：JSON output 数组提取 text 与 reasoning', () => {
  const obj = { output: [
    { type: 'text', text: '结论A' },
    { type: 'text', text: '结论B' },
    { type: 'reasoning', text: '推理1' },
    { type: 'reasoning', text: '推理2' },
    { type: 'tool_use', text: '忽略' },
  ] }
  const r = extractBoth(JSON.stringify(obj))
  assert.equal(r.text, '结论A\n结论B')
  assert.equal(r.reasoning, '推理1\n推理2')
})

test('extractBoth：非法 JSON 原样当 text', () => {
  const r = extractBoth('{not valid json')
  assert.equal(r.text, '{not valid json')
  assert.equal(r.reasoning, '')
})

test('extractBoth：对象输入序列化后解析', () => {
  const r = extractBoth({ output: [{ type: 'text', text: 'X' }] })
  assert.equal(r.text, 'X')
})

test('collectCharts：提取完整绝对路径 SVG、去重、反斜杠转正斜杠', () => {
  const t = '见图 E:/a/b/c.svg 和 E:\\a\\b\\c.svg 以及 E:/a/b/d.svg 和 d.svg 与 /rel/e.svg'
  const r = collectCharts(t)
  assert.deepEqual(r, ['E:/a/b/c.svg', 'E:/a/b/d.svg'])
})

test('collectCharts：忽略非 E:/ 开头与非 svg', () => {
  const r = collectCharts('E:/x/y.png E:/x/y.svg C:/z/w.svg')
  assert.deepEqual(r, ['E:/x/y.svg'])
})

test('buildGroups：全角色三组（选股∥消息 → 深度 → 总判断）', () => {
  const rm = { '选股': { name: 'A' }, '消息': { name: 'B' }, '深度': { name: 'C' }, '总判断': { name: 'D' } }
  const g = buildGroups(['选股', '消息', '深度', '总判断'], rm)
  assert.equal(g.length, 3)
  assert.deepEqual(g[0].map((x) => x.name), ['A', 'B'])
  assert.deepEqual(g[1].map((x) => x.name), ['C'])
  assert.deepEqual(g[2].map((x) => x.name), ['D'])
})

test('buildGroups：缺失角色跳过、空列表返回空', () => {
  const rm = { '选股': { name: 'A' }, '消息': { name: 'B' }, '深度': { name: 'C' }, '总判断': { name: 'D' } }
  assert.equal(buildGroups(['深度'], rm).length, 1)
  assert.equal(buildGroups(['消息'], rm).length, 1)
  assert.deepEqual(buildGroups([], rm), [])
  assert.equal(buildGroups(['选股', '总判断'], rm).length, 2)
})

test('isLoopbackRequest：loopback 无 origin 放行', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } }
  assert.equal(isLoopbackRequest(req), true)
})

test('isLoopbackRequest：非 loopback 拒绝', () => {
  const req = { socket: { remoteAddress: '192.168.1.5' }, headers: { host: '127.0.0.1:3080' } }
  assert.equal(isLoopbackRequest(req), false)
})

test('isLoopbackRequest：cross-site 拒绝', () => {
  const req = { socket: { remoteAddress: '::1' }, headers: { host: 'localhost:3080', 'sec-fetch-site': 'cross-site' } }
  assert.equal(isLoopbackRequest(req), false)
})

test('isLoopbackRequest：同源 origin 放行、异源拒绝', () => {
  const same = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }
  assert.equal(isLoopbackRequest(same), true)
  const cross = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080', origin: 'http://evil.example.com' } }
  assert.equal(isLoopbackRequest(cross), false)
})

test('fmt：毫秒转秒、空值返回空串', () => {
  assert.equal(fmt(1500), '1.5s')
  assert.equal(fmt(undefined), '')
  assert.equal(fmt(null), '')
  assert.equal(fmt(''), '')
})

test('isSepRow：表格分隔行', () => {
  assert.equal(isSepRow(['---', '---']), true)
  assert.equal(isSepRow([':---:', '---:']), true)
  assert.equal(isSepRow(['abc', 'def']), false)
})

test('splitBlocks：纯文本单个 text 块', () => {
  const r = splitBlocks('第一行\n第二行')
  assert.equal(r.length, 1)
  assert.deepEqual(r[0], { kind: 'text', text: '第一行\n第二行' })
})

test('splitBlocks：表格块丢弃分隔行', () => {
  const r = splitBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |')
  assert.equal(r.length, 1)
  assert.equal(r[0].kind, 'table')
  assert.deepEqual(r[0].rows, [['a', 'b'], ['1', '2']])
})

test('splitBlocks：文本与表格混合分块', () => {
  const r = splitBlocks('标题\n| x |\n| --- |\n| 1 |\n结尾')
  assert.equal(r.length, 3)
  assert.equal(r[0].kind, 'text')
  assert.equal(r[1].kind, 'table')
  assert.deepEqual(r[1].rows, [['x'], ['1']])
  assert.equal(r[2].kind, 'text')
})
