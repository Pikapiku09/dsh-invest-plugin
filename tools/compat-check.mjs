#!/usr/bin/env node
/**
 * DSH 升级兼容性自检（2026-11-20）
 *
 * 为什么需要它
 * ------------
 * 插件不是独立进程，它跑在 DSH 的 cordis 容器里，依赖一批**宿主接口**：
 *   ctx.webServer.register / ctx.tools.register / ctx.systemPrompt.section / ctx.effect
 *   ctx.get('fs' | 'agents' | 'attachments' | 'llm') / ctx.subagents
 *   client 侧的 5 个 @deepseek-ai/dsh-client-* 注入包
 * DSH 一升级，这些接口任何一个改名、改签名或删除，插件就可能**半死不活**：
 * 页面打不开、工具消失、或者更糟——apply() 抛异常把整个 profile 拖下水。
 *
 * 这个脚本在**不启动 DSH**的前提下，用一个会记录调用的假 ctx 跑一遍插件的 apply()，
 * 断言该注册的都注册了、该取的服务都取到了。升级 DSH 后先跑它，再决定要不要用工作台。
 *
 * 用法
 * ----
 *   node tools/compat-check.mjs            # 自检
 *   node tools/compat-check.mjs --json     # 机器可读结果
 *
 * 退出码：0 全部通过；1 有缺失（消息里会指名道姓说缺什么）；2 脚本自身跑不起来。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const ENTRY = path.join(ROOT, 'packages/dsh-invest/lib/index.js')
const wantJson = process.argv.includes('--json')

const results = []
function check(name, fn) {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail: detail || '' })
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

// 一个会记录一切的假 ctx：宿主接口的「最小可用形状」。
// 缺谁，apply() 里对应的注册/取值就会失败，从而在下面暴露出来。
function makeCtx(bucket) {
  const services = {}
  const fakeFs = {
    resolve: async (p) => p,
    readText: async (p) => fs.readFileSync(p, 'utf8'),
    writeText: async (p, text) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, text, 'utf8')
    },
    exists: async (p) => fs.existsSync(p),
    list: async () => [],
    remove: async () => {},
  }
  // 默认提供 fs；其余服务留空，用来验证插件在「服务缺失」时不会整体崩掉
  services.fs = fakeFs
  return {
    get(name) {
      bucket.servicesRequested.add(name)
      return services[name]
    },
    effect(fn) {
      bucket.effects += 1
      try {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      } catch (error) {
        bucket.effectErrors.push(error instanceof Error ? error.message : String(error))
        return () => {}
      }
    },
    on() { return () => {} },
    webServer: {
      register(route) { bucket.routes.push(route); return () => {} },
    },
    tools: {
      register(tool) { bucket.tools.push(tool); return () => {} },
      execute() {},
      prompt() {},
    },
    systemPrompt: {
      section(section) { bucket.prompts.push(section); return () => {} },
    },
    subagents: {
      list: async () => [],
      run: async () => ({ text: '' }),
      register() { return () => {} },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    emit() {},
  }
}

async function main() {
  if (!fs.existsSync(ENTRY)) {
    console.error(`找不到插件入口：${ENTRY}`)
    process.exit(2)
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-'))
  fs.mkdirSync(path.join(base, '.dsh-invest'), { recursive: true })
  // 用临时 BASE_DIR，绝不碰真实数据（自检不该有副作用）
  process.env.DSH_INVEST_BASE_DIR = base

  const bucket = {
    servicesRequested: new Set(),
    effects: 0,
    effectErrors: [],
    routes: [],
    tools: [],
    prompts: [],
    applyError: null,
  }

  let mod
  try {
    mod = await import(pathToUrl(ENTRY))
  } catch (error) {
    console.error('插件模块无法加载：', error instanceof Error ? error.message : error)
    process.exit(2)
  }

  check('模块导出 apply()', () => {
    if (typeof mod.apply !== 'function') throw new Error('exports.apply 不是函数')
    return 'ok'
  })

  check('apply() 可执行且不抛异常', () => {
    try {
      mod.apply(makeCtx(bucket), {})
    } catch (error) {
      bucket.applyError = error instanceof Error ? error.message : String(error)
      throw new Error(`apply() 抛出：${bucket.applyError}`)
    }
    return `effect 执行 ${bucket.effects} 次`
  })

  check('effect 回调内无异常', () => {
    if (bucket.effectErrors.length) throw new Error(bucket.effectErrors[0])
    return 'ok'
  })

  check('注册了 HTTP 路由', () => {
    if (!bucket.routes.length) throw new Error('webServer.register 未被调用')
    const bad = bucket.routes.filter((r) => !r.path || typeof r.handler !== 'function')
    if (bad.length) throw new Error(`路由结构异常：${bad.map((r) => r.path || '(无 path)').join(', ')}`)
    return `${bucket.routes.length} 条`
  })

  check('注册了工具', () => {
    if (!bucket.tools.length) throw new Error('tools.register 未被调用')
    const names = bucket.tools.map((t) => t?.name).filter(Boolean)
    if (!names.length) throw new Error('工具缺少 name 字段（宿主可能改了 schema）')
    return names.join(', ')
  })

  check('注册了系统提示段', () => {
    if (!bucket.prompts.length) throw new Error('systemPrompt.section 未被调用')
    return `${bucket.prompts.length} 段`
  })

  // 关键业务路由必须在场：这些一旦丢了，页面会白屏但进程不报错
  const requiredRoutes = [
    '/dsh-invest/api/index',
    '/dsh-invest/api/watchlist',
    '/dsh-invest/api/strategy-health',
    '/dsh-invest/api/sector-heatmap',
    '/dsh-invest/api/strategy-trials',
    '/dsh-invest/api/real-performance',
    '/dsh-invest/api/stock-ask',
  ]
  check('关键路由齐全', () => {
    const have = new Set(bucket.routes.map((r) => r.path))
    const missing = requiredRoutes.filter((p) => !have.has(p))
    if (missing.length) throw new Error(`缺：${missing.join(', ')}`)
    return `${requiredRoutes.length}/${requiredRoutes.length}`
  })

  // 静态扫描：注册阶段不触发 ctx.get（服务是请求时才取的），
  // 所以真实依赖面要从源码里读。这份清单就是升级 DSH 时要对照的「接口契约」。
  check('清单：插件依赖的宿主接口', () => {
    const source = fs.readFileSync(ENTRY, 'utf8')
    const services = [...new Set([...source.matchAll(/ctx\.get\(\s*["']([a-z-]+)["']/g)].map((m) => m[1]))].sort()
    const props = [...new Set([...source.matchAll(/\bctx\.([a-zA-Z]+)/g)].map((m) => m[1]))].sort()
    return `ctx.get: [${services.join(', ')}] · ctx.*: [${props.join(', ')}]`
  })

  check('请求的宿主服务可枚举', () => `[${[...bucket.servicesRequested].sort().join(', ')}]`)

  const failed = results.filter((r) => !r.ok)
  if (wantJson) {
    console.log(JSON.stringify({ ok: failed.length === 0, base, results }, null, 2))
  } else {
    console.log('\nDSH 兼容性自检\n' + '='.repeat(52))
    for (const r of results) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`)
    }
    console.log('='.repeat(52))
    console.log(failed.length ? `结果：${failed.length} 项失败` : '结果：全部通过')
  }
  // 清理临时目录，自检不留垃圾
  try { fs.rmSync(base, { recursive: true, force: true }) } catch {}
  process.exit(failed.length ? 1 : 0)
}

function pathToUrl(p) {
  const href = p.replace(/\\/g, '/')
  return 'file:///' + (href.startsWith('/') ? href.slice(1) : href)
}

main().catch((error) => {
  console.error('自检脚本自身出错：', error)
  process.exit(2)
})
