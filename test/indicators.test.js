// 指标计算单元测试（v0.42.0）
// 背景：图表/指标以前由模型手算后写成 JSON，存在精度风险；现改由 scripts/stockchart.js
// 确定性计算。这些函数一旦算错，报告里的 MA/MACD/九转全部失真，因此必须有硬断言。
const test = require('node:test')
const assert = require('node:assert/strict')
const { ma, ema, macdOf, nineTurn, buildLevels, guessSuffix } = require('../scripts/stockchart.js')

test('ma：窗口不足返回 null，满窗口为算术均值', () => {
  assert.deepEqual(ma([1, 2, 3, 4, 5], 5), [null, null, null, null, 3])
  assert.deepEqual(ma([2, 4, 6], 2), [null, 3, 5])
})

test('ema：首值作种子，逐日按 2/(n+1) 平滑', () => {
  const e = ema([1, 2, 3], 3) // k = 0.5
  assert.equal(e[0], 1)
  assert.equal(e[1], 1.5)
  assert.equal(e[2], 2.25)
})

test('macdOf：常量序列的 DIF/DEA/柱 全部收敛到 0', () => {
  const { dif, dea, hist } = macdOf(new Array(40).fill(10))
  assert.ok(Math.abs(dif[dif.length - 1]) < 1e-9)
  assert.ok(Math.abs(dea[dea.length - 1]) < 1e-9)
  assert.ok(Math.abs(hist[hist.length - 1]) < 1e-9)
})

test('macdOf：单边上涨序列 DIF 转正、柱为 (DIF-DEA)*2', () => {
  const close = Array.from({ length: 60 }, (_, i) => 10 + i)
  const { dif, dea, hist } = macdOf(close)
  const i = close.length - 1
  assert.ok(dif[i] > 0, 'DIF 应为正')
  assert.ok(Math.abs(hist[i] - (dif[i] - dea[i]) * 2) < 1e-9, '柱 = (DIF-DEA)*2')
})

test('nineTurn：连续下跌生成买入序列，第 9 根被记录为最近完成', () => {
  const close = Array.from({ length: 15 }, (_, i) => 100 - i)
  const r = nineTurn(close)
  assert.equal(r.up, 0)
  assert.equal(r.down, 11) // i=4..14 共 11 根满足 close[i] < close[i-4]
  assert.equal(r.entries.length, 7) // 只输出 5..13 的进度
  assert.deepEqual(r.entries.map((e) => e.count), [5, 6, 7, 8, 9, 10, 11])
  assert.ok(r.entries.every((e) => e.dir === 'buy'))
  assert.equal(r.lastDone.count, 9)
  assert.equal(r.lastDone.index, 12)
})

test('nineTurn：连续上涨生成卖出序列', () => {
  const close = Array.from({ length: 15 }, (_, i) => 100 + i)
  const r = nineTurn(close)
  assert.equal(r.down, 0)
  assert.equal(r.up, 11)
  assert.ok(r.entries.every((e) => e.dir === 'sell'))
  assert.equal(r.lastDone.dir, 'sell')
})

test('nineTurn：震荡序列不应产生序列计数', () => {
  const close = [10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11]
  const r = nineTurn(close)
  assert.equal(r.up, 0)
  assert.equal(r.down, 0)
  assert.equal(r.entries.length, 0)
})

test('buildLevels：同价位去重，区间极值与均线均被标注', () => {
  const rows = new Array(20).fill(0).map(() => ({ high: 10, low: 5 }))
  const levels = buildLevels(rows, 8, { ma5: 8.5, ma10: 8.2, ma20: 7.5, ma60: 7.4 })
  const vals = levels.map((l) => l.value)
  assert.equal(vals.length, new Set(vals).size, '不得出现重复价位')
  assert.equal(levels[0].label, '60日高')
  assert.equal(levels[0].value, 10)
  assert.ok(levels.some((l) => l.label === 'MA20' && l.value === 7.5))
  assert.ok(levels.some((l) => l.label === 'MA60' && l.value === 7.4))
  assert.ok(levels.some((l) => l.label === '20日低' && l.value === 5))
})

test('guessSuffix：六位代码按板块补后缀', () => {
  assert.equal(guessSuffix('600519'), '600519.SH')
  assert.equal(guessSuffix('000001'), '000001.SZ')
  assert.equal(guessSuffix('300750'), '300750.SZ')
  assert.equal(guessSuffix('830799'), '830799.BJ')
  assert.equal(guessSuffix('600519.SH'), '600519.SH')
  assert.equal(guessSuffix('000001.sz'), '000001.SZ')
})
