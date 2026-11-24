// 工作台前端产物版本守卫（2026-11-23）
//
// 事故：v0.75.2 → v0.75.4 三个版本只改了 packages/dsh-invest/package.json 与后端代码，
// 一直没重新构建工作台前端。结果界面左上角徽标停在 v0.75.0，而右上角「检测更新」显示
// 「已是最新版本 v0.75.4」（服务端读的是实时 package.json）——同一个页面两个版本号打架，
// 看着像升级没生效。
//
// 机制：vite 构建时把 package.json 的 version 注入 __APP_VERSION__，产物 v0.79.0 起落在
// 包内 packages/dsh-invest/web-dist/（早先是运行目录 <BASE_DIR>/.dsh-invest/web/dist），
// 所以改版本号后必须重新构建。
//
// 这里只在产物存在时校验（CI/新克隆没有 dist，自动跳过），锁住「改了版本号忘记重建前端」。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'packages', 'dsh-invest', 'package.json'), 'utf8'))
const PKG_DIST = path.join(root, 'packages', 'dsh-invest', 'web-dist')
const legacyBaseDir = process.env.DSH_INVEST_BASE_DIR || path.resolve(root, '..')
const LEGACY_DIST = path.join(legacyBaseDir, '.dsh-invest', 'web', 'dist')

/** 产物目录解析顺序与 Host 端一致：env → 包内 web-dist → 旧的运行目录 */
function resolveDistDir() {
  if (process.env.DSH_INVEST_WEB_DIST) return process.env.DSH_INVEST_WEB_DIST
  if (fs.existsSync(path.join(PKG_DIST, 'workbench.js'))) return PKG_DIST
  return LEGACY_DIST
}

const distDir = resolveDistDir()
const bundle = path.join(distDir, 'workbench.js')

test('工作台前端产物必须内嵌当前版本号（改版本号后要重建 dist）', (t) => {
  if (!fs.existsSync(bundle)) {
    t.skip('未构建前端产物：' + bundle)
    return
  }
  const text = fs.readFileSync(bundle, 'utf8')
  assert.ok(
    text.includes(JSON.stringify(pkg.version)),
    '前端产物里找不到版本号 ' + pkg.version + '：改了 package.json 却没重新构建前端，'
      + '界面徽标会停在旧版本。重建：cd web && node node_modules/vite/bin/vite.js build',
  )
})

test('前端产物与前端源码是否同步（产物比源码旧说明没重建）', (t) => {
  if (!fs.existsSync(bundle)) {
    t.skip('未构建前端产物：' + bundle)
    return
  }
  const bundleAt = fs.statSync(bundle).mtimeMs
  const srcDir = path.join(root, 'web', 'src')
  const stale = []
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) { walk(p); continue }
      if (!/\.(ts|css|html)$/.test(ent.name)) continue
      if (fs.statSync(p).mtimeMs > bundleAt) stale.push(path.relative(root, p))
    }
  }
  if (fs.existsSync(srcDir)) walk(srcDir)
  assert.deepEqual(stale, [], '前端源码比产物新，需要重新构建：' + stale.join('、'))
})
