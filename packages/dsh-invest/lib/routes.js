// 由 src/lib/routes.js 转换（CommonJS → ESM），与 dist 的 routes 同源
// dsh-invest 角色模型路由（纯数据 + 纯函数，无副作用、无外部依赖，可独立单测）
// 双形态共享：dist 由 tools/build.js 内联；packages/dsh-invest/lib/routes.js 由 build.js 转换为 ESM 后 import
// 修改后重新执行 `node tools/build.js` 同步到 dist 与 packages/lib
//
// 语义：路由值 = 'provider/model@effort'；用 '|' 分隔备选链（前一条预检/运行失败自动试下一条）；
//       'inherit' = 该角色不传 agentOptions，完整继承宿主会话的 provider/model/reasoningEffort。

// 4 个角色简码（顺序即展示顺序）
const ROLE_CODES = ['选股', '消息', '深度', '总判断']

// 预置档位。balanced 为默认档：
//   选股/消息 = flash 档（体力活，省时省钱）；深度 = v4-pro@high（质量关键路径）；
//   总判断 = 异构模型 glm-5.3@max，失败自动回退 v4-pro@max（独立第二意见，避免同源自证）。
const PRESETS = {
  inherit: {
    '选股': 'inherit',
    '消息': 'inherit',
    '深度': 'inherit',
    '总判断': 'inherit',
  },
  budget: {
    '选股': 'deepseek-official/deepseek-flash@off',
    '消息': 'deepseek-official/deepseek-flash@off',
    '深度': 'deepseek-official/deepseek-v4-flash@high',
    '总判断': 'deepseek-official/deepseek-v4-flash@high',
  },
  balanced: {
    '选股': 'deepseek-official/deepseek-flash@low',
    '消息': 'deepseek-official/deepseek-flash@low',
    '深度': 'deepseek-official/deepseek-v4-pro@high',
    '总判断': 'zai-coding-cn/glm-5.3@max|deepseek-official/deepseek-v4-pro@max',
  },
  'deepseek-only': {
    '选股': 'deepseek-official/deepseek-flash@low',
    '消息': 'deepseek-official/deepseek-flash@low',
    '深度': 'deepseek-official/deepseek-v4-pro@high',
    '总判断': 'deepseek-official/deepseek-v4-pro@max',
  },
  quality: {
    '选股': 'deepseek-official/deepseek-v4-pro@low',
    '消息': 'deepseek-official/deepseek-v4-flash@low',
    '深度': 'deepseek-official/deepseek-v4-pro@max',
    '总判断': 'zai-coding-cn/glm-5.3@max|deepseek-official/deepseek-v4-pro@max',
  },
}
const DEFAULT_PRESET = 'balanced'

const trimStr = (v) => (typeof v === 'string' ? v.trim() : '')

// 单条路由：'provider/model@effort' 或 { provider, model, reasoningEffort } → { provider, model, reasoningEffort? }
// 'inherit' / 空 / 非法 → null
function parseRoute(text) {
  if (text === undefined || text === null) return null
  if (typeof text === 'object') {
    const provider = trimStr(text.provider)
    const model = trimStr(text.model)
    const effort = trimStr(text.reasoningEffort) || trimStr(text.reasoning_effort)
    if (!provider || !model) return null
    return effort ? { provider, model, reasoningEffort: effort } : { provider, model }
  }
  const s = String(text).trim()
  if (!s || s === 'inherit') return null
  const at = s.indexOf('@')
  const body = at > 0 ? s.slice(0, at) : s
  const effort = at > 0 ? s.slice(at + 1).trim() : ''
  if (effort.indexOf('@') >= 0) return null   // 多个 @ 视为非法配置
  const slash = body.indexOf('/')
  if (slash <= 0 || slash === body.length - 1) return null
  const provider = body.slice(0, slash).trim()
  const model = body.slice(slash + 1).trim()
  if (!provider || !model || model.indexOf('/') >= 0) return null
  return effort ? { provider, model, reasoningEffort: effort } : { provider, model }
}

// 一层配置值 → 路由备选链（数组）
// undefined = 本层未指定该角色（保持上层取值）；[] = 显式继承宿主；非空数组 = 依次尝试的备选链
function parseRouteList(value) {
  if (value === undefined || value === null) return undefined
  const items = Array.isArray(value) ? value : String(value).split('|')
  const out = []
  for (const item of items) {
    if (typeof item === 'string' && item.trim() === 'inherit') return []
    const route = parseRoute(item)
    if (route) out.push(route)
  }
  return out
}

// 多层合并（后者覆盖前者，按角色粒度）：preset ← 插件 config ← routes.json ← 环境变量 ← 单次调用参数
// 返回 { '选股': Route[], '消息': Route[], '深度': Route[], '总判断': Route[] }，[] 表示继承宿主
function mergeRoutes(preset, ...layers) {
  const base = PRESETS[preset] || PRESETS[DEFAULT_PRESET]
  const out = {}
  for (const code of ROLE_CODES) out[code] = parseRouteList(base[code]) || []
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue
    for (const code of ROLE_CODES) {
      const list = parseRouteList(layer[code])
      if (list !== undefined) out[code] = list
    }
  }
  return out
}

// 单条路由 → 展示串；null/undefined → '继承宿主'
function formatRoute(route) {
  if (!route || !route.provider || !route.model) return '继承宿主'
  return route.provider + '/' + route.model + (route.reasoningEffort ? '@' + route.reasoningEffort : '')
}

// 备选链 → 展示串（'glm-5.3@max → v4-pro@max'）；空链 → '继承宿主'
function formatRouteChain(list) {
  if (!Array.isArray(list) || !list.length) return '继承宿主'
  return list.map(formatRoute).join(' → ')
}

// 短展示串（省掉 provider 前缀）：'deepseek-v4-pro@high'；'inherited' 原样返回
function routeShort(routeText) {
  const s = trimStr(routeText)
  if (!s || s === '继承宿主') return s || '继承宿主'
  const slash = s.lastIndexOf('/')
  return slash >= 0 ? s.slice(slash + 1) : s
}

// 宽松解析 JSON 对象（环境变量 / 单次调用参数；也容忍模型直接传字符串形式）
function parseRoutesJson(text) {
  if (text === undefined || text === null) return undefined
  if (typeof text === 'object') return Array.isArray(text) ? undefined : text
  if (typeof text !== 'string') return undefined
  const s = text.trim()
  if (!s) return undefined
  try {
    const obj = JSON.parse(s)
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : undefined
  } catch (e) {
    return undefined
  }
}

export { ROLE_CODES, PRESETS, DEFAULT_PRESET, parseRoute, parseRouteList, mergeRoutes, formatRoute, formatRouteChain, routeShort, parseRoutesJson }