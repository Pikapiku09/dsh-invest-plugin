// 构建脚本：一次构建产出全部形态
// 1) dist/（动态插件形态，供 cordis_define 粘贴）：PROMPTS + pure 内联进 host/client 函数体
// 2) packages/dsh-invest/lib/（常规插件形态，profile bundle 挂载）：prompts.js / pure.js 由 src 转换为 ESM
// 用法：node tools/build.js
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const prompts = require(path.join(root, 'src', 'prompts.js'))
const pure = fs.readFileSync(path.join(root, 'src', 'lib', 'pure.js'), 'utf8')
const routes = fs.readFileSync(path.join(root, 'src', 'lib', 'routes.js'), 'utf8')

// pure 去掉末尾的 CJS 导出行，作为内联进 dist 的纯函数核心
const PURE_EXPORT = "if (typeof module !== 'undefined' && module.exports) module.exports = { z2, localYmd, extractBoth, collectCharts, buildGroups, isLoopbackRequest, fmt, isSepRow, splitBlocks }"
const pureCore = pure.split(PURE_EXPORT).join('').trimEnd()

// routes 同样去掉 CJS 导出行：dist 内联，packages/lib 转 ESM
const ROUTES_EXPORT = "if (typeof module !== 'undefined' && module.exports) module.exports = { ROLE_CODES, PRESETS, DEFAULT_PRESET, parseRoute, parseRouteList, mergeRoutes, formatRoute, formatRouteChain, routeShort, parseRoutesJson }"
const routesCore = routes.split(ROUTES_EXPORT).join('').trimEnd()

const banner = '// 本文件由 tools/build.js 自动生成（node tools/build.js），请勿手动修改\n// 用法：将本文件内容作为 cordis_define 的 code.host 函数体\n// 生成时间：' + new Date().toISOString() + '\n'

// ---- 1) dist：动态插件形态 ----
const hostBody = banner + '\nconst PROMPTS = ' + JSON.stringify(prompts, null, 2) + ';\n\n' +
  pureCore + '\n\n' +
  routesCore + '\n\n' +
  fs.readFileSync(path.join(root, 'src', 'host.js'), 'utf8') + '\n'
fs.writeFileSync(path.join(root, 'dist', 'invest-run.host.js'), hostBody)

const clientBanner = banner.replace('code.host', 'code.client')
const clientBody = clientBanner + '\n' +
  pureCore + '\n\n' +
  fs.readFileSync(path.join(root, 'src', 'client.js'), 'utf8') + '\n'
fs.writeFileSync(path.join(root, 'dist', 'invest-run.client.js'), clientBody)

// ---- 2) packages：常规插件形态（ESM 转换）----
// 把 CJS 的导出行可靠地转成 ESM `export { ... }`。
// 历史教训：这里曾用精确字符串替换，src/prompts.js 后来新增 KB_* 符号后
// 精确匹配静默失效 → lib/prompts.js 仍是 CommonJS → profile 加载时报
// `does not provide an export named 'DATA_BASE'`，且不报错、只静默产出坏文件。
// 现在改为按导出行结构匹配，匹配不到直接抛错（fail fast，不再静默产出坏文件）。
const CJS_EXPORT_RE = /^(?:if\s*\([^)]*\)\s*)?module\.exports\s*=\s*\{([^}]*)\}\s*$/m
function toEsm(source, label) {
  if (!CJS_EXPORT_RE.test(source)) {
    throw new Error(label + ': 未找到 CJS 导出行 `module.exports = { ... }`，无法转换为 ESM')
  }
  return source.replace(CJS_EXPORT_RE, function (_match, names) { return 'export {' + names + '}' })
}

const promptsSrc = fs.readFileSync(path.join(root, 'src', 'prompts.js'), 'utf8')
const promptsEsm = '// 由 src/prompts.js 转换（CommonJS → ESM），与 dist/invest-run.host.js 的 PROMPTS 同源\n' +
  toEsm(promptsSrc, 'src/prompts.js')
fs.writeFileSync(path.join(root, 'packages', 'dsh-invest', 'lib', 'prompts.js'), promptsEsm)

const pureEsm = '// 由 src/lib/pure.js 转换（CommonJS → ESM），与 dist 的 pure 同源\n' +
  toEsm(pure, 'src/lib/pure.js')
fs.writeFileSync(path.join(root, 'packages', 'dsh-invest', 'lib', 'pure.js'), pureEsm)

const routesEsm = '// 由 src/lib/routes.js 转换（CommonJS → ESM），与 dist 的 routes 同源\n' +
  toEsm(routes, 'src/lib/routes.js')
fs.writeFileSync(path.join(root, 'packages', 'dsh-invest', 'lib', 'routes.js'), routesEsm)

console.log('build ok -> dist/invest-run.host.js, dist/invest-run.client.js, packages/dsh-invest/lib/{prompts,pure,routes}.js')

// ---- 提示词预算检查（v0.17.0 起）----
try {
  const budget = require('./check_prompt_budget.js')
} catch (e) { /* 预算脚本 exit(1) 时 require 抛错 → 提示但不阻断构建 */ console.warn('[预算] ' + e.message) }
