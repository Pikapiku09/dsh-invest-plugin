// P3 结论结构化解析测试
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { extractInvestCodes, parseConclusionBlocks } = require('../src/lib/pure.js')

test('extractInvestCodes：识别代码并排除时间戳/转债/基金', () => {
  assert.deepEqual(extractInvestCodes('分析 600519 与 000768.SZ、sh300750，时间 20261104_141529，转债 113000，基金 510300'), ['600519.SH', '000768.SZ', '300750.SZ'])
})

test('parseConclusionBlocks：解析结构化结论并跳过坏行', () => {
  const text = ['【结论结构化】{"code":"600519.SH","stance":"拒绝","target":1500,"stop":1296,"thesis":"赔率不足"}', '【结论结构化】{bad json}'].join('\n')
  const rows = parseConclusionBlocks(text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].code, '600519.SH')
  assert.equal(rows[0].stance, '拒绝')
})

test('parseConclusionBlocks：容忍 markdown 加粗 **【结论结构化】**', () => {
  const text = '**【结论结构化】**{"code":"000858.SZ","stance":"看多","target":180,"stop":150}'
  const rows = parseConclusionBlocks(text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].code, '000858.SZ')
})
