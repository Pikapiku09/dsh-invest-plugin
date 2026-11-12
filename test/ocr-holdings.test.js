// 持仓截图本地 OCR 端到端：真实截图 → /holdings/import → 草稿（engine=local-ocr）
// 依赖本机 Python + rapidocr_onnxruntime；若环境不具备则跳过。
//
// CI 教训（v0.44.1）：这里原先用 path.resolve('..') 定位 fixture，那是**相对 CWD** 的路径，
// 只有在仓库根目录执行 node --test 时才碰巧正确；GitHub Actions 上 CWD 同样是仓库根，
// 但上一级没有 .dsh-invest，于是模块加载阶段的无条件 copyFileSync 直接 ENOENT，
// 整个测试文件记为失败，把后端 CI job 拖挂。现在改为「相对测试文件自身」定位，
// 且所有 fixture 缺失时只跳过、不抛错。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { apply } from '../packages/dsh-invest/lib/index.js'

// test/ → 插件仓库 → 工作区（fixture 都在工作区，仓库里没有）
const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SAMPLE = path.join(WORKSPACE, '.dsh-invest/scratch/ocr-samples/em_light_3.jpg')
const SCRIPT = path.join(WORKSPACE, 'scripts/ocr_holdings.py')
const NAMES = path.join(WORKSPACE, '.dsh-invest/store/names.json')

/** 优先 python3（CI/Linux 只有 python3 的情况）再退回 python */
function pythonCmd() {
  for (const cmd of [process.env.PYTHON, 'python3', 'python']) {
    if (!cmd) continue
    try {
      const probe = spawnSync(cmd, ['-c', 'import sys; sys.exit(0)'], { stdio: 'ignore', windowsHide: true })
      if (probe.status === 0) return cmd
    } catch (e) { /* 试下一个 */ }
  }
  return ''
}

function hasOcrDeps() {
  if (!fs.existsSync(SAMPLE) || !fs.existsSync(SCRIPT) || !fs.existsSync(NAMES)) return false
  const py = pythonCmd()
  if (!py) return false
  const probe = spawnSync(py, ['-c', 'import rapidocr_onnxruntime'], { stdio: 'ignore', windowsHide: true })
  return probe.status === 0
}

const READY = hasOcrDeps()

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-ocr-'))
fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
// 只在 fixture 存在时拷贝：缺失时测试会被 skip，绝不能在加载阶段抛错
if (fs.existsSync(NAMES)) fs.copyFileSync(NAMES, path.join(base, '.dsh-invest', 'store', 'names.json'))
process.env.DSH_INVEST_BASE_DIR = base
process.env.DSH_INVEST_SKIP_REINDEX = '1'
process.env.DSH_INVEST_OCR_SCRIPT = SCRIPT
delete process.env.DSH_INVEST_JOB_CONCURRENCY
delete process.env.DSH_INVEST_LOCAL_OCR

const registered = []
const fakeFs = {
  resolve: async (p) => p,
  readText: async (p) => fs.readFileSync(p, 'utf8'),
  writeText: async (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8') },
}
apply({
  get(name) {
    if (name === 'fs') return fakeFs
    if (name === 'sandboxPolicy') return { resolve: () => ({}) }
    if (name === 'agents') return { roots: () => [], create: async () => { throw new Error('no agent') } }
    if (name === 'attachments') return undefined
    if (name === 'llm') return { listProviders: () => [], listModels: async () => [], resolveCallConfig: async () => ({}) }
    return undefined
  },
  effect(fn) { fn() },
  webServer: { register: (route) => { registered.push(route); return () => {} } },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
}, {})

async function postImport(payload) {
  const route = registered.find((item) => item.path === '/dsh-invest/api/holdings/import')
  assert.ok(route, '导入路由未注册')
  let status = 0
  let text = ''
  const req = {
    method: 'POST', url: '/dsh-invest/api/holdings/import', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)) },
  }
  const res = { setHeader() {}, set statusCode(v) { status = v }, get statusCode() { return status }, end(v) { text = v === undefined ? '' : String(v) } }
  await route.handler(req, res)
  return { status: status || 200, json: text ? JSON.parse(text) : null }
}

test.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

test('截图导入：本地 OCR 优先，返回草稿且引擎标记 local-ocr', { skip: !READY && '本机缺少 rapidocr/示例图' }, async () => {
  const imageBase64 = fs.readFileSync(SAMPLE).toString('base64')
  const { status, json } = await postImport({ source: 'screenshot', imageBase64, mimeType: 'image/jpeg' })
  assert.equal(status, 200, JSON.stringify(json))
  assert.equal(json.engine, 'local-ocr', '应走本地 OCR 而不是视觉模型')
  assert.ok(json.draftId, '应生成待确认草稿（不直接写账本）')
  assert.ok(Array.isArray(json.positions) && json.positions.length === 3, '应解析出 3 条持仓')
  const codes = json.positions.map((p) => p.code).sort()
  assert.deepEqual(codes, ['510500.SH', '600011.SH', '603606.SH'])
  const dfdl = json.positions.find((p) => p.code === '603606.SH')
  assert.equal(dfdl.shares, 1200)
  assert.equal(dfdl.cost, 34.998)
  assert.equal(dfdl.current_price, 38.1)
  assert.equal(json.account.total_asset, 111532.99)
  assert.equal(json.account.available_cash, 42054.19)
  assert.ok(json.warnings.some((w) => w.includes('本地 OCR')), '草稿需提示来源为本地 OCR')
})

test('截图导入：DSH_INVEST_LOCAL_OCR=0 时不走本地 OCR', { skip: !READY && '本机缺少 rapidocr/示例图' }, async () => {
  process.env.DSH_INVEST_LOCAL_OCR = '0'
  try {
    const imageBase64 = fs.readFileSync(SAMPLE).toString('base64')
    const { status, json } = await postImport({ source: 'screenshot', imageBase64, mimeType: 'image/jpeg' })
    // 视觉模型在测试环境不可用（无 attachments / 无 agent）→ 应报错而不是返回 local-ocr 草稿
    assert.equal(status, 400)
    assert.ok(!json.engine || json.engine !== 'local-ocr')
  } finally {
    delete process.env.DSH_INVEST_LOCAL_OCR
  }
})
