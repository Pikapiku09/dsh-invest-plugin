// DSH 动态插件 Host 半部（invest_run 工具 + 流水线编排）
// 由 tools/build.js 与 src/prompts.js、src/lib/pure.js 合并生成 dist/invest-run.host.js（完整函数体）
// 依赖：ctx（Cordis 受限上下文）、harness（DSH Host 内建）、PROMPTS（build 注入的提示词数据）、
//        pure.js 顶层函数（z2/localYmd/extractBoth/collectCharts/buildGroups，build 内联）

const { P_SELECT, P_NEWS, P_DEEP, P_FINAL, P_SWING } = PROMPTS

// 角色定义：简码 → { code, 显示名, persona }（模块级常量，避免每次 execute 重建）
const R = (code, name, persona) => ({ code, name, persona })
const ROLE_MAP = {
  '选股': R('选股', '选股分析师', P_SELECT),
  '消息': R('消息', '市场重点消息获取师', P_NEWS),
  '深度': R('深度', '股票深度分析师', P_DEEP),
  '总判断': R('总判断', '总判断师', P_FINAL),
  '波段': R('波段', '波段池管理师', P_SWING),
}
// 默认角色组合（按 mode）
const DEFAULT_ROLES = {
  '个股': ['深度'],
  '选股': ['选股'],
  '消息': ['消息'],
  '深度分析': ['选股', '深度'],
  '总判断': ['选股', '消息', '深度', '总判断'],
  '波段池': ['波段'],
}

return {
  name: 'invest-run',
  apply(ctx, config) {
    const text = (s) => [{ type: 'text', text: String(s) }]
    const progressStore = {}
    // 工作区基目录：默认 E:/Dsh_WorkSapce/Dify_Agents，可用 DSH_INVEST_BASE_DIR 覆盖
    const BASE_DIR = (typeof process !== 'undefined' && process.env && process.env.DSH_INVEST_BASE_DIR) || 'E:/Dsh_WorkSapce/Dify_Agents'
    const CACHE_DIR = BASE_DIR + '/.dsh-invest/cache'
    const TRADE_CACHE = CACHE_DIR + '/last-trade-date.json'
    const REPORTS_DIR = BASE_DIR + '/.dsh-invest/reports'
    const OUTPUT_ROOT = BASE_DIR + '/invest-outputs'
    const RUNS_LOG = BASE_DIR + '/.dsh-invest/runs.jsonl'
    const CHARTS_DIR = BASE_DIR + '/.dsh-invest/charts/'
    const MAX_CHARTS = 6
    // 提示词里的 {{BASE_DIR}} 占位符 → 实际基目录（token/缓存/图表路径）
    const resolveDir = (t) => String(t).split('{{BASE_DIR}}').join(BASE_DIR)
    // 模型路由配置：插件 config（cordis_define / cordis.patch.yml）与工作区覆盖文件
    const PLUGIN_CONFIG = (config && typeof config === 'object') ? config : {}
    const ROUTES_FILE = BASE_DIR + '/.dsh-invest/routes.json'
    // 本地持仓账本（跨会话共享）：由 scripts/holdings.py 维护，invest_run 每次运行注入摘要
    const HOLDINGS_FILE = BASE_DIR + '/.dsh-invest/持仓.json'
    const REALTIME_SCRIPT = BASE_DIR + '/scripts/realtime_quote.py'
    const STORE_INDEX = BASE_DIR + '/.dsh-invest/store/index.json'
    // 单阶段超时：默认 60 分钟（高推理强度深度分析较长，留足余量），可用环境变量覆盖
    const STAGE_TIMEOUT_MS = (Number(process.env.DSH_INVEST_STAGE_TIMEOUT_MS) > 0) ? Number(process.env.DSH_INVEST_STAGE_TIMEOUT_MS) : 3600000
    const CONCLUSIONS_LOG = BASE_DIR + '/.dsh-invest/store/conclusions.jsonl'

    // 读取账本 → 紧凑 Markdown 摘要（不存在/损坏时返回空串，绝不阻断流水线）
    const readHoldingsBlock = async () => {
      const fs = ctx.get('fs')
      if (fs === undefined) return ''
      try {
        const target = await fs.resolve(HOLDINGS_FILE)
        const d = JSON.parse(await fs.readText(target))
        const list = Array.isArray(d.positions) ? d.positions : []
        const acc = (d.account && typeof d.account === 'object') ? d.account : {}
        if (!list.length && acc.total_asset === undefined && acc.cash === undefined) return ''
        const f = (v) => (v === null || v === undefined || v === '') ? '-' : (typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v))
        const out = []
        out.push('【当前持仓账本（' + HOLDINGS_FILE + '，更新于 ' + f(d.updated_at) + '）】')
        if (acc.total_asset !== undefined || acc.cash !== undefined) {
          out.push('账户：总资产 ' + f(acc.total_asset) + ' ｜ 现金 ' + f(acc.cash) + (acc.note ? ' ｜ ' + acc.note : ''))
        }
        if (list.length) {
          out.push('| 代码 | 名称 | 池 | 数量/仓位 | 成本 | 状态 | 止损 | 备注 |')
          out.push('|---|---|---|---|---|---|---|---|')
          for (const p of list.slice(0, 20)) {
            const qty = (p.shares !== undefined && p.shares !== null) ? String(p.shares)
              : ((p.weight_pct !== undefined && p.weight_pct !== null) ? p.weight_pct + '%' : '-')
            out.push('| ' + p.code + ' | ' + f(p.name) + ' | ' + f(p.pool) + ' | ' + qty + ' | ' + f(p.cost) + ' | ' + f(p.status) + ' | ' + f(p.stop) + ' | ' + String(p.note || '').replace(/\n/g, ' ').slice(0, 60) + ' |')
          }
        }
        out.push('【账本使用规则】① 本账本只记录用户与 AI 确认过的实盘/纸面持仓，**不含 LihuQuantify 模拟盘（短线池）数据**，严禁把量化系统的模拟盘数字混进来；② 凡涉及个股/组合/加减仓/复盘，先按上表核对：是否已持有、成本与浮盈亏、止损位、仓位占比（数量×现价÷总资产）；③ 结论必须区分「已持有（加仓/减仓/持有）」与「新建仓」，账本外的标的按空仓处理；④ 用户在对话中口述持仓变动时，必须用 pwsh 执行 python "' + BASE_DIR + '/scripts/holdings.py" add/update 落账；⑤ 账本与用户口述冲突时以用户为准并明确提示差异，严禁编造账本外的持仓数字。')
        return out.join('\n')
      } catch (e) { return '' }
    }

    // P3：结构化结论读取、历史注入与落库（与 profile bundle 同源）
    const readConclusionRecords = async () => {
      const fs = ctx.get('fs')
      if (fs === undefined) return []
      try {
        const raw = await fs.readText(await fs.resolve(CONCLUSIONS_LOG))
        const out = []
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue
          try { const j = JSON.parse(line); if (j && j.code) out.push(j) } catch (e) { /* 坏行跳过 */ }
        }
        return out
      } catch (e) { return [] }
    }
    const conclusionDays = (asof) => {
      const m = String(asof || '').match(/(\d{4})-?(\d{2})-?(\d{2})/)
      const c = String(localYmd()).match(/(\d{4})(\d{2})(\d{2})/)
      if (!m || !c) return '未知'
      const a = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      const b = Date.UTC(Number(c[1]), Number(c[2]) - 1, Number(c[3]))
      const d = Math.max(0, Math.round((b - a) / 86400000))
      return d === 0 ? '今天' : d + ' 天前'
    }
    const readHistoryBlock = async (question, context, mode) => {
      let codes = extractInvestCodes(String(question || '') + ' ' + String(context || ''))
      if (!codes.length && /持仓|组合|复盘|波段|总判断|all/i.test(String(question || '') + ' ' + String(mode || ''))) {
        const fs = ctx.get('fs')
        if (fs !== undefined) {
          try {
            const h = JSON.parse(await fs.readText(await fs.resolve(HOLDINGS_FILE)))
            codes = (Array.isArray(h.positions) ? h.positions : []).map((p) => p.code).filter(Boolean)
          } catch (e) { /* ignore */ }
        }
      }
      if (!codes.length) return ''
      const structured = await readConclusionRecords()
      let backfill = []
      const fs = ctx.get('fs')
      if (fs !== undefined) {
        try { backfill = (JSON.parse(await fs.readText(await fs.resolve(STORE_INDEX))).records || []) } catch (e) { /* ignore */ }
      }
      const lines = []
      const val = (v) => (v === null || v === undefined || v === '') ? '—' : String(v)
      for (const code of codes.slice(0, 5)) {
        const ss = structured.filter((r) => r.code === code)
        const bb = backfill.filter((r) => r.code === code)
        const rec = ss.length ? ss[ss.length - 1] : (bb.length ? bb[bb.length - 1] : null)
        if (!rec) continue
        const asof = rec.asof || String(rec.ts || '').slice(0, 10)
        lines.push(code + '｜上次 ' + val(asof) + '（' + conclusionDays(asof) + '，' + val(rec.source) + '）：' + val(rec.stance)
          + '；目标 ' + val(rec.target) + '；止损 ' + val(rec.stop)
          + '；论据 ' + val(rec.thesis).slice(0, 160)
          + (rec.invalidate_if ? '；失效条件 ' + String(rec.invalidate_if).slice(0, 120) : ''))
      }
      if (!lines.length) return ''
      return '【历史结论记忆（自动注入）】\n以下历史结论只用于对照，不是当前事实；行情与指标必须重新取数。\n'
        + lines.join('\n')
        + '\n请先判断上次结论是否已兑现或失效，再明确写出本次与上次的**相同点、变化点及变化原因**；没有新证据不得简单重复历史结论。'
    }
    const persistConclusions = async (mode, question, callId, outputs, reports, policy) => {
      const fs = ctx.get('fs')
      if (fs === undefined) return 0
      let chosen = null
      let blocks = []
      for (let i = outputs.length - 1; i >= 0; i--) {
        const o = outputs[i]
        if (!o.ok) continue
        const parsed = parseConclusionBlocks(o.text)
        if (parsed.length) { chosen = o; blocks = parsed; break }
      }
      if (!chosen || !blocks.length) return 0
      const lines = blocks.slice(0, 3).map((b) => JSON.stringify({
        ts: new Date().toISOString(), mode, question: String(question).slice(0, 200), callId,
        code: b.code, stance: b.stance || '未明',
        target: (typeof b.target === 'number' ? b.target : null),
        stop: (typeof b.stop === 'number' ? b.stop : null),
        thesis: String(b.thesis || '').slice(0, 200),
        invalidate_if: String(b.invalidate_if || '').slice(0, 200),
        stage: chosen.stage, report: reports[0] || null, source: 'invest_run',
      }))
      try {
        const target = await fs.resolve(CONCLUSIONS_LOG)
        let existing = ''
        try { existing = await fs.readText(target) } catch (e) { /* 首次 */ }
        const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing
        await fs.writeText(target, prefix + lines.join('\n') + '\n', undefined, undefined, policy)
        return lines.length
      } catch (e) { return 0 }
    }

    // 读取工作区路由覆盖文件（不存在/损坏 → undefined，绝不阻断流水线）
    const readRoutesFile = async () => {
      const fs = ctx.get('fs')
      if (fs === undefined) return undefined
      try {
        const target = await fs.resolve(ROUTES_FILE)
        return parseRoutesJson(await fs.readText(target))
      } catch (e) { return undefined }
    }

    // Client→Host：按需读取图表 SVG（路径白名单：必须位于 charts 目录内）
    harness.handle('chart-content', async (args) => {
      const fs = ctx.get('fs')
      if (fs === undefined) return { error: 'fs unavailable' }
      const p = args && typeof args.path === 'string' ? args.path : ''
      if (!/\.svg$/i.test(p) || !p.startsWith(CHARTS_DIR)) return { error: 'denied' }
      try {
        const target = await fs.resolve(p)
        const svg = await fs.readText(target)
        if (svg.length > 160000) return { error: 'too large' }
        return { path: p, svg }
      } catch (e) {
        return { error: String(e).slice(0, 200) }
      }
    })

    // Client→Host：运行中阶段进度（仅返回 JSON 安全字段）
    harness.handle('progress', async (args) => {
      const id = args && typeof args.callId === 'string' ? args.callId : ''
      const p = id ? progressStore[id] : undefined
      if (p === undefined) return { none: true }
      const out = {
        stage: typeof p.stage === 'string' ? p.stage : '',
        index: typeof p.index === 'number' ? p.index : 0,
        total: typeof p.total === 'number' ? p.total : 0,
        status: typeof p.status === 'string' ? p.status : '',
        done: Array.isArray(p.done) ? p.done : [],
        updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
      }
      if (typeof p.elapsedMs === 'number') out.elapsedMs = p.elapsedMs
      return out
    })

    // 当日交易日锚点缓存（子代理写入，Host 读取注入）
    const readTradeCache = async () => {
      const fs = ctx.get('fs')
      if (fs === undefined) return null
      try {
        const target = await fs.resolve(TRADE_CACHE)
        const raw = await fs.readText(target)
        const obj = JSON.parse(raw)
        if (obj && typeof obj.trade_date === 'string' && /^\d{8}$/.test(obj.trade_date) && obj.date === localYmd()) return obj.trade_date
      } catch (e) { /* ignore */ }
      return null
    }

    const tool = harness.defineTool({
      name: 'invest_run',
      description: '运行多角色投研流水线。mode：个股（单只股票深度分析，最常用）/选股（全市场海选）/消息（消息面收集）/深度分析（选股+深度）/总判断/all（完整流水线）/波段池（中长周期波段建池与跟踪，持有 3 周-6 个月，持仓≤4 只，可空仓）。question 为用户投研问题（可含多只股票）；roles 可选：自定义角色组合（如 [\'深度\',\'总判断\']，省略则按 mode 默认）；context 可选，传入上一轮分析结论或追问背景（记忆与追问）；detail 可选：full=模型侧全量输出（token 多），summary=摘要输出省 token（默认，GUI 卡片始终显示完整报告）。routes/preset 可选：按角色覆盖模型路由（默认 inherit=继承宿主模型；preset 档位 inherit/budget/balanced/deepseek-only/quality；每角色可用 routes.json 自定义）。数据用 Tushare 实时获取。/ Multi-role A-share research pipeline: mode=stock(深析)/screening/news/deep/total/swing-pool; routes/preset select per-role LLM (default: inherit host model); Tushare realtime data.',
      parameters: { type: 'object', properties: { mode: { type: 'string', description: '运行模式' }, question: { type: 'string', description: '用户投研问题（可含多只股票）' }, roles: { type: 'array', items: { type: 'string' }, description: '可选：自定义角色组合，取值 [\'选股\',\'消息\',\'深度\',\'总判断\',\'波段\'] 的子集；省略则按 mode 默认角色' }, routes: { type: 'object', additionalProperties: true, description: '可选：按角色覆盖模型路由，形如 {"总判断":"zai-coding-cn/glm-5.3@max"}；值为 provider/model@effort，可用 "a|b" 写备选链，写 "inherit" 表示继承宿主模型；省略则用插件默认路由表' }, preset: { type: 'string', description: '可选：路由预置档 inherit/budget/balanced/deepseek-only/quality，默认 inherit（继承宿主）' }, context: { type: 'string', description: '可选：上一轮分析结论/追问背景，让本轮分析有记忆' }, detail: { type: 'string', description: '可选：full=模型侧全量（token 多）/ summary=摘要省 token（默认）。不影响 GUI 卡片，卡片始终显示完整报告与推理' } }, required: ['mode', 'question'] },
      output: {
        schema: { type: { type: "object" }, additionalProperties: true }, 
        render: (args, value) => {
          const detail = args && args.detail === 'full' ? 'full' : 'summary'
          const LIMIT = detail === 'full' ? 9000 : 2500
          const lines = []
          const outputs = Array.isArray(value.outputs) ? value.outputs : []
          const charts = Array.isArray(value.charts) ? value.charts.slice(0, MAX_CHARTS) : []
          const reports = Array.isArray(value.reports) ? value.reports : []
          if (value.error) lines.push('错误：' + String(value.error))
          lines.push('invest_run 模式=' + String(value.mode || '') + ' ｜ 阶段数=' + outputs.length + (charts.length ? ' ｜ 图表=' + charts.length + ' 张' : '') + (reports.length ? ' ｜ 报告已归档' : '') + ' ｜ detail=' + detail)
          for (const o of outputs) {
            lines.push('')
            lines.push('=== ' + o.stage + ' ｜ ' + (o.route || '继承宿主') + (o.ok ? ' ｜ 耗时 ' + (o.elapsedMs / 1000).toFixed(1) + 's' : ' ｜ 失败') + ' ===')
            if (o.error) lines.push('错误：' + o.error)
            if (o.ok && typeof o.text === 'string') {
              const t = o.text
              lines.push(t.length > LIMIT ? t.slice(0, LIMIT) + (detail === 'summary' ? '\n…（完整报告见 GUI 卡片或归档文件）' : '') : t)
            }
          }
          if (charts.length) {
            lines.push('')
            lines.push('图表文件：' + charts.join(' , '))
          }
          if (reports.length) {
            lines.push('')
            lines.push('报告归档：' + reports.join(' , '))
          }
          if (value.reportError) lines.push('归档错误：' + value.reportError + ' / Archive error')
          return text(lines.join('\n'))
        },
        presentationMeta: (args, value) => ({
          mode: String(value.mode || ''),
          charts: (Array.isArray(value.charts) ? value.charts.slice(0, MAX_CHARTS) : []).map((p) => ({ path: String(p) })),
          stages: (Array.isArray(value.outputs) ? value.outputs : []).map((o) => ({ stage: o.stage, code: typeof o.code === 'string' ? o.code : '', ok: o.ok === true, elapsedMs: o.elapsedMs, route: typeof o.route === 'string' ? o.route : '', text: typeof o.text === 'string' ? o.text : '', reasoning: typeof o.reasoning === 'string' ? o.reasoning : '' })),
        routes: (value.routes && typeof value.routes === 'object') ? value.routes : {},
        routeNotes: Array.isArray(value.routeNotes) ? value.routeNotes.slice(0, 8) : [],
        }),
      },
      async execute(args, exec) {
        // 缓存清理（2026-10-23）：>30 天缓存文件后台清理，防 .dsh-invest/cache 无限增长
        ;(async () => {
          try {
            const fs2 = ctx.get('fs')
            if (fs2 === undefined) return
            const cutoff = Date.now() - 30 * 24 * 3600 * 1000
            const entries = await fs2.list?.(CACHE_DIR)
            if (Array.isArray(entries)) {
              for (const ent of entries) {
                try {
                  const st = await fs2.stat?.(ent.path || ent)
                  if (st && st.mtime && st.mtime < cutoff) await fs2.remove?.(ent.path || ent)
                } catch (e) { /* 单文件失败忽略 */ }
              }
            }
          } catch (e) { /* 清理失败绝不阻断流水线 */ }
        })()
        const mode = args.mode
        const question = args.question
        const context = typeof args.context === 'string' && args.context.trim() ? args.context.trim().slice(0, 4000) : ''
        const callId = String(exec.callId || '')
        const runStart = Date.now()
        let outputs = []
        let allCharts = new Set()
        let reports = []
        let routeMap = {}
        let routeNotes = []
        // 沙箱策略提前解析（报告归档与运行日志共用）
        const fs = ctx.get('fs')
        const sp = ctx.get('sandboxPolicy')
        const policy = (sp !== undefined && exec.agent !== undefined) ? sp.resolve({ session: exec.agent.session }) : undefined
        try {
        // 2026-10-28 修复（第二版）：插件已在 inject 中声明 subagents，属性访问 ctx.subagents 取得的才是
        // 带 start() 的运行时（与宿主 dsh-tool-subagent 的 runtimeCtx.subagents 同源）；ctx.get() 取到的形态不带 start()。
        // 候选顺序：属性访问 → ctx.get(n, true) → ctx.get(n, false)，取第一个带 start() 的实例；
        // 都不可用时把探测到的键名写进错误便于定位。
        const candidatesOf = (n) => {
          const out = []
          try { out.push(ctx[n]) } catch (e) { /* 未声明 inject 时会抛错，忽略 */ }
          if (typeof ctx.get === 'function') {
            try { out.push(ctx.get(n, true)) } catch (e) { /* 忽略 */ }
            try { out.push(ctx.get(n, false)) } catch (e) { /* 忽略 */ }
          }
          return out.filter((x) => x)
        }
        const allCands = candidatesOf('subagents').concat(candidatesOf('subagent'))
        // 2026-10-29 修复（第三版）：DSH 宿主 subagent 运行时换代——新宿主以 startActivation() 取代 start()。
        // 新契约：startActivation({provider,label,request,signal,delivery}) →
        //   { childId, result: Promise<{output:[{type:'text'|'reasoning',text}], stopReason}>, dispose }
        // result.output 与 extractBoth 的解析口径兼容，可直接复用。
        // 新 provider 能力集 = {agentOptions,agentPreset,outputSchema,depthLimit}：不支持旧字段
        // persona/toolFilter → 角色设定注入 prompt，递归用 maxDepth=0 阻断。
        const nativeStart = allCands.find((x) => typeof x.start === 'function')
        const activationHost = allCands.find((x) => typeof x.startActivation === 'function')
        if (nativeStart === undefined && activationHost === undefined) {
          const probe = allCands[0]
          const keys = probe ? Object.keys(probe).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(probe) || {})) : []
          return { error: 'subagents not mounted（start()/startActivation() 均不可用）；候选 ' + allCands.length + ' 个；探测键名: ' + keys.join(',') + '；ctx.get 类型: ' + (typeof ctx.get) }
        }
        // 统一入口：旧宿主走原生 start()；新宿主翻译为 startActivation（返回同形状 {result,...}）
        const startStage = async (spec) => {
          if (nativeStart !== undefined) return nativeStart.start('spawn', spec)
          const plain = Array.isArray(spec.prompt)
            ? spec.prompt.map((b) => (b && b.text) || '').join('\n')
            : String(spec.prompt || '')
          const text = spec.persona ? '【角色设定】\n' + spec.persona + '\n\n' + plain : plain
          // maxDepth 不显式传：继承宿主设置（默认 1 = 本级允许、孙代被拒，等效旧的“禁止递归”）。
          // 实测 maxDepth:0 表示“禁止本级”——子代深度 1 会直接 SubagentDepthError。
          const request = { prompt: [{ type: 'text', text }], parent: spec.parent }
          if (spec.agentOptions) request.agentOptions = spec.agentOptions
          const call = (delivery) => activationHost.startActivation({
            provider: 'spawn',
            label: spec.label,
            request,
            signal: spec.signal,
            delivery,
          })
          let act
          try {
            act = await call('caller')   // 程序化调用方语义：不向父会话投递完成通知
          } catch (e) {
            if (/delivery|caller|UNSUPPORTED/i.test(String(e))) act = await call('parent')
            else throw e
          }
          return { result: act.result, childId: act.childId, dispose: act.dispose }
        }
        let roleCodes
        if (Array.isArray(args.roles) && args.roles.length) {
          roleCodes = args.roles.filter((r) => ROLE_MAP[r])
          if (!roleCodes.length) return { error: '无效的角色列表：' + JSON.stringify(args.roles) + '，可选：选股/消息/深度/总判断/波段' }
        } else {
          roleCodes = DEFAULT_ROLES[mode] || DEFAULT_ROLES['总判断']
        }
        // 问题已明确指定标的（出现 6 位代码）且本轮含深度+上游扫描角色时：深度并入第一组并行
        const qCodes = extractInvestCodes(String(question || ''))
        const parallelDeep = qCodes.length > 0 && roleCodes.includes('深度')
          && (roleCodes.includes('选股') || roleCodes.includes('消息') || roleCodes.includes('波段'))
        if (parallelDeep) routeNotes.push('问题已含标的 ' + qCodes.slice(0, 4).join('、') + '：深度与选股/消息并行执行（省约一个上游阶段的时间）')
        const groups = buildGroups(roleCodes, ROLE_MAP, undefined, { parallelDeep })
        // ---- 模型路由解析：preset ← 插件 config ← .dsh-invest/routes.json ← 环境变量 ← 单次调用参数 ----
        const llm = ctx.get('llm')
        const presetName = (typeof args.preset === 'string' && args.preset)
          || (typeof PLUGIN_CONFIG.preset === 'string' && PLUGIN_CONFIG.preset)
          || (typeof process !== 'undefined' && process.env && process.env.DSH_INVEST_PRESET)
          || DEFAULT_PRESET
        const roleRoutes = mergeRoutes(
          presetName,
          PLUGIN_CONFIG.routes,
          await readRoutesFile(),
          parseRoutesJson(typeof process !== 'undefined' && process.env ? process.env.DSH_INVEST_ROUTES : void 0),
          parseRoutesJson(args.routes),
        )
        // 逐角色预检（provider 注册/模型存在/effort 支持），不可用即降级；绝不阻断流水线
        const chosenRoutes = {}
        for (const code of roleCodes) {
          const chain = Array.isArray(roleRoutes[code]) ? roleRoutes[code] : []
          if (!chain.length) { chosenRoutes[code] = null; continue }
          if (llm === undefined) {
            routeNotes.push(code + '：llm 服务不可用，已回退继承宿主模型')
            chosenRoutes[code] = null
            continue
          }
          let picked = null
          for (let i = 0; i < chain.length; i++) {
            const r = chain[i]
            try {
              await llm.resolveCallConfig(Object.assign({ provider: r.provider, model: r.model }, r.reasoningEffort ? { reasoningEffort: r.reasoningEffort } : {}), exec.signal)
              picked = r
              if (i > 0) routeNotes.push(code + '：首选不可用，已切换备选 ' + formatRoute(r))
              break
            } catch (e) {
              routeNotes.push(code + '：' + formatRoute(r) + ' 预检失败（' + String(e).slice(0, 140) + '）')
            }
          }
          if (!picked) routeNotes.push(code + '：全部路由预检失败，已回退继承宿主模型')
          chosenRoutes[code] = picked
        }
        const setProgress = (p) => { progressStore[callId] = Object.assign({ updatedAt: Date.now() }, p) }
        setProgress({ stage: '', index: 0, total: groups.length, status: 'init', done: [] })
        const anchor = await readTradeCache()
        const realtimeLine = '【实时行情兜底（腾讯财经）】若 TuShare 返回的最新交易日早于今日、且当前处于交易日 09:30–15:00（含午休），必须先用 pwsh 执行 python "' + REALTIME_SCRIPT + '" <代码1> <代码2> 取腾讯实时价（JSON），并在正文以 [实时·腾讯 HH:MM] 与 [日线·TuShare YYYYMMDD] 双标注；技术指标（MA/MACD/九转/周线）仍必须用 TuShare 日线收盘计算，实时价只作盘中参考，严禁混用。非交易时段或 TuShare 已是最新交易日时不必调用。'
        const anchorLine = (anchor
          ? '【已缓存锚定】真实最新交易日 = ' + anchor + '（由流水线缓存提供，跳过 index_daily 锚定步骤，直接按此日期取数）'
          : '【交易日缓存为空】按日期锚定铁律完成 index_daily 锚定后，用 pwsh 执行 node -e 把 JSON {"date":"' + localYmd() + '","trade_date":"你的锚定结果YYYYMMDD"} 写入 ' + TRADE_CACHE + '（目录不存在先创建），供本日后续运行复用') + '\n' + realtimeLine
        const history = []
        const holdingsBlock = await readHoldingsBlock()
        const historyBlock = await readHistoryBlock(question, context, mode)
        const runStage = async (s) => {
          const t0 = Date.now()
          const parts = ['用户问题：' + question]
          if (context) parts.push('【对话上下文（记忆）】' + context + '\n请结合上述上下文继续分析，保持口径一致。')
          parts.push(anchorLine)
          if (holdingsBlock) parts.push(holdingsBlock)
          if (historyBlock) parts.push(historyBlock)
          if (allCharts.size) {
            parts.push('【上游图表（同类图表直接引用其完整绝对路径，严禁重复生成同类图）】' + Array.from(allCharts).join(' , '))
          }
          for (const h of history) {
            parts.push('【' + h.stage + ' 产出（请基于其继续，勿重复取数已覆盖内容）】\n' + h.text)
          }
          parts.push('请按你的角色职责完成分析并输出完整结果。')
          const basePrompt = parts.join('\n\n')
          let lastErr = ''
          // 本阶段实际使用的模型路由（null = 不传 agentOptions，完整继承宿主会话）
          let route = chosenRoutes[s.code] || null
          for (let attempt = 1; attempt <= 2; attempt++) {
            const routeLabel = route ? formatRoute(route) : '继承宿主'
            try {
              const promptText = lastErr ? basePrompt + '\n\n【上次执行失败，错误信息】' + lastErr + '\n请修正后重试。' : basePrompt
              const run = await startStage(Object.assign({
                label: s.name + (attempt > 1 ? '(重试)' : ''),
                prompt: [{ type: 'text', text: promptText }],
                parent: exec.agent,
                signal: exec.signal,
                persona: resolveDir(s.persona),
                // 禁止阶段子代理递归：移除子代理/流水线/cordis 类工具
                toolFilter: {
                  deny: [
                    'invest_run', 'subagent_fork',
                    'send_message', 'interrupt_agent', 'list_agents',
                  ],
                },
              }, route ? { agentOptions: route } : {}))
              // 阶段超时兜底：8 分钟未结算则主动 dispose；stopReason=error 一律失败，半截报告不算成功
              const result = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                  try { Promise.resolve(run.dispose ? run.dispose() : null).catch(() => {}) } catch (e) { /* ignore */ }
                  reject(new Error('阶段执行超时（' + Math.round(STAGE_TIMEOUT_MS / 60000) + ' 分钟），已主动终止子代理'))
                }, STAGE_TIMEOUT_MS)
                Promise.resolve(run.result).then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
              })
              if (result && result.stopReason === 'error') {
                throw new Error('子代理执行失败（stopReason=error）' + (result.diagnostic ? '：' + String(result.diagnostic).slice(0, 200) : ''))
              }
              const both = extractBoth(result)
              const full = String(both.text)
              collectCharts(full).forEach(c => allCharts.add(c))
              return { stage: s.name, code: s.code, ok: true, elapsedMs: Date.now() - t0, route: routeLabel, text: full.slice(0, 9000), reasoning: String(both.reasoning).slice(0, 4000) }
            } catch (e) {
              lastErr = String(e).slice(0, 600)
              // 路由类错误：换回继承宿主后再试一次（不重试同一条坏路由）
              if (route && /UNKNOWN_PROVIDER|unknown provider|is not registered|UNSUPPORTED_REASONING_EFFORT|UNKNOWN_MODEL|INVALID_MODEL|INVALID_REASONING|not allowed/i.test(lastErr)) {
                routeNotes.push(s.name + '：运行时路由失败（' + String(e).slice(0, 120) + '），已降级继承宿主模型重试')
                route = null
                continue
              }
              // 失败分类：权限/频率类错误重试无意义，直接失败；其余（网络/超时/模型）重试
              const nonRetryable = /40203|429|RATE_LIMIT|exceeded_current_quota|credit balance|无权限|权限不足|超限|频率|quota|forbidden|unauthorized|unauthenticated/i.test(lastErr)
              if (nonRetryable || attempt === 2) {
                return { stage: s.name, code: s.code, ok: false, error: lastErr, elapsedMs: Date.now() - t0, retried: attempt > 1, route: routeLabel }
              }
            }
          }
          return { stage: s.name, code: s.code, ok: false, error: '未知失败', elapsedMs: Date.now() - t0, route: route ? formatRoute(route) : '继承宿主' }
        }
        for (let gi = 0; gi < groups.length; gi++) {
          const g = groups[gi]
          const groupLabel = g.map(x => x.name).join(' + ')
          setProgress({ stage: groupLabel, index: gi + 1, total: groups.length, status: 'running', done: outputs.filter(o => o.ok).map(o => ({ stage: o.stage, ms: o.elapsedMs, route: o.route })) })
          const results = await Promise.all(g.map(s => runStage(s)))
          for (const r of results) {
            outputs.push(r)
            if (r.ok) history.push({ stage: r.stage, text: r.text })
          }
          setProgress({ stage: groupLabel, index: gi + 1, total: groups.length, status: 'done', elapsedMs: results.reduce((a, r) => Math.max(a, r.elapsedMs || 0), 0), done: outputs.filter(o => o.ok).map(o => ({ stage: o.stage, ms: o.elapsedMs, route: o.route })) })
        }
        setProgress({ stage: '', index: groups.length, total: groups.length, status: 'final', done: outputs.filter(o => o.ok).map(o => ({ stage: o.stage, ms: o.elapsedMs, route: o.route })) })
        // 报告归档（显式携带会话 sandboxPolicy，否则 workspace-write 默认根不含工作区）
        let reportError = ''
        if (fs !== undefined) {
          try {
            const d = new Date()
            const stamp = localYmd() + '_' + z2(d.getHours()) + z2(d.getMinutes()) + z2(d.getSeconds()) + '_' + Math.random().toString(36).slice(2, 6)
            const qkey = String(question).replace(/[^\w\u4e00-\u9fa5]+/g, '_').slice(0, 16) || 'query'
            const reportPath = REPORTS_DIR + '/' + stamp + '_' + qkey + '.md'
            const lines = []
            lines.push('# 投研流水线报告')
            lines.push('')
            lines.push('- 模式：' + mode)
            lines.push('- 时间：' + stamp)
            lines.push('- 问题：' + question)
            if (context) { lines.push('- 上下文：' + context.slice(0, 200).replace(/\n/g, ' ')) }
            lines.push('- 模型路由：' + roleCodes.map((c) => c + '=' + formatRoute(chosenRoutes[c])).join(' ｜ '))
            for (const n of routeNotes) lines.push('- 路由提示：' + n)
            for (const o of outputs) {
              lines.push('')
              lines.push('## ' + o.stage + (o.ok ? '（' + (o.route || '继承宿主') + ' ｜ 耗时 ' + (o.elapsedMs / 1000).toFixed(1) + 's' + (o.retried ? '，含重试' : '') + '）' : '（失败 ｜ ' + (o.route || '继承宿主') + '）'))
              lines.push('')
              lines.push(o.ok ? o.text : ('错误：' + o.error))
              if (o.ok && o.reasoning) {
                lines.push('')
                lines.push('### 推理过程')
                lines.push('')
                lines.push(o.reasoning)
              }
            }
            if (allCharts.size) {
              lines.push('')
              lines.push('## 图表')
              for (const c of Array.from(allCharts)) lines.push('- ' + c)
            }
            lines.push('')
            lines.push('---')
            lines.push('仅供参考，不构成投资建议。')
            const target = await fs.resolve(reportPath)
            await fs.writeText(target, lines.join('\n'), undefined, undefined, policy)
            reports.push(reportPath)
            // 建议登记说明（v0.44.0 口径统一）：结构化结论由 persistConclusions 统一写入
            // .dsh-invest/store/conclusions.jsonl（两形态共用，工作台与工具调用都覆盖）。
            // 旧 advice_log.jsonl 行级登记自 v0.22.0 起从未在任何运行路径落过盘（实测文件不存在），
            // 属冗余死代码，已移除——避免一份机制两个数据源。
          } catch (e) {
            reportError = String(e).slice(0, 300)
          }
        } else {
          reportError = 'fs unavailable'
        }
        // 对外统一输出：invest-outputs/<时间戳>_<问题关键词>/（报告.md + 图表/ 副本）
        if (fs !== undefined) {
          try {
            const d = new Date()
            const stamp = localYmd() + '_' + z2(d.getHours()) + z2(d.getMinutes()) + z2(d.getSeconds()) + '_' + Math.random().toString(36).slice(2, 6)
            const qkey = String(question).replace(/[^\w\u4e00-\u9fa5]+/g, '_').slice(0, 16) || 'query'
            const outDir = OUTPUT_ROOT + '/' + stamp + '_' + qkey
            const outLines = []
            outLines.push('# 投研流水线报告')
            outLines.push('')
            outLines.push('- 模式：' + mode)
            outLines.push('- 时间：' + stamp)
            outLines.push('- 问题：' + question)
            if (context) { outLines.push('- 上下文：' + context.slice(0, 200).replace(/\n/g, ' ')) }
            outLines.push('- 模型路由：' + roleCodes.map((c) => c + '=' + formatRoute(chosenRoutes[c])).join(' ｜ '))
            for (const n of routeNotes) outLines.push('- 路由提示：' + n)
            for (const o of outputs) {
              outLines.push('')
              outLines.push('## ' + o.stage + (o.ok ? '（' + (o.route || '继承宿主') + ' ｜ 耗时 ' + (o.elapsedMs / 1000).toFixed(1) + 's' + (o.retried ? '，含重试' : '') + '）' : '（失败 ｜ ' + (o.route || '继承宿主') + '）'))
              outLines.push('')
              outLines.push(o.ok ? o.text : ('错误：' + o.error))
              if (o.ok && o.reasoning) {
                outLines.push('')
                outLines.push('### 推理过程')
                outLines.push('')
                outLines.push(o.reasoning)
              }
            }
            outLines.push('')
            outLines.push('## 图表')
            if (allCharts.size) {
              for (const c of Array.from(allCharts)) outLines.push('- ' + c)
            } else {
              outLines.push('（本轮无图表）')
            }
            outLines.push('')
            outLines.push('---')
            outLines.push('仅供参考，不构成投资建议。')
            const outReport = outDir + '/报告.md'
            const outTarget = await fs.resolve(outReport)
            await fs.writeText(outTarget, outLines.join('\n'), undefined, undefined, policy)
            // 复制本轮 SVG 图表到 图表/ 子目录（同名 basename）
            const chartNames = []
            for (const c of Array.from(allCharts)) {
              try {
                const src = await fs.resolve(c)
                const svg = await fs.readText(src)
                const base = String(c).split('/').pop()
                const dst = await fs.resolve(outDir + '/图表/' + base)
                await fs.writeText(dst, svg, undefined, undefined, policy)
                chartNames.push(base)
              } catch (e) { /* 单张图表复制失败不阻断 */ }
            }
            reports.push(outReport + (chartNames.length ? '（图表 ' + chartNames.length + ' 张）' : ''))
          } catch (e) {
            reportError = String(e).slice(0, 300)
          }
        }
        for (const c of roleCodes) routeMap[c] = formatRoute(chosenRoutes[c])
        await persistConclusions(mode, question, callId, outputs, reports, policy)
        return { mode, stages: outputs.map(o => o.stage), charts: Array.from(allCharts), reports, reportError, outputs, routes: routeMap, routeNotes }
        } finally {
          // 防内存泄漏：流水线结束（无论成败）即清理进度条目
          if (callId) delete progressStore[callId]
          // 结构化运行日志（尽力而为，失败不阻断主流程）
          try {
            if (fs !== undefined) {
              const logLine = JSON.stringify({
                ts: new Date().toISOString(),
                mode,
                question: String(question).slice(0, 200),
                callId,
                ok: outputs.length > 0 && outputs.every((o) => o.ok === true),
                elapsedMs: Date.now() - runStart,
                stages: outputs.map((o) => ({ stage: o.stage, ok: o.ok === true, ms: o.elapsedMs || 0, route: o.route || '继承宿主', error: o.ok ? '' : String(o.error || '').slice(0, 200) })),
                routes: routeMap,
                routeNotes,
                charts: allCharts.size,
                reports: reports.length,
              }) + '\n'
              const logTarget = await fs.resolve(RUNS_LOG)
              let existing = ''
              try { existing = await fs.readText(logTarget) } catch (e) { /* 首次不存在 */ }
              await fs.writeText(logTarget, existing + logLine, undefined, undefined, policy)
            }
          } catch (e) { /* ignore */ }
        }
      },
    })
    harness.registerTool(ctx, tool)

    // ---- invest_config：分析师模型路由配置（2026-10-23）----
    // 与 invest_run 同机制注册；读写工作区 routes.json（fs.readText/writeText 已有先例），
    // 使"每个分析师用什么模型"可在对话里直接调整（说"把总判断换成 glm-5.3"即由 agent 调用本工具）。
    const cfgTool = harness.defineTool({
      name: 'invest_config',
      description: '查看或修改 dsh-invest 分析师模型路由。action：show=查看当前各角色生效路由 / set=设置某角色模型（role+model，model 写 inherit 恢复继承宿主）/ preset=把预设档物化进 routes.json（可再用 set 微调单角色）。修改立即生效无需重启。View or update per-role model routing: show / set (role+model) / preset (inherit|budget|balanced|deepseek-only|quality).',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['show', 'set', 'preset'], description: 'show=查看 / set=设置单角色 / preset=物化预设档' },
        role: { type: 'string', description: 'set 用：角色名（选股/消息/深度/总判断/波段）' },
        model: { type: 'string', description: 'set 用：provider/model@effort（备选链用 | 分隔）或 inherit' },
        preset: { type: 'string', description: 'preset 用：inherit/budget/balanced/deepseek-only/quality' },
      }, required: ['action'] },
      output: {
        schema: { type: { type: "object" }, additionalProperties: true },
        render: (a, v) => text(Array.isArray(v.lines) ? v.lines.join('\n') : JSON.stringify(v)),
      },
      async execute(args, exec) {
        const fs2 = ctx.get('fs')
        const sp = ctx.get('sandboxPolicy')
        const policy2 = (sp !== undefined && exec.agent !== undefined) ? sp.resolve({ session: exec.agent.session }) : undefined
        const action = String(args.action || 'show')
        const readCur = async () => {
          try { const t = await fs2.resolve(ROUTES_FILE); return JSON.parse(await fs2.readText(t)) } catch (e) { return {} }
        }
        const writeCur = async (obj) => {
          const t = await fs2.resolve(ROUTES_FILE)
          await fs2.writeText(t, JSON.stringify(obj, null, 2), undefined, undefined, policy2)
        }
        const out = []
        if (action === 'show') {
          const cur = await readCur()
          const presetName = (typeof cur._preset === 'string' && cur._preset) || DEFAULT_PRESET
          const merged = mergeRoutes(presetName, PLUGIN_CONFIG.routes, cur)
          out.push('# dsh-invest 分析师模型路由 / Analyst model routing')
          out.push('')
          out.push('当前生效（preset=' + presetName + '，优先级：preset < 插件config < routes.json < env < 单次调用）：')
          for (const code of ROLE_CODES) out.push('- ' + code + ' → ' + formatRouteChain(merged[code]))
          out.push('')
          out.push('routes.json 现有内容：' + JSON.stringify(cur))
          out.push('')
          out.push('修改方式：调用本工具 action=set（如 role=总判断 model=zai-coding-cn/glm-5.3@max）；或 preset=quality 物化整档；或直接编辑 ' + ROUTES_FILE)
        } else if (action === 'set') {
          const role = String(args.role || '').trim()
          const model = String(args.model || '').trim()
          if (!ROLE_CODES.includes(role)) return text({ lines: ['未知角色：' + role + '（可选：' + ROLE_CODES.join('/') + '）/ unknown role'] })
          if (!model) return text({ lines: ['缺少 model 参数（provider/model@effort 或 inherit）/ missing model'] })
          const cur = await readCur()
          cur[role] = model
          try {
            await writeCur(cur)
            out.push('已设置 ' + role + ' = ' + model + '（立即生效）/ updated')
          } catch (e) {
            out.push('写入失败 / write failed: ' + String(e).slice(0, 200))
            out.push('请手动保存以下内容到 ' + ROUTES_FILE + '：')
            out.push(JSON.stringify(cur, null, 2))
          }
        } else if (action === 'preset') {
          const name = String(args.preset || '').trim()
          const presetObj = PRESETS[name]
          if (!presetObj) return text({ lines: ['未知档位 / unknown preset：' + name + '（可选：' + Object.keys(PRESETS).join('/') + '）'] })
          const cur = await readCur()
          for (const code of ROLE_CODES) cur[code] = presetObj[code]
          try {
            await writeCur(cur)
            out.push('已将 ' + name + ' 档物化到 routes.json（可再用 set 微调单角色）/ applied')
            for (const code of ROLE_CODES) out.push('- ' + code + ' → ' + presetObj[code])
          } catch (e) {
            out.push('写入失败 / write failed: ' + String(e).slice(0, 200))
            out.push('请手动保存以下内容到 ' + ROUTES_FILE + '：')
            out.push(JSON.stringify(cur, null, 2))
          }
        } else {
          out.push('未知 action / unknown action：' + action)
        }
        return { lines: out }
      },
    })
    harness.registerTool(ctx, cfgTool)
  },
}
