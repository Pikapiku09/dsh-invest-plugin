// dsh-invest Host 半部：invest_run 工具 + /api/dsh-invest 路由 + agent 指引
// 常规 Cordis 插件（profile bundle 挂载），所有会话可见
import z from "@deepseek-ai/schemastery"
import { defineTool } from "@deepseek-ai/dsh-tools"
import { DATA_BASE, P_SELECT, P_NEWS, P_DEEP, P_FINAL, P_SWING } from "./prompts.js"
import { extractBoth, collectCharts, buildGroups, isLoopbackRequest, isSafeServePath, extractInvestCodes, parseConclusionBlocks, z2, localYmd } from "./pure.js"
import { DEFAULT_PRESET, mergeRoutes, formatRoute, parseRoutesJson } from "./routes.js"

// 插件配置：路由预置档 + 按角色覆盖（写在 profile 的 cordis.patch.yml 的 - id: invest → config）
const Config = z.object({
  preset: z.string().default(DEFAULT_PRESET),
  routes: z.dict(z.any()).default({}),
})

// 角色定义：简码 → { code, 显示名, persona }（模块级常量，避免每次 execute 重建）
const R = (code, name, persona) => ({ code, name, persona })
const ROLE_MAP = {
  "选股": R("选股", "选股分析师", P_SELECT),
  "消息": R("消息", "市场重点消息获取师", P_NEWS),
  "深度": R("深度", "股票深度分析师", P_DEEP),
  "总判断": R("总判断", "总判断师", P_FINAL),
  "波段": R("波段", "波段池管理师", P_SWING),
}
// 默认角色组合（按 mode）
const DEFAULT_ROLES = {
  "个股": ["深度"],
  "选股": ["选股"],
  "消息": ["消息"],
  "深度分析": ["选股", "深度"],
  "总判断": ["选股", "消息", "深度", "总判断"],
  "波段池": ["波段"],
}

/** Stable cordis plugin name. */
const name = "invest"

/** Services required before the invest surfaces can mount. */
const inject = ["webServer", "tools", "systemPrompt", "subagents"]

/** Model-facing announcement: plugin presence, capabilities, and limits. */
const INVEST_GUIDANCE = "本机已安装 dsh-invest 插件（A 股多角色投研流水线）：invest_run 工具由 5 个角色子代理（选股分析师/市场重点消息获取师/股票深度分析师/总判断师/波段池管理师）用 Tushare 实时数据逐层分析，自动生成 SVG 图表并在 GUI 卡片内联显示（卡片可查看每个 Agent 的完整报告与推理过程）。参数：mode 按问题类型选择（见下）；question=投研问题（可含多只股票对比）；roles=可选的自定义角色组合（['选股','消息','深度','总判断','波段'] 的子集，如 ['深度','总判断']，省略则按 mode 默认）；context=上一轮结论（记忆与追问）；detail=summary（默认，模型侧摘要省 token）/full（模型侧全量）。【模式选择规则】① 单只/两只个股的深度分析、操作建议、值不值得买（问题已指定具体代码）→ mode=个股（仅股票深度分析师，最省时）；② 收集某标的/行业/市场消息 → mode=消息；③ 全市场海选、短线强势股/下周可买标的推荐、需要候选名单的扫描 → mode=选股；④ 多只股票对比、需要选股初筛+深度逐只 → mode=深度分析；⑤ 持仓复盘、市场全景、需要完整流水线与最终综合建议、不确定时 → mode=all（选股∥消息 → 深度 → 总判断）；⑥ 中长周期波段建池/波段池跟踪（持有 3 周-3 个月、持仓<5 只、非必要可空仓）→ mode=波段池。【角色选择规则】用户问题中明确列出了角色（如「用深度分析师和总判断师分析XX」）→ 必须按所列角色传 roles 组合执行，不得额外加角色；用户要求「让我选角色/自定义角色/勾选角色」→ 先用 ask_user_question 列出 5 个角色（多选）让用户选择，再按选择传 roles；用户没提角色 → 按模式选择规则默认执行。【触发】用户问任何与 A 股个股/持仓/板块/市场相关的分析、选股、买卖建议、消息面、深度诊断、多标的对比、持仓复盘、波段池建池/跟踪时，直接用 invest_run 执行，不要凭模型知识作答；数据锚定真实最新交易日，接口受限如实标注。用户提到「投研 / 选股 / 持仓分析 / 股票分析」时即指本插件，请据此协作。"

/** One JSON response. */
function writeJson(res, status, body) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

/** Query parameter helper. */
function queryParam(url, key) {
  const value = url.searchParams.get(key)
  return value === null ? void 0 : value
}

/**
 * Mount the invest engine, routes, tools, and announcement.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - optional plugin config: { preset, routes } for per-role model routing.
 */
function apply(ctx, config) {
  const progressStore = {}
  // 工作区基目录：默认 E:/Dsh_WorkSapce/Dify_Agents，可用 DSH_INVEST_BASE_DIR 覆盖
  const BASE_DIR = (typeof process !== "undefined" && process.env && process.env.DSH_INVEST_BASE_DIR) || "E:/Dsh_WorkSapce/Dify_Agents"
  const CACHE_DIR = BASE_DIR + "/.dsh-invest/cache"
  const TRADE_CACHE = CACHE_DIR + "/last-trade-date.json"
  const REPORTS_DIR = BASE_DIR + "/.dsh-invest/reports"
  const OUTPUT_ROOT = BASE_DIR + "/invest-outputs"
  const RUNS_LOG = BASE_DIR + "/.dsh-invest/runs.jsonl"
  const CHARTS_DIR = BASE_DIR + "/.dsh-invest/charts/"
  const MAX_CHARTS = 6
  // 提示词里的 {{BASE_DIR}} 占位符 → 实际基目录（token/缓存/图表路径）
  const resolveDir = (t) => String(t).split("{{BASE_DIR}}").join(BASE_DIR)
  // 模型路由配置：插件 config（cordis.patch.yml）与工作区覆盖文件
  const PLUGIN_CONFIG = (config && typeof config === "object") ? config : {}
  const ROUTES_FILE = BASE_DIR + "/.dsh-invest/routes.json"
  // 本地持仓账本（跨会话共享）：由 scripts/holdings.py 维护，invest_run 每次运行注入摘要
  const HOLDINGS_FILE = BASE_DIR + "/.dsh-invest/持仓.json"
  const REALTIME_SCRIPT = BASE_DIR + "/scripts/realtime_quote.py"
  // 工作台（P1 只读）：页面与索引文件（tools/index_store.py 生成，运行时读取，改页面无需改插件）
  const WEB_INDEX = BASE_DIR + "/.dsh-invest/web/index.html"
  const STORE_INDEX = BASE_DIR + "/.dsh-invest/store/index.json"
  const CONCLUSIONS_LOG = BASE_DIR + "/.dsh-invest/store/conclusions.jsonl"
  const WEB_DIST_DIR = BASE_DIR + "/.dsh-invest/web/dist"
  const WEB_DIST_INDEX = WEB_DIST_DIR + "/index.html"
  const WEB_DIST_JS = WEB_DIST_DIR + "/workbench.js"
  const WEB_DIST_CSS = WEB_DIST_DIR + "/workbench.css"

  // 读取账本 → 紧凑 Markdown 摘要（不存在/损坏时返回空串，绝不阻断流水线）
  const readHoldingsBlock = async () => {
    const fs = ctx.get("fs")
    if (fs === undefined) return ""
    try {
      const target = await fs.resolve(HOLDINGS_FILE)
      const d = JSON.parse(await fs.readText(target))
      const list = Array.isArray(d.positions) ? d.positions : []
      const acc = (d.account && typeof d.account === "object") ? d.account : {}
      if (!list.length && acc.total_asset === undefined && acc.cash === undefined) return ""
      const f = (v) => (v === null || v === undefined || v === "") ? "-" : (typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v))
      const out = []
      out.push("【当前持仓账本（" + HOLDINGS_FILE + "，更新于 " + f(d.updated_at) + "）】")
      if (acc.total_asset !== undefined || acc.cash !== undefined) {
        out.push("账户：总资产 " + f(acc.total_asset) + " ｜ 现金 " + f(acc.cash) + (acc.note ? " ｜ " + acc.note : ""))
      }
      if (list.length) {
        out.push("| 代码 | 名称 | 池 | 数量/仓位 | 成本 | 状态 | 止损 | 备注 |")
        out.push("|---|---|---|---|---|---|---|---|")
        for (const p of list.slice(0, 20)) {
          const qty = (p.shares !== undefined && p.shares !== null) ? String(p.shares)
            : ((p.weight_pct !== undefined && p.weight_pct !== null) ? p.weight_pct + "%" : "-")
          out.push("| " + p.code + " | " + f(p.name) + " | " + f(p.pool) + " | " + qty + " | " + f(p.cost) + " | " + f(p.status) + " | " + f(p.stop) + " | " + String(p.note || "").replace(/\n/g, " ").slice(0, 60) + " |")
        }
      }
      out.push("【账本使用规则】① 本账本只记录用户与 AI 确认过的实盘/纸面持仓，**不含 LihuQuantify 模拟盘（短线池）数据**，严禁把量化系统的模拟盘数字混进来；② 凡涉及个股/组合/加减仓/复盘，先按上表核对：是否已持有、成本与浮盈亏、止损位、仓位占比（数量×现价÷总资产）；③ 结论必须区分「已持有（加仓/减仓/持有）」与「新建仓」，账本外的标的按空仓处理；④ 用户在对话中口述持仓变动时，必须用 pwsh 执行 python \"" + BASE_DIR + "/scripts/holdings.py\" add/update 落账；⑤ 账本与用户口述冲突时以用户为准并明确提示差异，严禁编造账本外的持仓数字。")
      return out.join("\n")
    } catch (e) { return "" }
  }

  // P3：读取结构化结论事件日志（invest_run 每次运行追加）
  const readConclusionRecords = async () => {
    const fs = ctx.get("fs")
    if (fs === void 0) return []
    try {
      const raw = await fs.readText(await fs.resolve(CONCLUSIONS_LOG))
      const out = []
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue
        try { const j = JSON.parse(line); if (j && j.code) out.push(j) } catch (e) { /* 跳过坏行 */ }
      }
      return out
    } catch (e) { return [] }
  }

  const conclusionDays = (asof) => {
    const m = String(asof || "").match(/(\d{4})-?(\d{2})-?(\d{2})/)
    const c = String(localYmd()).match(/(\d{4})(\d{2})(\d{2})/)
    if (!m || !c) return "未知"
    const a = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    const b = Date.UTC(Number(c[1]), Number(c[2]) - 1, Number(c[3]))
    const d = Math.max(0, Math.round((b - a) / 86400000))
    return d === 0 ? "今天" : d + " 天前"
  }

  // P3：按问题中的代码（组合问题则按账本）注入最近一条历史结论，并强制做差异分析
  const readHistoryBlock = async (question, context, mode) => {
    let codes = extractInvestCodes(String(question || "") + " " + String(context || ""))
    if (!codes.length && /持仓|组合|复盘|波段|总判断|all/i.test(String(question || "") + " " + String(mode || ""))) {
      const fs = ctx.get("fs")
      if (fs !== void 0) {
        try {
          const h = JSON.parse(await fs.readText(await fs.resolve(HOLDINGS_FILE)))
          codes = (Array.isArray(h.positions) ? h.positions : []).map((p) => p.code).filter(Boolean)
        } catch (e) { /* ignore */ }
      }
    }
    if (!codes.length) return ""
    const structured = await readConclusionRecords()
    let backfill = []
    const fs = ctx.get("fs")
    if (fs !== void 0) {
      try { backfill = (JSON.parse(await fs.readText(await fs.resolve(STORE_INDEX))).records || []) } catch (e) { /* ignore */ }
    }
    const lines = []
    const val = (v) => (v === null || v === void 0 || v === "") ? "—" : String(v)
    for (const code of codes.slice(0, 5)) {
      const ss = structured.filter((r) => r.code === code)
      const bb = backfill.filter((r) => r.code === code)
      const rec = ss.length ? ss[ss.length - 1] : (bb.length ? bb[bb.length - 1] : null)
      if (!rec) continue
      const asof = rec.asof || String(rec.ts || "").slice(0, 10)
      lines.push(code + "｜上次 " + val(asof) + "（" + conclusionDays(asof) + "，" + val(rec.source) + "）：" + val(rec.stance)
        + "；目标 " + val(rec.target) + "；止损 " + val(rec.stop)
        + "；论据 " + val(rec.thesis).slice(0, 160)
        + (rec.invalidate_if ? "；失效条件 " + String(rec.invalidate_if).slice(0, 120) : ""))
    }
    if (!lines.length) return ""
    return "【历史结论记忆（自动注入）】\n以下历史结论只用于对照，不是当前事实；行情与指标必须重新取数。\n"
      + lines.join("\n")
      + "\n请先判断上次结论是否已兑现或失效，再明确写出本次与上次的**相同点、变化点及变化原因**；没有新证据不得简单重复历史结论。"
  }

  // P3：从最后一个含结构化结论的成功阶段落库（最多 3 个核心标的）
  const persistConclusions = async (mode, question, callId, outputs, reports, policy) => {
    const fs = ctx.get("fs")
    if (fs === void 0) return 0
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
      code: b.code, stance: b.stance || "未明",
      target: (typeof b.target === "number" ? b.target : null),
      stop: (typeof b.stop === "number" ? b.stop : null),
      thesis: String(b.thesis || "").slice(0, 200),
      invalidate_if: String(b.invalidate_if || "").slice(0, 200),
      stage: chosen.stage, report: reports[0] || null, source: "invest_run",
    }))
    try {
      const target = await fs.resolve(CONCLUSIONS_LOG)
      let existing = ""
      try { existing = await fs.readText(target) } catch (e) { /* 首次 */ }
      const prefix = existing && !existing.endsWith("\n") ? existing + "\n" : existing
      await fs.writeText(target, prefix + lines.join("\n") + "\n", void 0, void 0, policy)
      return lines.length
    } catch (e) { return 0 }
  }

  // 读取工作区路由覆盖文件（不存在/损坏 → undefined，绝不阻断流水线）
  const readRoutesFile = async () => {
    const fs = ctx.get("fs")
    if (fs === void 0) return void 0
    try {
      const target = await fs.resolve(ROUTES_FILE)
      return parseRoutesJson(await fs.readText(target))
    } catch (e) { return void 0 }
  }

  // 当日交易日锚点缓存（子代理写入，Host 读取注入）
  const readTradeCache = async () => {
    const fs = ctx.get("fs")
    if (fs === void 0) return null
    try {
      const target = await fs.resolve(TRADE_CACHE)
      const raw = await fs.readText(target)
      const obj = JSON.parse(raw)
      if (obj && typeof obj.trade_date === "string" && /^\d{8}$/.test(obj.trade_date) && obj.date === localYmd()) return obj.trade_date
    } catch (e) { /* ignore */ }
    return null
  }

  // P2：一键任务模板（question 中 {code}/{input} 由网页传入）
  const TASK_TEMPLATES = [
    { id: "stock-review", name: "个股体检", description: "六维诊断、目标价、止损与失效条件", mode: "个股", roles: ["深度"], needsCode: true, placeholder: "600519 或 600519.SH", question: "对 {code} 做个股体检：先对照历史结论与持仓账本，再给出趋势、估值、目标价、止损与失效条件。{input}" },
    { id: "portfolio-review", name: "组合体检", description: "按当前账本复盘持仓风险与加减仓优先级", mode: "总判断", roles: ["深度", "总判断"], needsCode: false, placeholder: "", question: "复盘当前持仓账本：逐只核对成本、趋势、止损与仓位风险，给出持有/加仓/减仓/离场优先级，并明确与上次结论的差异。{input}" },
    { id: "morning-news", name: "早盘异动", description: "扫描持仓和近期关注标的的消息与异动", mode: "消息", roles: ["消息"], needsCode: false, placeholder: "", question: "扫描当前持仓账本及近期关注标的的最新消息、政策和异动，按可信度与影响排序，标注需跟踪的风险。{input}" },
    { id: "swing-weekly", name: "波段周检", description: "复核三重共振、v2 出场与纸面买卖点", mode: "波段池", roles: ["波段"], needsCode: false, placeholder: "", question: "执行本周波段池周检：读取台账，复核池内标的三重共振与 v2 出场条件，记录纸面虚拟买卖点并更新台账；暂停实盘纪律不变。{input}" },
    { id: "earnings", name: "财报速读", description: "最新财务数据、盈利质量与估值位置", mode: "个股", roles: ["深度"], needsCode: true, placeholder: "代码 + 可选报告期", question: "速读 {code} 最新可得的财报与财务指标：增长、盈利质量、现金流、负债、估值分位与主要风险，给出结论和失效条件。{input}" },
  ]
  const jobStore = Object.create(null)
  const jobOrder = []
  const taskQueue = []
  let queueRunning = false
  let reindexPromise = null

  const readRequestJson = async (req) => {
    let text = ""
    for await (const chunk of req) {
      text += String(chunk)
      if (text.length > 65536) throw new Error("request body too large")
    }
    return text.trim() ? JSON.parse(text) : {}
  }

  const runReindex = () => {
    if (reindexPromise) return reindexPromise
    reindexPromise = (async () => {
      const { spawn } = await import("node:child_process")
      await new Promise((resolve, reject) => {
        const child = spawn("python", [BASE_DIR + "/tools/index_store.py"], { cwd: BASE_DIR, stdio: "ignore", windowsHide: true })
        const timer = setTimeout(() => { child.kill(); reject(new Error("index_store timeout")) }, 90000)
        child.on("error", (e) => { clearTimeout(timer); reject(e) })
        child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("index_store exit " + code)) })
      })
      const fs = ctx.get("fs")
      if (fs !== void 0) {
        try { return JSON.parse(await fs.readText(await fs.resolve(STORE_INDEX))).stats || {} } catch (e) { return {} }
      }
      return {}
    })().finally(() => { reindexPromise = null })
    return reindexPromise
  }

  const jobSummary = (job, full) => {
    const out = {
      id: job.id, templateId: job.templateId, name: job.name, status: job.status,
      question: job.question, createdAt: job.createdAt, startedAt: job.startedAt || 0,
      elapsedMs: job.elapsedMs || 0, error: job.error || "",
    }
    if (full) {
      out.progress = progressStore[job.id] || null
      if (job.result) out.result = {
        mode: job.result.mode, reports: job.result.reports || [], charts: job.result.charts || [],
        outputs: (job.result.outputs || []).map((o) => ({ stage: o.stage, ok: o.ok, elapsedMs: o.elapsedMs, route: o.route, error: o.error, text: String(o.text || "").slice(0, 6000) })),
      }
    }
    return out
  }

  const executeJob = async (job) => {
    job.status = "running"
    job.startedAt = Date.now()
    try {
      const agents = ctx.get("agents")
      const roots = agents && typeof agents.roots === "function" ? agents.roots() : []
      const parent = roots[roots.length - 1]
      if (!parent) throw new Error("当前没有可用的顶层 Agent；请先打开一个 DSH 会话再启动网页任务")
      const controller = new AbortController()
      job.abort = () => controller.abort()
      const result = await tool.execute({ mode: job.mode, question: job.question, roles: job.roles, detail: "full" }, { callId: job.id, agent: parent, signal: controller.signal })
      job.result = result
      const outs = Array.isArray(result.outputs) ? result.outputs : []
      job.status = result.error || (outs.length && outs.every((o) => !o.ok)) ? "failed" : "done"
      job.error = result.error || (outs.find((o) => !o.ok) || {}).error || ""
    } catch (e) {
      job.status = "failed"
      job.error = String(e).slice(0, 600)
    } finally {
      job.elapsedMs = Date.now() - job.startedAt
      job.abort = null
      try { job.reindexStats = await runReindex() } catch (e) { job.reindexError = String(e).slice(0, 200) }
    }
  }

  const pumpJobs = async () => {
    if (queueRunning) return
    queueRunning = true
    try {
      while (taskQueue.length) await executeJob(taskQueue.shift())
    } finally { queueRunning = false }
  }

  const enqueueJob = (template, code, custom) => {
    if (taskQueue.length >= 8) throw new Error("任务队列已满，请等待现有任务完成")
    const id = "job_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7)
    const question = template.question.replaceAll("{code}", code || "").replaceAll("{input}", custom ? "\n补充要求：" + custom : "")
    const job = { id, templateId: template.id, name: template.name, mode: template.mode, roles: template.roles, question, status: "queued", createdAt: Date.now(), elapsedMs: 0 }
    jobStore[id] = job
    jobOrder.push(id)
    if (jobOrder.length > 30) { const old = jobOrder.shift(); if (jobStore[old] && jobStore[old].status !== "running") delete jobStore[old] }
    taskQueue.push(job)
    void pumpJobs()
    return job
  }

  const routes = [
    {
      kind: "exact",
      path: "/api/dsh-invest/chart",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const url = new URL(req.url ?? "/", "http://localhost")
        const p = queryParam(url, "path") ?? ""
        if (!/\.svg$/i.test(p) || !p.startsWith(CHARTS_DIR)) { writeJson(res, 400, { error: "denied" }); return }
        const fs = ctx.get("fs")
        if (fs === void 0) { writeJson(res, 503, { error: "fs unavailable" }); return }
        try {
          const target = await fs.resolve(p)
          const svg = await fs.readText(target)
          if (svg.length > 160000) { writeJson(res, 413, { error: "too large" }); return }
          writeJson(res, 200, { path: p, svg })
        } catch (e) {
          writeJson(res, 500, { error: String(e).slice(0, 200) })
        }
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-invest/progress",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const url = new URL(req.url ?? "/", "http://localhost")
        const id = queryParam(url, "callId") ?? ""
        const p = id ? progressStore[id] : void 0
        if (p === void 0) { writeJson(res, 200, { none: true }); return }
        const out = {
          stage: typeof p.stage === "string" ? p.stage : "",
          index: typeof p.index === "number" ? p.index : 0,
          total: typeof p.total === "number" ? p.total : 0,
          status: typeof p.status === "string" ? p.status : "",
          done: Array.isArray(p.done) ? p.done : [],
          updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : 0,
        }
        if (typeof p.elapsedMs === "number") out.elapsedMs = p.elapsedMs
        writeJson(res, 200, out)
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/app",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { res.statusCode = 403; res.end("forbidden: loopback-only"); return }
        if (req.method !== "GET") { res.statusCode = 405; res.end("method not allowed"); return }
        const fs = ctx.get("fs")
        if (fs === void 0) { res.statusCode = 503; res.end("fs unavailable"); return }
        let html = ""
        try { html = await fs.readText(await fs.resolve(WEB_DIST_INDEX)) }
        catch (e) { html = await fs.readText(await fs.resolve(WEB_INDEX)) }
        res.statusCode = 200
        res.setHeader("content-type", "text/html; charset=utf-8")
        res.setHeader("cache-control", "no-store")
        res.end(html)
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/index",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const fs = ctx.get("fs")
        if (fs === void 0) { writeJson(res, 503, { error: "fs unavailable" }); return }
        try {
          const raw = await fs.readText(await fs.resolve(STORE_INDEX))
          writeJson(res, 200, JSON.parse(raw))
        } catch (e) { writeJson(res, 404, { error: "index not built: python tools/index_store.py" }) }
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/holdings",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const fs = ctx.get("fs")
        if (fs === void 0) { writeJson(res, 503, { error: "fs unavailable" }); return }
        try {
          const raw = await fs.readText(await fs.resolve(HOLDINGS_FILE))
          writeJson(res, 200, JSON.parse(raw))
        } catch (e) { writeJson(res, 200, { none: true }) }
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/report",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const url = new URL(req.url ?? "/", "http://localhost")
        const p = queryParam(url, "path") ?? ""
        const allowed = /.md$/i.test(p) && (isSafeServePath(p, REPORTS_DIR) || isSafeServePath(p, OUTPUT_ROOT))
        if (!allowed) { writeJson(res, 400, { error: "denied" }); return }
        const fs = ctx.get("fs")
        if (fs === void 0) { writeJson(res, 503, { error: "fs unavailable" }); return }
        try {
          const text = await fs.readText(await fs.resolve(p))
          if (text.length > 2000000) { writeJson(res, 413, { error: "too large" }); return }
          writeJson(res, 200, { path: p, text })
        } catch (e) { writeJson(res, 500, { error: String(e).slice(0, 200) }) }
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/workbench.js",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { res.statusCode = 403; res.end("forbidden"); return }
        if (req.method !== "GET") { res.statusCode = 405; res.end("method not allowed"); return }
        const fs = ctx.get("fs")
        try {
          const text = await fs.readText(await fs.resolve(WEB_DIST_JS))
          res.statusCode = 200
          res.setHeader("content-type", "text/javascript; charset=utf-8")
          res.setHeader("cache-control", "no-store")
          res.end(text)
        } catch (e) { res.statusCode = 404; res.end("workbench bundle not built") }
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/workbench.css",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { res.statusCode = 403; res.end("forbidden"); return }
        if (req.method !== "GET") { res.statusCode = 405; res.end("method not allowed"); return }
        const fs = ctx.get("fs")
        try {
          const text = await fs.readText(await fs.resolve(WEB_DIST_CSS))
          res.statusCode = 200
          res.setHeader("content-type", "text/css; charset=utf-8")
          res.setHeader("cache-control", "no-store")
          res.end(text)
        } catch (e) { res.statusCode = 404; res.end("workbench css not built") }
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/templates",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        writeJson(res, 200, { templates: TASK_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, mode: t.mode, roles: t.roles, needsCode: t.needsCode, placeholder: t.placeholder })) })
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/run",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          const template = TASK_TEMPLATES.find((t) => t.id === String(body.templateId || ""))
          if (!template) { writeJson(res, 400, { error: "unknown templateId" }); return }
          const code = String(body.code || "").trim().toUpperCase()
          if (template.needsCode && !/^\d{6}(?:\.(?:SH|SZ|BJ))?$/.test(code)) { writeJson(res, 400, { error: "请输入正确的 6 位股票代码" }); return }
          const custom = String(body.question || "").trim().slice(0, 500)
          const job = enqueueJob(template, code, custom)
          writeJson(res, 202, { jobId: job.id })
        } catch (e) { writeJson(res, 400, { error: String(e).slice(0, 300) }) }
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/job",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const url = new URL(req.url ?? "/", "http://localhost")
        const job = jobStore[queryParam(url, "id") || ""]
        if (!job) { writeJson(res, 404, { error: "job not found" }); return }
        writeJson(res, 200, jobSummary(job, true))
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/jobs",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const jobs = jobOrder.slice().reverse().slice(0, 20).map((id) => jobStore[id]).filter(Boolean).map((j) => jobSummary(j, false))
        writeJson(res, 200, { jobs })
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/reindex",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try { const stats = await runReindex(); writeJson(res, 200, { ok: true, stats }) }
        catch (e) { writeJson(res, 500, { error: String(e).slice(0, 300) }) }
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/conclusions",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const url = new URL(req.url ?? "/", "http://localhost")
        const code = queryParam(url, "code") || ""
        let records = await readConclusionRecords()
        if (code) records = records.filter((r) => r.code === code)
        if (!records.length && code) {
          const fs = ctx.get("fs")
          if (fs !== void 0) {
            try { records = (JSON.parse(await fs.readText(await fs.resolve(STORE_INDEX))).records || []).filter((r) => r.code === code) } catch (e) { /* ignore */ }
          }
        }
        writeJson(res, 200, { records: records.slice(-100) })
      },
    },
  ]

  const tool = defineTool({
    name: "invest_run",
    description: "运行多角色投研流水线。mode：个股（单只股票深度分析，最常用）/选股（全市场海选）/消息（消息面收集）/深度分析（选股+深度）/总判断/all（完整流水线）/波段池（中长周期波段建池与跟踪，持有 3 周-3 个月，持仓<5 只，可空仓）。question 为用户投研问题（可含多只股票）；roles 可选：自定义角色组合（如 ['深度','总判断']，省略则按 mode 默认）；context 可选，传入上一轮分析结论或追问背景（记忆与追问）；detail 可选：full=模型侧全量输出（token 多），summary=摘要输出省 token（默认，GUI 卡片始终显示完整报告）。routes/preset 可选：按角色覆盖模型路由（默认 balanced：选股/消息=deepseek-flash，深度=deepseek-v4-pro，总判断=glm-5.3，失败自动回退）。数据用 Tushare 实时获取。",
    parameters: {
      mode: { type: "string", description: "运行模式", required: true },
      question: { type: "string", description: "用户投研问题（可含多只股票）", required: true },
      roles: { type: "array", items: { type: "string" }, description: "可选：自定义角色组合，取值 ['选股','消息','深度','总判断','波段'] 的子集（如 ['深度','总判断']）；省略则按 mode 默认角色。用户问题中明确列出角色时按所列角色执行；用户要求选择角色时用 ask_user_question 询问后再传" },
      context: { type: "string", description: "可选：上一轮分析结论/追问背景，让本轮分析有记忆" },
      routes: { type: "object", additionalProperties: true, description: "可选：按角色覆盖模型路由，形如 {\"总判断\":\"zai-coding-cn/glm-5.3@max\"}；值为 provider/model@effort，可用 \"a|b\" 写备选链，写 \"inherit\" 表示继承宿主模型；省略则用插件默认路由表" },
      preset: { type: "string", description: "可选：路由预置档 inherit/budget/balanced/deepseek-only/quality，默认 balanced" },
      detail: { type: "string", description: "可选：full=模型侧全量（token 多）/ summary=摘要省 token（默认）。不影响 GUI 卡片，卡片始终显示完整报告与推理" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => {
        const detail = args && args.detail === "full" ? "full" : "summary"
        const LIMIT = detail === "full" ? 9000 : 2500
        const lines = []
        const outputs = Array.isArray(value.outputs) ? value.outputs : []
        const charts = Array.isArray(value.charts) ? value.charts.slice(0, MAX_CHARTS) : []
        const reports = Array.isArray(value.reports) ? value.reports : []
        if (value.error) lines.push("错误：" + String(value.error))
        lines.push("invest_run 模式=" + String(value.mode || "") + " ｜ 阶段数=" + outputs.length + (charts.length ? " ｜ 图表=" + charts.length + " 张" : "") + (reports.length ? " ｜ 报告已归档" : "") + " ｜ detail=" + detail)
        for (const o of outputs) {
          lines.push("")
          lines.push("=== " + o.stage + " ｜ " + (o.route || "继承宿主") + (o.ok ? " ｜ 耗时 " + (o.elapsedMs / 1000).toFixed(1) + "s" : " ｜ 失败") + " ===")
          if (o.error) lines.push("错误：" + o.error)
          if (o.ok && typeof o.text === "string") {
            const t = o.text
            lines.push(t.length > LIMIT ? t.slice(0, LIMIT) + (detail === "summary" ? "\n…（完整报告见 GUI 卡片或归档文件）" : "") : t)
          }
        }
        if (charts.length) {
          lines.push("")
          lines.push("图表文件：" + charts.join(" , "))
        }
        if (reports.length) {
          lines.push("")
          lines.push("报告归档：" + reports.join(" , "))
        }
        if (value.reportError) lines.push("归档错误：" + value.reportError)
        return [{ type: "text", text: lines.join("\n") }]
      },
      presentationMeta: (args, value) => ({
        mode: String(value.mode || ""),
        charts: (Array.isArray(value.charts) ? value.charts.slice(0, MAX_CHARTS) : []).map((p) => ({ path: String(p) })),
        stages: (Array.isArray(value.outputs) ? value.outputs : []).map((o) => ({ stage: o.stage, code: typeof o.code === "string" ? o.code : "", ok: o.ok === true, elapsedMs: o.elapsedMs, route: typeof o.route === "string" ? o.route : "", text: typeof o.text === "string" ? o.text : "", reasoning: typeof o.reasoning === "string" ? o.reasoning : "" })),
        routes: (value.routes && typeof value.routes === "object") ? value.routes : {},
        routeNotes: Array.isArray(value.routeNotes) ? value.routeNotes.slice(0, 8) : [],
      }),
    },
    async execute(args, exec) {
      const mode = args.mode
      const question = args.question
      const context = typeof args.context === "string" && args.context.trim() ? args.context.trim().slice(0, 4000) : ""
      const callId = String(exec.callId || "")
      const runStart = Date.now()
      let outputs = []
      let allCharts = new Set()
      let reports = []
      let routeMap = {}
      let routeNotes = []
      // 沙箱策略提前解析（报告归档与运行日志共用）
      const fs = ctx.get("fs")
      const sp = ctx.get("sandboxPolicy")
      const policy = (sp !== void 0 && exec.agent !== void 0) ? sp.resolve({ session: exec.agent.session }) : void 0
      try {
      // 2026-10-28 修复（第二版）：插件已在 inject 中声明 subagents，属性访问 ctx.subagents 取得的才是
      // 带 start() 的运行时（与宿主 dsh-tool-subagent 的 runtimeCtx.subagents 同源）；ctx.get() 取到的形态不带 start()。
      // 候选顺序：属性访问 → ctx.get(n, true) → ctx.get(n, false)，取第一个带 start() 的实例；
      // 都不可用时把探测到的键名写进错误便于定位。
      const candidatesOf = (n) => {
        const out = []
        try { out.push(ctx[n]) } catch (e) { /* 未声明 inject 时会抛错，忽略 */ }
        if (typeof ctx.get === "function") {
          try { out.push(ctx.get(n, true)) } catch (e) { /* 忽略 */ }
          try { out.push(ctx.get(n, false)) } catch (e) { /* 忽略 */ }
        }
        return out.filter((x) => x)
      }
      const allCands = candidatesOf("subagents").concat(candidatesOf("subagent"))
      // 2026-10-29 修复（第三版）：DSH 宿主 subagent 运行时换代——新宿主以 startActivation() 取代 start()。
      // 新契约：startActivation({provider,label,request,signal,delivery}) →
      //   { childId, result: Promise<{output:[{type:'text'|'reasoning',text}], stopReason}>, dispose }
      // result.output 与 extractBoth 的解析口径兼容，可直接复用。
      // 新 provider 能力集 = {agentOptions,agentPreset,outputSchema,depthLimit}：不支持旧字段
      // persona/toolFilter → 角色设定注入 prompt，递归用 maxDepth=0 阻断。
      const nativeStart = allCands.find((x) => typeof x.start === "function")
      const activationHost = allCands.find((x) => typeof x.startActivation === "function")
      if (nativeStart === void 0 && activationHost === void 0) {
        const probe = allCands[0]
        const keys = probe ? Object.keys(probe).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(probe) || {})) : []
        return { error: "subagents not mounted（start()/startActivation() 均不可用）；候选 " + allCands.length + " 个；探测键名: " + keys.join(",") + "；ctx.get 类型: " + (typeof ctx.get) }
      }
      // 统一入口：旧宿主走原生 start()；新宿主翻译为 startActivation（返回同形状 {result,...}）
      const startStage = async (spec) => {
        if (nativeStart !== void 0) return nativeStart.start("spawn", spec)
        const plain = Array.isArray(spec.prompt)
          ? spec.prompt.map((b) => (b && b.text) || "").join("\n")
          : String(spec.prompt || "")
        const text = spec.persona ? "【角色设定】\n" + spec.persona + "\n\n" + plain : plain
        // maxDepth 不显式传：继承宿主设置（默认 1 = 本级允许、孙代被拒，等效旧的“禁止递归”）。
        // 实测 maxDepth:0 表示“禁止本级”——子代深度 1 会直接 SubagentDepthError。
        const request = { prompt: [{ type: "text", text }], parent: spec.parent }
        if (spec.agentOptions) request.agentOptions = spec.agentOptions
        const call = (delivery) => activationHost.startActivation({
          provider: "spawn",
          label: spec.label,
          request,
          signal: spec.signal,
          delivery,
        })
        let act
        try {
          act = await call("caller")   // 程序化调用方语义：不向父会话投递完成通知
        } catch (e) {
          if (/delivery|caller|UNSUPPORTED/i.test(String(e))) act = await call("parent")
          else throw e
        }
        return { result: act.result, childId: act.childId, dispose: act.dispose }
      }
      let roleCodes
      if (Array.isArray(args.roles) && args.roles.length) {
        roleCodes = args.roles.filter((r) => ROLE_MAP[r])
        if (!roleCodes.length) return { error: "无效的角色列表：" + JSON.stringify(args.roles) + "，可选：选股/消息/深度/总判断/波段" }
      } else {
        roleCodes = DEFAULT_ROLES[mode] || DEFAULT_ROLES["总判断"]
      }
      const groups = buildGroups(roleCodes, ROLE_MAP)
      // ---- 模型路由解析：preset ← 插件 config ← .dsh-invest/routes.json ← 环境变量 ← 单次调用参数 ----
      const llm = ctx.get("llm")
      const presetName = (typeof args.preset === "string" && args.preset)
        || (typeof PLUGIN_CONFIG.preset === "string" && PLUGIN_CONFIG.preset)
        || (typeof process !== "undefined" && process.env && process.env.DSH_INVEST_PRESET)
        || DEFAULT_PRESET
      const roleRoutes = mergeRoutes(
        presetName,
        PLUGIN_CONFIG.routes,
        await readRoutesFile(),
        parseRoutesJson(typeof process !== "undefined" && process.env ? process.env.DSH_INVEST_ROUTES : void 0),
        parseRoutesJson(args.routes),
      )
      // 逐角色预检（provider 注册/模型存在/effort 支持），不可用即降级；绝不阻断流水线
      const chosenRoutes = {}
      for (const code of roleCodes) {
        const chain = Array.isArray(roleRoutes[code]) ? roleRoutes[code] : []
        if (!chain.length) { chosenRoutes[code] = null; continue }
        if (llm === void 0) {
          routeNotes.push(code + "：llm 服务不可用，已回退继承宿主模型")
          chosenRoutes[code] = null
          continue
        }
        let picked = null
        for (let i = 0; i < chain.length; i++) {
          const r = chain[i]
          try {
            await llm.resolveCallConfig(Object.assign({ provider: r.provider, model: r.model }, r.reasoningEffort ? { reasoningEffort: r.reasoningEffort } : {}), exec.signal)
            picked = r
            if (i > 0) routeNotes.push(code + "：首选不可用，已切换备选 " + formatRoute(r))
            break
          } catch (e) {
            routeNotes.push(code + "：" + formatRoute(r) + " 预检失败（" + String(e).slice(0, 140) + "）")
          }
        }
        if (!picked) routeNotes.push(code + "：全部路由预检失败，已回退继承宿主模型")
        chosenRoutes[code] = picked
      }
      const setProgress = (p) => { progressStore[callId] = Object.assign({ updatedAt: Date.now() }, p) }
      setProgress({ stage: "", index: 0, total: groups.length, status: "init", done: [] })
      const anchor = await readTradeCache()
      const realtimeLine = "【实时行情兜底（腾讯财经）】若 TuShare 返回的最新交易日早于今日、且当前处于交易日 09:30–15:00（含午休），必须先用 pwsh 执行 python \"" + REALTIME_SCRIPT + "\" <代码1> <代码2> 取腾讯实时价（JSON），并在正文以 [实时·腾讯 HH:MM] 与 [日线·TuShare YYYYMMDD] 双标注；技术指标（MA/MACD/九转/周线）仍必须用 TuShare 日线收盘计算，实时价只作盘中参考，严禁混用。非交易时段或 TuShare 已是最新交易日时不必调用。"
      const anchorLine = (anchor
        ? "【已缓存锚定】真实最新交易日 = " + anchor + "（由流水线缓存提供，跳过 index_daily 锚定步骤，直接按此日期取数）"
        : "【交易日缓存为空】按日期锚定铁律完成 index_daily 锚定后，用 pwsh 执行 node -e 把 JSON {\"date\":\"" + localYmd() + "\",\"trade_date\":\"你的锚定结果YYYYMMDD\"} 写入 " + TRADE_CACHE + "（目录不存在先创建），供本日后续运行复用") + "\n" + realtimeLine
      const history = []
      const holdingsBlock = await readHoldingsBlock()
      const historyBlock = await readHistoryBlock(question, context, mode)
      const runStage = async (s) => {
        const t0 = Date.now()
        const parts = ["用户问题：" + question]
        if (context) parts.push("【对话上下文（记忆）】" + context + "\n请结合上述上下文继续分析，保持口径一致。")
        parts.push(anchorLine)
        if (holdingsBlock) parts.push(holdingsBlock)
        if (historyBlock) parts.push(historyBlock)
        if (allCharts.size) {
          parts.push("【上游图表（同类图表直接引用其完整绝对路径，严禁重复生成同类图）】" + Array.from(allCharts).join(" , "))
        }
        for (const h of history) {
          parts.push("【" + h.stage + " 产出（请基于其继续，勿重复取数已覆盖内容）】\n" + h.text)
        }
        parts.push("请按你的角色职责完成分析并输出完整结果。")
        const basePrompt = parts.join("\n\n")
        let lastErr = ""
        // 本阶段实际使用的模型路由（null = 不传 agentOptions，完整继承宿主会话）
        let route = chosenRoutes[s.code] || null
        for (let attempt = 1; attempt <= 2; attempt++) {
          const routeLabel = route ? formatRoute(route) : "继承宿主"
          try {
            const promptText = lastErr ? basePrompt + "\n\n【上次执行失败，错误信息】" + lastErr + "\n请修正后重试。" : basePrompt
            const run = await startStage(Object.assign({
              label: s.name + (attempt > 1 ? "(重试)" : ""),
              prompt: [{ type: "text", text: promptText }],
              parent: exec.agent,
              signal: exec.signal,
              persona: resolveDir(s.persona),
              // 关键：禁止阶段子代理递归——移除所有子代理/流水线/cordis 类工具，
              // 子代理只能用自己的 pwsh/read 等取数工具，不能再 spawn 子代理或调用 invest_run
              toolFilter: {
                deny: [
                  "invest_run", "subagent_fork",
                  "send_message", "interrupt_agent", "list_agents",
                ],
              },
            }, route ? { agentOptions: route } : {}))
            const result = await run.result
            // 新宿主 seam：子代理失败以 {stopReason:'error', output:[]} 返回（不 reject），显式转错误以触发重试
            if (result && result.stopReason === "error" && !(Array.isArray(result.output) && result.output.length)) {
              throw new Error("子代理执行失败（stopReason=error）" + (result.diagnostic ? "：" + String(result.diagnostic).slice(0, 200) : ""))
            }
            const both = extractBoth(result)
            const full = String(both.text)
            collectCharts(full).forEach((c) => allCharts.add(c))
            return { stage: s.name, code: s.code, ok: true, elapsedMs: Date.now() - t0, route: routeLabel, text: full.slice(0, 9000), reasoning: String(both.reasoning).slice(0, 4000) }
          } catch (e) {
            lastErr = String(e).slice(0, 600)
            // 路由类错误：换回继承宿主后再试一次（不重试同一条坏路由）
            if (route && /UNKNOWN_PROVIDER|unknown provider|is not registered|UNSUPPORTED_REASONING_EFFORT|UNKNOWN_MODEL|INVALID_MODEL|INVALID_REASONING|not allowed/i.test(lastErr)) {
              routeNotes.push(s.name + "：运行时路由失败（" + String(e).slice(0, 120) + "），已降级继承宿主模型重试")
              route = null
              continue
            }
            const nonRetryable = /40203|无权限|权限不足|超限|频率|quota|forbidden|unauthorized|unauthenticated/i.test(lastErr)
            if (nonRetryable || attempt === 2) {
              return { stage: s.name, code: s.code, ok: false, error: lastErr, elapsedMs: Date.now() - t0, retried: attempt > 1, route: routeLabel }
            }
          }
        }
        return { stage: s.name, code: s.code, ok: false, error: "未知失败", elapsedMs: Date.now() - t0, route: route ? formatRoute(route) : "继承宿主" }
      }
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi]
        const groupLabel = g.map((x) => x.name).join(" + ")
        setProgress({ stage: groupLabel, index: gi + 1, total: groups.length, status: "running", done: outputs.filter((o) => o.ok).map((o) => ({ stage: o.stage, ms: o.elapsedMs, route: o.route })) })
        const results = await Promise.all(g.map((s) => runStage(s)))
        for (const r of results) {
          outputs.push(r)
          if (r.ok) history.push({ stage: r.stage, text: r.text })
        }
        setProgress({ stage: groupLabel, index: gi + 1, total: groups.length, status: "done", elapsedMs: results.reduce((a, r) => Math.max(a, r.elapsedMs || 0), 0), done: outputs.filter((o) => o.ok).map((o) => ({ stage: o.stage, ms: o.elapsedMs, route: o.route })) })
      }
      setProgress({ stage: "", index: groups.length, total: groups.length, status: "final", done: outputs.filter((o) => o.ok).map((o) => ({ stage: o.stage, ms: o.elapsedMs, route: o.route })) })
      // 报告归档（显式携带会话 sandboxPolicy，否则 workspace-write 默认根不含工作区）
      let reportError = ""
      if (fs !== void 0) {
        try {
          const d = new Date()
          const stamp = localYmd() + "_" + z2(d.getHours()) + z2(d.getMinutes()) + z2(d.getSeconds()) + "_" + Math.random().toString(36).slice(2, 6)
          const qkey = String(question).replace(/[^\w\u4e00-\u9fa5]+/g, "_").slice(0, 16) || "query"
          const reportPath = REPORTS_DIR + "/" + stamp + "_" + qkey + ".md"
          const lines = []
          lines.push("# 投研流水线报告")
          lines.push("")
          lines.push("- 模式：" + mode)
          lines.push("- 时间：" + stamp)
          lines.push("- 问题：" + question)
          if (context) { lines.push("- 上下文：" + context.slice(0, 200).replace(/\n/g, " ")) }
          lines.push("- 模型路由：" + roleCodes.map((c) => c + "=" + formatRoute(chosenRoutes[c])).join(" ｜ "))
          for (const n of routeNotes) lines.push("- 路由提示：" + n)
          for (const o of outputs) {
            lines.push("")
            lines.push("## " + o.stage + (o.ok ? "（" + (o.route || "继承宿主") + " ｜ 耗时 " + (o.elapsedMs / 1000).toFixed(1) + "s" + (o.retried ? "，含重试" : "") + "）" : "（失败 ｜ " + (o.route || "继承宿主") + "）"))
            lines.push("")
            lines.push(o.ok ? o.text : ("错误：" + o.error))
            if (o.ok && o.reasoning) {
              lines.push("")
              lines.push("### 推理过程")
              lines.push("")
              lines.push(o.reasoning)
            }
          }
          if (allCharts.size) {
            lines.push("")
            lines.push("## 图表")
            for (const c of Array.from(allCharts)) lines.push("- " + c)
          }
          lines.push("")
          lines.push("---")
          lines.push("仅供参考，不构成投资建议。")
          const target = await fs.resolve(reportPath)
          await fs.writeText(target, lines.join("\n"), void 0, void 0, policy)
          reports.push(reportPath)
        } catch (e) {
          reportError = String(e).slice(0, 300)
        }
      } else {
        reportError = "fs unavailable"
      }
      // 对外统一输出：invest-outputs/<时间戳>_<问题关键词>/（报告.md + 图表/ 副本）
      if (fs !== void 0) {
        try {
          const d = new Date()
          const stamp = localYmd() + "_" + z2(d.getHours()) + z2(d.getMinutes()) + z2(d.getSeconds()) + "_" + Math.random().toString(36).slice(2, 6)
          const qkey = String(question).replace(/[^\w\u4e00-\u9fa5]+/g, "_").slice(0, 16) || "query"
          const outDir = OUTPUT_ROOT + "/" + stamp + "_" + qkey
          const outLines = []
          outLines.push("# 投研流水线报告")
          outLines.push("")
          outLines.push("- 模式：" + mode)
          outLines.push("- 时间：" + stamp)
          outLines.push("- 问题：" + question)
          if (context) { outLines.push("- 上下文：" + context.slice(0, 200).replace(/\n/g, " ")) }
          outLines.push("- 模型路由：" + roleCodes.map((c) => c + "=" + formatRoute(chosenRoutes[c])).join(" ｜ "))
          for (const n of routeNotes) outLines.push("- 路由提示：" + n)
          for (const o of outputs) {
            outLines.push("")
            outLines.push("## " + o.stage + (o.ok ? "（" + (o.route || "继承宿主") + " ｜ 耗时 " + (o.elapsedMs / 1000).toFixed(1) + "s" + (o.retried ? "，含重试" : "") + "）" : "（失败 ｜ " + (o.route || "继承宿主") + "）"))
            outLines.push("")
            outLines.push(o.ok ? o.text : ("错误：" + o.error))
            if (o.ok && o.reasoning) {
              outLines.push("")
              outLines.push("### 推理过程")
              outLines.push("")
              outLines.push(o.reasoning)
            }
          }
          outLines.push("")
          outLines.push("## 图表")
          if (allCharts.size) {
            for (const c of Array.from(allCharts)) outLines.push("- " + c)
          } else {
            outLines.push("（本轮无图表）")
          }
          outLines.push("")
          outLines.push("---")
          outLines.push("仅供参考，不构成投资建议。")
          const outReport = outDir + "/报告.md"
          const outTarget = await fs.resolve(outReport)
          await fs.writeText(outTarget, outLines.join("\n"), void 0, void 0, policy)
          // 复制本轮 SVG 图表到 图表/ 子目录（同名 basename）
          const chartNames = []
          for (const c of Array.from(allCharts)) {
            try {
              const src = await fs.resolve(c)
              const svg = await fs.readText(src)
              const base = String(c).split("/").pop()
              const dst = await fs.resolve(outDir + "/图表/" + base)
              await fs.writeText(dst, svg, void 0, void 0, policy)
              chartNames.push(base)
            } catch (e) { /* 单张图表复制失败不阻断 */ }
          }
          reports.push(outReport + (chartNames.length ? "（图表 " + chartNames.length + " 张）" : ""))
        } catch (e) {
          reportError = String(e).slice(0, 300)
        }
      }
      for (const c of roleCodes) routeMap[c] = formatRoute(chosenRoutes[c])
      await persistConclusions(mode, question, callId, outputs, reports, policy)
      return { mode, stages: outputs.map((o) => o.stage), charts: Array.from(allCharts), reports, reportError, outputs, routes: routeMap, routeNotes }
      } finally {
        // 防内存泄漏：流水线结束（无论成败）即清理进度条目
        if (callId) delete progressStore[callId]
        // 结构化运行日志（尽力而为，失败不阻断主流程）
        try {
          if (fs !== void 0) {
            const logLine = JSON.stringify({
              ts: new Date().toISOString(),
              mode,
              question: String(question).slice(0, 200),
              callId,
              ok: outputs.length > 0 && outputs.every((o) => o.ok === true),
              elapsedMs: Date.now() - runStart,
              stages: outputs.map((o) => ({ stage: o.stage, ok: o.ok === true, ms: o.elapsedMs || 0, route: o.route || "继承宿主" })),
              routes: routeMap,
              routeNotes,
              charts: allCharts.size,
              reports: reports.length,
            }) + "\n"
            const logTarget = await fs.resolve(RUNS_LOG)
            let existing = ""
            try { existing = await fs.readText(logTarget) } catch (e) { /* 首次不存在 */ }
            await fs.writeText(logTarget, existing + logLine, void 0, void 0, policy)
          }
        } catch (e) { /* ignore */ }
      }
    },
  })

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, "dsh-invest: routes")

  ctx.effect(() => {
    const dispose = ctx.tools.register(tool)
    return () => { dispose() }
  }, "dsh-invest: tools")

  ctx.systemPrompt.section({
    name: "plugin:dsh-invest",
    order: 150,
    text: INVEST_GUIDANCE,
  })
}

export { name, inject, apply, Config }
