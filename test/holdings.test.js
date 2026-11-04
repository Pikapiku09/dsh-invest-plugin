// 东财交割单解析测试
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseEastmoneyCsv } = require('../src/lib/pure.js')

const HEADER = '交收日期,发生日期,发生时间,证券代码,证券名称,交易类别,成交数量,成交均价,成交金额,发生金额,佣金,其他费用,印花税,过户费,股份余额,资金余额,成交编号,股东账号,流水号,交易市场,币种,其他,'
const rows = [
  HEADER,
  '2026-11-01,2026-11-01,09:30:00,= "600519",贵州茅台,证券买入,100,1500,150000,-150000,5,0,0,0,100,90000,x,x,x,沪市A股,人民币,--,',
  '2026-11-02,2026-11-02,10:00:00,= "600519",贵州茅台,证券买入,100,1400,140000,-140000,5,0,0,0,200,50000,x,x,x,沪市A股,人民币,--,',
  '2026-11-03,2026-11-03,11:00:00,= "600519",贵州茅台,证券卖出,50,1600,80000,80000,3,0,80,0,50,130000,x,x,x,沪市A股,人民币,--,',
].join('\n')

test('parseEastmoneyCsv：清洗代码公式并取最新股份余额与现金', () => {
  const r = parseEastmoneyCsv(rows)
  assert.equal(r.positions.length, 1)
  assert.equal(r.positions[0].code, '600519.SH')
  assert.equal(r.positions[0].name, '贵州茅台')
  assert.equal(r.positions[0].shares, 50)
  assert.equal(r.account.cash, 130000)
})

test('parseEastmoneyCsv：成本按买入加权均价估算', () => {
  const r = parseEastmoneyCsv(rows)
  assert.equal(r.positions[0].cost, 1450)
})
