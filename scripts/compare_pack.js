#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * 多只股票「同一交易日口径」的对比事实包 → 单行 JSON（机器可读，供前端直接渲染表格）
 *
 * 为什么另写：fetch_pack.js 输出的是给人读的中文字符串，多票对比时①无法保证同一交易日、
 * ②让模型转抄数字必然出错。本脚本一次取齐多票、先求公共 as-of、再在各自序列上按同一
 * 交易日对齐计算，所有数字原样输出为 number，不格式化、不由模型转述。
 *
 * 用法:
 *   node compare_pack.js <code> <code> [code...]        2–3 只，可传 600519 或 600519.SH
 *   node compare_pack.js --no-cache 600519.SH 000823.SZ
 *
 * 输出（stdout，单行 JSON）:
 *   { ok, asof, stocks:[{...}], stale_codes:[], warnings:[], cachePath }
 *   asof 是各票最新交易日的交集；某票若停牌早于 asof，stale=true 且进 stale_codes。
 *
 * 依赖: .dsh-invest/tushare.token（可用 TUSHARE_TOKEN 覆盖）
 */
'use strict'
const fs = require('fs')
const path = require('path')

const BASE = process.env.DSH_INVEST_BASE_DIR || path.resolve(__dirname, '..')
const TOKEN_FILE = path.join(BASE, '.dsh-invest', 'tushare.token')
const CACHE_DIR = path.join(BASE, '.dsh-invest', 'cache', 'compare')
const LOOKBACK_DAYS = 420
const MAX_STOCKS = 3

const warnings = []
const die = (msg) => { console.log(JSON.stringify({ ok: false, error: String(msg).slice(0, 500), warnings })); process.exit(0) }

const pad2 = (n) => String(n).padStart(2, '0')
const ymd = (d) => '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const f = Number(v)
  return isFinite(f) ? f : null
}
const round = (v, d) => (v === null || v === undefined || !isFinite(v)) ? null : Number(Number(v).toFixed(d === undefined ? 2 : d))

function readToken() {
  const env = process.env.TUSHARE_TOKEN
  if (env && env.trim()) return env.trim()
  if (!fs.existsSync(TOKEN_FILE)) die('缺少 token 文件: ' + TOKEN_FILE)
  const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
  if (!t) die('token 文件为空: ' + TOKEN_FILE)
  return t
}

function guessSuffix(code) {
  const c = String(code).trim().toUpperCase()
  if (/\.(SH|SZ|BJ)$/.test(c)) return c
  const d = c.replace(/\D/g, '')
  if (d.length !== 6) return c
  if (/^[569]/.test(d)) return d + '.SH'
  if (/^(0|1|2|3)/.test(d)) return d + '.SZ'
  if (/^(4|8)/.test(d)) return d + '.BJ'
  return d + '.SZ'
}

async function tushare(token, api_name, params) {
  const body = JSON.stringify({ api_name, token, params: params || {} })
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch('https://api.tushare.pro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const j = JSON.parse(await r.text())
      if (j.code === 0) {
        const fld = (j.data && j.data.fields) || []
        const rows = ((j.data && j.data.items) || []).map((it) => {
          const o = {}
          fld.forEach((k, i) => { o[k] = it[i] })
          return o
        })
        return { ok: true, rows }
      }
      const msg = String(j.msg || '')
      if (/权限|没有访问|积分/i.test(msg)) { warnings.push(api_name + ' 无权限，已跳过'); return { ok: false, rows: [] } }
      if (attempt === 2) { warnings.push(api_name + ' 失败: ' + msg.slice(0, 120)); return { ok: false, rows: [] } }
      await sleep(900)
    } catch (e) {
      if (attempt === 2) { warnings.push(api_name + ' 网络错误: ' + String(e).slice(0, 120)); return { ok: false, rows: [] } }
      await sleep(900)
    }
  }
  return { ok: false, rows: [] }
}

const last = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null)
const sum = (arr, k) => arr.reduce((a, r) => a + (num(r[k]) || 0), 0)
const byDate = (a, b) => String(a.trade_date).localeCompare(String(b.trade_date))

/** 取某票截至 asof（含）的全套事实 */
async function fetchOne(token, code, asofHint) {
  const now = new Date()
  const endYmd = ymd(now)
  const startYmd = ymd(new Date(now.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000))

  let daily = []
  // 独立缓存：不用共享的 cache/pack/daily_*.json —— 那份可能是 stockchart.js 为画图写的
  // 精简行（只有 trade_date + close），复用会让 open/high/low/pct_chg 全部变 null。
  const dailyCache = path.join(CACHE_DIR, 'daily_' + code.replace(/\./g, '_') + '_' + endYmd + '.json')
  if (fs.existsSync(dailyCache)) {
    try {
      const c = JSON.parse(fs.readFileSync(dailyCache, 'utf8'))
      const rows = (c && c.rows) || []
      const full = rows.length > 0 && rows.slice(-5).every((r) => num(r.close) !== null && num(r.high) !== null)
      if (full) daily = rows
    } catch (e) { /* ignore */ }
  }
  if (!daily.length) {
    const r = await tushare(token, 'daily', { ts_code: code, start_date: startYmd, end_date: endYmd })
    daily = r.rows.filter((row) => num(row.close) !== null)
    if (daily.length) {
      daily.sort(byDate)
      try { fs.writeFileSync(dailyCache, JSON.stringify({ code, endYmd, rows: daily })) } catch (e) { /* ignore */ }
    }
  }
  daily.sort(byDate)
  const latest = daily.length ? String(last(daily).trade_date) : ''
  if (!latest) return { ok: false, code, latest, reason: '未取到日线' }

  await sleep(120)
  const basic = ((await tushare(token, 'stock_basic', { ts_code: code, fields: 'ts_code,name,industry,market,list_date,area' })).rows || [])[0] || {}

  await sleep(120)
  const dbRows = (await tushare(token, 'daily_basic', { ts_code: code, start_date: startYmd, end_date: endYmd })).rows
  dbRows.sort(byDate)

  await sleep(120)
  const mfRows = (await tushare(token, 'moneyflow_dc', { ts_code: code, start_date: startYmd, end_date: endYmd })).rows
  mfRows.sort(byDate)

  await sleep(120)
  const finaRows = (await tushare(token, 'fina_indicator', { ts_code: code, start_date: ymd(new Date(now.getTime() - 900 * 24 * 3600 * 1000)), end_date: endYmd })).rows
  finaRows.sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)))

  return { ok: true, code, latest, basic, daily, dbRows, mfRows, finaRows }
}

/** 按 asof 截断序列，算出单票指标 */
function computeOne(src, asof, idx) {
  const daily = src.daily.filter((r) => String(r.trade_date) <= asof)
  const dbRows = src.dbRows.filter((r) => String(r.trade_date) <= asof)
  const mfRows = src.mfRows.filter((r) => String(r.trade_date) <= asof)
  const closes = daily.map((r) => num(r.close)).filter((v) => v !== null)
  const n = closes.length
  const close = n ? closes[n - 1] : null

  const pct = (k) => {
    if (n <= k) return null
    const base = closes[n - 1 - k]
    return (base && isFinite(base)) ? round((close / base - 1) * 100) : null
  }
  const ma = (k) => (n < k ? null : round(closes.slice(-k).reduce((a, b) => a + b, 0) / k))

  const rows250 = daily.slice(-250)
  const highs = rows250.map((r) => num(r.high)).filter((v) => v !== null)
  const lows = rows250.map((r) => num(r.low)).filter((v) => v !== null)
  const hi250 = highs.length ? Math.max.apply(null, highs) : null
  const lo250 = lows.length ? Math.min.apply(null, lows) : null

  const db = last(dbRows) || {}
  const fina = last(src.finaRows) || {}
  const mf5 = mfRows.slice(-5)
  const mf20 = mfRows.slice(-20)
  const mfLatest = last(mfRows)

  const idxClose = idx ? idx.map((r) => num(r.close)).filter((v) => v !== null) : []
  const idxPct = (k) => {
    const m = idxClose.length
    if (n <= k || m <= k || !idxClose[m - 1 - k]) return null
    return (idxClose[m - 1] / idxClose[m - 1 - k] - 1) * 100
  }
  const excess = (k) => {
    const a = (n <= k) ? null : (closes[n - 1 - k] ? (close / closes[n - 1 - k] - 1) * 100 : null)
    const b = idxPct(k)
    return (a === null || b === null) ? null : round(a - b)
  }

  const ma20 = ma(20)
  const lastRow = last(daily) || {}
  const totalMv = num(db.total_mv)

  return {
    code: src.code,
    name: src.basic.name || '',
    industry: src.basic.industry || '',
    market: src.basic.market || '',
    list_date: src.basic.list_date || '',
    asof: String(lastRow.trade_date || asof),
    stale: String(lastRow.trade_date || '') < asof,
    close: round(close),
    chg_pct: round(num(lastRow.pct_chg)),
    open: round(num(lastRow.open)),
    high: round(num(lastRow.high)),
    low: round(num(lastRow.low)),
    amount_wan: round(num(lastRow.amount)),
    vol_wan: round(num(lastRow.vol)),
    ma5: ma(5), ma10: ma(10), ma20, ma60: ma(60),
    dist_ma20_pct: (ma20 && close) ? round((close / ma20 - 1) * 100) : null,
    pct5: pct(5), pct20: pct(20), pct60: pct(60),
    hi250: round(hi250), lo250: round(lo250),
    drawdown_pct: (hi250 && hi250 > 0 && close) ? round((close / hi250 - 1) * 100) : null,
    pe: round(num(db.pe)), pe_ttm: round(num(db.pe_ttm)), pb: round(num(db.pb)),
    total_mv_yi: totalMv === null ? null : round(totalMv / 10000),
    circ_mv_yi: num(db.circ_mv) === null ? null : round(num(db.circ_mv) / 10000),
    turnover_rate: round(num(db.turnover_rate)),
    volume_ratio: round(num(db.volume_ratio)),
    db_date: String(db.trade_date || ''),
    mf5_wan: round(mf5.length ? sum(mf5, 'net_amount') : null),
    mf20_wan: round(mf20.length ? sum(mf20, 'net_amount') : null),
    mf_latest_date: String((mfLatest && mfLatest.trade_date) || ''),
    mf_latest_wan: mfLatest ? round(num(mfLatest.net_amount)) : null,
    fina_end_date: String(fina.end_date || ''),
    roe: round(num(fina.roe)),
    netprofit_yoy: round(num(fina.netprofit_yoy)),
    or_yoy: round(num(fina.or_yoy)),
    gpm: round(num(fina.grossprofit_margin)),
    debt_ratio: round(num(fina.debt_to_assets)),
    excess20: excess(20),
    excess60: excess(60),
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const noCache = argv.includes('--no-cache')
  const raw = argv.filter((a) => !a.startsWith('--'))
  if (raw.length < 2) die('用法: node compare_pack.js <code> <code> [code]（2–3 只）')
  if (raw.length > MAX_STOCKS) die('最多对比 ' + MAX_STOCKS + ' 只，收到 ' + raw.length + ' 只')
  const codes = []
  for (const a of raw) {
    const c = guessSuffix(a)
    if (!/^\d{6}\.(SH|SZ|BJ)$/.test(c)) die('代码格式不对: ' + a + '（应形如 000823.SZ 或 000823）')
    if (!codes.includes(c)) codes.push(c)
  }
  if (codes.length < 2) die('去重后只剩 ' + codes.length + ' 只，无法对比')

  const token = readToken()
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const cacheKey = 'compare_' + codes.map((c) => c.replace(/\./g, '_')).join('__') + '.json'
  const cachePath = path.join(CACHE_DIR, cacheKey)
  if (!noCache && fs.existsSync(cachePath)) {
    try {
      const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
      const fresh = c && c.ok && c.asof && (Date.now() - Number(c.fetched_at_ms || 0) < 6 * 3600 * 1000)
      if (fresh) {
        console.log(JSON.stringify({ ...c, from_cache: true }))
        return
      }
    } catch (e) { /* ignore */ }
  }

  const srcs = []
  for (const code of codes) {
    srcs.push(await fetchOne(token, code))
    await sleep(150)
  }
  const good = srcs.filter((s) => s.ok)
  if (good.length < 2) {
    die('可用数据不足 2 只：' + srcs.map((s) => s.code + (s.ok ? '' : '(' + (s.reason || '取数失败') + ')')).join(', '))
  }

  // 统一 as-of：各票最新交易日的交集（取最早的那个）
  const asof = good.map((s) => s.latest).sort()[0]
  const now = new Date()
  const idxRows = (await tushare(token, 'index_daily', {
    ts_code: '000001.SH',
    start_date: ymd(new Date(now.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000)),
    end_date: ymd(now),
  })).rows.filter((r) => String(r.trade_date) <= asof)
  idxRows.sort(byDate)

  const stocks = good.map((s) => computeOne(s, asof, idxRows))
  const stale = stocks.filter((s) => s.stale).map((s) => s.code)
  if (stale.length) warnings.push('停牌/数据滞后的标的（未按 asof 对齐最新一根）：' + stale.join(', '))
  if (srcs.length > good.length) warnings.push('取数失败已排除：' + srcs.filter((s) => !s.ok).map((s) => s.code).join(', '))

  const out = { ok: true, asof, stocks, stale_codes: stale, warnings, fetched_at_ms: Date.now(), cachePath: cachePath.replace(/\\/g, '/') }
  try { fs.writeFileSync(cachePath, JSON.stringify(out)) } catch (e) { warnings.push('缓存落盘失败: ' + String(e).slice(0, 100)) }
  console.log(JSON.stringify(out))
}

main().catch((e) => die(e && e.stack ? e.stack.slice(0, 500) : e))
