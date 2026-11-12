#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * 一条命令取全套个股数据 → 输出排版好的摘要（供模型直接阅读）
 *
 * 背景：过去每个阶段要把 daily / daily_basic / moneyflow / fina_indicator / income /
 * top_list / margin_detail / index_daily 拆成多次 pwsh 往返，单次分析多耗 40–80 秒，
 * 且字段名与单位（万元 / 元 / % ）全凭模型记忆，容易串。
 *
 * 本脚本一次取齐、统一单位、算好同比与超额收益，模型只需读 digest 即可开始分析。
 *
 * 用法:
 *   node fetch_pack.js <ts_code> [days]
 *      days 日线根数，默认 120
 *
 * 输出（stdout，单行 JSON）:
 *   { ok, code, name, packPath, digest, warnings:[] }
 *   packPath 指向完整原始数据（.dsh-invest/cache/pack/pack_<code>_<日期>.json），
 *   需要更细的明细时才去读该文件；摘要里已有的数字不要重复取数。
 *
 * 依赖: .dsh-invest/tushare.token
 */
'use strict'
const fs = require('fs')
const path = require('path')

const BASE = process.env.DSH_INVEST_BASE_DIR || path.resolve(__dirname, '..')
const TOKEN_FILE = path.join(BASE, '.dsh-invest', 'tushare.token')
const CACHE_DIR = path.join(BASE, '.dsh-invest', 'cache', 'pack')

const warnings = []
const die = (msg) => { console.log(JSON.stringify({ ok: false, error: String(msg).slice(0, 400), warnings })); process.exit(0) }

const pad2 = (n) => String(n).padStart(2, '0')
const ymd = (d) => '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const f = Number(v)
  return isFinite(f) ? f : null
}
const f2 = (v, d) => (v === null) ? '—' : Number(v).toFixed(d === undefined ? 2 : d)
const fp = (v, d) => (v === null) ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(d === undefined ? 2 : d) + '%'
const yi = (wan) => (wan === null) ? '—' : (wan / 10000).toFixed(2) + ' 亿'

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
      if (attempt === 2) { warnings.push(api_name + ' 失败: ' + msg.slice(0, 100)); return { ok: false, rows: [] } }
      await sleep(900)
    } catch (e) {
      if (attempt === 2) { warnings.push(api_name + ' 网络错误: ' + String(e).slice(0, 100)); return { ok: false, rows: [] } }
      await sleep(900)
    }
  }
  return { ok: false, rows: [] }
}

const last = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null)
const sum = (arr, k) => arr.reduce((a, r) => a + (num(r[k]) || 0), 0)

async function main() {
  const args = process.argv.slice(2)
  if (!args.length) die('用法: node fetch_pack.js <ts_code> [days]')
  const code = guessSuffix(args[0])
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(code)) die('代码格式不对: ' + args[0] + '（应形如 600519.SH 或 600519）')
  const days = Math.max(30, Math.min(400, Number(args[1]) || 120))
  const token = readToken()

  const now = new Date()
  const endYmd = ymd(now)
  const start = new Date(now.getTime() - 400 * 24 * 3600 * 1000)
  const startYmd = ymd(start)
  fs.mkdirSync(CACHE_DIR, { recursive: true })

  // ---- 日线（复用 stockchart.js 的本日缓存，避免重复取数）----
  let daily = []
  const dailyCache = path.join(CACHE_DIR, 'daily_' + code + '_' + endYmd + '.json')
  if (fs.existsSync(dailyCache)) {
    try {
      const c = JSON.parse(fs.readFileSync(dailyCache, 'utf8'))
      if (Array.isArray(c.rows)) { daily = c.rows; warnings.push('日线命中本日缓存') }
    } catch (e) { /* ignore */ }
  }
  if (!daily.length) {
    const r = await tushare(token, 'daily', { ts_code: code, start_date: startYmd, end_date: endYmd })
    daily = r.rows
    if (!daily.length) die('未取到 ' + code + ' 日线（' + startYmd + '–' + endYmd + '）')
    daily.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))
    try { fs.writeFileSync(dailyCache, JSON.stringify({ code, endYmd, rows: daily })) } catch (e) { /* ignore */ }
  }
  const rows = daily.slice(-days)
  const closes = rows.map((r) => num(r.close)).filter((v) => v !== null)
  const cur = last(closes)
  const latestDate = rows.length ? String(last(rows).trade_date) : ''

  // ---- 其余接口 ----
  const basic = (await tushare(token, 'stock_basic', { ts_code: code, fields: 'ts_code,name,industry,market,list_date,area' })).rows[0] || {}
  const name = basic.name || ''

  await sleep(150)
  const dbRows = (await tushare(token, 'daily_basic', { ts_code: code, start_date: startYmd, end_date: endYmd })).rows
  dbRows.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))
  const db = last(dbRows) || {}

  await sleep(150)
  const mfRows = (await tushare(token, 'moneyflow_dc', { ts_code: code, start_date: startYmd, end_date: endYmd })).rows
  mfRows.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))

  await sleep(150)
  const finaRows = (await tushare(token, 'fina_indicator', { ts_code: code, start_date: ymd(new Date(now.getTime() - 900 * 24 * 3600 * 1000)), end_date: endYmd })).rows
  finaRows.sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)))
  const fina = last(finaRows) || {}

  await sleep(150)
  const incRows = (await tushare(token, 'income', { ts_code: code, start_date: ymd(new Date(now.getTime() - 900 * 24 * 3600 * 1000)), end_date: endYmd })).rows
  incRows.sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)))

  // 龙虎榜：接口强制要求 trade_date，改为回看最近 8 个交易日（含当日），有记录即收集
  await sleep(150)
  const topRows = []
  const topDates = daily.slice(-8).map((r) => String(r.trade_date)).reverse()
  for (const d of topDates) {
    const r = await tushare(token, 'top_list', { trade_date: d, ts_code: code })
    if (r.rows.length) topRows.push.apply(topRows, r.rows)
    await sleep(120)
  }
  topRows.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))

  await sleep(150)
  const mgRows = (await tushare(token, 'margin_detail', { ts_code: code, start_date: ymd(new Date(now.getTime() - 60 * 24 * 3600 * 1000)), end_date: endYmd })).rows
  mgRows.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))

  await sleep(150)
  const idxRows = (await tushare(token, 'index_daily', { ts_code: '000001.SH', start_date: startYmd, end_date: endYmd })).rows
  idxRows.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))

  // ---- 计算 ----
  const n = closes.length
  const pct = (k) => {
    if (n <= k || n === 0) return null
    const base = closes[n - 1 - k]
    return (base && isFinite(base)) ? (cur / base - 1) * 100 : null
  }
  const ma = (k) => {
    if (n < k) return null
    const seg = closes.slice(-k)
    return seg.reduce((a, b) => a + b, 0) / k
  }
  const hi = rows.length ? Math.max.apply(null, rows.map((r) => num(r.high)).filter((v) => v !== null)) : null
  const lo = rows.length ? Math.min.apply(null, rows.map((r) => num(r.low)).filter((v) => v !== null)) : null
  const mf5 = mfRows.slice(-5)
  const mf20 = mfRows.slice(-20)
  const mf5Sum = sum(mf5, 'net_amount')
  const mf20Sum = sum(mf20, 'net_amount')
  const mg = last(mgRows) || {}
  const mg5 = mgRows.slice(-5)
  const rzyeLatest = num(mg.rzye)
  const rzye5Ago = mg5.length ? num(mg5[0].rzye) : null

  // 相对强度 vs 上证指数
  const idxClose = idxRows.map((r) => num(r.close)).filter((v) => v !== null)
  const excess = (k) => {
    const a = pct(k)
    const m = idxClose.length
    if (a === null || m <= k || !idxClose[m - 1 - k]) return null
    const b = (idxClose[m - 1] / idxClose[m - 1 - k] - 1) * 100
    return a - b
  }

  // ---- 摘要 ----
  const L = []
  L.push('【数据摘要（脚本取数并统一单位，直接引用，勿重复取数）】')
  L.push(code + ' ' + (name || '') + (basic.industry ? ' ｜ ' + basic.industry : '') + (basic.market ? ' ｜ ' + basic.market : '') + (basic.list_date ? ' ｜ 上市 ' + basic.list_date : '') + ' ｜ 最新交易日 ' + latestDate)
  L.push('价格：收盘 ' + f2(cur) + ' ｜ 近5日 ' + fp(pct(5)) + ' ｜ 近20日 ' + fp(pct(20)) + ' ｜ 近60日 ' + fp(pct(60)) + ' ｜ 区间高 ' + f2(hi) + ' / 低 ' + f2(lo) + ' ｜ 距区间高 ' + (hi && cur ? fp((cur / hi - 1) * 100) : '—'))
  L.push('均线：MA5 ' + f2(ma(5)) + ' ｜ MA10 ' + f2(ma(10)) + ' ｜ MA20 ' + f2(ma(20)) + ' ｜ MA60 ' + f2(ma(60)))
  L.push('估值：PE ' + f2(num(db.pe)) + ' ｜ PE_TTM ' + f2(num(db.pe_ttm)) + ' ｜ PB ' + f2(num(db.pb)) + ' ｜ 总市值 ' + f2(num(db.total_mv) === null ? null : num(db.total_mv) / 10000) + ' 亿 ｜ 流通市值 ' + f2(num(db.circ_mv) === null ? null : num(db.circ_mv) / 10000) + ' 亿 ｜ 换手率 ' + f2(num(db.turnover_rate)) + '%' + ' ｜ 量比 ' + f2(num(db.volume_ratio)))
  L.push('主力资金（东财口径，单位万元→已折算）：近5日净流入 ' + yi(mf5Sum) + ' ｜ 近20日净流入 ' + yi(mf20Sum) + (mfRows.length ? ' ｜ 最新日 ' + String(last(mfRows).trade_date) + ' ' + yi(num(last(mfRows).net_amount)) + '（占比 ' + fp(num(last(mfRows).net_amount_rate)) + '）' : ''))
  if (mf20.length) {
    L.push('  近5日逐日：' + mf5.map((r) => String(r.trade_date).slice(4) + ' ' + (num(r.net_amount) >= 0 ? '+' : '') + (num(r.net_amount) / 10000).toFixed(2) + '亿').join(' / '))
  }
  if (Object.keys(fina).length) {
    L.push('财务（' + String(fina.end_date || '') + ' 报告期）：ROE ' + fp(num(fina.roe)) + ' ｜ 净利同比 ' + fp(num(fina.netprofit_yoy)) + ' ｜ 营收同比 ' + fp(num(fina.or_yoy)) + ' ｜ 毛利率 ' + fp(num(fina.grossprofit_margin)) + ' ｜ 资产负债率 ' + fp(num(fina.debt_to_assets)))
  }
  if (incRows.length) {
    const uniq = []
    const seen = new Set()
    for (let i = incRows.length - 1; i >= 0 && uniq.length < 4; i--) {
      const r = incRows[i]
      const k = String(r.end_date || '')
      if (!k || seen.has(k)) continue
      seen.add(k)
      uniq.push(r)
    }
    const seg = uniq.reverse().map((r) => String(r.end_date) + ' 营收 ' + (num(r.revenue) === null ? '—' : (num(r.revenue) / 1e8).toFixed(2) + '亿') + ' / 归母净利 ' + (num(r.n_income_attr_p) === null ? '—' : (num(r.n_income_attr_p) / 1e8).toFixed(2) + '亿'))
    if (seg.length) L.push('业绩（近 ' + seg.length + ' 期，YTD 累计口径）：' + seg.join(' ｜ '))
  }
  L.push('龙虎榜：近8个交易日' + (topRows.length ? '上榜 ' + topRows.length + ' 次，最近 ' + String(last(topRows).trade_date) + '（' + String(last(topRows).reason || '') + '）' : '无记录'))
  L.push('融资融券：融资余额 ' + (rzyeLatest === null ? '—' : (rzyeLatest / 1e8).toFixed(2) + ' 亿') + (rzyeLatest !== null && rzye5Ago !== null ? '，近5日变化 ' + fp((rzyeLatest / rzye5Ago - 1) * 100) : '') + '（' + String(mg.trade_date || '') + '）')
  L.push('相对强度（vs 上证指数）：近20日超额 ' + fp(excess(20)) + ' ｜ 近60日超额 ' + fp(excess(60)))
  L.push('如需原始数据（含全部日线字段、逐期财务明细）：' + path.join(CACHE_DIR, 'pack_' + code.replace(/\./g, '_') + '_' + endYmd + '.json').replace(/\\/g, '/'))

  // ---- 落盘完整数据 ----
  const packPath = path.join(CACHE_DIR, 'pack_' + code.replace(/\./g, '_') + '_' + endYmd + '.json')
  try {
    fs.writeFileSync(packPath, JSON.stringify({
      code, name, endYmd, days,
      basic, daily: rows, daily_basic: dbRows,
      moneyflow_dc: mfRows, fina_indicator: finaRows, income: incRows,
      top_list: topRows, margin_detail: mgRows,
      index_daily_000001SH: idxRows,
      computed: { cur, pct5: pct(5), pct20: pct(20), pct60: pct(60), hi, lo, mf5Sum, mf20Sum, excess20: excess(20), excess60: excess(60) },
    }))
  } catch (e) { warnings.push('完整数据落盘失败: ' + String(e).slice(0, 100)) }

  console.log(JSON.stringify({
    ok: true, code, name,
    packPath: packPath.replace(/\\/g, '/'),
    digest: L.join('\n'),
    warnings,
  }))
}

main().catch((e) => die(e && e.stack ? e.stack.slice(0, 400) : e))
