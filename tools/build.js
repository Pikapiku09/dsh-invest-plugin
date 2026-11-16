// 构建脚本：一次构建产出全部形态
// 1) dist/（动态插件形态，供 cordis_define 粘贴）：PROMPTS + pure 内联进 host/client 函数体
// 2) packages/dsh-invest/lib/（常规插件形态，profile bundle 挂载）：prompts.js / pure.js 由 src 转换为 ESM
// 用法：node tools/build.js
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const prompts = require(path.join(root, 'src', 'prompts.js'))
// 从源码里剥掉末尾的 CJS 导出行，作为内联进 dist 的纯函数核心。
// 历史教训（2026-11-16）：这里原本用两个精确字符串常量做 split/join，
// 后来 pure.js 的导出名增加（isSafeServePath/extractInvestCodes/...），
// 常量再也匹配不上，于是 dist 里被静默内联了 `module.exports = {...}` 这一行；
// 一旦宿主以 CJS 上下文执行该函数体，就会覆盖宿主的 module.exports。
// 现在统一用行锚定的正则剥离，匹配不到直接抛错，不再静默产出坏文件。
const CJS_EXPORT_RE = /^(?:if\s*\([^)]*\)\s*)?module\.exports\s*=\s*\{([^}]*)\}\s*$/m
function stripCjsExport(source, label) {
  if (!CJS_EXPORT_RE.test(source)) {
    throw new Error(label + ': 未找到 CJS 导出行 `module.exports = { ... }`，无法剥离')
  }
  return source.replace(CJS_EXPORT_RE, '').trimEnd()
}

const pure = fs.readFileSync(path.join(root, 'src', 'lib', 'pure.js'), 'utf8')
const routes = fs.readFileSync(path.join(root, 'src', 'lib', 'routes.js'), 'utf8')

const pureCore = stripCjsExport(pure, 'src/lib/pure.js')

// routes 同样去掉 CJS 导出行：dist 内联，packages/lib 转 ESM
const routesCore = stripCjsExport(routes, 'src/lib/routes.js')

// 2026-11-11：banner 去掉"生成时间"——时间戳会让每次构建的 dist 都变化，
// 导致 `git diff --exit-code` 永远失败、无法在 CI 里校验构建产物是否最新。
// 构建应当可重复：同样的 src 产出同样的字节。
const banner = '// 本文件由 tools/build.js 自动生成（node tools/build.js），请勿手动修改\n// 用法：将本文件内容作为 cordis_define 的 code.host 函数体\n'

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
// 现在改为按导出行结构匹配（CJS_EXPORT_RE 定义在文件顶部，dist 内联与 ESM 转换共用），
// 匹配不到直接抛错（fail fast，不再静默产出坏文件）。
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

// ---- 运行时脚本部署（v0.42.0 起）----
// stockchart.js / fetch_pack.js 由本仓库托管（唯一事实来源），提示词按
// {{BASE_DIR}}/scripts/<name> 调用；构建时同步到工作区，避免仓库副本与工作区副本漂移。
// 工作区目录不存在时静默跳过（例如 CI 环境）。
const DEPLOY_SCRIPTS = ['stockchart.js', 'fetch_pack.js']
try {
  const baseDir = process.env.DSH_INVEST_BASE_DIR || 'E:/Dsh_WorkSapce/Dify_Agents'
  if (fs.existsSync(baseDir)) {
    const targetDir = path.join(baseDir, 'scripts')
    fs.mkdirSync(targetDir, { recursive: true })
    const deployed = []
    const same = []
    for (const name of DEPLOY_SCRIPTS) {
      const from = path.join(root, 'scripts', name)
      const to = path.join(targetDir, name)
      if (!fs.existsSync(from)) continue
      const next = fs.readFileSync(from)
      const prev = fs.existsSync(to) ? fs.readFileSync(to) : null
      if (prev && prev.equals(next)) { same.push(name); continue }
      fs.writeFileSync(to, next)
      deployed.push(name)
    }
    console.log('运行时脚本部署 -> ' + targetDir + '｜已更新: ' + (deployed.join(', ') || '无') + '｜无变化: ' + (same.join(', ') || '无'))
  }
} catch (e) {
  console.warn('[部署] 运行时脚本同步失败（不影响构建）: ' + e.message)
}

// ---- 提示词预算检查（v0.17.0 起）----
try {
  const budget = require('./check_prompt_budget.js')
} catch (e) { /* 预算脚本 exit(1) 时 require 抛错 → 提示但不阻断构建 */ console.warn('[预算] ' + e.message) }
