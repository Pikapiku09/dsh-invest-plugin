// DSH 宿主依赖的可选导入（v0.44.2）
//
// @deepseek-ai/schemastery 与 @deepseek-ai/dsh-tools 由 DSH host 提供（私有包，不在公共 npm 上）。
// 单元测试与独立运行环境（例如 CI 的干净 clone、只装了 node_modules 之外的依赖）里没有这两个包，
// 直接 `import` 会让整个 index.js 加载失败，进而所有导入插件的测试集体报错——
// 这正是 v0.44.1 之后 CI 后端 job 仍然失败的原因（本机有 node_modules，所以一直看不出来）。
//
// 这里改为「真包优先、缺失时用最小 fallback」：
//   · 宿主环境下行为完全不变（始终拿到真实实现）；
//   · 测试环境只要求模块可加载，Config schema 与 defineTool 参与不到断言。
//
// 注意：本文件必须用顶层 await 动态导入，不能用静态 import，否则失败发生在链接阶段、catch 不住。

function makeFallbackSchema() {
  // 可链式调用的最小 schema 桩：任何属性访问都返回自身，调用返回自身
  const node = () => {
    const self = function () { return self }
    const chain = ['default', 'description', 'required', 'optional', 'role', 'hidden', 'deprecated']
    for (const key of chain) self[key] = () => self
    return self
  }
  const z = {}
  for (const key of ['string', 'number', 'boolean', 'any', 'object', 'dict', 'array', 'tuple', 'union', 'intersect', 'const', 'enum', 'date', 'func', 'is']) {
    z[key] = node
  }
  return z
}

let z
try {
  z = (await import('@deepseek-ai/schemastery')).default
  if (!z || typeof z.object !== 'function') z = makeFallbackSchema()
} catch (e) {
  z = makeFallbackSchema()
}

let defineTool
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  defineTool = typeof mod.defineTool === 'function' ? mod.defineTool : (def) => def
} catch (e) {
  // 独立运行/测试环境：defineTool 只是把定义原样返回的包装
  defineTool = (def) => def
}

export { z, defineTool }
