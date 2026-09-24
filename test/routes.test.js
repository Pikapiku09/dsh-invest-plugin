// dsh-invest 模型路由单元测试（Node 内置 node:test，零依赖）
// 运行：npm test 或 node --test test/
const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  ROLE_CODES, PRESETS, DEFAULT_PRESET, parseRoute, parseRouteList, mergeRoutes,
  formatRoute, formatRouteChain, routeShort, parseRoutesJson,
} = require('../src/lib/routes.js')

test('ROLE_CODES 覆盖 4 个角色', () => {
  assert.deepEqual(ROLE_CODES, ['选股', '消息', '深度', '总判断'])
})

test('DEFAULT_PRESET 为 balanced 且每档覆盖全部角色', () => {
  assert.equal(DEFAULT_PRESET, 'balanced')
  for (const name of Object.keys(PRESETS)) {
    for (const code of ROLE_CODES) {
      assert.equal(typeof PRESETS[name][code], 'string', name + '/' + code + ' 缺失')
    }
  }
})

test('balanced 默认档：选股/消息=deepseek-flash，深度=v4-pro，总判断=glm-5.3 备选 v4-pro', () => {
  const r = mergeRoutes('balanced')
  assert.deepEqual(r['选股'], [{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }])
  assert.deepEqual(r['消息'], [{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }])
  assert.deepEqual(r['深度'], [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }])
  assert.deepEqual(r['总判断'], [
    { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' },
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
  ])
})

test('parseRoute：合法 / 缺 effort / 缺 provider / inherit / 空', () => {
  assert.deepEqual(parseRoute('deepseek-official/deepseek-v4-pro@high'), { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' })
  assert.deepEqual(parseRoute('deepseek-official/deepseek-flash'), { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.equal(parseRoute('deepseek-v4-pro@high'), null)
  assert.equal(parseRoute('/deepseek-v4-pro@high'), null)
  assert.equal(parseRoute('inherit'), null)
  assert.equal(parseRoute(''), null)
  assert.equal(parseRoute(undefined), null)
})

test('parseRoute：对象形式与多余的 @', () => {
  assert.deepEqual(parseRoute({ provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' }), { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' })
  assert.deepEqual(parseRoute({ provider: 'zai-coding-cn', model: 'glm-5.3', reasoning_effort: 'max' }), { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' })
  assert.equal(parseRoute({ provider: 'x', model: '' }), null)
  assert.equal(parseRoute('zai-coding-cn/glm-5.3@max@extra'), null)
  assert.equal(parseRoute('a/b/c@low'), null)
})

test('parseRouteList：未指定 / 显式 inherit / 备选链 / 全非法', () => {
  assert.equal(parseRouteList(undefined), undefined)
  assert.equal(parseRouteList(null), undefined)
  assert.deepEqual(parseRouteList('inherit'), [])
  assert.deepEqual(parseRouteList('a/b@low|c/d@max'), [{ provider: 'a', model: 'b', reasoningEffort: 'low' }, { provider: 'c', model: 'd', reasoningEffort: 'max' }])
  assert.deepEqual(parseRouteList(['a/b@low', 'c/d@max']), [{ provider: 'a', model: 'b', reasoningEffort: 'low' }, { provider: 'c', model: 'd', reasoningEffort: 'max' }])
  assert.deepEqual(parseRouteList('完全不是路由'), [])
})

test('mergeRoutes：config 覆盖单角色，其余保持 preset', () => {
  const r = mergeRoutes('balanced', { '深度': 'deepseek-official/deepseek-v4-pro@max' })
  assert.deepEqual(r['深度'], [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }])
  assert.deepEqual(r['选股'], [{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }])
})

test('mergeRoutes：层序 preset ← config ← file ← env ← args（后者胜）', () => {
  const r = mergeRoutes('inherit',
    { '深度': 'a/depth@low' },
    { '深度': 'b/depth@low' },
    { '深度': 'c/depth@low' },
    { '深度': 'd/depth@max' })
  assert.deepEqual(r['深度'], [{ provider: 'd', model: 'depth', reasoningEffort: 'max' }])
})

test('mergeRoutes：显式 inherit 清空上层路由（回退宿主）', () => {
  const r = mergeRoutes('balanced', { '总判断': 'inherit' })
  assert.deepEqual(r['总判断'], [])
})

test('mergeRoutes：未知 preset 回退默认档', () => {
  assert.deepEqual(mergeRoutes('不存在的档'), mergeRoutes(DEFAULT_PRESET))
})

test('formatRoute / formatRouteChain / routeShort', () => {
  assert.equal(formatRoute(null), '继承宿主')
  assert.equal(formatRoute({ provider: 'a', model: 'b', reasoningEffort: 'low' }), 'a/b@low')
  assert.equal(formatRouteChain([]), '继承宿主')
  assert.equal(formatRouteChain([{ provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' }, { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }]), 'zai-coding-cn/glm-5.3@max → deepseek-official/deepseek-v4-pro@max')
  assert.equal(routeShort('deepseek-official/deepseek-v4-pro@high'), 'deepseek-v4-pro@high')
  assert.equal(routeShort('继承宿主'), '继承宿主')
})

test('parseRoutesJson：对象 / JSON 字符串 / 非法输入', () => {
  assert.deepEqual(parseRoutesJson('{"深度":"a/b@low"}'), { '深度': 'a/b@low' })
  assert.deepEqual(parseRoutesJson({ '深度': 'a/b@low' }), { '深度': 'a/b@low' })
  assert.equal(parseRoutesJson('不是 JSON'), undefined)
  assert.equal(parseRoutesJson('[1,2]'), undefined)
  assert.equal(parseRoutesJson(''), undefined)
  assert.equal(parseRoutesJson(undefined), undefined)
})

test('端到端：env JSON + 单次参数 → 有效路由链', () => {
  const env = parseRoutesJson('{"选股":"deepseek-official/deepseek-v4-pro@max"}')
  const r = mergeRoutes('balanced', undefined, env, parseRoutesJson('{"总判断":"inherit"}'))
  assert.deepEqual(r['选股'], [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }])
  assert.deepEqual(r['总判断'], [])
  assert.equal(formatRouteChain(r['深度']), 'deepseek-official/deepseek-v4-pro@high')
})
