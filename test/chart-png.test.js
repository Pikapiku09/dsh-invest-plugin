// v0.53.0 图表接口测试：PNG 支持 + 按代码归集
// 关键回归：真实 DSH 宿主的 fs.resolve 返回的是句柄对象（不是字符串），
// node:fs 的 readFile 吃不了对象——这里用对象句柄模拟真实宿主，
// 防止「SVG 分支能跑、PNG 分支一跑就 ERR_INVALID_ARG_TYPE」这种只在真实环境暴露的缺陷再次溜进主干。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-chart-'))
const storeDir = path.join(base, '.dsh-invest', 'store')
const chartsDir = path.join(base, '.dsh-invest', 'charts')
fs.mkdirSync(storeDir, { recursive: true })
fs.mkdirSync(chartsDir, { recursive: true })
process.env.DSH_INVEST_BASE_DIR = base

// 模拟真实 DSH fs：resolve 返回句柄对象（有 toString 但本身不是 string）——
// node:fs 只接受 string/Buffer/URL，直接把句柄传给 readFile 必炸。
const fakeFs = {
  resolve: async (p) => ({ kind: 'handle', toString: () => p }),
  readText: async (target) => fs.readFileSync(String(target), 'utf8'),
  writeText: async (target, text) => { fs.mkdirSync(path.dirname(String(target)), { recursive: true }); fs.writeFileSync(String(target), text) },
}

const registered = []
apply({
  get(name) {
    if (name === 'fs') return fakeFs
    if (name === 'sandboxPolicy') return { resolve: () => ({}) }
    if (name === 'agents') return { roots: () => [], create: async () => { throw new Error('unused') } }
    if (name === 'llm') return { listProviders: () => [], listModels: async () => ({}), resolveCallConfig: async () => ({}) }
    return undefined
  },
  effect(fn) { fn() },
  webServer: { register: (route) => { registered.push(route); return () => {} } },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
}, {})

async function call(method, pathname) {
  const route = registered.find((item) => item.path === pathname.split('?')[0])
  assert.ok(route, '路由未注册：' + pathname)
  const req = { method, url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' } }
  let status = 0
  let text = ''
  const res = { setHeader() {}, set statusCode(v) { status = v }, get statusCode() { return status }, end(v) { text = v === undefined ? '' : String(v) } }
  await route.handler(req, res)
  return { status: status || 200, json: text ? JSON.parse(text) : null }
}

test.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

// 白名单按「BASE_DIR 原样拼接」比对，查询路径必须用同一构造方式
// （mkdtemp 在 Windows 下是反斜杠路径，直接 replace 成正斜杠会过不了 startsWith）
const chartsUrl = base + '/.dsh-invest/charts'

test('图表接口：PNG 走 base64 直读（fs.resolve 返回句柄对象也不炸）', async () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const pngPath = chartsUrl + '/000123_trend.png'
  fs.writeFileSync(path.join(chartsDir, '000123_trend.png'), pngBytes)

  const r = await call('GET', '/api/dsh-invest/chart?path=' + encodeURIComponent(pngPath))
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.png, pngBytes.toString('base64'), 'PNG 应原样返回 base64')
  assert.equal(r.json.svg, undefined, 'PNG 分支不应带 svg 字段')
})

test('图表接口：SVG 照常走 fs.readText（句柄对象）', async () => {
  const svgPath = chartsUrl + '/000123_kline.svg'
  fs.writeFileSync(path.join(chartsDir, '000123_kline.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  const r = await call('GET', '/api/dsh-invest/chart?path=' + encodeURIComponent(svgPath))
  assert.equal(r.status, 200)
  assert.ok(r.json.svg.startsWith('<svg'))
})

test('图表接口：白名单仍然生效（越出 charts 目录 / 非 svg|png 一律拒绝）', async () => {
  fs.writeFileSync(path.join(base, 'outside.svg'), '<svg></svg>')
  assert.equal((await call('GET', '/api/dsh-invest/chart?path=' + encodeURIComponent(base + '/outside.svg'))).status, 400)
  assert.equal((await call('GET', '/api/dsh-invest/chart?path=' + encodeURIComponent(chartsUrl + '/evil.exe'))).status, 400)
  assert.equal((await call('POST', '/api/dsh-invest/chart?path=x.svg')).status, 405)
})

test('stock-charts：按 6 位代码归集，svg+png 都收、按时间倒序、限 24 张', async () => {
  const now = Date.now()
  const mk = (name, ageMs) => {
    const p = path.join(chartsDir, name)
    fs.writeFileSync(p, name.endsWith('.png') ? Buffer.from([1, 2, 3]) : '<svg></svg>')
    const t = new Date(now - ageMs)
    fs.utimesSync(p, t, t)
    return p
  }
  mk('000456_trend.svg', 1000)
  mk('000456_macd.svg', 500)      // 最新
  mk('000456_td9.png', 2000)      // PNG 也应收
  mk('001234_price.svg', 300)     // 代码不含 000456，不应收
  mk('notes_000456.txt', 0)       // 非 svg/png，不应收

  const r = await call('GET', '/dsh-invest/api/stock-charts?code=000456.SZ')
  assert.equal(r.status, 200)
  assert.equal(r.json.total, 3)
  const names = r.json.charts.map((c) => c.name)
  assert.deepEqual(names, ['000456_macd.svg', '000456_trend.svg', '000456_td9.png'], '按修改时间倒序：' + names.join(','))

  assert.equal((await call('GET', '/dsh-invest/api/stock-charts?code=abc')).status, 400)
  assert.equal((await call('GET', '/dsh-invest/api/stock-charts?code=12345')).status, 400)
})
