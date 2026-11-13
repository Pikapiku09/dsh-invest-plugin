// 更新检查（v0.50.0）
// 覆盖：① cmpVersion 语义化比较（含 v 前缀、位数不同、prerelease）；
//      ② 路由在「有新版 / 同版本 / 网络失败」三种情况下的返回；
//      ③ 网络请求只发一次（30 分钟缓存）。
// 全程 stub globalThis.fetch，不打真实网络。
import test from 'node:test'
import assert from 'node:assert/strict'

import { cmpVersion } from '../packages/dsh-invest/lib/pure.js'

test('cmpVersion：语义化版本比较', () => {
  assert.equal(cmpVersion('0.50.0', '0.49.2'), 1)
  assert.equal(cmpVersion('0.49.2', '0.50.0'), -1)
  assert.equal(cmpVersion('0.50.0', '0.50.0'), 0)
  assert.equal(cmpVersion('v0.50.0', '0.50.0'), 0, '忽略 v 前缀')
  assert.equal(cmpVersion('0.50', '0.50.0'), 0, '缺位补 0')
  assert.equal(cmpVersion('0.50.1', '0.50'), 1)
  assert.equal(cmpVersion('1.0.0', '0.99.99'), 1)
  assert.equal(cmpVersion('0.50.0-rc.1', '0.50.0'), 0, '忽略 prerelease')
  assert.equal(cmpVersion('', '0.1.0'), -1)
  assert.equal(cmpVersion('abc', '0.0.0'), 0, '非法串按 0 处理')
})

// 复用一个最小 harness：只注册路由，不启动任何后台任务
async function makeHarness() {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { apply } = await import('../packages/dsh-invest/lib/index.js')

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-update-'))
  fs.mkdirSync(path.join(base, '.dsh-invest', 'store'), { recursive: true })
  process.env.DSH_INVEST_BASE_DIR = base
  process.env.DSH_INVEST_SKIP_REINDEX = '1'
  process.env.DSH_INVEST_WATCH_DAILY = '0'
  process.env.DSH_INVEST_SKIP_STOCK_NOTES = '1'
  process.env.DSH_INVEST_AUTO_CURATE = '0'

  const registered = []
  const ctx = {
    get(n) {
      if (n === 'fs') return { resolve: async (p) => p, readText: async (p) => fs.readFileSync(p, 'utf8'), writeText: async () => {} }
      if (n === 'sandboxPolicy') return { resolve: () => ({}) }
      if (n === 'agents') return { roots: () => [], create: async () => ({ agent: null, dispose: async () => {} }) }
      return undefined
    },
    effect(fn) { fn() },
    webServer: { register: (r) => { registered.push(r); return () => {} } },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => {} },
  }
  apply(ctx, {})

  async function get(p, search = '') {
    const route = registered.find((r) => r.path === p)
    assert.ok(route, '路由未注册：' + p)
    let status = 0, text = ''
    const res = { setHeader() {}, set statusCode(v) { status = v }, get statusCode() { return status }, end(v) { text = v === undefined ? '' : String(v) } }
    await route.handler({ method: 'GET', url: p + search, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' } }, res)
    return { status: status || 200, json: text ? JSON.parse(text) : null }
  }
  return { base, get, cleanup: () => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

const realFetch = globalThis.fetch
function stubFetch(impl) { globalThis.fetch = impl }
function restore() { globalThis.fetch = realFetch }

/** 按 URL 分派 stub：key 是 URL 片段，value 是返回体 / Error / 返回体的函数 */
function stubFetchByUrl(map) {
  globalThis.fetch = async (url) => {
    const u = String(url)
    const key = Object.keys(map).find((k) => u.includes(k))
    if (!key) throw new Error('unexpected fetch: ' + u)
    let v = map[key]
    if (typeof v === 'function') v = v()      // 函数用于计数 / 动态取值，返回的仍是 body
    if (v instanceof Error) throw v
    if (v && v.ok === false) return v          // 允许显式给一个失败响应
    return { ok: true, json: async () => v }
  }
}

const PKG_URL = 'packages/dsh-invest/package.json'
const WN_URL = 'packages/dsh-invest/lib/whats-new.json'

test('更新检查：远端版本更高 → updateAvailable=true，并给出命令', async (t) => {
  const h = await makeHarness()
  t.after(() => { restore(); h.cleanup() })
  let calls = 0
  // 只对 package.json 计数：v0.51.0 起「有新版」还会再拉一次更新要点
  stubFetchByUrl({ [PKG_URL]: () => { calls++; return { version: '99.0.0' } }, [WN_URL]: { releases: [] } })
  const r = await h.get('/dsh-invest/api/update-check')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.latest, '99.0.0')
  assert.equal(r.json.updateAvailable, true)
  assert.ok(r.json.current, '必须返回本机版本')
  assert.ok(['link', 'github', 'unknown'].includes(r.json.installKind))
  assert.equal(typeof r.json.hint, 'string')

  // 第二次调用走 30 分钟缓存，不再发网络请求
  const r2 = await h.get('/dsh-invest/api/update-check')
  assert.equal(r2.json.latest, '99.0.0')
  assert.equal(calls, 1, '缓存期内不应重复请求')
})

test('更新检查：远端同版本 → updateAvailable=false', async (t) => {
  const h = await makeHarness()
  t.after(() => { restore(); h.cleanup() })
  // 远端返回与当前一致的版本：先探一次拿到 current，再据此回放
  stubFetch(async () => ({ ok: true, json: async () => ({ version: '0.0.1' }) }))
  const r = await h.get('/dsh-invest/api/update-check')
  assert.equal(r.json.ok, true)
  assert.equal(r.json.updateAvailable, false, '本机版本高于 0.0.1，不应提示更新')
})

test('更新检查：网络失败 → ok:false + error，不抛 500', async (t) => {
  const h = await makeHarness()
  t.after(() => { restore(); h.cleanup() })
  stubFetch(async () => { throw new Error('offline') })
  const r = await h.get('/dsh-invest/api/update-check')
  assert.equal(r.status, 200, '网络失败也必须 200，前端据此静默')
  assert.equal(r.json.ok, false)
  assert.ok(String(r.json.error || '').includes('offline') || String(r.json.error || '').length > 0)
  assert.ok(r.json.current, '即使失败也返回本机版本，便于展示')
})

// ===== 本次更新说明（v0.50.0） =====
test('whats-new：最新版本必须等于当前包版本（防止改了版本号忘记重新生成）', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'packages', 'dsh-invest', 'package.json'), 'utf8'))
  const wnPath = path.join(here, '..', 'packages', 'dsh-invest', 'lib', 'whats-new.json')
  assert.ok(fs.existsSync(wnPath), 'whats-new.json 必须存在（发布前跑 tools/gen-whats-new.js）')
  const wn = JSON.parse(fs.readFileSync(wnPath, 'utf8'))
  assert.equal(wn.latest, pkg.version, `whats-new.latest(${wn.latest}) 必须等于包版本(${pkg.version})，请重新生成`)
  const self = wn.releases.find((r) => r.version === pkg.version)
  assert.ok(self, '最新版本必须有对应条目')
  assert.ok(Array.isArray(self.items) && self.items.length > 0, '条目不能为空')
  // 要点应是完整句子，不能被折行截断（生成器要合并续行）
  for (const it of self.items) {
    assert.ok(typeof it === 'string' && it.trim().length >= 4, '要点内容有效')
    assert.ok(!it.endsWith('，') && !it.endsWith(','), '要点不应在逗号处被截断：' + it)
    // v0.51.1：生成器保留 **加粗** 标记供前端转 <b>，必须成对，否则会漏出裸标记
    const bold = (it.match(/\*\*/g) || []).length
    assert.equal(bold % 2, 0, '粗体标记必须成对：' + it)
  }
  // 所有版本的要点都要能安全渲染，不只是最新版本
  for (const rel of wn.releases) {
    for (const it of rel.items) {
      assert.equal(((it.match(/\*\*/g) || []).length) % 2, 0, `v${rel.version} 粗体标记不成对：` + it)
    }
  }
})

test('whats-new：路由返回 ok 与版本列表', async (t) => {
  const h = await makeHarness()
  t.after(() => h.cleanup())
  const r = await h.get('/dsh-invest/api/whats-new')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.ok(Array.isArray(r.json.releases) && r.json.releases.length > 0)
  const first = r.json.releases[0]
  assert.ok(first.version && first.items.length > 0)
})

// ===== 手动检测与「发现新版本」要点（v0.51.0） =====

test('检测更新：?force=1 绕过 30 分钟缓存（手动检测必须实时）', async (t) => {
  const h = await makeHarness()
  t.after(() => { restore(); h.cleanup() })
  let pkgCalls = 0
  let latest = '99.0.0'
  stubFetchByUrl({ [PKG_URL]: () => { pkgCalls++; return { version: latest } }, [WN_URL]: { releases: [] } })

  const r1 = await h.get('/dsh-invest/api/update-check')
  assert.equal(r1.json.latest, '99.0.0')
  assert.equal(r1.json.cached, undefined, '首次实时查询不应带 cached 标记')

  const r2 = await h.get('/dsh-invest/api/update-check')
  assert.equal(r2.json.cached, true, '缓存命中要明说，便于前端区分')
  assert.equal(pkgCalls, 1, '缓存期内不应重复请求')

  // 远端已更新，但缓存期内普通检查仍返回旧结果
  latest = '99.1.0'
  const r3 = await h.get('/dsh-invest/api/update-check')
  assert.equal(r3.json.latest, '99.0.0', '缓存期内仍是旧结果')

  // 用户手动点「检测更新」→ 必须绕过缓存
  const r4 = await h.get('/dsh-invest/api/update-check', '?force=1')
  assert.equal(r4.json.latest, '99.1.0')
  assert.equal(pkgCalls, 2, 'force 必须重新请求')
})

test('检测更新：force 失败不污染已有缓存', async (t) => {
  const h = await makeHarness()
  t.after(() => { restore(); h.cleanup() })
  stubFetchByUrl({ [PKG_URL]: { version: '99.0.0' }, [WN_URL]: { releases: [] } })
  const ok = await h.get('/dsh-invest/api/update-check')
  assert.equal(ok.json.ok, true)

  stubFetchByUrl({ [PKG_URL]: new Error('offline') })
  const bad = await h.get('/dsh-invest/api/update-check', '?force=1')
  assert.equal(bad.json.ok, false)
  assert.equal(bad.json.latest, undefined, '失败时不能编造 latest')

  // 已知结果仍在缓存里：一次网络抖动不该把「已知有新版」抹掉
  const again = await h.get('/dsh-invest/api/update-check')
  assert.equal(again.json.ok, true, '失败结果不该写进 30 分钟缓存')
  assert.equal(again.json.latest, '99.0.0')
})

test('检测更新：远端要点只保留比本机新的版本，新到旧，条目截断', async (t) => {
  const h = await makeHarness()
  t.after(() => { restore(); h.cleanup() })
  const many = Array.from({ length: 15 }, (_, i) => '条目 ' + (i + 1))
  stubFetchByUrl({
    [PKG_URL]: { version: '99.0.0' },
    [WN_URL]: {
      latest: '99.0.0',
      releases: [
        { version: '0.50.0', date: '2026-11-13', title: '旧版本', items: ['不该出现'] },
        { version: '98.0.0', date: '2026-11-19', title: '次新', items: ['一条'] },
        { version: '99.0.0', date: '2026-11-20', title: '最新', items: many },
      ],
    },
  })
  const r = await h.get('/dsh-invest/api/update-check')
  assert.equal(r.json.updateAvailable, true)
  assert.deepEqual(r.json.highlights.map((x) => x.version), ['99.0.0', '98.0.0'], '只留比本机新的，且新到旧')
  assert.equal(r.json.highlights[0].items.length, 8, '单个版本要点最多 8 条')
  assert.equal(r.json.highlights[0].title, '最新')
  assert.equal(r.json.highlights[0].date, '2026-11-20')
})

test('检测更新：更新要点拉取失败 → 空数组，不影响「有新版」的判定', async (t) => {
  const h = await makeHarness()
  t.after(() => { restore(); h.cleanup() })
  stubFetchByUrl({ [PKG_URL]: { version: '99.0.0' }, [WN_URL]: new Error('boom') })
  const r = await h.get('/dsh-invest/api/update-check')
  assert.equal(r.json.ok, true, '要点拉不到不能把检测整条拖失败')
  assert.equal(r.json.updateAvailable, true)
  assert.deepEqual(r.json.highlights, [])
})

test('检测更新：没有新版本时不请求更新要点', async (t) => {
  const h = await makeHarness()
  t.after(() => { restore(); h.cleanup() })
  let wnCalls = 0
  stubFetchByUrl({
    [PKG_URL]: { version: '0.0.1' },
    [WN_URL]: () => { wnCalls++; return { releases: [] } },
  })
  const r = await h.get('/dsh-invest/api/update-check')
  assert.equal(r.json.updateAvailable, false)
  assert.equal(wnCalls, 0, '无更新时不该多打一次网络')
  assert.deepEqual(r.json.highlights, [])
})
