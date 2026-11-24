// 行情数据源适配层单测（v0.79.0）
//
// 覆盖点：
// ① 代码互转（Tushare ↔ 腾讯）——错一个字母就拉不到数据，且是静默失败，必须锁死；
// ② K 线 URL 构造——个股要 qfq、指数不能带 qfq（带了腾讯返回空）；
// ③ 响应解析——首行没有前收，pre_close/change/pct_chg 必须留 null 而不是编造；
// ④ 失败即降级——网络炸了返回 []，绝不抛给上游；
// ⑤ 离线开关——DSH_INVEST_OFFLINE=1 时一次外呼都不发。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  toTencentCode,
  fromTencentCode,
  toDashed,
  toCompact,
  buildTencentKlineUrl,
  parseTencentKline,
  fetchTencentDaily,
  needsAdjFactor,
  describeSource,
  buildOnboardingHint,
  offlineMode,
} from '../packages/dsh-invest/lib/source.js'

test('代码互转：Tushare → 腾讯', () => {
  assert.equal(toTencentCode('600000.SH'), 'sh600000')
  assert.equal(toTencentCode('000001.SZ'), 'sz000001')
  assert.equal(toTencentCode('300750.SZ'), 'sz300750')
  assert.equal(toTencentCode('688981.SH'), 'sh688981')
  assert.equal(toTencentCode('430047.BJ'), 'bj430047')
  // 已带前缀 / 纯 6 位
  assert.equal(toTencentCode('sh600000'), 'sh600000')
  assert.equal(toTencentCode('600519'), 'sh600519')
  assert.equal(toTencentCode('000858'), 'sz000858')
  assert.equal(toTencentCode('430047'), 'bj430047')
  // 不认识的形态原样返回，不猜
  assert.equal(toTencentCode('BRK.B'), 'brk.b')
  assert.equal(toTencentCode(''), '')
})

test('代码互转：腾讯 → Tushare', () => {
  assert.equal(fromTencentCode('sh600000'), '600000.SH')
  assert.equal(fromTencentCode('sz000001'), '000001.SZ')
  assert.equal(fromTencentCode('bj430047'), '430047.BJ')
  assert.equal(fromTencentCode('600000.SH'), '600000.SH', '已是大写后缀则原样返回')
})

test('日期格式互转', () => {
  assert.equal(toDashed('20261124'), '2026-11-24')
  assert.equal(toCompact('2026-11-24'), '20261124')
  assert.equal(toDashed('2026-11-24'), '2026-11-24', '非 8 位数字原样返回')
  assert.equal(toCompact('x'), 'x')
})

test('K 线 URL：个股带 qfq、指数不带 qfq', () => {
  const stock = decodeURIComponent(buildTencentKlineUrl('600000.SH', false, 400).split('param=')[1])
  assert.equal(stock, 'sh600000,day,,,400,qfq')

  const index = decodeURIComponent(buildTencentKlineUrl('000001.SH', true, 400).split('param=')[1])
  assert.equal(index, 'sh000001,day,,,400,')
  assert.ok(!index.endsWith('qfq'), '指数请求不能带 qfq，否则腾讯返回空')
})

test('K 线 URL：days 夹在 [30, 800]', () => {
  const p = (n) => decodeURIComponent(buildTencentKlineUrl('600000.SH', false, n).split('param=')[1])
  assert.equal(p(5), 'sh600000,day,,,30,qfq')
  assert.equal(p(0), 'sh600000,day,,,400,qfq', '非法值回落 400')
  assert.equal(p(9999), 'sh600000,day,,,800,qfq')
})

const QFQ_FIXTURE = JSON.stringify({
  code: 0,
  data: {
    sh600000: {
      qfqday: [
        ['2026-11-20', '10.00', '10.20', '10.30', '9.90', '123456'],
        ['2026-11-21', '10.20', '10.71', '10.80', '10.10', '234567'],
      ],
    },
  },
})

test('解析：qfqday → Tushare 行，升序且补齐涨跌字段', () => {
  const rows = parseTencentKline(QFQ_FIXTURE, '600000.SH', false)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.trade_date), ['20261120', '20261121'])
  assert.equal(rows[0].ts_code, '600000.SH')
  assert.equal(rows[0].open, 10)
  assert.equal(rows[0].close, 10.2)
  assert.equal(rows[0].high, 10.3)
  assert.equal(rows[0].low, 9.9)
  assert.equal(rows[0].vol, 123456)

  // 首行没有前收 —— 留 null，不编造 0
  assert.equal(rows[0].pre_close, null)
  assert.equal(rows[0].change, null)
  assert.equal(rows[0].pct_chg, null)

  // 第二行由首行收盘价推出
  assert.equal(rows[1].pre_close, 10.2)
  assert.equal(rows[1].change, 0.51)
  assert.equal(rows[1].pct_chg, 5)

  // 腾讯不给成交额，统一 null（下游不可当 0 用）
  assert.equal(rows[0].amount, null)
})

test('解析：指数用 day 键；即便响应里混了 qfqday 也不取', () => {
  const text = JSON.stringify({
    code: 0,
    data: { sh000001: { day: [['2026-11-20', '3000', '3010', '3020', '2990', '888888']], qfqday: [['garbage']] } },
  })
  const rows = parseTencentKline(text, '000001.SH', true)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].close, 3010)
  assert.equal(rows[0].ts_code, '000001.SH')
})

test('解析：异常响应一律返回空数组，不抛', () => {
  assert.deepEqual(parseTencentKline('not json', '600000.SH', false), [])
  assert.deepEqual(parseTencentKline(JSON.stringify({ code: 1 }), '600000.SH', false), [])
  assert.deepEqual(parseTencentKline(JSON.stringify({ code: 0, data: {} }), '600000.SH', false), [])
  // 价格非法（<=0）的行被丢弃
  const bad = JSON.stringify({ code: 0, data: { sh600000: { qfqday: [['2026-11-20', '0', '0', '0', '0', '1']] } } })
  assert.deepEqual(parseTencentKline(bad, '600000.SH', false), [])
  // 行内没有 5 列的也丢
  const short = JSON.stringify({ code: 0, data: { sh600000: { qfqday: [['2026-11-20', '1']] } } })
  assert.deepEqual(parseTencentKline(short, '600000.SH', false), [])
})

test('fetchTencentDaily：注入 fetch 时正常返回；抛出时返回空数组', async () => {
  const ok = await fetchTencentDaily('600000.SH', false, 400, async () => ({
    ok: true,
    text: async () => QFQ_FIXTURE,
  }))
  assert.equal(ok.length, 2)

  const boom = await fetchTencentDaily('600000.SH', false, 400, async () => {
    throw new Error('network down')
  })
  assert.deepEqual(boom, [], '网络异常必须降级成空数组，不能抛')

  const notOk = await fetchTencentDaily('600000.SH', false, 400, async () => ({ ok: false, text: async () => '' }))
  assert.deepEqual(notOk, [])
})

test('离线开关：DSH_INVEST_OFFLINE=1 时一次外呼都不发', async () => {
  const prev = process.env.DSH_INVEST_OFFLINE
  process.env.DSH_INVEST_OFFLINE = '1'
  try {
    assert.equal(offlineMode(), true)
    let called = false
    const rows = await fetchTencentDaily('600000.SH', false, 400, async () => {
      called = true
      return { ok: true, text: async () => QFQ_FIXTURE }
    })
    assert.deepEqual(rows, [])
    assert.equal(called, false, '离线模式下不应发起请求')
  } finally {
    if (prev === undefined) delete process.env.DSH_INVEST_OFFLINE
    else process.env.DSH_INVEST_OFFLINE = prev
  }
})

test('复权因子语义：腾讯前复权价不需要再乘因子', () => {
  assert.equal(needsAdjFactor('tencent'), false)
  assert.equal(needsAdjFactor('tushare'), true)
  assert.equal(needsAdjFactor(''), true)
})

test('数据源说明：三种状态都要说人话，且降级不静默', () => {
  assert.match(describeSource({ daily: 'tushare' }), /数据源：Tushare/)
  const tencent = describeSource({ daily: 'tencent' })
  assert.match(tencent, /腾讯自选股/)
  assert.match(tencent, /前复权/)
  assert.match(tencent, /基本面字段缺失/)
  const none = describeSource({ daily: 'none' })
  assert.match(none, /未就绪/)
  assert.match(none, /腾讯行情也未连通/)

  const withErr = describeSource({ daily: 'tencent', error: 'daily 接口超时' })
  assert.match(withErr, /最近一次取数失败：daily 接口超时/)
  // 长错误要截断，避免把报告头撑爆
  assert.ok(describeSource({ daily: 'tencent', error: 'x'.repeat(400) }).length < 400)
})

test('首装引导：有 token 时为空串，没有时给两条路', () => {
  assert.equal(buildOnboardingHint(true), '')
  const hint = buildOnboardingHint(false)
  assert.match(hint, /腾讯自选股免费行情/)
  assert.match(hint, /tushare\.pro/)
  assert.match(hint, /\.dsh-invest\/tushare\.token/)
  assert.match(hint, /深度分析会按「无财务数据」处理/)
})
