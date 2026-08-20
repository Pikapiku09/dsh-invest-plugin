// 构建脚本：一次构建产出全部形态
// 1) dist/（动态插件形态，供 cordis_define 粘贴）：PROMPTS + pure 内联进 host/client 函数体
// 2) packages/dsh-invest/lib/（常规插件形态，profile bundle 挂载）：prompts.js / pure.js 由 src 转换为 ESM
// 用法：node tools/build.js
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const prompts = require(path.join(root, 'src', 'prompts.js'))
const pure = fs.readFileSync(path.join(root, 'src', 'lib', 'pure.js'), 'utf8')

// pure 去掉末尾的 CJS 导出行，作为内联进 dist 的纯函数核心
const PURE_EXPORT = "if (typeof module !== 'undefined' && module.exports) module.exports = { z2, localYmd, extractBoth, collectCharts, buildGroups, isLoopbackRequest, fmt, isSepRow, splitBlocks }"
const pureCore = pure.split(PURE_EXPORT).join('').trimEnd()

const banner = '// 本文件由 tools/build.js 自动生成（node tools/build.js），请勿手动修改\n// 用法：将本文件内容作为 cordis_define 的 code.host 函数体\n// 生成时间：' + new Date().toISOString() + '\n'

// ---- 1) dist：动态插件形态 ----
const hostBody = banner + '\nconst PROMPTS = ' + JSON.stringify(prompts, null, 2) + ';\n\n' +
  pureCore + '\n\n' +
  fs.readFileSync(path.join(root, 'src', 'host.js'), 'utf8') + '\n'
fs.writeFileSync(path.join(root, 'dist', 'invest-run.host.js'), hostBody)

const clientBanner = banner.replace('code.host', 'code.client')
const clientBody = clientBanner + '\n' +
  pureCore + '\n\n' +
  fs.readFileSync(path.join(root, 'src', 'client.js'), 'utf8') + '\n'
fs.writeFileSync(path.join(root, 'dist', 'invest-run.client.js'), clientBody)

// ---- 2) packages：常规插件形态（ESM 转换）----
const promptsSrc = fs.readFileSync(path.join(root, 'src', 'prompts.js'), 'utf8')
const promptsEsm = '// 由 src/prompts.js 转换（CommonJS → ESM），与 dist/invest-run.host.js 的 PROMPTS 同源\n' +
  promptsSrc.replace('module.exports = { DATA_BASE, CHECKLIST, P_SELECT, P_NEWS, P_DEEP, P_FINAL }', 'export { DATA_BASE, CHECKLIST, P_SELECT, P_NEWS, P_DEEP, P_FINAL }')
fs.writeFileSync(path.join(root, 'packages', 'dsh-invest', 'lib', 'prompts.js'), promptsEsm)

const pureEsm = '// 由 src/lib/pure.js 转换（CommonJS → ESM），与 dist 的 pure 同源\n' +
  pure.replace(PURE_EXPORT, 'export { z2, localYmd, extractBoth, collectCharts, buildGroups, isLoopbackRequest, fmt, isSepRow, splitBlocks }')
fs.writeFileSync(path.join(root, 'packages', 'dsh-invest', 'lib', 'pure.js'), pureEsm)

console.log('build ok -> dist/invest-run.host.js, dist/invest-run.client.js, packages/dsh-invest/lib/prompts.js, packages/dsh-invest/lib/pure.js')
