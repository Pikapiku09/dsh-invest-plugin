// 构建产物盖章（2026-11-25）
//
// vite 出完包后，把「这份产物是用哪一版源码构建的」写进 web-dist/build-manifest.json。
// 版本号来自 packages/dsh-invest/package.json（唯一事实来源），源码指纹来自 tools/source-hash.js。
// test/web-build-version.test.js 会重新算一遍指纹：对不上 = 改了前端忘了重建。
//
// 由 web/package.json 的 build 脚本串在 vite build 之后执行：
//   tsc --noEmit && vite build && node ../tools/stamp-web-build.js
const fs = require('node:fs');
const path = require('node:path');
const { sourceHash } = require('./source-hash');

const ROOT = path.resolve(__dirname, '..');
const PKG_DIR = path.join(ROOT, 'packages', 'dsh-invest');
const OUT_DIR = process.env.DSH_INVEST_WEB_DIST || path.join(PKG_DIR, 'web-dist');

const bundle = path.join(OUT_DIR, 'workbench.js');
if (!fs.existsSync(bundle)) {
  console.error('[stamp] 找不到产物 ' + bundle + '，先跑 vite build');
  process.exit(1);
}

let version = 'dev';
try {
  version = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version || 'dev';
} catch { /* 包没装好也不该阻断构建，版本留 dev 让测试去报 */ }

const { hash, files } = sourceHash(path.join(ROOT, 'web', 'src'));
const manifest = {
  version,
  sourceHash: hash,
  sourceFiles: files,
  builtAt: new Date().toISOString(),
};

fs.writeFileSync(path.join(OUT_DIR, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('[stamp] ' + path.relative(ROOT, OUT_DIR) + '/build-manifest.json  v' + version + '  ' + files + ' 个源文件  ' + hash.slice(0, 12));
