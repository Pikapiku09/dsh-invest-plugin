// 「悟道」条目库路由（v0.78.0）
//
// 线上接口经 DSH 鉴权（401），肉眼看不到服务端到底返回什么；而条目会直接进 prompt，
// 所以这里钉住：落盘形状、更新语义、删除语义、坏文件降级、参数与模型失败的区分。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../packages/dsh-invest/lib/index.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-dao-'))
const storeDir = path.join(base, '.dsh-invest', 'store')
fs.mkdirSync(storeDir, { recursive: true })
fs.mkdirSync(path.join(base, 'scripts'), { recursive: true })
process.env.DSH_INVEST_BASE_DIR = base

const DAO_FILE = path.join(storeDir, 'dao.json')
const DAO_BAK = path.join(storeDir, 'dao.bak.json')

const registered = []
const fakeFs = {
  resolve: async (p) => p,
  readText: async (p) => fs.readFileSync(p, 'utf8'),
  writeText: async (p, text) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text, 'utf8')
  },
}
apply({
  get(name) { return name === 'fs' ? fakeFs : undefined },
  effect(fn) { fn() },
  webServer: { register: (route) => { registered.push(route); return () => {} } },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
}, {})

async function call(routePath, opts = {}) {
  const route = registered.find((item) => item.path === routePath)
  assert.ok(route, '路由未注册：' + routePath)
  const method = opts.method || (routePath.endsWith('/dao') ? 'GET' : 'POST')
  const req = {
    method,
    url: routePath,
    socket: { remoteAddress: opts.remote || '127.0.0.1' },
    headers: { host: opts.host || 'localhost:3080', 'content-type': 'application/json' },
    on() {},
    async *[Symbol.asyncIterator]() {
      if (opts.body !== undefined) yield Buffer.from(JSON.stringify(opts.body), 'utf8')
    },
  }
  let status = 0
  let text = ''
  const res = {
    setHeader() {},
    set statusCode(v) { status = v },
    get statusCode() { return status },
    end(v) { text = v === undefined ? '' : String(v) },
  }
  await route.handler(req, res)
  return { status: status || 200, json: text ? JSON.parse(text) : null }
}

const ENTRY = {
  title: '财报前一周不开新仓',
  body: '季报前一周不新开仓，等业绩落地再看。',
  kind: '纪律',
  tags: ['深度', '总判断'],
}

let createdId = ''

test('GET：空库返回空列表，不报错', async () => {
  const r = await call('/dsh-invest/api/dao')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.items, [])
  assert.equal(r.json.stats.total, 0)
})

test('POST entry：新建落盘，GET 能读回', async () => {
  const r = await call('/dsh-invest/api/dao/entry', { body: ENTRY })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.ok(r.json.item.id.startsWith('dao_'))
  assert.deepEqual(r.json.items.map((one) => one.title), [ENTRY.title])
  createdId = r.json.item.id

  const raw = JSON.parse(fs.readFileSync(DAO_FILE, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.items.length, 1)
  assert.deepEqual(raw.items[0].tags, ['深度', '总判断'])

  const list = await call('/dsh-invest/api/dao')
  assert.equal(list.json.items[0].id, createdId)
})

test('POST entry：带 id 即更新，created_at 保留、updated_at 刷新、写前留备份', async () => {
  const before = JSON.parse(fs.readFileSync(DAO_FILE, 'utf8')).items[0]
  await new Promise((resolve) => setTimeout(resolve, 5))
  const r = await call('/dsh-invest/api/dao/entry', { body: Object.assign({}, ENTRY, { id: createdId, title: '财报前不开新仓（改）', pinned: true }) })
  assert.equal(r.status, 200)
  assert.equal(r.json.items.length, 1, '更新不是新增')
  assert.equal(r.json.item.title, '财报前不开新仓（改）')
  assert.equal(r.json.item.created_at, before.created_at)
  assert.notEqual(r.json.item.updated_at, before.updated_at)
  assert.equal(r.json.item.pinned, true)

  const bak = JSON.parse(fs.readFileSync(DAO_BAK, 'utf8'))
  assert.equal(bak.items[0].title, ENTRY.title, '备份是写前的旧状态')
})

test('参数校验：空正文、非法 id、非法人格都返回 400 而不是 500', async () => {
  const empty = await call('/dsh-invest/api/dao/entry', { body: { title: '空' } })
  assert.equal(empty.status, 400)
  assert.match(empty.json.error, /正文不能为空/)

  const ghost = await call('/dsh-invest/api/dao/entry', { body: Object.assign({}, ENTRY, { id: 'dao_ghost' }) })
  assert.equal(ghost.status, 400)
  assert.match(ghost.json.error, /不存在或已被删除/)

  const persona = await call('/dsh-invest/api/dao/chat', { body: { persona: '玉皇大帝', messages: [{ role: 'user', text: '在吗' }] } })
  assert.equal(persona.status, 400)
  assert.match(persona.json.error, /未知的对话人格/)
})

test('chat / distill：模型不可用时是 503 且提示可读，不吞成 400', async () => {
  const chat = await call('/dsh-invest/api/dao/chat', { body: { persona: '深度', messages: [{ role: 'user', text: '聊聊仓位' }] } })
  assert.equal(chat.status, 503)
  assert.match(chat.json.error, /模型暂不可用/)

  const distill = await call('/dsh-invest/api/dao/distill', { body: { persona: '教练', messages: [{ role: 'assistant', text: '仓位别一次打满' }] } })
  assert.equal(distill.status, 503)
  assert.match(distill.json.error, /模型暂不可用/)
})

test('删除：命中返回 removed=1，重复删除 removed=0', async () => {
  const r = await call('/dsh-invest/api/dao/delete', { body: { id: createdId } })
  assert.equal(r.status, 200)
  assert.equal(r.json.removed, 1)
  assert.deepEqual(r.json.items, [])
  const again = await call('/dsh-invest/api/dao/delete', { body: { id: createdId } })
  assert.equal(again.json.removed, 0)
})

test('坏文件：GET 降级成空库，页面不至于打不开', async () => {
  fs.writeFileSync(DAO_FILE, '{ 这不是 json', 'utf8')
  const r = await call('/dsh-invest/api/dao')
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.items, [])
})

test('环回限制与方法限制', async () => {
  const remote = await call('/dsh-invest/api/dao', { remote: '10.0.0.9' })
  assert.equal(remote.status, 403)
  const method = await call('/dsh-invest/api/dao', { method: 'POST' })
  assert.equal(method.status, 405)
  const entryMethod = await call('/dsh-invest/api/dao/entry', { method: 'GET' })
  assert.equal(entryMethod.status, 405)
})
