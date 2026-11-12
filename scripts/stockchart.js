#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * 一条命令完成「取数 → 算指标 → 出 SVG 图表 → 返回技术摘要」
 *
 * 背景：过去由模型手写 charts/*.json（145 天 × 7 个数组 ≈ 13KB 纯数字），
 * 单个标的深度分析因此多耗 80–160 秒，且模型手算 MA/MACD 存在精度风险。
 * 本脚本把全部数值计算交给确定性代码，模型只需调用一次并引用返回的 digest。
 *
 * 用法:
 *   node stockchart.js <ts_code> [types] [days]
 *     types  price | macd | both   （默认 both）
 *     days   日线根数，默认 145（含 MA60 预热，实际多取 70 根）
 *
 * 例:
 *   node scripts/stockchart.js 600519.SH
 *   node scripts/stockchart.js 000001.SZ price 90
 *
 * 输出（stdout，单行 JSON）:
 *   { ok, code, name, charts:[{type,svg,json}], digest, warnings:[] }
 *   digest 为可直接粘贴进报告的「技术面摘要」，数字全部由本脚本计算，无需模型重算。
 *
 * 依赖: 本机 python + scripts/chart.py（SVG 渲染）、.dsh-invest/tushare.token
 */
'use strict'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const BASE = process.env.DSH_INVEST_BASE_DIR || path.resolve(__dirname, '..')
const TOKEN_FILE = path.join(BASE, '.dsh-invest', 'tushare.token')
const CHARTS_DIR = path.join(BASE, '.dsh-invest', 'charts')
const CACHE_DIR = path.join(BASE, '.dsh-invest', 'cache', 'pack')
const CHART_PY = path.join(BASE, 'scripts', 'chart.py')

const warnings = []
const die = (msg) => { console.log(JSON.stringify({ ok: false, error: String(msg).slice(0, 400), warnings })); process.exit(0) }

// ---------- 基础设施 ----------
const pad2 = (n) => String(n).padStart(2, '0')
const ymd = (d) => '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
const round = (v, n) => (v === null || v === undefined || !isFinite(v)) ? null : Math.round(v * Math.pow(10, n)) / Math.pow(10, n)

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
      // 0 = 成功；其余为业务错误（权限不足 / 参数错 / 频率超限）
      if (j.code === 0) return { fields: (j.data && j.data.fields) || [], items: (j.data && j.data.items) || [] }
      const msg = String(j.msg || '')
      if (/权限|没有访问|积分/i.test(msg)) { warnings.push(api_name + ' 无权限，已跳过'); return { fields: [], items: [] } }
      if (attempt === 2) { warnings.push(api_name + ' 失败: ' + msg.slice(0, 120)); return { fields: [], items: [] } }
      await new Promise((r2) => setTimeout(r2, 800))
    } catch (e) {
      if (attempt === 2) { warnings.push(api_name + ' 网络错误: ' + String(e).slice(0, 120)); return { fields: [], items: [] } }
      await new Promise((r2) => setTimeout(r2, 800))
    }
  }
  return { fields: [], items: [] }
}

const toRows = (res) => {
  const f = res.fields || []
  return (res.items || []).map((it) => {
    const o = {}
    f.forEach((k, i) => { o[k] = it[i] })
    return o
  })
}

// ---------- 指标计算（确定性） ----------
function ma(arr, n) {
  const out = []
  let sum = 0
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i]
    if (i >= n) sum -= arr[i - n]
    out.push(i >= n - 1 ? sum / n : null)
  }
  return out
}

function ema(arr, n) {
  const k = 2 / (n + 1)
  const out = []
  let prev = null
  for (const v of arr) {
    if (v === null || v === undefined || !isFinite(v)) { out.push(prev); continue }
    prev = (prev === null) ? v : v * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

function macdOf(close) {
  const e12 = ema(close, 12)
  const e26 = ema(close, 26)
  const dif = close.map((_, i) => (e12[i] === null || e26[i] === null) ? null : e12[i] - e26[i])
  const dea = ema(dif, 9)
  const hist = dif.map((d, i) => (d === null || dea[i] === null) ? null : (d - dea[i]) * 2)
  return { dif, dea, hist }
}

// 九转序列（TD Sequential）：close[i] 与 close[i-4] 比较，连续计数
function nineTurn(close) {
  const entries = []
  let up = 0
  let down = 0
  let lastDone = null
  for (let i = 4; i < close.length; i++) {
    if (close[i] > close[i - 4]) { up++; down = 0 } else if (close[i] < close[i - 4]) { down++; up = 0 } else { up = 0; down = 0 }
    const dir = up > 0 ? 'sell' : (down > 0 ? 'buy' : null)
    const count = up > 0 ? up : down
    if (dir && count >= 5 && count <= 13) entries.push({ index: i, dir, count })
    if (dir && count === 9) lastDone = { dir, index: i, count }
  }
  return { entries, up, down, lastDone }
}

// 摆动点（window 内极值）
function swings(arr, w, kind) {
  const out = []
  for (let i = w; i < arr.length - w; i++) {
    let is = true
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue
      if (kind === 'high' ? arr[j] > arr[i] : arr[j] < arr[i]) { is = false; break }
    }
    if (is) out.push(i)
  }
  return out
}

// 背离：价格创新高而 DIF 未创新高（顶）；反之底
function divergences(close, dif, lookback) {
  const out = []
  const start = Math.max(5, close.length - lookback)
  const hs = swings(close.slice(start), 5, 'high').map((i) => i + start).filter((i) => i > 0 && i < close.length - 1)
  const ls = swings(close.slice(start), 5, 'low').map((i) => i + start).filter((i) => i > 0 && i < close.length - 1)
  const push = (a, b, dir, label) => {
    if (a === undefined || b === undefined) return
    if (dir === 'top' && close[b] > close[a] && dif[b] !== null && dif[a] !== null && dif[b] < dif[a]) {
      out.push({ index: b, dir: 'top', label: label || '顶背离' })
    }
    if (dir === 'bot' && close[b] < close[a] && dif[b] !== null && dif[a] !== null && dif[b] > dif[a]) {
      out.push({ index: b, dir: 'bot', label: label || '底背离' })
    }
  }
  for (let k = 1; k < hs.length; k++) push(hs[k - 1], hs[k], 'top')
  for (let k = 1; k < ls.length; k++) push(ls[k - 1], ls[k], 'bot')
  // 只保留最近 3 处，按时间排序
  return out.sort((a, b) => a.index - b.index).slice(-3)
}

// 关键价位：区间高低 + 均线 + 整数关口
function buildLevels(rows, cur, maVals) {
  const n = rows.length
  const seg = (k) => rows.slice(Math.max(0, n - k))
  const hi = (k) => Math.max.apply(null, seg(k).map((r) => r.high).filter((v) => isFinite(v)))
  const lo = (k) => Math.min.apply(null, seg(k).map((r) => r.low).filter((v) => isFinite(v)))
  const raw = []
  const h60 = hi(60); const l60 = lo(60); const h20 = hi(20); const l20 = lo(20)
  if (isFinite(h60)) raw.push({ value: round(h60, 2), label: '60日高' })
  if (isFinite(h20)) raw.push({ value: round(h20, 2), label: '20日高' })
  for (const [k, label] of [['ma20', 'MA20'], ['ma60', 'MA60']]) {
    const v = maVals[k]
    if (v !== null && isFinite(v)) raw.push({ value: round(v, 2), label })
  }
  if (isFinite(l20)) raw.push({ value: round(l20, 2), label: '20日低' })
  if (isFinite(l60)) raw.push({ value: round(l60, 2), label: '60日低' })
  // 整数关口（贴近现价才加）
  if (isFinite(cur) && cur > 0) {
    const step = cur < 5 ? 0.5 : cur < 20 ? 1 : cur < 100 ? 5 : cur < 500 ? 10 : 50
    const rn = Math.round(cur / step) * step
    if (rn > 0 && Math.abs(rn - cur) / cur < 0.03) raw.push({ value: round(rn, 2), label: '整数关口' })
  }
  // 去重（0.4% 内视为同一价位），保留先出现的（区间高低与均线优先）
  const out = []
  for (const l of raw) {
    if (l.value === null || !isFinite(l.value)) continue
    if (out.some((x) => Math.abs(x.value - l.value) / Math.max(1e-9, l.value) < 0.004)) continue
    out.push(l)
  }
  return out.slice(0, 6)
}

// ---------- 摘要 ----------
function buildDigest(ctx) {
  const { code, name, rows, close, maVals, macd, nine, levels, divs, days } = ctx
  const n = close.length
  const last = close[n - 1]
  const prev = n > 1 ? close[n - 2] : null
  const chg = (prev && isFinite(prev) && prev !== 0) ? (last / prev - 1) * 100 : null
  const pct = (k) => {
    if (n <= k) return null
    const base = close[n - 1 - k]
    return (base && isFinite(base)) ? (last / base - 1) * 100 : null
  }
  const f2 = (v) => (v === null || !isFinite(v)) ? '—' : Number(v).toFixed(2)
  const fp = (v) => (v === null || !isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
  const dif = macd.dif[n - 1]
  const dea = macd.dea[n - 1]
  const hist = macd.hist[n - 1]
  const histPrev = n > 1 ? macd.hist[n - 2] : null
  // 均线排列
  const vals = [last, maVals.ma5, maVals.ma10, maVals.ma20, maVals.ma60].filter((v) => v !== null && isFinite(v))
  let arrange = '数据不足'
  if (vals.length === 5) {
    const desc = vals.every((v, i) => i === 0 || vals[i - 1] >= v)
    const asc = vals.every((v, i) => i === 0 || vals[i - 1] <= v)
    arrange = desc ? '多头排列（收盘>MA5>MA10>MA20>MA60）' : asc ? '空头排列（收盘<MA5<MA10<MA20<MA60）' : '均线交织'
  }
  // 九转当前状态
  let nineTxt = '无进行中的序列'
  if (nine.up > 0) nineTxt = '卖出序列进行中 ' + nine.up + (nine.up >= 9 ? '（已达/超过 9，衰竭风险）' : '（未到 9）')
  else if (nine.down > 0) nineTxt = '买入序列进行中 ' + nine.down + (nine.down >= 9 ? '（已达/超过 9，反弹窗口）' : '（未到 9）')
  const doneTxt = nine.lastDone ? ('；最近完成 ' + (nine.lastDone.dir === 'sell' ? '卖出9' : '买入9') + ' @' + rows[nine.lastDone.index].trade_date) : ''
  const divTxt = divs.length ? divs.map((d) => (d.dir === 'top' ? '顶背离' : '底背离') + ' @' + rows[d.index].trade_date).join(' / ') : '未检出'
  const lvTxt = levels.map((l) => l.label + ' ' + f2(l.value)).join(' / ')
  const macdState = (dif !== null && dea !== null) ? (dif > dea ? 'DIF>DEA（多头）' : 'DIF<DEA（空头）') : '—'
  const histTrend = (hist !== null && histPrev !== null) ? (Math.abs(hist) > Math.abs(histPrev) ? '动能放大' : '动能收敛') : ''

  const lines = []
  lines.push('【技术面摘要（脚本计算，直接引用，勿重算）】')
  lines.push(code + ' ' + (name || '') + ' ｜ 区间 ' + rows[0].trade_date + '–' + rows[n - 1].trade_date + '（' + n + ' 根日线，展示 ' + days + ' 根）')
  lines.push('收盘 ' + f2(last) + '（' + fp(chg) + '）｜ 近5日 ' + fp(pct(5)) + ' ｜ 近20日 ' + fp(pct(20)) + ' ｜ 近60日 ' + fp(pct(60)))
  lines.push('MA5 ' + f2(maVals.ma5) + ' ｜ MA10 ' + f2(maVals.ma10) + ' ｜ MA20 ' + f2(maVals.ma20) + ' ｜ MA60 ' + f2(maVals.ma60) + ' ｜ 排列：' + arrange)
  lines.push('MACD：DIF ' + f2(dif) + ' / DEA ' + f2(dea) + ' / 柱 ' + f2(hist) + '（' + macdState + (histTrend ? '，' + histTrend : '') + '）')
  lines.push('九转：' + nineTxt + doneTxt)
  lines.push('关键价位：' + (lvTxt || '—'))
  lines.push('背离：' + divTxt)
  const v5 = rows.slice(-5).reduce((a, r) => a + (Number(r.vol) || 0), 0) / Math.max(1, Math.min(5, rows.length))
  const v20 = rows.slice(-20).reduce((a, r) => a + (Number(r.vol) || 0), 0) / Math.max(1, Math.min(20, rows.length))
  if (v20 > 0) lines.push('量能：5日均量 / 20日均量 = ' + (v5 / v20).toFixed(2) + '（>1.2 放量、<0.8 缩量）')
  return lines.join('\n')
}

// ---------- 主流程 ----------
async function main() {
  const args = process.argv.slice(2)
  if (!args.length) die('用法: node stockchart.js <ts_code> [price|macd|both] [days]')
  const code = guessSuffix(args[0])
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(code)) die('代码格式不对: ' + args[0] + '（应形如 600519.SH 或 600519）')
  let types = String(args[1] || 'both').toLowerCase()
  if (types === 'all') types = 'both'
  if (!/^(price|macd|both|price,macd|macd,price)$/.test(types)) die('types 只能是 price / macd / both')
  const want = types === 'both' || types.includes(',') ? ['price', 'macd'] : [types]
  const days = Math.max(30, Math.min(400, Number(args[2]) || 145))
  const token = readToken()

  const end = new Date()
  const start = new Date(end.getTime() - 400 * 24 * 3600 * 1000)
  const startYmd = ymd(start)
  const endYmd = ymd(end)

  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const cacheFile = path.join(CACHE_DIR, 'daily_' + code + '_' + endYmd + '.json')
  let dailyRows
  if (fs.existsSync(cacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (Array.isArray(c.rows) && c.rows.length) { dailyRows = c.rows; warnings.push('日线命中本日缓存') }
    } catch (e) { /* 缓存损坏则重新取 */ }
  }
  if (!dailyRows) {
    const res = await tushare(token, 'daily', { ts_code: code, start_date: startYmd, end_date: endYmd })
    dailyRows = toRows(res)
    if (!dailyRows.length) die('未取到 ' + code + ' 的日线数据（区间 ' + startYmd + '–' + endYmd + '），请确认代码或数据权限')
    dailyRows.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))
    try { fs.writeFileSync(cacheFile, JSON.stringify({ code, endYmd, rows: dailyRows })) } catch (e) { /* 缓存失败不影响 */ }
  }

  // 名称
  let name = ''
  const basicFile = path.join(CACHE_DIR, 'basic_' + code + '.json')
  if (fs.existsSync(basicFile)) {
    try { name = JSON.parse(fs.readFileSync(basicFile, 'utf8')).name || '' } catch (e) { /* ignore */ }
  }
  if (!name) {
    const b = toRows(await tushare(token, 'stock_basic', { ts_code: code, fields: 'ts_code,name,industry,market' }))[0]
    if (b && b.name) {
      name = b.name
      try { fs.writeFileSync(basicFile, JSON.stringify({ name: b.name, industry: b.industry || '', market: b.market || '' })) } catch (e) { /* ignore */ }
    }
  }

  // 取最后 days 根
  const rows = dailyRows.slice(-days)
  if (rows.length < 30) die('日线样本不足（' + rows.length + ' 根），无法计算指标')
  const close = rows.map((r) => Number(r.close))
  const dates = rows.map((r) => String(r.trade_date))

  const ma5 = ma(close, 5)
  const ma10 = ma(close, 10)
  const ma20 = ma(close, 20)
  const ma60 = ma(close, 60)
  const macd = macdOf(close)
  const nine = nineTurn(close)
  const divs = divergences(close, macd.dif, 80)
  const maVals = {
    ma5: ma5[ma5.length - 1], ma10: ma10[ma10.length - 1],
    ma20: ma20[ma20.length - 1], ma60: ma60[ma60.length - 1],
  }
  const levels = buildLevels(rows, close[close.length - 1], maVals)

  fs.mkdirSync(CHARTS_DIR, { recursive: true })
  const stamp = dates[0] + '-' + dates[dates.length - 1]
  const charts = []
  const r2 = (arr) => arr.map((v) => round(v, 3))

  for (const type of want) {
    const jPath = path.join(CHARTS_DIR, code.replace(/\./g, '_') + '_' + type + '.json')
    const sPath = path.join(CHARTS_DIR, code.replace(/\./g, '_') + '_' + type + '.svg')
    let payload
    if (type === 'price') {
      payload = {
        type: 'price',
        title: (name || code) + ' ' + code + ' 走势 ' + stamp,
        code, name,
        dates, close: r2(close),
        ma5: r2(ma5), ma10: r2(ma10), ma20: r2(ma20), ma60: r2(ma60),
        levels, nine: nine.entries,
        width: 1000, height: 520,
      }
    } else {
      payload = {
        type: 'macd',
        title: (name || code) + ' ' + code + ' MACD ' + stamp,
        code, name,
        dates, dif: r2(macd.dif), dea: r2(macd.dea), hist: r2(macd.hist),
        divergences: divs,
        width: 1000, height: 560,
      }
    }
    fs.writeFileSync(jPath, JSON.stringify(payload))
    const py = spawnSync('python', [CHART_PY, jPath, sPath], { encoding: 'utf8', timeout: 60000 })
    let okPy = false
    let pyMsg = ''
    if (py.error) pyMsg = String(py.error.message || py.error)
    else {
      const out = String(py.stdout || '').trim()
      try {
        const j = JSON.parse(out.split('\n').filter(Boolean).pop() || '{}')
        okPy = j.ok === true
        pyMsg = okPy ? '' : String(j.error || '')
      } catch (e) { pyMsg = 'chart.py 输出无法解析: ' + out.slice(0, 120) }
    }
    if (okPy) charts.push({ type, svg: sPath.replace(/\\/g, '/'), json: jPath.replace(/\\/g, '/') })
    else warnings.push(type + ' 图渲染失败: ' + pyMsg.slice(0, 160))
  }

  const digest = buildDigest({ code, name, rows, close, maVals, macd, nine, levels, divs, days })
  const chartTxt = charts.length
    ? charts.map((c) => c.type + ' → ' + c.svg).join(' ｜ ')
    : '（无，见 warnings）'

  console.log(JSON.stringify({
    ok: charts.length > 0,
    code, name,
    charts,
    digest: digest + '\n图表：' + chartTxt,
    warnings,
  }, null, 0))
}

// 供单元测试引用的纯函数（不触发 CLI 主流程）
module.exports = { ma, ema, macdOf, nineTurn, swings, divergences, buildLevels, guessSuffix }

if (require.main === module) {
  main().catch((e) => die(e && e.stack ? e.stack.slice(0, 400) : e))
}
