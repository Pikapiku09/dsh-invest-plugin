// 可移植性守卫（v0.79.0）
//
// 0.78.0 及以前有两处「装到别人机器上必挂」的硬编码：
// ① 工作区基目录写死成作者本机的 E:/Dsh_WorkSapce/Dify_Agents；
// ② 前端产物要从工作区的 .dsh-invest/web/dist 读，而它不在包里 —— 别人装完是白屏。
// 这里用「空临时目录 + 不设 DSH_INVEST_WEB_DIST」的组合，模拟一个全新用户的家目录，
// 断言界面仍能从包内 web-dist 起来。这条测试挂了，就说明插件又退回到「只有作者能跑」。
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

// 空临时目录：没有 .dsh-invest/store，也没有 tushare.token
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-fresh-'))
process.env.DSH_INVEST_BASE_DIR = base
delete process.env.DSH_INVEST_WEB_DIST // 关键：不告诉它 web-dist 在哪，让它自己从包内找

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

test('基目录跟随 DSH_INVEST_BASE_DIR，且统一成正斜杠无尾斜杠', async () => {
  const r = await call('GET', '/dsh-invest/api/datasource')
  assert.equal(r.status, 200)
  const payload = JSON.parse(String(r.body))
  const expected = base.replace(/\\/g, '/').replace(/\/$/, '')
  assert.equal(payload.baseDir, expected, 'baseDir 必须等于环境变量指定的目录（归一化后）')
  assert.ok(!payload.baseDir.includes('\\'), 'baseDir 不应残留反斜杠，否则后续所有路径拼接口径不一致')
  assert.notEqual(payload.baseDir, 'E:/Dsh_WorkSapce/Dify_Agents', '显式指定基目录时不能再回落到作者本机路径')
})

test('全新用户：界面从包内 web-dist 起来，不依赖工作区里的旧 dist', async (t) => {
  if (!fs.existsSync(path.join(PKG_DIST, 'index.html'))) {
    t.skip('未构建前端产物：' + PKG_DIST)
    return
  }
  const js = await call('GET', '/dsh-invest/workbench.js')
  assert.equal(js.status, 200, '包内 web-dist/workbench.js 必须能取到')
  const css = await call('GET', '/dsh-invest/workbench.css')
  assert.equal(css.status, 200, '包内 web-dist/workbench.css 必须能取到')
  const bg = await call('GET', '/dsh-invest/dao-space.webp')
  assert.equal(bg.status, 200, '包内 web-dist/dao-space.webp 必须能取到')
  const index = await call('GET', '/dsh-invest/app')
  assert.equal(index.status, 200)
})

test('无 token 时数据源接口给出降级状态与补救提示', async () => {
  const r = await call('GET', '/dsh-invest/api/datasource')
  const payload = JSON.parse(String(r.body))
  assert.equal(payload.ok, true)
  assert.equal(payload.hasToken, false, '空目录里没有 tushare.token，hasToken 必须是 false')
  assert.match(payload.summary, /数据源/, 'summary 要让用户看懂当前用的是哪路数据')
  assert.match(payload.hint, /腾讯/, '首次使用提示里要说明已自动切到免费行情')
  assert.match(payload.hint, /tushare\.token/, '提示里要给出 token 该写到哪个文件')
  assert.ok(payload.state && typeof payload.state === 'object', 'state 暴露各能力的数据源，便于排障')
})
