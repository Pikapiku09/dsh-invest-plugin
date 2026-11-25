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

// 前端产物与前端源码是否同步
//
// 老做法是比较 mtime（产物比源码旧就报错）。在 CI 上是假红：全新 clone 时
// git 把所有文件写成同一时刻，谁比谁「新」取决于遍历顺序，于是云端每次都报
// 「web/src/api.ts 比产物新，需要重新构建」——本地明明刚构建过。
//
// 现在比内容指纹：构建脚本（web/package.json → tools/stamp-web-build.js）把
// web/src 的 sha256 写进 web-dist/build-manifest.json，这里重算一遍比对。
// 同源码同结果，和检出时间、操作系统无关。
// 没有清单的老产物退回 mtime 判断，但给 5 秒容差，同样不会在 CI 上误报。
const MANIFEST_TOLERANCE_MS = 5000;

test('前端产物与前端源码是否同步（源码改了要重建 dist）', (t) => {
  if (!fs.existsSync(bundle)) {
    t.skip('未构建前端产物：' + bundle)
    return
  }
  const srcDir = path.join(root, 'web', 'src')
  if (!fs.existsSync(srcDir)) {
    t.skip('没有前端源码目录：' + srcDir)
    return
  }
  const rebuildHint = '重建：cd web && npm run build（会顺带重新盖章 build-manifest.json）'
  const manifestPath = path.join(distDir, 'build-manifest.json')

  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    assert.ok(manifest.sourceHash, 'build-manifest.json 里没有 sourceHash：' + rebuildHint)
    const { hash } = require('../tools/source-hash.js').sourceHash(srcDir)
    assert.equal(
      hash,
      manifest.sourceHash,
      '前端源码和产物对不上：改了 web/src 却没重建，界面还是旧的。' + rebuildHint,
    )
    return
  }

  // 老产物没有指纹清单：退回 mtime，但给 5 秒容差（CI 全新 clone 全是同一时刻）
  const bundleAt = fs.statSync(bundle).mtimeMs
  const stale = []
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) { walk(p); continue }
      if (!/\.(ts|css|html)$/.test(ent.name)) continue
      if (fs.statSync(p).mtimeMs > bundleAt + MANIFEST_TOLERANCE_MS) stale.push(path.relative(root, p))
    }
  }
  walk(srcDir)
  assert.deepEqual(stale, [], '前端源码比产物新，需要重新构建：' + stale.join('、') + '。' + rebuildHint)
})
