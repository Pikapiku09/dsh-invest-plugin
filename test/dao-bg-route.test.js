// 悟道背景图路由守卫（v0.79.0）
//
// 背景图路径有两处必须对齐，任一处错都是「背景一片黑」这种最难查的故障：
// ① 前端 vite 的 base 是 '/dsh-invest/'，产物里引用的是 /dsh-invest/dao-space.webp；
// ② Host 端必须注册同名路由，并从 WEB_DIST_DIR 读同一份文件。
// 所以这里同时断言「路由能用」和「产物里引用的正是这个 URL」。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../packages/dsh-invest/lib/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const PKG_DIST = path.join(root, 'packages', 'dsh-invest', 'web-dist')
const webpPath = path.join(PKG_DIST, 'dao-space.webp')
const bundlePath = path.join(PKG_DIST, 'workbench.js')

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-daobg-'))
fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
process.env.DSH_INVEST_BASE_DIR = base
process.env.DSH_INVEST_WEB_DIST = PKG_DIST

const registered = []
apply({
  get(name) {
    if (name === 'fs') return { resolve: async (p) => ({ toString: () => p }), readText: async (t) => fs.readFileSync(String(t), 'utf8'), writeText: async () => {} }
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

function call(method, pathname, remoteAddress = '127.0.0.1') {
  const route = registered.find((item) => item.path === pathname.split('?')[0])
  assert.ok(route, '路由未注册：' + pathname)
  const req = { method, url: pathname, socket: { remoteAddress }, headers: { host: 'localhost:3080' } }
  let status = 0
  const headers = {}
  let body = null
  const res = {
    setHeader(k, v) { headers[k.toLowerCase()] = v },
    set statusCode(v) { status = v },
    get statusCode() { return status },
    end(v) { body = v === undefined ? '' : v },
  }
  return route.handler(req, res).then(() => ({ status: status || 200, headers, body }))
}

test.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

test('悟道背景路由：返回 webp 原始字节 + 正确 content-type', async (t) => {
  if (!fs.existsSync(webpPath)) {
    t.skip('未构建背景图产物：' + webpPath)
    return
  }
  const r = await call('GET', '/dsh-invest/dao-space.webp')
  assert.equal(r.status, 200, '背景图路由应可访问')
  assert.equal(r.headers['content-type'], 'image/webp')
  assert.equal(r.headers['cache-control'], 'no-store', '背景图不缓存，改图后刷新即生效')
  assert.ok(Buffer.isBuffer(r.body), '必须直接 end(Buffer)，不能转成字符串')
  const onDisk = fs.readFileSync(webpPath)
  assert.equal(r.body.length, onDisk.length, '返回字节数应与产物一致')
  // RIFF....WEBP 魔数：确认没在传输层被破坏
  assert.equal(r.body.subarray(0, 4).toString('latin1'), 'RIFF')
  assert.equal(r.body.subarray(8, 12).toString('latin1'), 'WEBP')
})

test('悟道背景路由：非 loopback / 非 GET 一律拒绝', async () => {
  assert.equal((await call('GET', '/dsh-invest/dao-space.webp', '10.1.2.3')).status, 403)
  assert.equal((await call('POST', '/dsh-invest/dao-space.webp')).status, 405)
})

test('前端产物引用的背景图 URL 与 Host 路由同名', (t) => {
  if (!fs.existsSync(bundlePath)) {
    t.skip('未构建前端产物：' + bundlePath)
    return
  }
  const text = fs.readFileSync(bundlePath, 'utf8')
  assert.ok(text.includes('/dsh-invest/dao-space.webp'),
    'workbench.js 里找不到 /dsh-invest/dao-space.webp：vite base 或 Host 路由有一处改错了')
})
