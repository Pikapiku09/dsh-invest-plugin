// 校验 lib/client.js（已安装插件的客户端 bundle）
// 1) 语法可解析（vm.Script 只编译不执行）
// 2) 用桩环境执行 factory，验证它向 sidebar.panellist / main 各注册了一次，
//    且 id 一致（这是「点左侧图标能切到工作台面板」的唯一契约）
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(here, '..', 'packages', 'dsh-invest', 'lib', 'client.js')
const PKG = path.join(here, '..', 'packages', 'dsh-invest', 'package.json')

function loadBundle() {
  const code = fs.readFileSync(BUNDLE, 'utf8')
  let registered = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { registered = def } } },
    document: { createElement: () => ({ setAttribute() {}, appendChild() {} }), head: { appendChild() {} }, querySelector: () => null },
    console,
  }
  vm.createContext(sandbox)
  // document.head.appendChild / styleEl.parentNode 的最小实现
  sandbox.document.head.appendChild = () => {}
  new vm.Script(code, { filename: 'client.js' }).runInContext(sandbox)
  assert.ok(registered, 'bundle 必须调用 window.__ModuleLoader__.load()')
  assert.equal(typeof registered.id, 'string')
  assert.equal(typeof registered.factory, 'function')
  return registered
}

test('客户端 bundle：可解析并注册 factory（id 与包名一致）', () => {
  const def = loadBundle()
  assert.equal(def.id, 'dsh-invest')
})

test('客户端 bundle：package.json 声明了 dsh.client 与 ./client 导出', () => {
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
  assert.ok(pkg.exports && pkg.exports['./client'], '必须导出 ./client')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  const client = pkg.dsh && pkg.dsh.client
  assert.ok(client, '必须声明 dsh.client')
  assert.equal(client.platform, 'web')
  assert.ok(Array.isArray(client.inject) && client.inject.length > 0, 'dsh.client.inject 不能为空')
  // 侧栏与布局的 slot 声明必须在我们的之前到达，否则注册会因 seat 未声明而跳过
  assert.ok(client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'), '必须 inject 侧栏包（声明 sidebar.panellist）')
  assert.ok(client.inject.includes('@deepseek-ai/dsh-client-ui-layout'), '必须 inject 布局包（声明 main）')
})

test('客户端 bundle：apply 会注册 sidebar.panellist 与同名 main 面板', () => {
  const def = loadBundle()
  const calls = []
  const slots = {
    // 声明感知注册：立即执行回调（模拟 seat 已声明）
    inject: (name, fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    register: (opts) => { calls.push(opts); return () => {} },
  }
  const effects = []
  const ctx = {
    get: (n) => (n === 'slots' ? slots : undefined),
    effect: (fn) => { const d = fn(); if (typeof d === 'function') effects.push(d) },
    interval: () => () => {},
  }
  const ReactStub = {
    createElement: () => null,
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
  const exportsObj = def.factory((req) => {
    assert.equal(req, 'react', '只应 require react（其余依赖必须是基线模块）')
    return ReactStub
  })
  assert.equal(typeof exportsObj.apply, 'function')
  exportsObj.apply(ctx)

  const panel = calls.find((c) => c.name === 'sidebar.panellist')
  const main = calls.find((c) => c.name === 'main')
  assert.ok(panel, '必须注册 sidebar.panellist 入口')
  assert.ok(main, '必须注册 main 面板')
  assert.equal(panel.id, main.key, '侧栏入口 id 必须等于主面板 key，否则点击不会切换')
  assert.equal(panel.id, 'invest-workbench')
  assert.equal(panel.label, '投研工作台')
  assert.equal(typeof panel.order, 'number')
  // 工具卡片注册仍在
  assert.ok(calls.some((c) => c.name === 'tool.call.toolview' && c.key === 'invest_run'))
})
