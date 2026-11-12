// dsh-invest Host 半部：invest_run 工具 + /api/dsh-invest 路由 + agent 指引
// 常规 Cordis 插件（profile bundle 挂载），所有会话可见
// 宿主私有包（schemastery / dsh-tools）走可选导入：见 host-deps.js（干净 clone / 测试环境缺包时自动降级）
import { z, defineTool } from "./host-deps.js"
import { promises as fsp } from "node:fs"
import { DATA_BASE, P_SELECT, P_NEWS, P_DEEP, P_FINAL, P_SWING, P_SUMMARY } from "./prompts.js"
import { extractBoth, collectCharts, buildGroups, isLoopbackRequest, isSafeServePath, extractInvestCodes, parseConclusionBlocks, parseEastmoneyCsv, z2, localYmd } from "./pure.js"
import { DEFAULT_PRESET, PRESETS, ROLE_CODES, mergeRoutes, formatRoute, formatRouteChain, parseRoute, parseRouteList, parseRoutesJson } from "./routes.js"
import { buildStockNotes, normalizeCode, stockFileName } from "./stock-notes.js"
import { buildCuratePrompt, sanitizeCurated, validateCurated, rawTimelineMarkdown } from "./stock-curator.js"

// 插件配置：路由预置档 + 按角色覆盖（写在 profile 的 cordis.patch.yml 的 - id: invest → config）
const Config = z.object({
  preset: z.string().default(DEFAULT_PRESET),
  routes: z.dict(z.any()).default({}),
  // 报告二次总结（观点先行 + 去重压缩）；false 或环境变量 DSH_INVEST_SUMMARY=0 可关闭
  summary: z.boolean().default(true),
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
const INVEST_GUIDANCE = "本机已安装 dsh-invest 插件（A 股多角色投研流水线）：invest_run 工具由 5 个角色子代理（选股分析师/市场重点消息获取师/股票深度分析师/总判断师/波段池管理师）用 Tushare 实时数据逐层分析，自动生成 SVG 图表并在 GUI 卡片内联显示（卡片可查看每个 Agent 的完整报告与推理过程）。参数：mode 按问题类型选择（见下）；question=投研问题（可含多只股票对比）；roles=可选的自定义角色组合（['选股','消息','深度','总判断','波段'] 的子集，如 ['深度','总判断']，省略则按 mode 默认）；context=上一轮结论（记忆与追问）；detail=summary（默认，模型侧摘要省 token）/full（模型侧全量）。【模式选择规则】① 单只/两只个股的深度分析、操作建议、值不值得买（问题已指定具体代码）→ mode=个股（仅股票深度分析师，最省时）；② 收集某标的/行业/市场消息 → mode=消息；③ 全市场海选、短线强势股/下周可买标的推荐、需要候选名单的扫描 → mode=选股；④ 多只股票对比、需要选股初筛+深度逐只 → mode=深度分析；⑤ 持仓复盘、市场全景、需要完整流水线与最终综合建议、不确定时 → mode=all（选股∥消息 → 深度 → 总判断）；⑥ 中长周期波段建池/波段池跟踪（持有 3 周-6 个月、持仓≤4 只、非必要可空仓）→ mode=波段池。【角色选择规则】用户问题中明确列出了角色（如「用深度分析师和总判断师分析XX」）→ 必须按所列角色传 roles 组合执行，不得额外加角色；用户要求「让我选角色/自定义角色/勾选角色」→ 先用 ask_user_question 列出 5 个角色（多选）让用户选择，再按选择传 roles；用户没提角色 → 按模式选择规则默认执行。【触发】用户问任何与 A 股个股/持仓/板块/市场相关的分析、选股、买卖建议、消息面、深度诊断、多标的对比、持仓复盘、波段池建池/跟踪时，直接用 invest_run 执行，不要凭模型知识作答；数据锚定真实最新交易日，接口受限如实标注。用户提到「投研 / 选股 / 持仓分析 / 股票分析」时即指本插件，请据此协作。"

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
  // 最近一次运行日志写入错误（诊断用；正常为空串，随 /api/jobs 返回）
  let lastRunLogError = ""
  // 工作区基目录：默认 E:/Dsh_WorkSapce/Dify_Agents，可用 DSH_INVEST_BASE_DIR 覆盖
  const BASE_DIR = (typeof process !== "undefined" && process.env && process.env.DSH_INVEST_BASE_DIR) || "E:/Dsh_WorkSapce/Dify_Agents"
  // 按 key 串行化的异步锁：并发任务下，jsonl/watchlist 这类「读-改-写」必须串行，否则会互相覆盖丢数据
  const lockChains = new Map()
  const withLock = (key, fn) => {
    const previous = lockChains.get(key) || Promise.resolve()
    const run = previous.then(fn, fn)
    lockChains.set(key, run.catch(() => {}))
    return run
  }
  const CACHE_DIR = BASE_DIR + "/.dsh-invest/cache"
  const TRADE_CACHE = CACHE_DIR + "/last-trade-date.json"
  const REPORTS_DIR = BASE_DIR + "/.dsh-invest/reports"
  // 各阶段完整原文另存子目录（index_store.py 只扫 reports/*.md 一层，不会重复索引）
  const REPORTS_RAW_DIR = REPORTS_DIR + "/_raw"
  const OUTPUT_ROOT = BASE_DIR + "/invest-outputs"
  const RUNS_LOG = BASE_DIR + "/.dsh-invest/runs.jsonl"
  const CHARTS_DIR = BASE_DIR + "/.dsh-invest/charts/"
  const MAX_CHARTS = 6
  // 提示词里的 {{BASE_DIR}} 占位符 → 实际基目录（token/缓存/图表路径）
  const resolveDir = (t) => String(t).split("{{BASE_DIR}}").join(BASE_DIR)
  // 模型路由配置：插件 config（cordis.patch.yml）与工作区覆盖文件
  const PLUGIN_CONFIG = (config && typeof config === "object") ? config : {}
  const ROUTES_FILE = BASE_DIR + "/.dsh-invest/routes.json"
  const SETTINGS_FILE = BASE_DIR + "/.dsh-invest/settings.json"
  // 最近任务持久化（跨 web 关闭/DSH 重启保留最近 5 个）
  const RECENT_JOBS_FILE = BASE_DIR + "/.dsh-invest/store/recent-jobs.json"
  const HOLDINGS_AUDIT = BASE_DIR + "/.dsh-invest/store/holdings_audit.jsonl"
  const HOLDINGS_BACKUP_DIR = BASE_DIR + "/.dsh-invest/store/backups"
  const holdingsDrafts = Object.create(null)
  // 本地持仓账本（跨会话共享）：由 scripts/holdings.py 维护，invest_run 每次运行注入摘要
  const HOLDINGS_FILE = BASE_DIR + "/.dsh-invest/持仓.json"
  const REALTIME_SCRIPT = BASE_DIR + "/scripts/realtime_quote.py"
  // Python 解释器探测（v0.44.1）：Windows 上叫 python，Linux/CI 上通常只有 python3。
  // 只探测一次并缓存；探测失败时按平台给默认值，让上层错误处理照常报错。
  let pythonCmdCache = ""
  const resolvePython = async () => {
    if (pythonCmdCache) return pythonCmdCache
    const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]
    try {
      const { spawnSync } = await import("node:child_process")
      for (const cmd of candidates) {
        try {
          const probe = spawnSync(cmd, ["-V"], { stdio: "ignore", windowsHide: true })
          if (probe && probe.status === 0) { pythonCmdCache = cmd; return cmd }
        } catch (e) { /* 试下一个 */ }
      }
    } catch (e) { /* 探测失败走默认 */ }
    pythonCmdCache = candidates[0]
    return pythonCmdCache
  }
  // 工作台（P1 只读）：页面与索引文件（tools/index_store.py 生成，运行时读取，改页面无需改插件）
  const WEB_INDEX = BASE_DIR + "/.dsh-invest/web/index.html"
  const STORE_INDEX = BASE_DIR + "/.dsh-invest/store/index.json"
  // 单阶段超时：默认 60 分钟，可用环境变量 DSH_INVEST_STAGE_TIMEOUT_MS 覆盖
  const STAGE_TIMEOUT_MS = (Number(process.env.DSH_INVEST_STAGE_TIMEOUT_MS) > 0) ? Number(process.env.DSH_INVEST_STAGE_TIMEOUT_MS) : 3600000
  // 报告二次总结超时：与阶段超时一致（默认 60 分钟）。这是上限而非常规耗时（正常 1-3 分钟）；
  // 超时会 dispose 子代理并自动回退原文。运行时可在 settings.json 用 "summaryTimeoutMs"（毫秒）覆盖，改配置无需重启插件。
  const SUMMARY_TIMEOUT_MS = STAGE_TIMEOUT_MS
  const CONCLUSIONS_LOG = BASE_DIR + "/.dsh-invest/store/conclusions.jsonl"
  // 标的档案（观察 + 持仓统一监控）：code 唯一，状态机 观察→持有→已清仓→已移除
  const WATCHLIST_FILE = BASE_DIR + "/.dsh-invest/store/watchlist.json"
  // 监控提醒事件日志（每次触发的信号追加，供工作台内提醒与防重复）
  const WATCHLIST_ALERTS = BASE_DIR + "/.dsh-invest/store/watchlist_alerts.jsonl"
  // 观察仓日检状态：开关、定时时刻、开机/收盘两次跑批的日期标记（各自每天只跑一次）
  const WATCH_DAILY_FILE = BASE_DIR + "/.dsh-invest/store/watch-daily.json"
  // 证券名称索引（code → 名称）：结论流水不带 name，观察档案建档时用它补全
  const NAMES_FILE = BASE_DIR + "/.dsh-invest/store/names.json"
  // 个股分析知识库：报告按「个股」切段归集（清单 + 每只股票一份 Markdown）
  const STOCK_NOTES_FILE = BASE_DIR + "/.dsh-invest/store/stock-notes.json"
  const STOCK_NOTES_DIR = BASE_DIR + "/.dsh-invest/store/stocks"
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
        const signed = (v) => (typeof v === "number" && Number.isFinite(v)) ? (v > 0 ? "+" : "") + v : f(v)
        const pct = (v) => (typeof v === "number" && Number.isFinite(v)) ? v + "%" : "-"
        // 紧凑列：把「数量/可用」「成本/现价」「市值/盈亏(率)」「状态/止损」合并，避免表过宽
        out.push("| 代码 | 名称 | 池 | 数量/可用 | 成本/现价 | 市值/盈亏(率) | 权重 | 状态/止损 | 备注 |")
        out.push("|---|---|---|---|---|---|---|---|---|")
        for (const p of list.slice(0, 20)) {
          const qty = (p.shares !== undefined && p.shares !== null) ? String(p.shares)
            : ((p.weight_pct !== undefined && p.weight_pct !== null) ? p.weight_pct + "%" : "-")
          const avail = (p.available_shares !== undefined && p.available_shares !== null && p.available_shares !== "") ? "/" + p.available_shares : ""
          const mvPnl = f(p.market_value) + "／" + signed(p.pnl)
            + ((typeof p.pnl_pct === "number" && Number.isFinite(p.pnl_pct)) ? "(" + signed(p.pnl_pct) + "%)" : "")
          out.push("| " + p.code + " | " + f(p.name) + " | " + f(p.pool) + " | " + qty + avail
            + " | " + f(p.cost) + "/" + f(p.current_price) + " | " + mvPnl + " | " + pct(p.weight_pct)
            + " | " + f(p.status) + "/" + f(p.stop) + " | " + String(p.note || "").replace(/\n/g, " ").slice(0, 60) + " |")
        }
      }
      out.push("【账本使用规则】① 本账本只记录用户与 AI 确认过的实盘/纸面持仓，**不含 LihuQuantify 模拟盘（短线池）数据**，严禁把量化系统的模拟盘数字混进来；② 凡涉及个股/组合/加减仓/复盘，先按上表核对：是否已持有、成本与浮盈亏、止损位、仓位占比（数量×现价÷总资产）；③ 结论必须区分「已持有（加仓/减仓/持有）」与「新建仓」，账本外的标的按空仓处理；④ 用户在对话中口述持仓变动时，必须用 pwsh 执行 python \"" + BASE_DIR + "/scripts/holdings.py\" add/update 落账；⑤ 账本与用户口述冲突时以用户为准并明确提示差异，严禁编造账本外的持仓数字。")
      return out.join("\n")
    } catch (e) { return "" }
  }
  // 当前持仓清单（code + name）：选股环节用它做「只找新标的」的硬排除
  const readHeldPositions = async () => {
    const fs = ctx.get("fs")
    if (fs === void 0) return []
    try {
      const d = JSON.parse(await fs.readText(await fs.resolve(HOLDINGS_FILE)))
      return (Array.isArray(d.positions) ? d.positions : [])
        .map((p) => ({ code: String(p.code || "").toUpperCase().trim(), name: String(p.name || "").trim() }))
        .filter((p) => /^\d{6}\.(SH|SZ|BJ)$/.test(p.code))
    } catch (e) { return [] }
  }
  // 选股环节的持仓排除约束（避免全市场海选把已持有标的当新机会重复分析）
  const heldExclusionLine = (held) => {
    if (!held || !held.length) return ""
    const list = held.map((p) => p.code + (p.name ? " " + p.name : "")).join("、")
    return "【选股硬约束：只找新标的】以下代码是账户**当前持仓**，严禁出现在候选名单中——本环节只负责挖掘新建仓机会；已持有标的的加仓/减仓/持有判断请走「组合体检」或「个股体检」。\n"
      + "当前持仓：" + list + "。\n"
      + "若某只已持有标的确实质地极佳，最多在报告末尾用「【已持有·不入选】代码 名称 一句话理由」单独列出（供参考），**不得**计入候选池、评分与买入计划。"
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
      buy_low: (typeof b.buy_low === "number" ? b.buy_low : null),
      buy_high: (typeof b.buy_high === "number" ? b.buy_high : null),
      thesis: String(b.thesis || "").slice(0, 200),
      invalidate_if: String(b.invalidate_if || "").slice(0, 200),
      stage: chosen.stage, report: reports[0] || null, source: "invest_run",
    }))
    try {
      await withLock("conclusions", async () => {
        const target = await fs.resolve(CONCLUSIONS_LOG)
        let existing = ""
        try { existing = await fs.readText(target) } catch (e) { /* 首次 */ }
        const prefix = existing && !existing.endsWith("\n") ? existing + "\n" : existing
        await fs.writeText(target, prefix + lines.join("\n") + "\n", void 0, void 0, policy)
      })
      // 同步标的档案：观察/看多 → 建档或更新观察档案；持有/减仓 → 更新持仓档案
      try { await syncWatchlistFromConclusions(blocks.slice(0, 3)) } catch (e) { /* 档案同步失败不阻断结论落库 */ }
      return lines.length
    } catch (e) { return 0 }
  }

  // ============ 标的档案（watchlist）：观察 + 持仓统一监控 ============
  // 状态机：观察 →（建仓）持有 →（清仓）已清仓 →（手动）已移除；已清仓可回到观察
  const WATCH_STATES = ["观察", "持有", "已清仓", "已移除"]
  // 数值规范化：有限数→number，空值→null（注意 Number("")===0，null 必须先短路，否则空阈值被误判为 0）
  const wNum = (v) => {
    if (v === null || v === undefined || v === "") return null
    const s = String(v).trim()
    if (s === "") return null
    const n = typeof v === "number" ? v : Number(s)
    return Number.isFinite(n) ? n : null
  }
  // 空档案骨架
  const emptyWatch = (code, name) => ({
    code, name: name || code, state: "观察",
    watch: { buy_low: null, buy_high: null, ideal_buy: null, buy_qty: null, invalidate_if: "", thesis: "", stance: "观察", target: null, stop: null, created_at: null, last_conclusion_ts: null },
    position: { cost: null, shares: null, stop: null, target: null, add_low: null, add_high: null, trim_line: null, trailing_stop: null },
    monitor: { current_price: null, refreshed_at: null, dist_buy_pct: null, dist_stop_pct: null, notify: true, last_signal_key: "", last_signal_at: null },
  })
  // 结论流水不带 name，观察档案建档时 name 会退化成代码；读写时统一用 names.json 补全
  const readStockNames = async () => {
    const d = await readJsonFile(NAMES_FILE, {})
    return (d && typeof d === "object" && !Array.isArray(d)) ? d : {}
  }
  const fillWatchNames = async (doc) => {
    const names = await readStockNames()
    for (const it of doc.items || []) {
      if (it && (!it.name || it.name === it.code)) {
        const n = names[it.code]
        if (typeof n === "string" && n.trim()) it.name = n.trim()
      }
    }
    return doc
  }
  const readWatchlist = async () => {
    const doc = await readJsonFile(WATCHLIST_FILE, { version: 1, updated_at: null, items: [] })
    if (!Array.isArray(doc.items)) doc.items = []
    return fillWatchNames(doc)
  }
  const writeWatchlist = async (doc) => {
    await fillWatchNames(doc)
    doc.updated_at = new Date().toISOString()
    await writeJsonFile(WATCHLIST_FILE, doc)
  }
  const findWatch = (doc, code) => doc.items.find((it) => it && String(it.code || "").toUpperCase() === String(code || "").toUpperCase())
  // 计算监控派生字段（距买点%/距止损%），现价缺失时清空派生
  const deriveWatch = (it) => {
    const m = it.monitor || (it.monitor = {})
    const p = wNum(m.current_price)
    const w = it.watch || {}
    const pos = it.position || {}
    if (p === null) { m.dist_buy_pct = null; m.dist_stop_pct = null; return }
    if (it.state === "观察") {
      const lo = wNum(w.buy_low), hi = wNum(w.buy_high)
      // 距买点：以买入区间下沿为锚；无下沿用上沿；都无则 null
      const anchor = lo !== null ? lo : hi
      m.dist_buy_pct = anchor && anchor > 0 ? Math.round(((p - anchor) / anchor) * 10000) / 100 : null
      m.dist_stop_pct = null
    } else if (it.state === "持有") {
      const st = wNum(pos.stop)
      m.dist_stop_pct = st && st > 0 ? Math.round(((p - st) / st) * 10000) / 100 : null
      m.dist_buy_pct = null
    } else { m.dist_buy_pct = null; m.dist_stop_pct = null }
  }
  // 信号比对：返回 {key, kind, level, qty, message} 或 null；kind: buy/invalidate/stop/target/add/trim
  // qty = 购买仓位数：观察期（买入/失效）取 watch.buy_qty 计划买入股数；持有期（止盈/止损/加减仓）取 position.shares 持仓股数
  const evalWatchSignal = (it) => {
    const m = it.monitor || {}, w = it.watch || {}, pos = it.position || {}
    const p = wNum(m.current_price)
    if (p === null || m.notify === false) return null
    const nm = it.name || it.code
    const f2 = (v) => v === null ? "—" : String(v)
    const qtyText = (qty, label) => label + " " + (qty === null ? "待定" : qty + " 股")
    const buyQty = wNum(w.buy_qty)
    if (it.state === "观察") {
      const lo = wNum(w.buy_low), hi = wNum(w.buy_high)
      if (lo !== null && hi !== null && p >= lo && p <= hi) {
        return { key: it.code + "|buy|" + localYmd(), kind: "buy", level: "good", qty: buyQty, message: "【买入提醒】" + nm + " " + it.code + " 现价 " + p + " 落入买入区间 [" + lo + ", " + hi + "]，理想买点 " + f2(wNum(w.ideal_buy)) + "，" + qtyText(buyQty, "购买仓位数") + "。" }
      }
      // 失效：观察标的若设了止损/失效价且现价跌破 → 观察失效（用 watch.stop 作为失效价锚）
      const inv = wNum(w.stop)
      if (inv !== null && p < inv) {
        return { key: it.code + "|invalidate|" + localYmd(), kind: "invalidate", level: "warn", qty: buyQty, message: "【观察失效】" + nm + " " + it.code + " 现价 " + p + " 跌破失效价 " + inv + "，观察逻辑：" + String(w.invalidate_if || "未填").slice(0, 60) + "，" + qtyText(buyQty, "购买仓位数") + "。" }
      }
      return null
    }
    if (it.state === "持有") {
      const heldQty = wNum(pos.shares)
      const heldText = qtyText(heldQty, "持仓仓位数")
      const st = wNum(pos.stop)
      if (st !== null && p <= st) return { key: it.code + "|stop|" + localYmd(), kind: "stop", level: "bad", qty: heldQty, message: "【止损提醒】" + nm + " " + it.code + " 现价 " + p + " 触及/跌破止损价 " + st + "，成本 " + f2(wNum(pos.cost)) + "，" + heldText + "。" }
      const tg = wNum(pos.target)
      if (tg !== null && p >= tg) return { key: it.code + "|target|" + localYmd(), kind: "target", level: "good", qty: heldQty, message: "【止盈提醒】" + nm + " " + it.code + " 现价 " + p + " 达到目标价 " + tg + "，成本 " + f2(wNum(pos.cost)) + "，" + heldText + "。" }
      const al = wNum(pos.add_low), ah = wNum(pos.add_high)
      if (al !== null && ah !== null && p >= al && p <= ah) return { key: it.code + "|add|" + localYmd(), kind: "add", level: "info", qty: heldQty, message: "【加仓提醒】" + nm + " " + it.code + " 现价 " + p + " 回落至加仓区间 [" + al + ", " + ah + "]，" + heldText + "。" }
      const tr = wNum(pos.trim_line)
      if (tr !== null && p >= tr) return { key: it.code + "|trim|" + localYmd(), kind: "trim", level: "warn", qty: heldQty, message: "【减仓提醒】" + nm + " " + it.code + " 现价 " + p + " 触及减仓线 " + tr + "，" + heldText + "。" }
      return null
    }
    return null
  }
  // 追加提醒事件（带防重复：同 key 当日只记一次）
  const appendAlert = async (doc, it, sig) => {
    if (!sig) return null
    const m = it.monitor || (it.monitor = {})
    if (m.last_signal_key === sig.key) return null // 当日同信号已提醒
    m.last_signal_key = sig.key
    m.last_signal_at = new Date().toISOString()
    const rec = { ts: m.last_signal_at, code: it.code, name: it.name, state: it.state, kind: sig.kind, level: sig.level, qty: sig.qty === undefined ? null : sig.qty, message: sig.message, key: sig.key, read: false }
    try {
      const fs = ctx.get("fs")
      if (fs !== void 0) {
        // 并发任务可能同时追加提醒 → 串行化，避免「读-改-写」互相覆盖丢记录
        await withLock("alerts", async () => {
          const target = await fs.resolve(WATCHLIST_ALERTS)
          let existing = ""
          try { existing = await fs.readText(target) } catch (e) { /* 首次 */ }
          const prefix = existing && !existing.endsWith("\n") ? existing + "\n" : existing
          await fs.writeText(target, prefix + JSON.stringify(rec) + "\n", void 0, void 0, getFsPolicy())
        })
      }
    } catch (e) { /* 提醒日志失败不阻断 */ }
    return rec
  }
  // 结论 → 标的档案同步：观察/看多自动建档或更新；持仓标的更新止盈止损；拒绝只更新立场不删档
  // 并发任务可能同时落结论 → 用 watchlist 锁串行化整段「读-改-写」，避免互相覆盖
  const syncWatchlistFromConclusions = async (blocks) => withLock("watchlist", async () => {
    const doc = await readWatchlist()
    let changed = false
    const now = new Date().toISOString()
    for (const b of blocks) {
      const code = String(b.code || "").trim().toUpperCase()
      if (!/^\d{6}(\.(SH|SZ|BJ))?$/.test(code)) continue
      const stance = String(b.stance || "")
      let it = findWatch(doc, code)
      const bullish = (stance === "观察" || stance === "看多")
      if (!it && bullish) {
        it = emptyWatch(code, String(b.name || ""))
        doc.items.push(it)
      }
      if (!it) continue
      // 已清仓 + 新观察结论 → 回到观察
      if (it.state === "已清仓" && bullish) it.state = "观察"
      if (it.state === "观察") {
        const w = it.watch
        w.stance = stance || w.stance
        w.last_conclusion_ts = now
        if (!w.created_at) w.created_at = now
        if (typeof b.buy_low === "number") w.buy_low = b.buy_low
        if (typeof b.buy_high === "number") w.buy_high = b.buy_high
        if (typeof b.target === "number") w.target = b.target
        if (typeof b.stop === "number") w.stop = b.stop
        if (b.thesis) w.thesis = String(b.thesis).slice(0, 200)
        if (b.invalidate_if) w.invalidate_if = String(b.invalidate_if).slice(0, 300)
        deriveWatch(it)
        changed = true
      } else if (it.state === "持有" && (stance === "持有" || stance === "减仓" || stance === "离场")) {
        const pos = it.position
        if (typeof b.target === "number") pos.target = b.target
        if (typeof b.stop === "number") pos.stop = b.stop
        if (b.invalidate_if) it.watch.invalidate_if = String(b.invalidate_if).slice(0, 300)
        it.watch.last_conclusion_ts = now
        deriveWatch(it)
        changed = true
      }
    }
    if (changed) await writeWatchlist(doc)
    return changed
  })

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

  // 持仓：所有来源先形成草稿，人工确认后才写账本；截图原图只转为临时 attachment，不留档
  const readHoldingsDoc = async () => await readJsonFile(HOLDINGS_FILE, { version: 1, updated_at: null, account: {}, positions: [] })
  // 数值字段规范化：有限数→number，空值/非有限数→null（空串→null）
  const numOrNull = (v) => {
    if (v === null || v === void 0 || v === "") return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  // 四舍五入到 d 位：Math.round(v*10^d)/10^d（与前端/holdings.py 口径保持一致）
  const roundN = (v, d) => { const m = Math.pow(10, d); return Math.round(v * m) / m }
  const normalizePosition = (p, source) => {
    const code = String(p.code || "").toUpperCase().trim()
    if (!/^\d{6}\.(SH|SZ|BJ)$/.test(code)) throw new Error("股票代码格式错误：" + code)
    const shares = Number(p.shares)
    if (!Number.isFinite(shares) || shares < 0) throw new Error(code + " 持仓数量无效")
    const cost = p.cost === null || p.cost === void 0 || p.cost === "" ? null : Number(p.cost)
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) throw new Error(code + " 成本价无效")
    return {
      code, name: String(p.name || ""), pool: String(p.pool || "实盘"), source: source || p.source || "manual",
      shares: Math.round(shares), available_shares: numOrNull(p.available_shares), cost,
      current_price: numOrNull(p.current_price), market_value: numOrNull(p.market_value),
      pnl: numOrNull(p.pnl), pnl_pct: numOrNull(p.pnl_pct), weight_pct: numOrNull(p.weight_pct),
      status: String(p.status || "持有"), stop: p.stop ?? null, target: p.target ?? null, note: String(p.note || ""),
    }
  }
  // 纯函数：按统一口径重算每条的 market_value / pnl / pnl_pct / weight_pct，返回新数组（不改动入参）
  const recalcPositions = (positions, account) => {
    const acc = account && typeof account === "object" ? account : {}
    const list = Array.isArray(positions) ? positions : []
    // 先算出所有条的 market_value（权重分母回退项 cash + Σmarket_value 需要用到）
    const partial = list.map((p) => {
      const shares = numOrNull(p.shares)
      const cp = numOrNull(p.current_price)
      const cost = numOrNull(p.cost)
      const market_value = (shares !== null && cp !== null) ? roundN(shares * cp, 2) : null
      const pnl = (shares !== null && cp !== null && cost !== null) ? roundN(shares * (cp - cost), 2) : null
      const pnl_pct = (cp !== null && cost !== null && cost > 0) ? roundN((cp - cost) / cost * 100, 3) : null
      return { p, market_value, pnl, pnl_pct }
    })
    // 权重分母：total_asset 优先；缺失回退 cash + Σmarket_value；仍缺失→weight_pct = null
    let totalAsset = numOrNull(acc.total_asset)
    if (totalAsset === null) {
      const cash = numOrNull(acc.cash)
      if (cash !== null) totalAsset = cash + partial.reduce((s, x) => s + (x.market_value || 0), 0)
    }
    return partial.map(({ p, market_value, pnl, pnl_pct }) => ({
      ...p,
      market_value, pnl, pnl_pct,
      weight_pct: (market_value !== null && totalAsset !== null && totalAsset > 0)
        ? roundN(market_value / totalAsset * 100, 2) : null,
    }))
  }
  const positionsDiff = (before, after) => {
    const a = new Map((before || []).map((p) => [p.code, p]))
    const b = new Map((after || []).map((p) => [p.code, p]))
    const added = [], removed = [], modified = [], unchanged = []
    for (const [code] of b) if (!a.has(code)) added.push(code)
    for (const [code] of a) if (!b.has(code)) removed.push(code)
    for (const [code, next] of b) {
      const prev = a.get(code)
      if (!prev) continue
      const changed = ["name", "shares", "cost", "status", "note", "pool", "stop", "target",
        "available_shares", "current_price", "market_value", "pnl", "pnl_pct", "weight_pct"].some((k) => String(prev[k] ?? "") !== String(next[k] ?? ""))
      ;(changed ? modified : unchanged).push(code)
    }
    return { added, removed, modified, unchanged }
  }
  const normalizeAccount = (account) => {
    const a = account && typeof account === "object" ? account : {}
    const numberOrNull = (v) => v === void 0 || v === null || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null)
    const total = numberOrNull(a.total_asset ?? a.totalAsset ?? a.assets ?? a.total)
    const cash = numberOrNull(a.cash ?? a.available_cash ?? a.availableCash ?? a.available)
    return { ...a, total_asset: total, cash, available_cash: cash }
  }
  const makeHoldingsDraft = async (source, positions, account, warnings) => {
    const current = await readHoldingsDoc()
    const id = "hd_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7)
    const normAccount = normalizeAccount(account)
    // positions 已先经 normalizePosition，再统一重算计算列，保证草稿永远与 cost/shares/current_price 一致
    const calcPositions = recalcPositions(Array.isArray(positions) ? positions : [], normAccount)
    const draft = { id, source, createdAt: Date.now(), positions: calcPositions, account: normAccount, warnings: warnings || [] }
    holdingsDrafts[id] = draft
    return { draftId: id, source, positions: calcPositions, account: draft.account, diff: positionsDiff(current.positions, calcPositions), warnings: draft.warnings }
  }
  // 持仓账本 → 标的档案同步（持仓工作区改股数/成本后，标的档案必须一致）：
  //   ① 账本中存在 → 档案进入/保持「持有」，股数、成本、现价以账本为准；
  //   ② 账本中已消失（清仓/删除）→ 档案标记「已清仓」，避免继续按持仓规则误报止盈/止损。
  const syncWatchlistFromHoldings = async (positions) => withLock("watchlist", async () => {
    const doc = await readWatchlist()
    const byCode = new Map()
    for (const p of Array.isArray(positions) ? positions : []) {
      const code = String(p && p.code ? p.code : "").toUpperCase().trim()
      if (code) byCode.set(code, p)
    }
    const changes = []
    const seen = new Set()
    for (const it of doc.items || []) {
      if (!it) continue
      const code = String(it.code || "").toUpperCase().trim()
      const pos = it.position || (it.position = {})
      const p = byCode.get(code)
      if (p) {
        seen.add(code)
        const shares = numOrNull(p.shares)
        const cost = numOrNull(p.cost)
        const price = numOrNull(p.current_price)
        let touched = false
        // 重新买入：已清仓/已移除/观察的档案都要回到「持有」，
        // 否则账本里明明有这只票，档案里却显示已清仓（2026-11-11 修复）
        if (it.state !== "持有") {
          const from = it.state
          it.state = "持有"
          touched = true
          changes.push(code + " " + from + "→持有")
        }
        if (shares !== null && pos.shares !== shares) { pos.shares = shares; touched = true; changes.push(code + " 股数 " + shares) }
        if (cost !== null && pos.cost !== cost) { pos.cost = cost; touched = true }
        if (price !== null) it.monitor.current_price = price
        if (touched) deriveWatch(it)
      } else if (it.state === "持有") {
        it.state = "已清仓"
        pos.shares = 0
        deriveWatch(it)
        changes.push(code + " 持有→已清仓")
      }
    }
    // 账本里有、档案里没有 → 自动建「持有」档案：
    // 以前只在档案里已有的条目上双向同步，导致持仓工作区新写入的票永远进不了监控
    for (const [code, p] of byCode) {
      if (seen.has(code)) continue
      const shares = numOrNull(p.shares)
      if (shares === null || shares <= 0) continue
      const it = emptyWatch(code, String(p.name || ""))
      it.state = "持有"
      it.position.shares = shares
      const cost = numOrNull(p.cost)
      if (cost !== null) it.position.cost = cost
      const price = numOrNull(p.current_price)
      if (price !== null) it.monitor.current_price = price
      deriveWatch(it)
      doc.items.push(it)
      changes.push(code + " 新建档案（持有）")
    }
    if (changes.length) await writeWatchlist(doc)
    return changes
  })
  // 账本 → 档案对账：外部脚本（scripts/holdings.py sync）或手工改 持仓.json 造成的不一致，
  // 在「刷新现价」「观察仓日检」时自愈。账本缺失/空壳时不对账，避免把「持有」档案误判成已清仓。
  const reconcileWatchFromHoldings = async () => {
    const doc = await readHoldingsDoc()
    if (!doc || !doc.updated_at) return []
    return await syncWatchlistFromHoldings(Array.isArray(doc.positions) ? doc.positions : [])
  }
  // 档案 → 持仓账本的反向同步（与 syncWatchlistFromHoldings 对称）：
  //   state=已清仓 → 从账本移除该票；state=持有 → 按档案里的成本/股数 upsert 账本
  // 写入前备份 + 追加审计，与「确认持仓」同一套口径；观察/已移除不动账本，只回一条提示
  const syncHoldingsFromWatch = async (it) => withLock("holdings", async () => {
    const fs = ctx.get("fs")
    if (fs === void 0) return { changed: false, action: "none", warnings: ["fs 不可用，未同步持仓账本"] }
    const current = await readHoldingsDoc()
    const list = Array.isArray(current.positions) ? current.positions : []
    const code = String(it.code || "").toUpperCase().trim()
    const idx = list.findIndex((p) => p && String(p.code || "").toUpperCase().trim() === code)
    const st = String(it.state || "")
    const pos = it.position || {}
    const shares = numOrNull(pos.shares)
    const cost = numOrNull(pos.cost)
    let nextList = list
    let action = "none"
    if (st === "已清仓") {
      if (idx < 0) return { changed: false, action: "none", warnings: [] }
      nextList = list.filter((_, i) => i !== idx)
      action = "清仓"
    } else if (st === "持有") {
      if (shares === null || shares <= 0) {
        return { changed: false, action: "skip", warnings: ["档案已置为「持有」，但股数为空或为 0：持仓账本未写入，请补录股数（成本可选）后重新保存"] }
      }
      const base = idx >= 0 ? list[idx] : { code, name: it.name || code, pool: "实盘", status: "持有", source: "watch" }
      // 只改了止损/目标等监控字段时不必重写账本（否则每点一次保存都会多一份备份）
      if (idx >= 0) {
        const sameShares = numOrNull(base.shares) === shares
        const sameCost = cost === null || numOrNull(base.cost) === cost
        const sameName = !it.name || it.name === code || String(base.name || "") === it.name
        if (sameShares && sameCost && sameName) return { changed: false, action: "none", warnings: [] }
      }
      const merged = Object.assign({}, base, { code, shares })
      if (it.name && it.name !== code) merged.name = it.name
      if (cost !== null) merged.cost = cost
      nextList = idx >= 0 ? list.map((p, i) => (i === idx ? merged : p)) : list.concat([merged])
      action = idx >= 0 ? "更新持仓" : "建仓"
    } else {
      // 观察 / 已移除：不动账本（避免误删真实持仓），但账本里若还持有要明确提示
      if (idx >= 0) return { changed: false, action: "none", warnings: ["档案已改为「" + st + "」，但持仓账本里仍有该标的；若要真清仓请改用「已清仓」状态，或在持仓工作区删除"] }
      return { changed: false, action: "none", warnings: [] }
    }
    const account = normalizeAccount(current.account && typeof current.account === "object" ? current.account : {})
    const positions = recalcPositions(nextList, account)
    const diff = positionsDiff(list, positions)
    const d = new Date()
    const stamp = localYmd() + "_" + z2(d.getHours()) + z2(d.getMinutes()) + z2(d.getSeconds())
    const backup = HOLDINGS_BACKUP_DIR + "/持仓_" + stamp + "_watch.json"
    try { await fs.writeText(await fs.resolve(backup), JSON.stringify(current, null, 2) + "\n", void 0, void 0, getFsPolicy()) } catch (e) { /* 首次无账本可忽略 */ }
    const updatedAt = d.toISOString()
    await writeJsonFile(HOLDINGS_FILE, { version: 1, updated_at: updatedAt, account, positions })
    try {
      const auditTarget = await fs.resolve(HOLDINGS_AUDIT)
      let oldLog = ""
      try { oldLog = await fs.readText(auditTarget) } catch (e) { /* 首次 */ }
      const audit = JSON.stringify({ ts: updatedAt, action: "watch-sync", watchAction: action, code, diff, positions, account })
      await fs.writeText(auditTarget, oldLog + (oldLog && !oldLog.endsWith("\n") ? "\n" : "") + audit + "\n", void 0, void 0, getFsPolicy())
    } catch (e) { /* 审计失败不阻断 */ }
    return { changed: true, action, code, updated_at: updatedAt, backup, diff, warnings: [] }
  })
  const confirmHoldingsDraft = async (draftId, rawPositions, account) => {
    const draft = holdingsDrafts[draftId]
    if (!draft) throw new Error("草稿不存在或已过期，请重新上传/生成")
    const current = await readHoldingsDoc()
    const normalized = (Array.isArray(rawPositions) ? rawPositions : []).map((p) => normalizePosition(p, draft.source)).filter((p) => p.shares > 0)
    const nextAccount = normalizeAccount(account && typeof account === "object" ? account : (draft.account || {}))
    // 写入前统一重算计算列，权重分母用 nextAccount
    const positions = recalcPositions(normalized, nextAccount)
    const diff = positionsDiff(current.positions, positions)
    const fs = ctx.get("fs")
    if (fs === void 0) throw new Error("fs unavailable")
    const d = new Date()
    const stamp = localYmd() + "_" + z2(d.getHours()) + z2(d.getMinutes()) + z2(d.getSeconds())
    const backup = HOLDINGS_BACKUP_DIR + "/持仓_" + stamp + ".json"
    try { await fs.writeText(await fs.resolve(backup), JSON.stringify(current, null, 2) + "\n", void 0, void 0, getFsPolicy()) } catch (e) { /* 首次无账本可忽略 */ }
    const updatedAt = d.toISOString()
    const next = { version: 1, updated_at: updatedAt, account: nextAccount, positions }
    await writeJsonFile(HOLDINGS_FILE, next)
    const auditTarget = await fs.resolve(HOLDINGS_AUDIT)
    let oldLog = ""
    try { oldLog = await fs.readText(auditTarget) } catch (e) { /* 首次 */ }
    const audit = JSON.stringify({ ts: updatedAt, action: "confirm", source: draft.source, draftId, diff, positions, account: nextAccount })
    await fs.writeText(auditTarget, oldLog + (oldLog && !oldLog.endsWith("\n") ? "\n" : "") + audit + "\n", void 0, void 0, getFsPolicy())
    // 账本已落盘 → 同步标的档案（失败不阻断账本写入，但把错误带回前端）
    let watchSync = []
    let watchSyncError = ""
    try { watchSync = await syncWatchlistFromHoldings(positions) }
    catch (e) { watchSyncError = String(e && e.message ? e.message : e).slice(0, 200) }
    delete holdingsDrafts[draftId]
    return { ok: true, updated_at: updatedAt, backup, diff, watchSync, watchSyncError }
  }
  // 一键刷新现价（直接落账本，不生成草稿、不需要人工确认）：只改 current_price 并重算市值/盈亏/权重
  const refreshHoldingsPrices = async () => {
    const current = await readHoldingsDoc()
    const positions = Array.isArray(current.positions) ? current.positions : []
    const codes = Array.from(new Set(positions
      .map((p) => String(p.code || "").trim().toUpperCase())
      .filter((code) => /^\d{6}\.(SH|SZ|BJ)$/.test(code))))
    if (!codes.length) throw new Error("账本里没有可刷新的有效证券代码")
    const fetched = await fetchQuotePrices(codes)
    const byDigits = {}
    for (const q of fetched.quotes || []) {
      const digits = String(q && q.code != null ? q.code : "").replace(/\D/g, "").slice(0, 6)
      const price = (q == null || q.price === null || q.price === void 0 || q.price === "") ? null : Number(q.price)
      if (digits.length === 6 && price !== null && Number.isFinite(price) && price > 0) byDigits[digits] = price
    }
    const prices = {}
    const missing = []
    for (const code of codes) {
      const price = byDigits[code.replace(/\D/g, "").slice(0, 6)]
      if (typeof price === "number") prices[code] = price
      else missing.push(code)
    }
    const hit = Object.keys(prices)
    if (!hit.length) throw new Error("行情接口未返回任何有效现价，请稍后重试或手工录入")
    const updated = positions.map((p) => {
      const code = String(p.code || "").trim().toUpperCase()
      return typeof prices[code] === "number" ? Object.assign({}, p, { current_price: prices[code] }) : Object.assign({}, p)
    })
    const nextAccount = normalizeAccount(current.account && typeof current.account === "object" ? current.account : {})
    const recalculated = recalcPositions(updated, nextAccount)
    const diff = positionsDiff(positions, recalculated)
    const fs = ctx.get("fs")
    if (fs === void 0) throw new Error("fs unavailable")
    const d = new Date()
    const stamp = localYmd() + "_" + z2(d.getHours()) + z2(d.getMinutes()) + z2(d.getSeconds())
    const backup = HOLDINGS_BACKUP_DIR + "/持仓_" + stamp + ".json"
    try { await fs.writeText(await fs.resolve(backup), JSON.stringify(current, null, 2) + "\n", void 0, void 0, getFsPolicy()) } catch (e) { /* 首次无账本可忽略 */ }
    const updatedAt = d.toISOString()
    const next = { version: 1, updated_at: updatedAt, account: nextAccount, positions: recalculated }
    await writeJsonFile(HOLDINGS_FILE, next)
    const auditTarget = await fs.resolve(HOLDINGS_AUDIT)
    let oldLog = ""
    try { oldLog = await fs.readText(auditTarget) } catch (e) { /* 首次 */ }
    const audit = JSON.stringify({ ts: updatedAt, action: "refresh-quotes", source: fetched.source || "tencent", prices, diff, positions: recalculated, account: nextAccount })
    await fs.writeText(auditTarget, oldLog + (oldLog && !oldLog.endsWith("\n") ? "\n" : "") + audit + "\n", void 0, void 0, getFsPolicy())
    let watchSync = []
    let watchSyncError = ""
    try { watchSync = await syncWatchlistFromHoldings(recalculated) }
    catch (e) { watchSyncError = String(e && e.message ? e.message : e).slice(0, 200) }
    return { ok: true, updated_at: updatedAt, updated: hit.length, total: codes.length, missing, prices, fetched_at: fetched.fetchedAt || updatedAt, backup, diff, watchSync, watchSyncError }
  }
  // 现价刷新：优先复用 scripts/realtime_quote.py；spawn python 不可用时退化到 Node 直接拉腾讯行情
  const fetchTencentViaNode = async (codes) => {
    const q = codes.map((c) => {
      let s = String(c || "").trim().toLowerCase()
      for (const suf of [".sh", ".sz", ".bj"]) if (s.endsWith(suf)) { s = s.slice(0, -suf.length); break }
      if (/^(sh|sz|bj)/.test(s)) return s
      if (/^(60|68|90|50|51|58)/.test(s)) return "sh" + s
      if (/^(00|30|20|15|16|18)/.test(s)) return "sz" + s
      if (/^(43|83|87|88|92)/.test(s)) return "bj" + s
      return "sh" + s
    }).join(",")
    const resp = await fetch("https://qt.gtimg.cn/q=" + q, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/" } })
    if (!resp.ok) throw new Error("腾讯行情 HTTP " + resp.status)
    const buf = await resp.arrayBuffer()
    let raw
    try { raw = new TextDecoder("gbk").decode(buf) } catch (e) { raw = new TextDecoder("gb18030").decode(buf) }
    const quotes = []
    for (const seg of raw.split(";")) {
      const t = seg.trim()
      const eq = t.indexOf("=")
      if (eq < 0) continue
      const body = t.slice(eq + 1).trim().replace(/^"|"$/g, "")
      const fld = body.split("~")
      if (fld.length < 4) continue
      const price = Number(fld[3])
      quotes.push({ code: fld[2], price: Number.isFinite(price) ? price : null })
    }
    return quotes
  }
  // 返回 { quotes, fetchedAt }；脚本失败/非 ok/解析失败抛 Error（由路由转成 400），spawn 不可用则退化到 Node fetch
  const fetchQuotePrices = async (codes) => {
    const { spawn } = await import("node:child_process")
    const pyCmd = await resolvePython()
    const run = await new Promise((resolve) => {
      let settled = false, timer = null, child = null
      const done = (r) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(r) }
      try {
        child = spawn(pyCmd, [REALTIME_SCRIPT, ...codes], { cwd: BASE_DIR, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      } catch (e) {
        done({ ok: false, spawnUnavailable: true, reason: "spawn python 失败：" + String(e && e.message || e) })
        return
      }
      let out = "", err = ""
      child.stdout.on("data", (d) => out += String(d))
      child.stderr.on("data", (d) => err += String(d))
      child.on("error", (e) => done({ ok: false, spawnUnavailable: true, reason: "spawn python 不可用：" + String(e && e.message || e) }))
      child.on("close", (code) => {
        if (settled) return
        if (code !== 0) { done({ ok: false, reason: "实时行情脚本退出码 " + code + (err.trim() ? "：" + err.trim().slice(0, 180) : "") }); return }
        let parsed
        try { parsed = JSON.parse(out) } catch (e) { done({ ok: false, reason: "实时行情脚本 stdout 解析失败：" + String(e && e.message || e).slice(0, 120) }); return }
        if (!parsed || parsed.ok !== true) { done({ ok: false, reason: "实时行情脚本未返回 ok：" + String((parsed && parsed.error) || "ok!=true").slice(0, 180) }); return }
        done({ ok: true, quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [], fetchedAt: (parsed && typeof parsed.fetched_at === "string" && parsed.fetched_at) ? parsed.fetched_at : void 0 })
      })
      timer = setTimeout(() => { try { child && child.kill() } catch (e) { /* ignore */ } done({ ok: false, reason: "实时行情脚本超时（12 秒）" }) }, 12000)
    })
    if (run.ok) return { quotes: run.quotes, fetchedAt: run.fetchedAt || new Date().toISOString() }
    if (run.spawnUnavailable) return { quotes: await fetchTencentViaNode(codes), fetchedAt: new Date().toISOString() }
    throw new Error(run.reason || "实时行情获取失败")
  }
  // 批量刷新现价 + 比对信号（观察仓日检与「刷新现价」按钮共用，避免两套逻辑漂移）
  // 返回 { doc, refreshed, fired, fetchedAt }；无观察/持有标的时 refreshed=0，不抛错
  const refreshWatchPrices = async () => withLock("watchlist", async () => {
    const doc = await readWatchlist()
    // 需要现价的标的：观察 + 持有（已清仓/已移除跳过）
    const active = doc.items.filter((it) => it && (it.state === "观察" || it.state === "持有"))
    if (!active.length) return { doc, refreshed: 0, fired: [], fetchedAt: null }
    const codes = active.map((it) => it.code)
    const result = await fetchQuotePrices(codes)
    const byDigits = {}
    for (const q of result.quotes) {
      const digits = String(q && q.code != null ? q.code : "").replace(/\D/g, "").slice(0, 6)
      const price = (q == null || q.price === null || q.price === void 0 || q.price === "") ? null : Number(q.price)
      if (digits.length === 6 && price !== null && Number.isFinite(price)) byDigits[digits] = price
    }
    const fired = []
    for (const it of active) {
      const digits = String(it.code).replace(/\D/g, "").slice(0, 6)
      const p = byDigits[digits]
      const m = it.monitor || (it.monitor = {})
      if (p !== undefined) { m.current_price = p } else { m.current_price = null }
      m.refreshed_at = result.fetchedAt || new Date().toISOString()
      deriveWatch(it)
      const sig = evalWatchSignal(it)
      if (sig) {
        const rec = await appendAlert(doc, it, sig)
        if (rec) fired.push(rec)
      }
    }
    await writeWatchlist(doc)
    return { doc, refreshed: active.length, fired, fetchedAt: result.fetchedAt || new Date().toISOString() }
  })
  const runVisionSubagent = async (prompt) => runPromptSubagent(prompt, { label: "持仓截图识别", timeoutMs: 120000 })
  // 通用子代理执行（单个阶段式提问）：限流 + 超时 + 禁止递归
  const runPromptSubagent = async (prompt, opts) => {
    const options = opts || {}
    const label = options.label || "投研子任务"
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 120000
    const agents = ctx.get("agents")
    const roots = agents && typeof agents.roots === "function" ? agents.roots() : []
    const parent = roots[roots.length - 1]
    if (!parent) throw new Error("没有可用的顶层 Agent，无法执行「" + label + "」")
    const candidates = []
    try { if (ctx.subagents) candidates.push(ctx.subagents) } catch (e) { /* ignore */ }
    for (const n of ["subagents", "subagent"]) {
      try { const v = ctx.get(n, true); if (v) candidates.push(v) } catch (e) { /* ignore */ }
      try { const v = ctx.get(n, false); if (v) candidates.push(v) } catch (e) { /* ignore */ }
    }
    const native = candidates.find((x) => typeof x.start === "function")
    const activation = candidates.find((x) => typeof x.startActivation === "function")
    const signal = new AbortController().signal
    // 宿主 spawn 的 prompt 必须是内容块数组（内部会调用 content.some），字符串会抛
    // "content.some is not a function"；这里统一包成 [{type:"text", text}]。
    const promptContent = typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt
    const spec = {
      label, prompt: promptContent, parent, signal,
      toolFilter: { deny: ["invest_run", "subagent_fork", "send_message", "interrupt_agent", "list_agents"] },
    }
    if (options.agentOptions) spec.agentOptions = options.agentOptions
    let run
    if (native) run = await native.start("spawn", spec)
    else if (activation) {
      const act = await activation.startActivation({ provider: "spawn", label, request: spec, signal, delivery: "caller" })
      run = { result: act.result }
    } else throw new Error("子代理服务不可用，无法执行「" + label + "」")
    // 超时守卫：无论成功失败都要清掉定时器，否则会拖住进程/事件循环
    let timer = null
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { if (run && typeof run.dispose === "function") Promise.resolve(run.dispose()).catch(() => {}) } catch (e) { /* ignore */ }
        reject(new Error(label + "超时（" + Math.round(timeoutMs / 1000) + " 秒）"))
      }, timeoutMs)
    })
    let result
    try {
      result = await Promise.race([Promise.resolve(run.result), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (result && result.stopReason === "error") throw new Error(label + "失败（stopReason=error）")
    return extractBoth(result).text
  }
  // 报告路径白名单：只允许工作区内、以 .md 结尾的绝对路径
  const isSafeReportPath = (path) => {
    const normalized = String(path || "").replace(/\\/g, "/")
    const base = BASE_DIR.replace(/\\/g, "/").replace(/\/+$/, "")
    return normalized.startsWith(base + "/") && /\.md$/i.test(normalized) && !normalized.includes("/../")
  }
  // 报告追问：只依据报告全文回答，多轮历史一并传入
  const askReport = async (reportPath, question, history) => {
    const q = String(question || "").trim()
    if (!q) throw new Error("请输入要追问的问题")
    if (!isSafeReportPath(reportPath)) throw new Error("报告路径不合法（必须是工作区内的 .md 文件）")
    const fs = ctx.get("fs")
    if (fs === void 0) throw new Error("fs 服务不可用")
    let full = ""
    try { full = await fs.readText(await fs.resolve(reportPath)) } catch (e) { throw new Error("读取报告失败：" + String(e).slice(0, 120)) }
    const body = String(full).slice(0, 24000)
    const turns = (Array.isArray(history) ? history : []).slice(-6)
      .map((turn) => (turn && turn.role === "assistant" ? "助手：" : "用户：") + String((turn && turn.text) || "").slice(0, 1200))
      .join("\n")
    const prompt = [
      "你是投研报告答疑助手。用户针对一份已完成的投研报告提问，你只依据报告内容回答。",
      "规则：① 只使用报告里出现的事实、数字与结论，严禁编造行情、财报数字或评级；② 报告未涉及的内容要明确说「报告未涉及」，并说明可补哪些数据；③ 回答要点化，给依据（引用报告中的段落或数字）；④ 若涉及操作建议，必须区分「报告结论」与「你的补充推理」，补充部分要注明是推理；⑤ 用 Markdown 输出：一句话结论先行并加粗，对比信息用表格，小标题用 ###，避免大段无结构长文（默认控制在 800 字以内，用户明确要求展开时才写长）。",
      "【报告路径】" + reportPath,
      "【报告全文】\n" + body,
      turns ? "【对话历史】\n" + turns : "",
      "【本轮问题】" + q.slice(0, 1500),
    ].filter(Boolean).join("\n\n")
    const started = Date.now()
    const answer = await runPromptSubagent(prompt, { label: "报告追问", timeoutMs: 180000 })
    return { answer: String(answer || "").trim(), elapsedMs: Date.now() - started }
  }
  // 本地 OCR 解析持仓截图（RapidOCR + 确定性表格还原，不联网、不经过视觉模型）
  // 返回脚本 JSON：{ok, engine, account, positions, expected_rows, confidence, warnings}
  const runLocalOcrHoldings = async (imageBase64, mimeType) => {
    const { spawn } = await import("node:child_process")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const fsp = await import("node:fs/promises")
    const ext = /jpe?g/i.test(String(mimeType || "")) ? ".jpg" : ".png"
    const tmp = join(tmpdir(), "dsh-holdings-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6) + ext)
    await fsp.writeFile(tmp, Buffer.from(imageBase64, "base64"))
    try {
      const script = process.env.DSH_INVEST_OCR_SCRIPT || (BASE_DIR + "/scripts/ocr_holdings.py")
      const pyCmd = await resolvePython()
      const stdout = await new Promise((resolve, reject) => {
        const child = spawn(pyCmd, [script, tmp], { cwd: BASE_DIR, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
        let out = ""
        let err = ""
        const timer = setTimeout(() => { try { child.kill() } catch (e) { /* ignore */ } reject(new Error("本地 OCR 超时（60 秒）")) }, 60000)
        child.stdout.on("data", (chunk) => { out += String(chunk) })
        child.stderr.on("data", (chunk) => { err += String(chunk) })
        child.on("error", (error) => { clearTimeout(timer); reject(error) })
        child.on("close", (code) => {
          clearTimeout(timer)
          if (code === 0 && out.trim()) resolve(out)
          else reject(new Error("本地 OCR 脚本退出码 " + code + (err.trim() ? "：" + err.trim().slice(0, 200) : "")))
        })
      })
      return JSON.parse(stdout)
    } finally {
      await fsp.unlink(tmp).catch(() => {})
    }
  }
  const recognizeScreenshot = async (imageBase64, mimeType) => {
    const attachments = ctx.get("attachments")
    if (!attachments || typeof attachments.admitPromptContent !== "function") throw new Error("附件服务不可用，无法上传截图")
    const instruction = "你是持仓截图识别器。只输出一个 JSON 对象，不要任何解释或代码围栏：{\"positions\":[{\"code\":\"600519.SH\",\"name\":\"贵州茅台\",\"shares\":100,\"cost\":1500,\"status\":\"持有\",\"note\":\"\"}],\"account\":{\"total_asset\":200000,\"cash\":50000}}。请真实读取截图中的证券代码、名称、持仓数量、成本价、账户总资产与可用资金；代码转换为 6 位+.SH/.SZ/.BJ，无法辨认的字段填 null，不要编造。"
    const prompt = await attachments.admitPromptContent([
      { type: "text", text: instruction },
      { type: "image", data: imageBase64, mediaType: mimeType || "image/png", name: "holdings-upload" },
    ])
    const text = await runVisionSubagent(prompt)
    const start = text.indexOf("{"), end = text.lastIndexOf("}")
    if (start < 0 || end <= start) throw new Error("模型未返回持仓 JSON，请人工核对后重试")
    let parsed
    try { parsed = JSON.parse(text.slice(start, end + 1)) } catch (e) { throw new Error("持仓 JSON 解析失败：" + String(e).slice(0, 120)) }
    if (!Array.isArray(parsed.positions)) throw new Error("识别结果缺少 positions 数组")
    return { positions: parsed.positions, account: parsed.account || {} }
  }

  // 模型设置：角色路由写 routes.json；模板预设写 settings.json（模板 > 角色 > 全局预设 > 继承宿主）
  const readJsonFile = async (path, fallback) => {
    const fs = ctx.get("fs")
    if (fs === void 0) return fallback
    try { return JSON.parse(await fs.readText(await fs.resolve(path))) } catch (e) { return fallback }
  }
  const writeJsonFile = async (path, value) => {
    const fs = ctx.get("fs")
    if (fs === void 0) throw new Error("fs unavailable")
    await fs.writeText(await fs.resolve(path), JSON.stringify(value, null, 2) + "\n", void 0, void 0, getFsPolicy())
  }
  // 写文件必须带沙箱 policy（宿主 workspace-write 模式会拒绝无 policy 的写入）
  const getFsPolicy = () => {
    try {
      const sp = ctx.get("sandboxPolicy")
      const agents = ctx.get("agents")
      const roots = agents && typeof agents.roots === "function" ? agents.roots() : []
      const agent = roots[roots.length - 1]
      return (sp !== void 0 && agent !== void 0) ? sp.resolve({ session: agent.session }) : void 0
    } catch (e) { return void 0 }
  }
  const resolveTemplatePreset = async (templateId, fallback) => {    const settings = await readJsonFile(SETTINGS_FILE, {})
    const value = settings.templates && settings.templates[templateId]
    return typeof value === "string" && PRESETS[value] ? value : (PRESETS[fallback] ? fallback : "inherit")
  }
  // ===== 个股分析知识库：报告按「个股」切段归集到 store/stocks/<代码>.md =====
  // 归因顺序：显式标记 <!--stock:600519.SH|贵州茅台--> → 含代码的小标题 → 行级提及节选
  let stockNotesCache = null
  let stockNotesBuilding = null
  const ensureStockNotes = async (fresh = false, hard = false) => {
    if (!fresh && stockNotesCache && Date.now() - stockNotesCache.at < 45000) return stockNotesCache.data
    if (stockNotesBuilding) return stockNotesBuilding
    stockNotesBuilding = (async () => {
      const indexDoc = await readJsonFile(STORE_INDEX, {})
      const names = {}
      const codeMap = (indexDoc && indexDoc.codes) || {}
      for (const [code, value] of Object.entries(codeMap)) {
        const normalized = normalizeCode(code)
        if (normalized && value && value.name) names[normalized] = String(value.name)
      }
      const codesByPath = {}
      for (const report of ((indexDoc && indexDoc.reports) || [])) {
        const p = String((report && report.path) || "").replace(/\\/g, "/")
        const file = p.split("/").pop()
        if (!file) continue
        codesByPath[file] = Array.isArray(report.codes) ? report.codes.map(normalizeCode).filter(Boolean) : []
      }
      const data = await buildStockNotes({
        reportsDir: REPORTS_DIR, storeFile: STOCK_NOTES_FILE, stocksDir: STOCK_NOTES_DIR,
        names, codesByPath, force: hard,
      })
      data.names = names
      stockNotesCache = { data, at: Date.now() }
      return data
    })().finally(() => { stockNotesBuilding = null })
    return stockNotesBuilding
  }
  // ===== 个股知识库「二次整理」：把散落节选合并成一篇可读文档（LLM 完成）=====
  // 状态落盘在 store/stocks/_curation.json；整理稿写 <代码>.md，原始记录仍在 <代码>.raw.md（buildStockNotes 维护）
  const STOCK_KB_STATE = STOCK_NOTES_DIR + "/_curation.json"
  const STOCK_KB_DEFAULT_MODEL = process.env.DSH_INVEST_KB_MODEL || "opencode-go/deepseek-v4.1-flash@low"
  const STOCK_KB_TIMEOUT_MS = Number(process.env.DSH_INVEST_KB_TIMEOUT_MS) > 0 ? Number(process.env.DSH_INVEST_KB_TIMEOUT_MS) : 180000
  const CURATION_VERSION = 1
  let curationCache = null
  const nowStamp = () => {
    const d = new Date()
    const p = (n) => String(n).padStart(2, "0")
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes())
  }
  const readCurationDoc = async () => {
    if (curationCache) return curationCache
    try {
      const raw = JSON.parse(await fsp.readFile(STOCK_KB_STATE, "utf8"))
      if (raw && raw.stocks && typeof raw.stocks === "object") { curationCache = raw; return curationCache }
    } catch (e) { /* 首次整理 */ }
    curationCache = { version: CURATION_VERSION, stocks: {} }
    return curationCache
  }
  const saveCurationDoc = async () => {
    const doc = curationCache
    if (!doc) return
    await withLock("stock-kb-state", async () => {
      try {
        await fsp.mkdir(STOCK_NOTES_DIR, { recursive: true })
        await fsp.writeFile(STOCK_KB_STATE, JSON.stringify(doc), "utf8")
      } catch (e) { /* 状态落盘失败不阻断整理 */ }
    })
  }
  const curatedFile = (code) => (STOCK_NOTES_DIR + "/" + stockFileName(code)).replace(/\\/g, "/")
  const readCurated = async (code) => { try { return await fsp.readFile(curatedFile(code), "utf8") } catch (e) { return "" } }
  const kbModelLabel = async () => {
    const settings = await readJsonFile(SETTINGS_FILE, {})
    const fromFile = settings && typeof settings.stockKbModel === "string" ? settings.stockKbModel.trim() : ""
    return fromFile || STOCK_KB_DEFAULT_MODEL
  }
  const pendingEntries = (doc, code, list) => {
    const item = (doc && doc.stocks && doc.stocks[code]) || {}
    const covered = new Set(Array.isArray(item.ids) ? item.ids : [])
    return (list || []).filter((entry) => !covered.has(entry.id))
  }
  const plainSnippet = (text, limit) => String(text || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/[#>*`|~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)

  // 单只整理：读既有整理稿 + 未收录的新材料 → LLM 重写整篇 → 结构校验后落盘
  const curateStock = async (code, options = {}) => {
    const data = await ensureStockNotes(false)
    const list = (data.stocks && data.stocks.get(code)) || []
    if (!list.length) return { skipped: "empty" }
    const doc = await readCurationDoc()
    const prev = doc.stocks[code] || {}
    if (prev.status === "running" && Date.now() - (prev.attemptAt || 0) < 10 * 60 * 1000) return { skipped: "running" }
    const fresh = options.full ? list.slice() : pendingEntries(doc, code, list)
    if (!fresh.length && !options.full && !options.rewrite) return { skipped: "no-new" }
    // 一次喂给模型的材料有上限：只把「真正喂进去的」记为已收录，剩余的下次继续（避免旧段被静默丢掉）
    const feed = fresh.slice(0, options.full ? 20 : 12)
    const oldKb = options.full ? "" : (prev.at ? await readCurated(code) : "")
    const name = (data.names && data.names[code]) || (list[0] && list[0].name) || ""
    const modelLabel = await kbModelLabel()
    const route = parseRoute(modelLabel)
    const started = Date.now()
    doc.stocks[code] = Object.assign({}, prev, { status: "running", attemptAt: started, model: modelLabel, error: "" })
    await saveCurationDoc()
    try {
      const prompt = buildCuratePrompt({
        code, name, oldKb, entries: feed,
        reports: new Set(list.map((entry) => entry.report)).size,
        now: nowStamp().slice(0, 10),
      })
      let answer = ""
      try {
        answer = await runPromptSubagent(prompt, { label: "知识库整理 " + code, timeoutMs: STOCK_KB_TIMEOUT_MS, agentOptions: route || void 0 })
      } catch (e) {
        if (!route) throw e
        // 配置的整理模型不可用（未注册/无权限）时回退宿主模型，整理不中断
        answer = await runPromptSubagent(prompt, { label: "知识库整理 " + code + "（回退宿主）", timeoutMs: STOCK_KB_TIMEOUT_MS })
      }
      const purified = sanitizeCurated(answer, { code, name })
      const invalid = validateCurated(purified)
      if (invalid) throw new Error(invalid)
      await fsp.mkdir(STOCK_NOTES_DIR, { recursive: true })
      await fsp.writeFile(curatedFile(code), purified, "utf8")
      doc.stocks[code] = {
        status: "done", at: nowStamp(), model: modelLabel,
        ids: Array.from(new Set([...(prev.ids || []), ...feed.map((entry) => entry.id)])).slice(-500),
        chars: purified.length, error: "", reports: new Set(list.map((entry) => entry.report)).size, ms: Date.now() - started,
      }
      await saveCurationDoc()
      return { ok: true, chars: purified.length, model: modelLabel }
    } catch (e) {
      doc.stocks[code] = Object.assign({}, prev, {
        status: "error", error: String((e && e.message) || e).slice(0, 300), model: modelLabel, attemptAt: Date.now(),
        ids: prev.ids || [], at: prev.at || "",
      })
      await saveCurationDoc()
      return { ok: false, error: String((e && e.message) || e).slice(0, 300) }
    }
  }
  // 串行队列：同时只整理一只股票，避免一次任务把模型额度打满
  const curateQueue = []
  let curateRunning = 0
  let curateFailStreak = 0
  let curateCooldownUntil = 0
  // 并发整理：每只股票一个子代理，默认 3 个同时跑；遇到连续失败自动冷却 60 秒再继续
  const kbConcurrency = async () => {
    const settings = await readJsonFile(SETTINGS_FILE, {})
    const n = Number(settings.stockKbConcurrency)
    if (Number.isFinite(n) && n >= 1) return Math.min(6, Math.floor(n))
    return 3
  }
  const drainCuration = async () => {
    const limit = await kbConcurrency()
    if (Date.now() < curateCooldownUntil) {
      const wait = Math.max(500, curateCooldownUntil - Date.now())
      const timer = setTimeout(() => { void drainCuration() }, wait)
      if (typeof timer.unref === "function") timer.unref()
      return
    }
    while (curateRunning < limit && curateQueue.length) {
      const job = curateQueue.shift()
      curateRunning += 1
      void (async () => {
        try {
          const result = await curateStock(job.code, job.options)
          if (result && result.ok === false) curateFailStreak += 1
          else curateFailStreak = 0
        } catch (e) {
          curateFailStreak += 1
        } finally {
          curateRunning -= 1
          // 连续失败（多半是限流/额度）先停 60 秒，别把队列一路撞穿
          if (curateFailStreak >= 3) {
            curateFailStreak = 0
            curateCooldownUntil = Date.now() + 60000
          }
          void drainCuration()
        }
      })()
    }
  }
  const requestCuration = (code, options) => {
    if (!code) return
    if (curateQueue.some((job) => job.code === code)) return
    const item = { code, options: options || {} }
    // 任务刚结束的（priority）排在最前，后台补历史时不能把新内容挤到几百条后面
    if (item.options.priority) curateQueue.unshift(item)
    else curateQueue.push(item)
    void drainCuration()
  }
  // 后台自动整理：落地页不点开也能把历史知识库慢慢整理完（默认开启，settings.json 的 stockKbAuto=false 可关）
  const kbAutoEnabled = async () => {
    const settings = await readJsonFile(SETTINGS_FILE, {})
    return settings.stockKbAuto !== false
  }
  const sweepCuration = async () => {
    try {
      if (process.env.DSH_INVEST_AUTO_CURATE === "0") return
      if (!(await kbAutoEnabled())) return
      const data = await ensureStockNotes(true)
      const doc = await readCurationDoc()
      const need = []
      for (const [code, list] of (((data && data.stocks) || new Map())).entries()) {
        if (!pendingEntries(doc, code, list).length) continue
        if (doc.stocks[code] && doc.stocks[code].status === "running") continue
        if (curateQueue.some((job) => job.code === code)) continue
        need.push({ code, newest: (list[0] && list[0].ts) || "" })
      }
      need.sort((a, b) => String(b.newest).localeCompare(String(a.newest)))
      need.forEach((item) => requestCuration(item.code))
    } catch (e) { /* 后台补整理失败不抛出 */ }
  }
  // 后台磁盘卫生（v0.44.0）：只清 cache 下 >30 天的取数/索引缓存（可再生，删除无副作用）。
  // scratch / 根目录临时脚本属于人工排查残留，**不自动清**——交给 tools/cleanup.js 手动执行，
  // 因为那类文件可能正被使用者手工排查中，自动清掉会让人困惑。
  // 旧实现的清理只扫 cache 顶层（非递归），导致子目录里的过期文件一直留着（实测 1179 个 / 44MB）。
  let lastCacheSweep = { at: "", removed: 0, error: "" }
  const sweepCacheFiles = async () => {
    try {
      const { readdirSync, statSync, rmSync } = await import("node:fs")
      const dir = BASE_DIR + "/.dsh-invest/cache"
      const cutoff = Date.now() - 30 * 86400000
      let removed = 0
      const walkDir = (d, depth) => {
        if (depth > 4) return
        let entries = []
        try { entries = readdirSync(d, { withFileTypes: true }) } catch (e) { return }
        for (const ent of entries) {
          const full = d + "/" + ent.name
          if (ent.isDirectory()) { walkDir(full, depth + 1); continue }
          try {
            if (statSync(full).mtimeMs < cutoff) { rmSync(full, { force: true }); removed += 1 }
          } catch (e) { /* 单文件失败忽略 */ }
        }
      }
      walkDir(dir, 0)
      lastCacheSweep = { at: new Date().toISOString(), removed, error: "" }
    } catch (e) {
      lastCacheSweep = { at: new Date().toISOString(), removed: 0, error: String(e).slice(0, 200) }
    }
  }
  // 任务结束后：把受影响的股票排进整理队列（最多 6 只，优先最近的）
  const requestCurationForTouched = async (data) => {
    if (process.env.DSH_INVEST_AUTO_CURATE === "0") return
    const doc = await readCurationDoc()
    const touched = []
    for (const [code, list] of ((data && data.stocks) || new Map()).entries()) {
      if (!pendingEntries(doc, code, list).length) continue
      touched.push({ code, newest: (list[0] && list[0].ts) || "" })
    }
    touched.sort((a, b) => String(b.newest).localeCompare(String(a.newest)))
    touched.slice(0, 6).forEach((item) => requestCuration(item.code, { priority: true }))
  }

  // 追问个股知识库：只依据整理稿（+未并入的最新材料）回答，知识库之后的变化明确说「可能滞后」
  const askStock = async (code, question, history) => {
    const q = String(question || "").trim()
    if (!q) throw new Error("请输入要追问的问题")
    const normalized = normalizeCode(code)
    if (!normalized) throw new Error("股票代码不合法")
    const data = await ensureStockNotes(false)
    const list = (data.stocks && data.stocks.get(normalized)) || []
    if (!list.length) throw new Error("该标的还没有知识库内容，先跑一次个股任务")
    const doc = await readCurationDoc()
    const item = doc.stocks[normalized] || {}
    const kb = (item.at ? await readCurated(normalized) : "") || rawTimelineMarkdown({
      code: normalized, name: (data.names && data.names[normalized]) || "", entries: list, updatedAt: nowStamp().slice(0, 10),
    })
    const fresh = pendingEntries(doc, normalized, list).slice(0, 5)
    const freshBlock = fresh.map((entry) => "### " + String(entry.ts || "").slice(0, 16) + " · " + (entry.mode || "投研") + "\n" + String(entry.text || "").slice(0, 1800)).join("\n\n")
    const turns = (Array.isArray(history) ? history : []).slice(-6)
      .map((turn) => (turn && turn.role === "assistant" ? "助手：" : "用户：") + String((turn && turn.text) || "").slice(0, 1200))
      .join("\n")
    const updatedAt = item.at || "尚未整理"
    const prompt = [
      "你是个股知识库的答疑助手。用户针对一只股票的「知识库」提问，你只依据知识库内容回答。",
      "规则：① 只用知识库里的事实、数字与结论，严禁编造行情、财报数字或评级；② 知识库没涉及的，明确说「知识库未涉及」并说明可以补哪些数据；" +
        "③ 知识库更新时间为 " + updatedAt + "，若问题涉及更晚的行情/事件，直接说明「知识库截至 " + updatedAt + "，可能滞后」，并建议用户跑一次个股任务更新，不要猜测；" +
        "④ 涉及操作建议时区分「知识库结论」与「你的补充推理」，补充部分注明是推理；⑤ 不要调用任何工具，只依据给定知识库；⑥ 用 Markdown 输出：一句话结论先行并加粗，对比信息用表格，默认 700 字以内。",
      "【标的】" + ((data.names && data.names[normalized]) || normalized) + "（" + normalized + "）",
      "【知识库更新于】" + updatedAt + (item.model ? " ｜ 整理模型：" + item.model : ""),
      "【知识库全文】\n" + String(kb).slice(0, 26000),
      freshBlock ? "【尚未并入知识库的最新材料】\n" + freshBlock : "",
      turns ? "【对话历史】\n" + turns : "",
      "【本轮问题】" + q.slice(0, 1500),
    ].filter(Boolean).join("\n\n")
    const started = Date.now()
    const answer = await runPromptSubagent(prompt, { label: "个股知识库追问", timeoutMs: 180000 })
    return {
      answer: String(answer || "").trim(), elapsedMs: Date.now() - started,
      kbUpdatedAt: item.at || "", kbStatus: item.status || "none", newEntries: fresh.length,
    }
  }

  const stockNotesListPayload = async (data) => {
    const names = (data && data.names) || {}
    const doc = await readCurationDoc()
    const stocks = Array.from(((data && data.stocks) || new Map()).entries()).map(([code, list]) => {
      const item = doc.stocks[code] || {}
      return {
        code,
        name: names[code] || (list[0] && list[0].name) || "",
        count: list.length,
        last_ts: (list[0] && list[0].ts) || "",
        modes: Array.from(new Set(list.map((entry) => entry.mode).filter(Boolean))).slice(0, 4),
        kinds: Array.from(new Set(list.map((entry) => entry.kind).filter(Boolean))).slice(0, 4),
        curated_at: item.at || "",
        kb_status: item.status || "none",
        new_entries: pendingEntries(doc, code, list).length,
      }
    })
    stocks.sort((a, b) => String(b.last_ts).localeCompare(String(a.last_ts)))
    return {
      built_at: (data.manifest && data.manifest.built_at) || "",
      stats: data.stats,
      stocks,
      orphans: (data.orphans || []).slice(0, 200),
      pending_curation: stocks.filter((stock) => stock.new_entries > 0).length,
      curating: curateRunning > 0 || curateQueue.length > 0,
      curating_count: curateRunning,
    }
  }
  const stockNotesDetailPayload = async (data, code) => {
    const names = (data && data.names) || {}
    const list = (data && data.stocks && data.stocks.get(code)) || []
    const doc = await readCurationDoc()
    const item = doc.stocks[code] || {}
    // 只有真正整理过（有 at）才用 <代码>.md；旧版本留下的「报告拼接稿」一律忽略，等二次整理覆盖
    const saved = item.at ? await readCurated(code) : ""
    const markdown = saved || rawTimelineMarkdown({
      code, name: names[code] || (list[0] && list[0].name) || "", entries: list, updatedAt: nowStamp().slice(0, 10),
    })
    const pending = pendingEntries(doc, code, list)
    const cooling = item.status === "error" && Date.now() - (item.attemptAt || 0) < 5 * 60 * 1000
    const autoCurate = process.env.DSH_INVEST_AUTO_CURATE !== "0"
    if (pending.length && item.status !== "running" && !cooling && autoCurate) requestCuration(code)
    // 状态要反映「真实在跑」：没有整理过、也没排队的，就是 raw（前端据此显示「待并入」而不是假装排队）
    const queued = curateQueue.some((job) => job.code === code) || item.status === "running"
    const status = item.status === "error" ? "error"
      : (queued || (pending.length && autoCurate && !cooling)) ? "queued"
        : item.at ? "done" : "raw"
    return {
      code,
      name: names[code] || (list[0] && list[0].name) || "",
      count: list.length,
      last_ts: (list[0] && list[0].ts) || "",
      updated_at: item.at || "",
      status: item.status === "running" ? "running" : status,
      model: item.model || (await kbModelLabel()),
      error: item.error || "",
      new_entries: pending.length,
      chars: markdown.length,
      file: curatedFile(code),
      markdown,
      entries: list.slice(0, 60).map((entry) => ({
        id: entry.id, ts: entry.ts, mode: entry.mode, kind: entry.kind, heading: entry.heading,
        report: entry.report, report_name: String(entry.report || "").split("/").pop(), chars: entry.chars,
        snippet: plainSnippet(entry.text, 260),
      })),
    }
  }
  // ===== 最近任务持久化（跨 web 关闭 / DSH 重启保留最近 5 个）=====
  const readRecentJobs = async () => {
    const doc = await readJsonFile(RECENT_JOBS_FILE, { jobs: [] })
    return Array.isArray(doc && doc.jobs) ? doc.jobs.filter((job) => job && job.id) : []
  }
  const rememberRecentJob = async (job) => {
    try {
      const list = await readRecentJobs()
      const entry = {
        id: job.id,
        templateId: job.templateId,
        name: job.name || "",
        mode: job.mode || "",
        question: String(job.question || "").slice(0, 200),
        status: job.status || "done",
        createdAt: job.createdAt || Date.now(),
        elapsedMs: job.elapsedMs || 0,
        error: String(job.error || "").slice(0, 300),
        reportPath: (job.result && Array.isArray(job.result.reports) && job.result.reports[0]) || "",
        finishedAt: new Date().toISOString(),
      }
      const next = [entry, ...list.filter((item) => item.id !== job.id)].slice(0, 5)
      await writeJsonFile(RECENT_JOBS_FILE, { updated_at: new Date().toISOString(), jobs: next })
    } catch (e) { /* 持久化失败不影响任务本身 */ }
  }
  // 会话宿主模型 = 当前会话根 Agent 的 provider/model（网页任务在 executeJob 里原本继承的就是它）
  const resolveSessionHostModel = () => {
    try {
      const agents = ctx.get("agents")
      const roots = agents && typeof agents.roots === "function" ? agents.roots() : []
      const host = roots[roots.length - 1]
      const opt = (host && host.options) ? host.options : {}
      const model = opt.model
      if (!model) return null
      const provider = opt.provider || ""
      return { provider, model, label: (provider ? provider + "/" : "") + model, source: "session" }
    } catch (e) { return null }
  }
  // 生效宿主模型 = 「模型设置」里选的覆盖（settings.defaultModel）优先，缺省回落会话模型
  const resolveHostModel = async () => {
    const settings = await readJsonFile(SETTINGS_FILE, {})
    const override = (typeof settings.defaultModel === "string" && settings.defaultModel.trim()) ? settings.defaultModel.trim() : ""
    if (override) {
      // 用 parseRoute 正确拆 provider/model@effort：model 里不能带 @max，推理强度要单独透传
      const parsed = parseRoute(override)
      if (parsed) {
        return {
          provider: parsed.provider,
          model: parsed.model,
          ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {}),
          label: override,
          source: "override",
        }
      }
      // 覆盖值非法（如手工改坏 settings.json）→ 静默回退会话模型，不阻断任务
    }
    const session = resolveSessionHostModel()
    return session ? { ...session, source: "session" } : null
  }
  // 模板 → 各角色生效路由（与 executeJob 的解析口径一致：预设 > 插件 config > routes.json）
  const resolveTemplateRouteMap = async (presetName) => {
    const fileRoutesRaw = (await readRoutesFile()) || {}
    const isTemplatePreset = presetName !== "inherit" && presetName !== DEFAULT_PRESET
    const fileRoutes = isTemplatePreset
      ? Object.fromEntries(Object.entries(fileRoutesRaw).filter(([, v]) => String(v).trim().toLowerCase() !== "inherit"))
      : fileRoutesRaw
    return mergeRoutes(presetName, PLUGIN_CONFIG.routes, fileRoutes, {})
  }
  const modelSettingsPayload = async () => {
    const fileRoutes = (await readRoutesFile()) || {}
    const effective = mergeRoutes(DEFAULT_PRESET, PLUGIN_CONFIG.routes, fileRoutes, {})
    const hostModel = await resolveHostModel()
    const sessionModel = resolveSessionHostModel()
    const hostLabel = hostModel ? hostModel.label : "未识别"
    const descriptions = {
      inherit: "继承当前宿主模型（默认）：" + hostLabel,
      fast: "快速档：DeepSeek V4 Flash，适合快诊/消息",
      budget: "经济档：低成本快速分析",
      balanced: "均衡档：速度与深度平衡",
      quality: "高质量档：更强模型与推理强度",
      "deepseek-only": "全部使用 DeepSeek 系列",
    }
    const presetNames = {
      inherit: "继承宿主",
      fast: "快速",
      budget: "经济快速",
      balanced: "均衡",
      quality: "高质量",
      "deepseek-only": "仅 DeepSeek",
    }
    return {
      hostModel,
      sessionModel,
      // 个股知识库二次整理模型（settings.json 的 stockKbModel 覆盖；默认便宜的 flash 低思考档）
      stockKb: {
        model: await kbModelLabel(),
        default: STOCK_KB_DEFAULT_MODEL,
        auto: await kbAutoEnabled(),
        concurrency: await kbConcurrency(),
        description: "把个股的历史分析节选整理成可读知识库时使用的模型",
      },
      roles: ROLE_CODES.map((code) => ({ code, name: ROLE_MAP[code].name, route: formatRouteChain(effective[code]) })),
      templates: await Promise.all(TASK_TEMPLATES.map(async (t) => ({ id: t.id, name: t.name, preset: await resolveTemplatePreset(t.id, t.preset) }))),
      presets: Object.keys(PRESETS).map((id) => ({ id, name: presetNames[id] || id, description: descriptions[id] || id })),
      modelOptions: await (async () => {
        const options = [{ value: "inherit", label: "跟随会话宿主（默认）" }]
        try {
          const llm = ctx.get("llm")
          if (!llm || typeof llm.listProviders !== "function" || typeof llm.listModels !== "function") return options
          for (const provider of llm.listProviders()) {
            try {
              const models = await llm.listModels(provider.id)
              for (const model of models) options.push({ value: provider.id + "/" + model.id, label: (provider.name || provider.id) + " / " + (model.name || model.id), provider: provider.id, model: model.id })
            } catch (e) { /* 单 provider 目录失败不阻断 */ }
          }
        } catch (e) { /* llm 不可用时保留 inherit */ }
        return options
      })(),
      routesFile: ROUTES_FILE,
      settingsFile: SETTINGS_FILE,
    }
  }

  // 股票名查找：索引 + 腾讯行情缓存，失败时回退腾讯智能搜索
  const lookupStockName = async (code) => {
    try {
      const idx = JSON.parse(await (ctx.get("fs")).readText(await (ctx.get("fs")).resolve(STORE_INDEX)))
      const c = idx.codes && idx.codes[code]
      if (c && c.name) return c.name
    } catch (e) { /* ignore */ }
    try {
      const h = await readHoldingsDoc()
      const p = (h.positions || []).find((x) => x.code === code)
      if (p && p.name) return p.name
    } catch (e) { /* ignore */ }
    return ""
  }
  const resolveNameToCode = async (name) => {
    const n = String(name).trim()
    const map = new Map()
    try {
      const idx = JSON.parse(await (ctx.get("fs")).readText(await (ctx.get("fs")).resolve(STORE_INDEX)))
      for (const [code, e] of Object.entries(idx.codes || {})) if (e.name) map.set(code, e.name)
    } catch (e) { /* ignore */ }
    try {
      const h = await readHoldingsDoc()
      for (const p of (h.positions || [])) if (p.name) map.set(p.code, p.name)
    } catch (e) { /* ignore */ }
    for (const [code, nm] of map) if (nm === n) return { code, name: nm, found: true }
    for (const [code, nm] of map) if (nm.includes(n) || n.includes(nm)) return { code, name: nm, found: true }
    try {
      const suffixOf = (d) => /^[69]/.test(d) ? "SH" : /^[023]/.test(d) ? "SZ" : /^159/.test(d) ? "SZ" : /^[458]/.test(d) ? "SH" : /^[48]/.test(d) ? "BJ" : "SH"
      const r = await fetch("https://smartbox.gtimg.cn/s3/?v=2&q=" + encodeURIComponent(n) + "&t=all")
      const t = await r.text()
      const m = t.match(/v_hint="([^"]*)"/)
      if (m) {
        const first = m[1].split(";")[0].split("~")
        if (first.length >= 2 && /^\d{6}$/.test(first[0])) {
          const code = first[0] + "." + suffixOf(first[0])
          return { code, name: first[1], found: true }
        }
      }
    } catch (e) { /* ignore */ }
    return null
  }

  // P2：一键任务模板（question 中 {code}/{input} 由网页传入）
  const TASK_TEMPLATES = [
    { id: "stock-review", name: "个股体检", description: "消息面 → 技术估值财务 → 综合决策", mode: "个股", roles: ["消息", "深度", "总判断"], preset: "inherit", needsCode: true, placeholder: "600519 或 600519.SH", question: "对 {code} 做深度体检：先取最新消息面，再做技术/估值/财务六维诊断，最后综合给出目标价、止损与失效条件。{input}" },
    { id: "stock-quick", name: "个股快诊", description: "快速技术估值判断 + 一句话结论", mode: "个股", roles: ["深度", "总判断"], preset: "fast", needsCode: true, placeholder: "600519 或 600519.SH", question: "对 {code} 做快速诊断：用必要行情与关键指标给出300字内结论、支撑/压力位、风险回报比与失效条件；结论文字限制300字不包含图表，图表照常生成。{input}" },
    { id: "portfolio-review", name: "组合体检", description: "持仓消息风险 + 逐只诊断 + 调仓建议", mode: "总判断", roles: ["消息", "深度", "总判断"], preset: "inherit", needsCode: false, placeholder: "", question: "复盘当前持仓账本：先排查持仓相关风险消息，再逐只核对成本、趋势、估值与止损，最后给出持有/加仓/减仓/离场及调仓优先级，并明确与上次结论的差异。{input}" },
    { id: "morning-news", name: "早盘异动", description: "隔夜消息与大盘 → 影响标的行情", mode: "消息", roles: ["消息", "选股"], preset: "fast", needsCode: false, placeholder: "", question: "扫描隔夜消息、政策、大盘情绪及持仓/近期关注标的异动，随后补充受影响标的的最新行情与相对强弱，按可信度和影响排序。{input}" },
    { id: "swing-weekly", name: "波段周检", description: "双池准入复核 → 纸面决策（v3.0）", mode: "波段池", roles: ["波段", "总判断"], sequence: ["波段", "总判断"], preset: "inherit", needsCode: false, placeholder: "", question: "执行本周波段池周检（纪律 v3.0，状态 S1 纸面前向验证：只记纸面虚拟买卖点，不投入任何资金，输出一律标【纸面】）：\n① 读取 .dsh-invest/波段池_持仓.md 台账；\n② 按**所属池**逐一复核准入——反转池 R：R1 估值分位（近 3 年日历窗 PE/PB ≤30%）/ R2 周线止跌 / R3 基本面不恶化；动量池 M：M1 周收盘站上 30 周线且 20 周线斜率≥0 / M2 突破周量≥前 4 周均量 1.5 倍 / M3 收盘距 30 周线≤+35%；\n③ 逐只给纸面指令（继续持有/加仓≤1次/减仓/清仓/移出观察/换池），并校验高价股硬闸 P_max=单票上限%×总资产÷100（反转池 20%、动量池 15%），股价超限即不可建仓，禁止用\"只买一手\"绕过；\n④ 对拟持有标的给出三行模板（买入理由/失效条件/时间盒）与赔率=(目标−成本)/(成本−止损)，赔率<3:1 一律挂观察；\n⑤ 更新台账，并把本次周检写入「周检记录」；\n⑥ 最后尝试推送 NAS：powershell -File E:\\Dsh_WorkSapce\\Dify_Agents\\scripts\\swing-weekly.ps1（NAS 离线时脚本自动降级为本地镜像，失败不得阻断周检）。\n纪律：出场取「或」——−15% 硬止损 / 动量池周收盘破 30 周线 / 自峰值回撤 20% / 满 126 交易日收割；反转池用逻辑止损+估值止损替代趋势止损；严禁固定百分比移动止盈；持仓合计≤4 只；每月最多 1 次调仓。{input}" },
    { id: "watch-daily", name: "观察仓日检", description: "观察仓批量刷新 → 触发者逐只判断是否买入（默认每日自动）", mode: "个股", roles: ["深度", "总判断"], sequence: ["深度", "总判断"], preset: "balanced", needsCode: false, placeholder: "", question: "执行观察仓日检：只处理标的档案中 state=观察 的标的，不重跑全市场选股。\n① 用 pwsh 读取台账 " + BASE_DIR + "/.dsh-invest/store/watchlist.json（关键字段：code/name/state、watch.buy_low/buy_high/ideal_buy/stop/invalidate_if/thesis、monitor.current_price）；台账不存在或观察仓为空时，直接说明「观察仓为空」并结束，不要改跑全市场选股。\n② 对每只用 Tushare 日线（daily，最近 60 个交易日）+ 最新价格复核：现价是否已进入买入区间、原买入逻辑（thesis）是否仍成立、失效条件（invalidate_if）是否已被触发。\n③ 每只结论只能三选一：**可买**（给建议买入价、首批股数、止损、赔率=(目标−成本)/(成本−止损)）/ **继续观察**（给等待价与触发条件）/ **放弃**（给理由，建议移出观察）。\n④ 多只可买时按赔率排序，并校验仓位约束：单票≤25%、单日新增≤总仓位 50%；赔率<3:1 一律归入继续观察。\n⑤ 报告按「可买 / 继续观察 / 放弃」三段分组，先给结论表再给理由，全文不超过 1000 字。\n⑥ 每只标的各输出一行【结论结构化】JSON（code/stance/target/stop/buy_low/buy_high/thesis/invalidate_if），stance 取 看多/观察/拒绝。\n{input}" },
    { id: "market-screen-full", name: "海选·全流程", description: "选股 → 消息核验 → 深度 → 总判断（四角色严格串行）", mode: "选股", roles: ["选股", "消息", "深度", "总判断"], sequence: ["选股", "消息", "深度", "总判断"], preset: "balanced", needsCode: false, placeholder: "", question: "全市场海选全流程（四阶段严格串行，每层只做自己那段，不要重复上游已取的数据）：\n【只要新标的】候选池必须排除账户当前持仓（已持有标的不得进入候选、评分与买入计划）。\n① 选股：扫全市场，候选池 ≤8 只，逐只给评分/入场区间/止损/建议仓位（单票≤25%）。\n② 消息：只针对这 ≤8 只候选及其所属主线做定向消息核验（催化、风险、情绪阶段），显式标注「消息面无支撑」的标的；只做信息整理，不给买卖结论。\n③ 深度：只对评分最高的 3-4 只做技术/资金/财务深度诊断，给出失效条件；不要展开未被选中的标的。\n④ 总判断：在组合层面给出最终 ≤3 只的优先级排序、仓位分配、相关性与调仓顺序（结合当前持仓避免重复暴露），并说明与上次结论的差异。{input}" },
  ]
  const jobStore = Object.create(null)
  const jobOrder = []
  const taskQueue = []
  let reindexPromise = null

  const readRequestJson = async (req, maxBytes = 1048576) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buf.length
      if (size > maxBytes) {
        try { req.resume() } catch (e) { /* ignore */ }
        throw new Error("上传内容过大（上限 " + Math.round(maxBytes / 1048576) + " MB），请压缩图片后重试")
      }
      chunks.push(buf)
    }
    const text = Buffer.concat(chunks).toString("utf8")
    return text.trim() ? JSON.parse(text) : {}
  }

  const runReindex = (force) => {
    // 调试/测试开关：跳过索引重建（避免测试环境 spawn python 拖慢或占用临时目录）
    if (process.env.DSH_INVEST_SKIP_REINDEX === "1") return Promise.resolve({})
    // force=true：忽略在途/缓存的重建任务，强制用最新落盘数据重建一次
    if (reindexPromise && !force) return reindexPromise
    const tracked = (async () => {
      const { spawn } = await import("node:child_process")
      const pyCmd = await resolvePython()
      await new Promise((resolve, reject) => {
        const child = spawn(pyCmd, [BASE_DIR + "/tools/index_store.py"], { cwd: BASE_DIR, stdio: "ignore", windowsHide: true })
        const timer = setTimeout(() => { child.kill(); reject(new Error("index_store timeout")) }, 90000)
        child.on("error", (e) => { clearTimeout(timer); reject(e) })
        child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("index_store exit " + code)) })
      })
      const fs = ctx.get("fs")
      if (fs !== void 0) {
        try { return JSON.parse(await fs.readText(await fs.resolve(STORE_INDEX))).stats || {} } catch (e) { return {} }
      }
      return {}
    })()
    const settled = tracked.finally(() => { if (reindexPromise === settled) reindexPromise = null })
    reindexPromise = settled
    return settled
  }

  // ===== 运行日志：追加 + 回读校验 + 两级兜底（失败必留痕，绝不静默）=====
  const appendRunLogLine = async (line, policyArg) => {
    const fs = ctx.get("fs")
    let firstError = ""
    // 通道 1：宿主 fs（带 sandbox policy），写后回读校验，避免"以为写了其实没写"
    if (fs !== void 0) {
      try {
        await withLock("runs", async () => {
          const target = await fs.resolve(RUNS_LOG)
          let existing = ""
          try { existing = await fs.readText(target) } catch (e) { /* 首次不存在 */ }
          await fs.writeText(target, existing + line, void 0, void 0, policyArg)
          const after = await fs.readText(target)
          if (!String(after || "").endsWith(line)) throw new Error("写入校验失败：回读未发现新日志行")
        })
        return ""
      } catch (e) { firstError = "宿主 fs 写入失败：" + String(e).slice(0, 200) }
    }
    // 通道 2：node:fs 直接追加（追加写本身原子，无需锁）
    try {
      const { appendFile } = await import("node:fs/promises")
      await appendFile(RUNS_LOG, line, "utf8")
      return firstError ? firstError + "（已用 node:fs 兜底写入成功）" : ""
    } catch (e) {
      return (firstError ? firstError + " ｜ " : "") + "node:fs 追加也失败：" + String(e).slice(0, 200)
    }
  }
  // 清理运行日志里的重复行（历史自愈按索引重复行批量补写，导致同一任务出现多条）
  // 只删「完全同任务」的重复：recovered 行按 ts+question+mode 判定，普通行按原文判定；
  // 重复时优先保留 reportPath 指向 .dsh-invest/reports/ 的主报告行。改写前先备份。
  const compactRunLog = async () => {
    const fs = ctx.get("fs")
    if (fs === void 0) throw new Error("fs unavailable")
    let text = ""
    try { text = await fs.readText(await fs.resolve(RUNS_LOG)) } catch (e) { return { removed: 0, total: 0 } }
    const lines = String(text || "").split("\n").filter((line) => line.trim())
    if (!lines.length) return { removed: 0, total: 0 }
    const isPrimary = (value) => /\/\.dsh-invest\/reports\//i.test(String(value || "").replace(/\\/g, "/"))
    // 该秒已有真实埋点 → 说明当时任务自己写过日志，补写行是重复（索引按秒匹配会把同一份报告挂给多个 run）
    const stampOf = (value) => {
      const d = new Date(value)
      if (Number.isNaN(d.getTime())) return ""
      const pad = (n) => String(n).padStart(2, "0")
      return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
    }
    const realStamps = new Set()
    for (const line of lines) {
      try { const rec = JSON.parse(line); if (rec && !rec.recovered) realStamps.add(stampOf(rec.ts)) } catch (e) { /* 坏行忽略 */ }
    }
    const kept = []
    const indexByKey = new Map()
    for (const line of lines) {
      let rec = null
      try { rec = JSON.parse(line) } catch (e) { rec = null }
      if (rec && rec.recovered && realStamps.has(stampOf(rec.ts))) continue
      const key = rec && rec.recovered
        ? "rec|" + rec.ts + "|" + (rec.question || "") + "|" + (rec.mode || "")
        : "raw|" + line.trim()
      const at = indexByKey.get(key)
      if (at === undefined) { indexByKey.set(key, kept.length); kept.push(line); continue }
      let prevRec = null
      try { prevRec = JSON.parse(kept[at]) } catch (e) { prevRec = null }
      if (rec && rec.recovered && isPrimary(rec.reportPath) && !isPrimary(prevRec && prevRec.reportPath)) kept[at] = line
    }
    if (kept.length === lines.length) return { removed: 0, total: lines.length }
    const backup = RUNS_LOG + ".bak-" + Date.now()
    try { await fs.writeText(await fs.resolve(backup), text, void 0, void 0, getFsPolicy()) } catch (e) { /* 备份失败不阻断 */ }
    await fs.writeText(await fs.resolve(RUNS_LOG), kept.join("\n") + "\n", void 0, void 0, getFsPolicy())
    return { removed: lines.length - kept.length, total: kept.length, backup }
  }
  // 自愈：把「有报告、无运行日志」的历史任务补写进 runs.jsonl（只补客观字段，不伪造 stage/耗时）
  const guessModeFromTitle = (title) => {
    const t = String(title || "")
    if (/海选|选股/.test(t)) return "选股"
    if (/复盘|组合|持仓|调仓/.test(t)) return "总判断"
    if (/消息|异动|盘中/.test(t)) return "消息"
    if (/个股|体检|快诊|诊断/.test(t)) return "个股"
    return "组合"
  }
  const repairRunLog = async () => {
    const fs = ctx.get("fs")
    if (fs === void 0) throw new Error("fs 服务不可用")
    const readTextSafe = async (p) => { try { return await fs.readText(await fs.resolve(p)) } catch (e) { return "" } }
    const logText = await readTextSafe(RUNS_LOG)
    const lines = String(logText || "").split("\n").filter((line) => line.trim())
    const covered = new Set()
    const callIds = new Set()
    for (const line of lines) {
      try {
        const rec = JSON.parse(line)
        if (Array.isArray(rec.reports)) rec.reports.forEach((p) => { if (p) covered.add(String(p).replace(/\\/g, "/").toLowerCase()) })
        if (rec.reportPath) covered.add(String(rec.reportPath).replace(/\\/g, "/").toLowerCase())
        if (rec.callId) callIds.add(String(rec.callId))
      } catch (e) { /* 坏行跳过 */ }
    }
    const index = JSON.parse(await readTextSafe(STORE_INDEX) || "{}")
    const reports = Array.isArray(index.reports) ? index.reports : []
    const additions = []
    const seenTask = new Set()
    for (const report of reports) {
      const path = String(report.path || "")
      if (!path) continue
      if (covered.has(path.replace(/\\/g, "/").toLowerCase())) continue
      if (report.run_id !== undefined && report.run_id !== null && callIds.has(String(report.run_id))) continue
      const m = path.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/)
      if (!m) continue
      const title = path.replace(/\\/g, "/").split("/").find((seg) => /^\d{8}_\d{6}/.test(seg)) || ""
      const clean = title.replace(/^\d{8}_\d{6}_[a-z0-9]+_?/i, "").replace(/\.md$/i, "").replace(/_/g, " ").trim()
      // 批内去重：索引里同一份报告可能有多行，绝不能一次批量写多条
      const taskKey = m[1] + m[2] + m[3] + m[4] + m[5] + m[6] + "|" + clean
      if (seenTask.has(taskKey)) continue
      seenTask.add(taskKey)
      additions.push(JSON.stringify({
        ts: new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).toISOString(),
        mode: guessModeFromTitle(clean),
        question: String(clean || "报告归档").slice(0, 200),
        callId: report.run_id !== undefined && report.run_id !== null ? String(report.run_id) : `report-${report.id}`,
        ok: true,
        elapsedMs: 0,
        stages: [],
        charts: Array.isArray(report.charts) ? report.charts.length : 0,
        reports: 1,
        recovered: true,
        reportPath: path,
      }) + "\n")
    }
    if (!additions.length) return { appended: 0, total: lines.length }
    const payload = additions.join("")
    let error = await appendRunLogLine(payload, getFsPolicy())
    if (error) return { appended: 0, error, total: lines.length }
    // 补写后必须让索引跟上：用 force 重建（跳过在途任务），并核对索引里的 runs 是否已覆盖新行
    let reindexed = false
    let reindexError = ""
    for (let attempt = 1; attempt <= 2 && !reindexed; attempt += 1) {
      try {
        const stats = await runReindex(true)
        const runsInIndex = Number(stats && stats.runs)
        const expected = lines.length + additions.length
        if (!Number.isFinite(runsInIndex)) reindexed = true
        else if (runsInIndex >= expected) reindexed = true
        else reindexError = "索引 runs=" + runsInIndex + " 少于日志行数 " + expected
      } catch (e) { reindexError = String(e && e.message ? e.message : e).slice(0, 200) }
      if (!reindexed && attempt === 1) await new Promise((resolve) => setTimeout(resolve, 800))
    }
    return { appended: additions.length, total: lines.length + additions.length, reindexed, reindexError }
  }

  const jobSummary = (job, full) => {
    const out = {
      id: job.id, templateId: job.templateId, name: job.name, mode: job.mode || "", status: job.status,
      sequence: Array.isArray(job.sequence) ? job.sequence : null,
      question: job.question, createdAt: job.createdAt, startedAt: job.startedAt || 0,
      elapsedMs: job.status === "running" && job.startedAt ? Date.now() - job.startedAt : (job.elapsedMs || 0), error: job.error || "",
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

  // ============ 判断质量回测（v0.44.0）：conclusions.jsonl × 日线 → 命中率 ============
  // 数据源：每次流水线末尾【结论结构化】行（persistConclusions 落库，68 条起步持续积累）。
  // 口径：以结论日后第一个交易日收盘为基准，看第 5 / 20 个交易日收盘的涨跌（另计超额 vs 上证指数）。
  // 命中定义：看多/持有/加仓 → 上涨命中；拒绝/回避/减仓/离场 → 下跌命中；观察不计命中率（单独看后续走势）。
  // 日线来源：cache/pack/daily_<code>_<endYmd>.json（fetch_pack / stockchart 产生，同 key 复用），
  // 无缓存时按需从 Tushare 拉 400 自然日并回写缓存；指数用 000001.SH。
  const BACKTEST_IDX_CODE = "000001.SH"
  const btRound = (v) => (typeof v === "number" && Number.isFinite(v)) ? Math.round(v * 100) / 100 : null
  const btReadToken = async () => {
    try {
      const { readFileSync } = await import("node:fs")
      const t = String(readFileSync(BASE_DIR + "/.dsh-invest/tushare.token", "utf8")).trim()
      return t || ""
    } catch (e) { return "" }
  }
  // 读某 code 最新的日线缓存；没有则在线拉取（400 自然日）并回写。
  // isIndex=true 时用 index_daily 接口（Tushare 的 daily 不支持指数代码）。
  const btDaily = async (code, token, isIndex) => {
    const { readdirSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs")
    const dir = BASE_DIR + "/.dsh-invest/cache/pack"
    const prefix = "daily_" + code.replace(/\./g, "_") + "_"
    let best = "", bestDate = ""
    try {
      for (const f of readdirSync(dir)) {
        if (!f.startsWith(prefix) || !f.endsWith(".json")) continue
        const d = f.slice(prefix.length, -5)
        if (d > bestDate) { bestDate = d; best = f }
      }
    } catch (e) { /* 目录不存在 */ }
    if (best) {
      try {
        const rows = JSON.parse(readFileSync(dir + "/" + best, "utf8")).rows
        if (Array.isArray(rows) && rows.length >= 30) return rows
      } catch (e) { /* 坏缓存，走在线 */ }
    }
    if (!token) return null
    const p2 = (n) => String(n).padStart(2, "0")
    const ymd = (d) => "" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate())
    const end = new Date()
    const start = new Date(end.getTime() - 400 * 86400000)
    try {
      const r = await fetch("https://api.tushare.pro", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_name: isIndex ? "index_daily" : "daily", token, params: { ts_code: code, start_date: ymd(start), end_date: ymd(end) } }),
      })
      const j = JSON.parse(await r.text())
      if (j.code !== 0 || !j.data || !Array.isArray(j.data.items)) return null
      const fields = j.data.fields
      const rows = j.data.items.map((it) => { const o = {}; fields.forEach((k, i) => { o[k] = it[i] }); return o })
        .sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))
      if (rows.length < 30) return null
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(dir + "/" + prefix + ymd(end) + ".json", JSON.stringify({ code, endYmd: ymd(end), rows }))
      } catch (e) { /* 回写失败不影响本次 */ }
      return rows
    } catch (e) { return null }
  }
  const computeBacktest = async () => {
    const fs0 = ctx.get("fs")
    const readSafe = async (p) => {
      if (fs0 !== void 0) { try { return await fs0.readText(await fs0.resolve(p)) } catch (e) { /* fallthrough */ } }
      try { const { readFileSync } = await import("node:fs"); return readFileSync(p, "utf8") } catch (e) { return "" }
    }
    const text = await readSafe(CONCLUSIONS_LOG)
    const conclusions = String(text || "").split("\n").filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l) } catch (e) { return null }
    }).filter((r) => r && typeof r.code === "string" && /^\d{6}\.(SH|SZ|BJ)$/.test(r.code) && r.ts)
    if (!conclusions.length) return { total: 0, matched: 0, rows: [], byStage: [], byStance: [], byMonth: [], overall: null, warnings: ["conclusions.jsonl 暂无有效结论"], generatedAt: new Date().toISOString(), lastTradeDate: "" }
    const token = await btReadToken()
    const warnings = []
    const codes = Array.from(new Set(conclusions.map((c) => c.code)))
    const daily = {}
    for (const code of codes) {
      daily[code] = await btDaily(code, token)
      if (!daily[code]) warnings.push(code + "：无日线数据（缓存与 Tushare 均失败）")
    }
    const idx = await btDaily(BACKTEST_IDX_CODE, token, true)
    const idxDates = idx ? idx.map((x) => String(x.trade_date)) : []
    const rows = []
    for (const c of conclusions) {
      const r = daily[c.code]
      if (!r) continue
      const dates = r.map((x) => String(x.trade_date))
      const tsYmd = String(c.ts).slice(0, 10).replace(/-/g, "")
      const i = dates.findIndex((d) => d >= tsYmd)
      if (i < 0) continue
      const base = Number(r[i].close)
      if (!Number.isFinite(base) || base <= 0) continue
      const closeAt = (n) => (i + n < r.length) ? Number(r[i + n].close) : null
      const fwd5 = closeAt(5), fwd20 = closeAt(20)
      const ret5 = fwd5 !== null ? (fwd5 / base - 1) * 100 : null
      const ret20 = fwd20 !== null ? (fwd20 / base - 1) * 100 : null
      // 超额 = 个股区间收益 − 上证指数同区间收益
      let ex5 = null, ex20 = null
      if (idx) {
        const j = idxDates.findIndex((d) => d >= tsYmd)
        if (j >= 0) {
          const ibase = Number(idx[j].close)
          if (ibase > 0) {
            const ifwd5 = j + 5 < idx.length ? Number(idx[j + 5].close) : null
            const ifwd20 = j + 20 < idx.length ? Number(idx[j + 20].close) : null
            if (ret5 !== null && ifwd5 !== null) ex5 = ret5 - (ifwd5 / ibase - 1) * 100
            if (ret20 !== null && ifwd20 !== null) ex20 = ret20 - (ifwd20 / ibase - 1) * 100
          }
        }
      }
      const bullish = ["看多", "持有", "加仓"].includes(c.stance)
      const bearish = ["拒绝", "回避", "减仓", "离场"].includes(c.stance)
      const directional = bullish || bearish
      rows.push({
        ts: c.ts, code: c.code, stance: String(c.stance || ""), stage: String(c.stage || ""), mode: String(c.mode || ""),
        base: btRound(base), target: (typeof c.target === "number" ? c.target : null),
        ret5: btRound(ret5), ret20: btRound(ret20), ex5: btRound(ex5), ex20: btRound(ex20),
        hit5: (ret5 === null || !directional) ? null : (bullish ? ret5 > 0 : ret5 < 0),
        hit20: (ret20 === null || !directional) ? null : (bullish ? ret20 > 0 : ret20 < 0),
        thesis: String(c.thesis || "").slice(0, 80),
      })
    }
    rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    const agg = (list) => {
      const h5 = list.filter((x) => x.hit5 !== null && x.hit5 !== undefined)
      const h20 = list.filter((x) => x.hit20 !== null && x.hit20 !== undefined)
      const r5 = list.filter((x) => x.ret5 !== null)
      const r20 = list.filter((x) => x.ret20 !== null)
      const e5 = list.filter((x) => x.ex5 !== null)
      const e20 = list.filter((x) => x.ex20 !== null)
      const avg = (arr, k) => arr.length ? btRound(arr.reduce((a, x) => a + x[k], 0) / arr.length) : null
      return {
        samples: list.length,
        hits5: h5.length, rate5: h5.length ? btRound(h5.filter((x) => x.hit5).length / h5.length * 100) : null,
        hits20: h20.length, rate20: h20.length ? btRound(h20.filter((x) => x.hit20).length / h20.length * 100) : null,
        avgRet5: avg(r5, "ret5"), avgRet20: avg(r20, "ret20"),
        avgEx5: avg(e5, "ex5"), avgEx20: avg(e20, "ex20"),
      }
    }
    const groupAgg = (keyFn) => {
      const map = new Map()
      for (const x of rows) {
        const k = keyFn(x) || "—"
        if (!map.has(k)) map.set(k, [])
        map.get(k).push(x)
      }
      return Array.from(map.entries()).map(([name, list]) => ({ name, ...agg(list) })).sort((a, b) => b.samples - a.samples)
    }
    const lastTradeDate = datesOfLatest(daily)
    return {
      generatedAt: new Date().toISOString(),
      total: conclusions.length, matched: rows.length,
      overall: agg(rows),
      byStage: groupAgg((x) => x.stage), byStance: groupAgg((x) => x.stance),
      byMonth: groupAgg((x) => String(x.ts).slice(0, 7)),
      rows: rows.slice(-300), warnings, lastTradeDate,
    }
  }
  function datesOfLatest(daily) {
    let latest = ""
    for (const rows of Object.values(daily)) {
      if (!Array.isArray(rows)) continue
      for (const r of rows) { const d = String(r.trade_date); if (d > latest) latest = d }
    }
    return latest
  }

  const executeJob = async (job) => {
    job.status = "running"
    job.startedAt = Date.now()
    let taskHandle = null
    try {
      const agents = ctx.get("agents")
      // 方案A：为本次任务创建专用执行 Agent，与当前对话彻底隔离（不挂在聊天下）
      let parent = null
      if (agents && typeof agents.create === "function") {
        try {
          const sid = (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
            ? globalThis.crypto.randomUUID()
            : "wb-task-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
          // 专用 Agent 装上宿主模型：使"继承宿主"类角色能继承到有效模型
          // 宿主模型优先级：模型设置里的覆盖（settings.defaultModel）> 当前会话根 Agent 的模型
          const roots0 = agents.roots ? agents.roots() : []
          const hostAgent = roots0[roots0.length - 1]
          const hostModel = await resolveHostModel()
          const agentOptions = hostModel
            ? {
                provider: hostModel.provider,
                model: hostModel.model,
                ...(hostModel.reasoningEffort ? { reasoningEffort: hostModel.reasoningEffort } : {}),
              }
            : (hostAgent && hostAgent.options ? { provider: hostAgent.options.provider, model: hostAgent.options.model } : {})
          taskHandle = await agents.create({ sessionId: sid, agentOptions })
          parent = taskHandle.agent
          // 给专用 Agent 会话补沙箱模式（同对话会话 danger-full-access），
          // 否则子代理继承默认受限沙箱，写不了文件/起不了终端（Tushare/图表/报告全废）
          try {
            if (parent.session && typeof parent.session.append === "function") {
              parent.session.append("sandbox/mode", { mode: "danger-full-access" })
            }
          } catch (e) { /* ignore */ }
        } catch (e) { /* 创建失败则回退到顶层 Agent */ }
      }
      if (!parent) {
        const roots = agents && typeof agents.roots === "function" ? agents.roots() : []
        parent = roots[roots.length - 1]
      }
      if (!parent) throw new Error("当前没有可用的执行 Agent；请先打开一个 DSH 会话再启动网页任务")
      const controller = new AbortController()
      job.abort = () => controller.abort()
      const preset = await resolveTemplatePreset(job.templateId, job.preset)
      const result = await tool.execute({ mode: job.mode, question: job.question, roles: job.roles, preset, detail: "full", ...(Array.isArray(job.sequence) && job.sequence.length ? { sequence: job.sequence } : {}) }, { callId: job.id, agent: parent, signal: controller.signal })
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
      // 最近任务持久化（最近 5 个，跨 web 关闭/DSH 重启保留）
      try { await rememberRecentJob(job) } catch (e) { /* ignore */ }
      // 释放专用任务执行 Agent（该任务的分析子代理已完成）
      if (taskHandle && typeof taskHandle.dispose === "function") {
        try { await taskHandle.dispose() } catch (e) { /* ignore */ }
      }
      try { job.reindexStats = await runReindex() } catch (e) { job.reindexError = String(e).slice(0, 200) }
      // 报告落盘后刷新个股知识库（增量），并把有新材料的股票排进「二次整理」队列
      if (process.env.DSH_INVEST_SKIP_STOCK_NOTES !== "1") {
        try {
          const notes = await ensureStockNotes(true)
          await requestCurationForTouched(notes)
        } catch (e) { /* ignore */ }
      }
    }
  }

  // 任务并发度：默认 2；DSH_INVEST_JOB_CONCURRENCY=1 可退回旧的串行行为（上限 6）
  const jobConcurrency = () => {
    const fromEnv = Number(process.env.DSH_INVEST_JOB_CONCURRENCY)
    return (Number.isFinite(fromEnv) && fromEnv >= 1) ? Math.min(6, Math.floor(fromEnv)) : 2
  }
  // 并发池：同时最多 N 个任务在跑，其余排队；每个任务结束立即补位
  const runningJobs = new Set()
  const pumpJobs = () => {
    const limit = jobConcurrency()
    while (runningJobs.size < limit && taskQueue.length) {
      const job = taskQueue.shift()
      runningJobs.add(job)
      void executeJob(job)
        .catch(() => { /* executeJob 内部已兜底 */ })
        .finally(() => { runningJobs.delete(job); pumpJobs() })
    }
  }

  const enqueueJob = (template, code, custom) => {
    if (taskQueue.length >= 8) throw new Error("任务队列已满，请等待现有任务完成")
    const id = "job_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7)
    const question = template.question.replaceAll("{code}", code || "").replaceAll("{input}", custom ? "\n补充要求：" + custom : "")
    const job = { id, templateId: template.id, name: template.name, mode: template.mode, roles: template.roles, sequence: Array.isArray(template.sequence) ? template.sequence : null, preset: template.preset || "inherit", question, status: "queued", createdAt: Date.now(), elapsedMs: 0 }
    jobStore[id] = job
    jobOrder.push(id)
    if (jobOrder.length > 30) { const old = jobOrder.shift(); if (jobStore[old] && jobStore[old].status !== "running") delete jobStore[old] }
    taskQueue.push(job)
    void pumpJobs()
    return job
  }

  // ============ 观察仓日检（watch-daily）：规则层天天跑，LLM 层只跑触发者 ============
  const WATCH_DAILY_DEFAULTS = {
    enabled: true, at: "15:10",
    bootYmd: "", closeYmd: "", // 开机补跑 / 收盘定时 各自每天只跑一次的日期标记
    lastRunAt: "", lastTrigger: "", lastStatus: "", lastTriggered: [], lastJobId: "", lastNote: "",
  }
  const readWatchDaily = async () => {
    const raw = await readJsonFile(WATCH_DAILY_FILE, {})
    return Object.assign({}, WATCH_DAILY_DEFAULTS, (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {})
  }
  const patchWatchDaily = async (patch) => {
    const next = Object.assign({}, await readWatchDaily(), patch, { updated_at: new Date().toISOString() })
    await writeJsonFile(WATCH_DAILY_FILE, next)
    return next
  }
  // 本地 HH:MM（日检定时用本机时区，不做 UTC 转换）
  const localHm = (d) => {
    const t = d || new Date()
    return String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0")
  }
  // 只做工作日闸：法定节假日照跑，靠「没有新日线」自然降级（Tushare 仍返回上一交易日）
  const isTradingWeekday = () => { const w = new Date().getDay(); return w >= 1 && w <= 5 }
  const watchDailyBusy = () => jobOrder.some((id) => {
    const j = jobStore[id]
    return Boolean(j && j.templateId === "watch-daily" && (j.status === "running" || j.status === "queued"))
  })

  const runWatchDaily = async (trigger) => {
    if (watchDailyBusy()) return { ok: false, skipped: "running", message: "已有观察仓日检任务在跑，本次跳过" }
    try { await reconcileWatchFromHoldings() } catch (e) { /* 对账失败不阻断日检 */ }
    const r = await refreshWatchPrices()
    const watchOnly = (r.doc.items || []).filter((it) => it && it.state === "观察")
    // 规则层触发集合：只有「进入买区」「跌破失效价」两种需要再做买入判断
    const hits = r.fired.filter((a) => a && a.state === "观察" && (a.kind === "buy" || a.kind === "invalidate"))
    const base = { checkedAt: localHm(), watchCount: watchOnly.length, refreshed: r.refreshed, fetchedAt: r.fetchedAt }
    if (!hits.length) {
      const st = await patchWatchDaily({ lastRunAt: new Date().toISOString(), lastTrigger: trigger, lastStatus: "no-trigger", lastTriggered: [], lastJobId: "", lastNote: "观察 " + watchOnly.length + " 只，本次无触发" })
      return Object.assign({ status: "no-trigger" }, base, st)
    }
    const template = TASK_TEMPLATES.find((t) => t.id === "watch-daily")
    if (!template) throw new Error("watch-daily 模板不存在，无法执行日检")
    const detail = hits.map((a) => "- " + a.code + " " + String(a.name || "") + "：" + String(a.message || "")).join("\n")
    const custom = "本次日检由规则层筛出 " + hits.length + " 只触发的观察标的，只处理这几只：\n" + detail
    const job = enqueueJob(template, "", custom)
    const codes = hits.map((a) => a.code)
    const st = await patchWatchDaily({ lastRunAt: new Date().toISOString(), lastTrigger: trigger, lastStatus: "fired", lastTriggered: codes, lastJobId: job.id, lastNote: "触发 " + hits.length + " 只：" + codes.join(" / ") })
    return Object.assign({ status: "fired", jobId: job.id, triggered: codes }, base, st)
  }

  // 自动调度：开机补跑（启动后 25 秒，等插件与行情脚本就绪）+ 每分钟检查收盘后定时
  let watchDailyAutoBusy = false
  const maybeAutoRunWatchDaily = async (phase) => {
    if (watchDailyAutoBusy) return
    watchDailyAutoBusy = true
    try {
      const st = await readWatchDaily()
      if (!st.enabled) return
      if (!isTradingWeekday()) return
      const today = localYmd()
      if (phase === "boot") {
        if (st.bootYmd === today) return
        // 先落日期标记再跑：宁可当天失败一次（可手动重跑），也不要因异常反复触发 LLM
        await patchWatchDaily({ bootYmd: today })
        await runWatchDaily("boot")
        return
      }
      if (st.closeYmd === today) return
      if (localHm() < String(st.at || "15:10")) return
      await patchWatchDaily({ closeYmd: today })
      await runWatchDaily("close")
    } catch (e) {
      try { await patchWatchDaily({ lastStatus: "error", lastRunAt: new Date().toISOString(), lastNote: String(e && e.message ? e.message : e).slice(0, 200) }) } catch (e2) { /* ignore */ }
    } finally {
      watchDailyAutoBusy = false
    }
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
        const allowed = /.md$/i.test(p) && (isSafeServePath(p, REPORTS_DIR) || isSafeServePath(p, OUTPUT_ROOT) || isSafeServePath(p, STOCK_NOTES_DIR))
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
      // 个股分析知识库：按个股归集的清单（前端按股票名排序 + 首字母索引导航）
      kind: "exact",
      path: "/dsh-invest/api/stock-notes",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const data = await ensureStockNotes(false)
          writeJson(res, 200, await stockNotesListPayload(data))
        } catch (e) { writeJson(res, 500, { error: String(e && e.message ? e.message : e).slice(0, 300) }) }
      },
    },
    {
      // 单只个股的知识库：整理稿 Markdown + 整理状态 + 原始记录摘要
      kind: "exact",
      path: "/dsh-invest/api/stock-note",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const url = new URL(req.url ?? "/", "http://localhost")
        const code = normalizeCode(queryParam(url, "code") || "")
        if (!code) { writeJson(res, 400, { error: "缺少或非法的股票代码" }); return }
        try {
          const data = await ensureStockNotes(false)
          const payload = await stockNotesDetailPayload(data, code)
          if (!payload.count) { writeJson(res, 404, { error: "该标的还没有归集的个股分析", code }); return }
          writeJson(res, 200, payload)
        } catch (e) { writeJson(res, 500, { error: String(e && e.message ? e.message : e).slice(0, 300) }) }
      },
    },
    {
      // 手动触发知识库二次整理（全量重写，忽略增量判断）
      kind: "exact",
      path: "/dsh-invest/api/stock-note/curate",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          const code = normalizeCode(String(body.code || ""))
          if (!code) { writeJson(res, 400, { error: "缺少或非法的股票代码" }); return }
          requestCuration(code, { rewrite: true, full: body.full === true })
          writeJson(res, 202, { ok: true, queued: true, code })
        } catch (e) { writeJson(res, 400, { error: String(e && e.message ? e.message : e).slice(0, 300) }) }
      },
    },
    {
      // 个股知识库追问：只依据整理稿回答，滞后内容明确提示更新
      kind: "exact",
      path: "/dsh-invest/api/stock-ask",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          const result = await askStock(String(body.code || ""), String(body.question || ""), body.history)
          writeJson(res, 200, Object.assign({ ok: true }, result))
        } catch (e) { writeJson(res, 400, { error: String(e && e.message ? e.message : e).slice(0, 400) }) }
      },
    },
    {
      // 强制重建个股知识库（改了报告或标记格式后手动触发）
      kind: "exact",
      path: "/dsh-invest/api/stock-notes/rebuild",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const url = new URL(req.url ?? "/", "http://localhost")
          // 默认增量重建（未变化的报告复用解析结果）；?full=1 时全量重解析（解析规则变更后用）
          const full = queryParam(url, "full") === "1"
          const data = await ensureStockNotes(true, full)
          writeJson(res, 200, Object.assign({ ok: true }, await stockNotesListPayload(data), { stats: data.stats }))
        } catch (e) { writeJson(res, 500, { error: String(e && e.message ? e.message : e).slice(0, 300) }) }
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
        try {
          const host = await resolveHostModel()
          const templates = []
          for (const t of TASK_TEMPLATES) {
            const presetName = await resolveTemplatePreset(t.id, t.preset)
            const roleRoutes = await resolveTemplateRouteMap(presetName)
            const effectiveModels = (t.roles || []).map((code) => {
              const chain = roleRoutes[code] || []
              return {
                role: code,
                route: formatRouteChain(chain),
                // 空链（inherit）→ 实际使用宿主模型；非空 → 首选模型
                resolved: chain.length ? formatRoute(chain[0]) : (host ? host.label : "继承宿主"),
              }
            })
            templates.push({
              id: t.id, name: t.name, description: t.description, mode: t.mode,
              roles: t.roles, sequence: Array.isArray(t.sequence) ? t.sequence : null,
              needsCode: t.needsCode, placeholder: t.placeholder,
              preset: presetName,
              effectiveModels,
              hostModel: host ? host.label : "继承宿主",
            })
          }
          writeJson(res, 200, { templates, hostModel: host })
        } catch (e) { writeJson(res, 500, { error: String(e).slice(0, 300) }) }
      },
    },
    {
      // 判断质量回测：结构化结论 × 日线 → 5/20 日命中率与超额收益（只读，含缓存回写）
      kind: "exact",
      path: "/dsh-invest/api/backtest",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const result = await computeBacktest()
          writeJson(res, 200, result)
        } catch (e) { writeJson(res, 500, { error: String(e).slice(0, 300) }) }
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
        const jobs = jobOrder.slice().reverse().slice(0, 20).map((id) => jobStore[id]).filter(Boolean).map((j) => {
          const out = jobSummary(j, false)
          // 列表页也要保留报告入口；不必附带完整 outputs 文本
          if (j.result) out.result = { reports: j.result.reports || [], charts: j.result.charts || [] }
          return out
        })
        const recent = await readRecentJobs()
        writeJson(res, 200, { jobs, recent, concurrency: jobConcurrency(), running: runningJobs.size, queued: taskQueue.length, runLogError: lastRunLogError || null })
      },
    },
    {
      // 报告追问：针对已完成报告的多轮问答（只读报告内容回答）
      kind: "exact",
      path: "/dsh-invest/api/report-ask",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          const result = await askReport(String(body.path || ""), String(body.question || ""), body.history)
          writeJson(res, 200, { ok: true, answer: result.answer, elapsedMs: result.elapsedMs })
        } catch (e) { writeJson(res, 400, { error: String(e && e.message ? e.message : e).slice(0, 400) }) }
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/run-log/repair",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const compact = await compactRunLog()
          const result = await repairRunLog()
          lastRunLogError = result.error ? String(result.error).slice(0, 300) : ""
          writeJson(res, 200, Object.assign({ ok: true }, result, { compact }))
        } catch (e) { writeJson(res, 400, { error: String(e && e.message ? e.message : e).slice(0, 400) }) }
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
    {
      // 标的档案：读列表 + 未读提醒
      kind: "exact",
      path: "/dsh-invest/api/watchlist",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const doc = await readWatchlist()
          doc.items.forEach(deriveWatch)
          // 未读提醒（最近 50 条倒序）
          const fs = ctx.get("fs")
          let alerts = []
          if (fs !== void 0) {
            try {
              const raw = await fs.readText(await fs.resolve(WATCHLIST_ALERTS))
              alerts = raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean).slice(-50).reverse()
            } catch (e) { /* 首次为空 */ }
          }
          writeJson(res, 200, { updated_at: doc.updated_at, items: doc.items, alerts, unread: alerts.filter((a) => !a.read).length })
        } catch (e) { writeJson(res, 500, { error: String(e && e.message ? e.message : e).slice(0, 300) }) }
      },
    },
    {
      // 标的档案：批量刷新现价 + 比对信号（观察买区/持仓止盈止损加仓）+ 追加提醒
      kind: "exact",
      path: "/dsh-invest/api/watchlist/refresh",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          // 先对账（账本 → 档案）再刷现价：外部脚本改过账本时，一次刷新即可对齐
          let watchSync = []
          let watchSyncError = ""
          try { watchSync = await reconcileWatchFromHoldings() }
          catch (e) { watchSyncError = String(e && e.message ? e.message : e).slice(0, 200) }
          const r = await refreshWatchPrices()
          if (!r.refreshed) { writeJson(res, 200, { ok: true, refreshed: 0, alerts: [], message: "档案中无观察/持有标的", watchSync, watchSyncError }); return }
          writeJson(res, 200, { ok: true, refreshed: r.refreshed, fetched_at: r.fetchedAt, alerts: r.fired, updated_at: r.doc.updated_at, watchSync, watchSyncError })
        } catch (e) { writeJson(res, 400, { error: String(e && e.message ? e.message : e).slice(0, 300) }) }
      },
    },
    {
      // 观察仓日检：读状态（开关 / 定时时刻 / 上次结果 / 观察仓只数）
      kind: "exact",
      path: "/dsh-invest/api/watch-daily",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const st = await readWatchDaily()
          const doc = await readWatchlist()
          const watchCount = doc.items.filter((it) => it && it.state === "观察").length
          writeJson(res, 200, Object.assign({ ok: true, running: watchDailyBusy(), watchCount }, st))
        } catch (e) { writeJson(res, 500, { error: String(e).slice(0, 300) }) }
      },
    },
    {
      // 观察仓日检：开 / 关 + 改收盘后的定时时刻（HH:MM）
      kind: "exact",
      path: "/dsh-invest/api/watch-daily/settings",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          const patch = {}
          if (body && body.enabled !== undefined) patch.enabled = Boolean(body.enabled)
          if (body && body.at !== undefined) {
            const at = String(body.at || "").trim()
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) { writeJson(res, 400, { error: "定时时刻需为 HH:MM（24 小时制）" }); return }
            patch.at = at
          }
          if (!Object.keys(patch).length) { writeJson(res, 400, { error: "没有可更新的字段" }); return }
          const st = await patchWatchDaily(patch)
          writeJson(res, 200, Object.assign({ ok: true }, st))
        } catch (e) { writeJson(res, 400, { error: String(e && e.message ? e.message : e).slice(0, 300) }) }
      },
    },
    {
      // 观察仓日检：立即跑一次（规则刷新 → 只为触发者入队 LLM 判断）
      kind: "exact",
      path: "/dsh-invest/api/watch-daily/run",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const r = await runWatchDaily("manual")
          writeJson(res, 200, Object.assign({ ok: true }, r))
        } catch (e) { writeJson(res, 400, { error: String(e && e.message ? e.message : e).slice(0, 300) }) }
      },
    },
    {
      // 标的档案：更新监控规则（state/买入区间/止盈止损/加仓/减仓/notify）或新增档案
      kind: "exact",
      path: "/dsh-invest/api/watchlist/update",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          const code = String(body.code || "").trim().toUpperCase()
          if (!/^\d{6}(\.(SH|SZ|BJ))?$/.test(code)) { writeJson(res, 400, { error: "股票代码格式错误：" + code }); return }
          const doc = await readWatchlist()
          let it = findWatch(doc, code)
          const creating = !it
          if (creating) {
            it = emptyWatch(code, String(body.name || ""))
            doc.items.push(it)
          }
          // 名称
          if (typeof body.name === "string" && body.name.trim()) it.name = body.name.trim()
          // 状态机迁移
          if (body.state !== undefined) {
            const st = String(body.state)
            if (!WATCH_STATES.includes(st)) { writeJson(res, 400, { error: "state 只能取：" + WATCH_STATES.join("/") }); return }
            if (creating && st !== "观察") { writeJson(res, 400, { error: "新建档案只能从「观察」状态开始" }); return }
            it.state = st
          }
          // 观察区字段（buy_low/buy_high/ideal_buy/失效条件）
          if (body.watch && typeof body.watch === "object") {
            const w = it.watch
            if (body.watch.buy_low !== undefined) w.buy_low = wNum(body.watch.buy_low)
            if (body.watch.buy_high !== undefined) w.buy_high = wNum(body.watch.buy_high)
            if (body.watch.ideal_buy !== undefined) w.ideal_buy = wNum(body.watch.ideal_buy)
            if (body.watch.buy_qty !== undefined) w.buy_qty = wNum(body.watch.buy_qty)
            if (body.watch.invalidate_if !== undefined) w.invalidate_if = String(body.watch.invalidate_if).slice(0, 300)
            if (body.watch.stop !== undefined) w.stop = wNum(body.watch.stop)
            if (body.watch.target !== undefined) w.target = wNum(body.watch.target)
          }
          // 持有区字段（stop/target/add/trim/trailing）
          if (body.position && typeof body.position === "object") {
            const pos = it.position
            for (const k of ["cost", "shares", "stop", "target", "add_low", "add_high", "trim_line", "trailing_stop"]) {
              if (body.position[k] !== undefined) pos[k] = wNum(body.position[k])
            }
          }
          // 提醒开关
          if (body.notify !== undefined) it.monitor.notify = body.notify === true
          deriveWatch(it)
          await writeWatchlist(doc)
          // 反向同步持仓账本：已清仓→移除；置为持有/改成本股数→upsert（失败不阻断档案写入，错误带回前端）
          const touchedPosition = Boolean(body.position && (body.position.shares !== undefined || body.position.cost !== undefined))
          let holdingSync = null
          let holdingSyncError = ""
          if (body.state !== undefined || touchedPosition) {
            try { holdingSync = await syncHoldingsFromWatch(it) }
            catch (e) { holdingSyncError = String(e && e.message ? e.message : e).slice(0, 200) }
          }
          // 真清仓后把档案股数归零，避免「已清仓」还挂着 200 股的自相矛盾
          if (holdingSync && holdingSync.changed && holdingSync.action === "清仓") {
            it.position.shares = 0
            await writeWatchlist(doc)
          }
          writeJson(res, 200, { ok: true, item: it, updated_at: doc.updated_at, holdingSync, holdingSyncError })
        } catch (e) { writeJson(res, 400, { error: String(e && e.message ? e.message : e).slice(0, 300) }) }
      },
    },
    {
      // 标的档案：提醒已读（全部或按 key）
      kind: "exact",
      path: "/dsh-invest/api/watchlist/alerts/read",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          const key = typeof body.key === "string" && body.key ? body.key : null
          const fs = ctx.get("fs")
          if (fs === void 0) { writeJson(res, 200, { ok: true, marked: 0 }); return }
          const target = await fs.resolve(WATCHLIST_ALERTS)
          let raw = ""
          try { raw = await fs.readText(target) } catch (e) { raw = "" }
          const lines = raw.split(/\r?\n/).filter((l) => l.trim())
          let marked = 0
          const out = lines.map((l) => {
            try {
              const j = JSON.parse(l)
              if (!key || j.key === key) { if (!j.read) { j.read = true; marked += 1 } }
              return JSON.stringify(j)
            } catch (e) { return l }
          })
          await fs.writeText(target, out.join("\n") + (out.length ? "\n" : ""), void 0, void 0, getFsPolicy())
          writeJson(res, 200, { ok: true, marked })
        } catch (e) { writeJson(res, 500, { error: String(e && e.message ? e.message : e).slice(0, 300) }) }
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/model-settings",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        try {
          if (req.method === "GET") { writeJson(res, 200, await modelSettingsPayload()); return }
          if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
          const body = await readRequestJson(req)
          // 宿主模型：写 settings.json 的 defaultModel；"inherit" 或空 → 删除覆盖，回到跟随会话宿主
          if (body.scope === "host") {
            const value = String(body.value || "").trim()
            const settings = await readJsonFile(SETTINGS_FILE, {})
            if (!value || value === "inherit") {
              delete settings.defaultModel
            } else {
              if (!parseRoute(value)) { writeJson(res, 400, { error: "模型格式应为 provider/model（可选 @effort）" }); return }
              settings.defaultModel = value
            }
            await writeJsonFile(SETTINGS_FILE, settings)
            writeJson(res, 200, { ok: true, scope: "host", value: settings.defaultModel || "inherit", settings: await modelSettingsPayload() })
            return
          }
          if (body.scope === "role") {
            const role = String(body.role || "")
            if (!ROLE_MAP[role]) { writeJson(res, 400, { error: "未知分析师角色：" + role }); return }
            const route = String(body.route || "inherit").trim() || "inherit"
            if (route !== "inherit" && !(parseRouteList(route) || []).length) { writeJson(res, 400, { error: "模型路由格式应为 inherit 或 provider/model@effort（可用 | 备选）" }); return }
            const doc = await readJsonFile(ROUTES_FILE, {})
            doc[role] = route
            await writeJsonFile(ROUTES_FILE, doc)
            writeJson(res, 200, { ok: true, scope: "role", role, route, settings: await modelSettingsPayload() })
            return
          }
          if (body.scope === "template") {
            const template = TASK_TEMPLATES.find((t) => t.id === String(body.templateId || ""))
            const preset = String(body.preset || "inherit")
            if (!template) { writeJson(res, 400, { error: "未知模板" }); return }
            if (!PRESETS[preset]) { writeJson(res, 400, { error: "未知预设档：" + preset }); return }
            const settings = await readJsonFile(SETTINGS_FILE, {})
            if (!settings.templates || typeof settings.templates !== "object") settings.templates = {}
            settings.templates[template.id] = preset
            await writeJsonFile(SETTINGS_FILE, settings)
            writeJson(res, 200, { ok: true, scope: "template", templateId: template.id, preset, settings: await modelSettingsPayload() })
            return
          }
          if (body.scope === "stockKb") {
            const value = String(body.model || "").trim()
            const settings = await readJsonFile(SETTINGS_FILE, {})
            if (!value || value === "default") {
              delete settings.stockKbModel
            } else if (value === "inherit") {
              settings.stockKbModel = "inherit"
            } else {
              if (!parseRoute(value)) { writeJson(res, 400, { error: "模型格式应为 provider/model（可选 @effort）" }); return }
              settings.stockKbModel = value
            }
            if (typeof body.auto === "boolean") settings.stockKbAuto = body.auto
            if (body.concurrency !== void 0) {
              const n = Number(body.concurrency)
              if (!Number.isFinite(n) || n < 1 || n > 6) { writeJson(res, 400, { error: "并发数应为 1-6" }); return }
              settings.stockKbConcurrency = Math.floor(n)
            }
            await writeJsonFile(SETTINGS_FILE, settings)
            writeJson(res, 200, { ok: true, scope: "stockKb", model: await kbModelLabel(), auto: await kbAutoEnabled(), concurrency: await kbConcurrency(), settings: await modelSettingsPayload() })
            return
          }
          writeJson(res, 400, { error: "scope 必须为 host / role / template / stockKb" })
        } catch (e) { writeJson(res, 400, { error: String(e).slice(0, 300) }) }
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/holdings/import",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          // 持仓截图 base64 通常为数百 KB～数 MB；原先 64KB 上限会中断请求并造成 Failed to fetch
          const body = await readRequestJson(req, 16 * 1048576)
          const source = String(body.source || "")
          if (source === "csv") {
            let text = ""
            if (typeof body.contentBase64 === "string" && body.contentBase64) {
              text = new TextDecoder("gb18030").decode(Buffer.from(body.contentBase64, "base64"))
            } else if (typeof body.content === "string") text = body.content
            if (!text.trim()) { writeJson(res, 400, { error: "请上传东财交割单 CSV（contentBase64）" }); return }
            const parsed = parseEastmoneyCsv(text)
            const positions = parsed.positions.map((p) => normalizePosition(p, "eastmoney-csv"))
            writeJson(res, 200, await makeHoldingsDraft("csv", positions, parsed.account, parsed.warnings.concat(parsed.meta && parsed.meta.trades ? ["共解析 " + parsed.meta.trades + " 笔成交流水。"] : [])))
            return
          }
          if (source === "screenshot") {
            const imageBase64 = String(body.imageBase64 || "").replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "")
            if (!imageBase64) { writeJson(res, 400, { error: "请提供截图 imageBase64" }); return }
            // ① 优先本地 OCR：离线、确定性、不占模型额度；置信度高才采用
            if (process.env.DSH_INVEST_LOCAL_OCR !== "0") {
              try {
                const ocr = await runLocalOcrHoldings(imageBase64, String(body.mimeType || "image/png"))
                const rows = Array.isArray(ocr && ocr.positions) ? ocr.positions : []
                const usable = ocr && ocr.ok === true && ocr.confidence === "high" && rows.some((p) => p && p.code && Number(p.shares) > 0)
                if (usable) {
                  const closed = rows.filter((p) => !(Number(p && p.shares) > 0)).length
                  const positions = rows
                    .filter((p) => p && p.code && Number(p.shares) > 0)
                    .map((p) => normalizePosition(Object.assign({}, p, { pool: "实盘", status: "持有" }), "screenshot-ocr"))
                  const warnings = ["本地 OCR 识别（离线解析，未经视觉模型）：请逐项核对后再确认写入。"]
                  if (closed) warnings.push("已跳过 " + closed + " 条 0 股（清仓）记录。")
                  const draft = await makeHoldingsDraft("screenshot", positions, ocr.account, warnings.concat(Array.isArray(ocr.warnings) ? ocr.warnings : []))
                  writeJson(res, 200, Object.assign({}, draft, { engine: "local-ocr", engineNote: "本地 OCR" }))
                  return
                }
              } catch (e) { /* 本地 OCR 不可用或失败 → 走视觉模型兜底 */ }
            }
            // ② 视觉模型兜底（原有路径）
            const busy = jobOrder.some((id) => { const j = jobStore[id]; return j && (j.status === "queued" || j.status === "running") })
            if (busy) { writeJson(res, 409, { error: "分析任务进行中，模型暂不可用，请稍后再导入截图。" }); return }
            let sendBase64 = imageBase64
    let sendMime = String(body.mimeType || "image/png")
    if (Buffer.from(sendBase64, "base64").length > 350 * 1024) {
      try {
        const { spawn } = await import("node:child_process")
        const py = BASE_DIR + "/tools/compress_image.py"
        const pyCmd = await resolvePython()
        sendBase64 = await new Promise((resolve, reject) => {
          const child = spawn(pyCmd, [py], { cwd: BASE_DIR, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
          let out = "", err = ""
          child.stdout.on("data", (d) => out += String(d))
          child.stderr.on("data", (d) => err += String(d))
          child.on("close", (code) => code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error("compress_image exit " + code + " " + err.slice(0, 180))))
          child.on("error", reject)
          child.stdin.write(JSON.stringify({ base64: imageBase64, mimeType: sendMime }))
          child.stdin.end()
        })
        sendMime = "image/jpeg"
      } catch (e) { /* 服务端压缩失败则直接用原图，视觉模型若不接受会报具体错 */ }
    }
    const parsed = await recognizeScreenshot(sendBase64, sendMime)
            const positions = parsed.positions.map((p) => normalizePosition(p, "screenshot"))
            writeJson(res, 200, Object.assign({}, await makeHoldingsDraft("screenshot", positions, parsed.account, ["截图由多模态模型识别，原图未留档；请逐项核对后再确认写入。"]), { engine: "vision", engineNote: "视觉模型" }))
            return
          }
          if (source === "manual") {
            const current = await readHoldingsDoc()
            const positions = Array.isArray(body.positions) ? body.positions.map((p) => normalizePosition(p, "manual")) : current.positions
            const account = body.account && typeof body.account === "object" ? body.account : current.account
            writeJson(res, 200, await makeHoldingsDraft("manual", positions, account, ["手动编辑不会自动写入，请确认差异后保存。"]))
            return
          }
          writeJson(res, 400, { error: "source 必须为 csv / screenshot / manual" })
        } catch (e) { writeJson(res, 400, { error: String(e).slice(0, 400) }) }
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/holdings/draft",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const url = new URL(req.url ?? "/", "http://localhost")
        const id = queryParam(url, "id") || ""
        const draft = holdingsDrafts[id]
        if (!draft) { writeJson(res, 404, { error: "草稿不存在或已过期" }); return }
        const current = await readHoldingsDoc()
        writeJson(res, 200, { draftId: id, source: draft.source, positions: draft.positions, account: draft.account, diff: positionsDiff(current.positions, draft.positions), warnings: draft.warnings })
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/holdings/confirm",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          writeJson(res, 200, await confirmHoldingsDraft(String(body.draftId || ""), body.positions, body.account))
        } catch (e) { writeJson(res, 400, { error: String(e).slice(0, 400) }) }
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/holdings/quotes/refresh",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try { writeJson(res, 200, await refreshHoldingsPrices()) }
        catch (e) { writeJson(res, 400, { error: String(e && e.message ? e.message : e).slice(0, 300) }) }
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/holdings/quotes",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          const codes = (Array.isArray(body.codes) ? body.codes : []).map((c) => String(c == null ? "" : c).trim().toUpperCase()).filter(Boolean)
          if (!codes.length) { writeJson(res, 400, { error: "codes 不能为空，请提供股票代码数组" }); return }
          const bad = codes.find((c) => !/^\d{6}(?:\.(?:SH|SZ|BJ))?$/.test(c))
          if (bad) { writeJson(res, 400, { error: "股票代码格式错误：" + bad }); return }
          const result = await fetchQuotePrices(codes)
          // 脚本返回的 code 是 6 位纯数字，去掉后缀比对前 6 位数字映射回请求的完整 code
          const byDigits = {}
          for (const q of result.quotes) {
            const digits = String(q && q.code != null ? q.code : "").replace(/\D/g, "").slice(0, 6)
            const price = (q == null || q.price === null || q.price === void 0 || q.price === "") ? null : Number(q.price)
            if (digits.length === 6 && price !== null && Number.isFinite(price)) byDigits[digits] = price
          }
          const prices = {}, missing = []
          for (const full of codes) {
            const digits = full.replace(/\D/g, "").slice(0, 6)
            const price = byDigits[digits]
            if (price !== void 0 && Number.isFinite(price)) prices[full] = price
            else missing.push(full)
          }
          writeJson(res, 200, { ok: true, source: "tencent", fetched_at: result.fetchedAt, prices, missing })
        } catch (e) { writeJson(res, 400, { error: String(e && e.message ? e.message : e).slice(0, 300) }) }
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/stock/resolve",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const url = new URL(req.url ?? "/", "http://localhost")
          const query = String(queryParam(url, "query") || "").trim()
          if (!query) { writeJson(res, 400, { error: "缺少 query" }); return }
          const suffixOf = (d) => /^[69]/.test(d) ? "SH" : /^[023]/.test(d) ? "SZ" : /^159/.test(d) ? "SZ" : /^[458]/.test(d) ? "SH" : /^[48]/.test(d) ? "BJ" : "SH"
          const q = query.toUpperCase()
          if (/^\d{6}$/.test(q) || /^\d{6}\.(SH|SZ|BJ)$/.test(q)) {
            const digits = q.slice(0, 6)
            const code = q.includes(".") ? q : digits + "." + suffixOf(digits)
            writeJson(res, 200, { code, name: await lookupStockName(code), found: true })
            return
          }
          const found = await resolveNameToCode(query)
          if (found) { writeJson(res, 200, found); return }
          writeJson(res, 200, { code: null, name: null, found: false })
        } catch (e) { writeJson(res, 400, { error: String(e).slice(0, 300) }) }
      },
    },
  ]

  const tool = defineTool({
    name: "invest_run",
    description: "运行多角色投研流水线。mode：个股（单只股票深度分析，最常用）/选股（全市场海选）/消息（消息面收集）/深度分析（选股+深度）/总判断/all（完整流水线）/波段池（中长周期波段建池与跟踪，持有 3 周-6 个月，持仓≤4 只，可空仓）。question 为用户投研问题（可含多只股票）；roles 可选：自定义角色组合（如 ['深度','总判断']，省略则按 mode 默认）；context 可选，传入上一轮分析结论或追问背景（记忆与追问）；detail 可选：full=模型侧全量输出（token 多），summary=摘要输出省 token（默认，GUI 卡片始终显示完整报告）。routes/preset 可选：按角色覆盖模型路由（默认 balanced：选股/消息=deepseek-flash，深度=deepseek-v4-pro，总判断=glm-5.3，失败自动回退）。数据用 Tushare 实时获取。",
    parameters: {
      mode: { type: "string", description: "运行模式", required: true },
      question: { type: "string", description: "用户投研问题（可含多只股票）", required: true },
      roles: { type: "array", items: { type: "string" }, description: "可选：自定义角色组合，取值 ['选股','消息','深度','总判断','波段'] 的子集（如 ['深度','总判断']）；省略则按 mode 默认角色。用户问题中明确列出角色时按所列角色执行；用户要求选择角色时用 ask_user_question 询问后再传" },
      sequence: { type: "array", items: { type: "string" }, description: "可选：显式串行顺序（角色简码数组，如 ['选股','消息','深度','总判断']）。给出时每个角色各成一阶段、严格按该顺序串行（下游可见上游产出）；省略则沿用默认分组：选股∥消息∥波段 并行 → 深度 → 总判断" },
      context: { type: "string", description: "可选：上一轮分析结论/追问背景，让本轮分析有记忆" },
      routes: { type: "object", additionalProperties: true, description: "可选：按角色覆盖模型路由，形如 {\"总判断\":\"zai-coding-cn/glm-5.3@max\"}；值为 provider/model@effort，可用 \"a|b\" 写备选链，写 \"inherit\" 表示继承宿主模型；省略则用插件默认路由表" },
      preset: { type: "string", description: "可选：路由预置档 inherit/fast/budget/balanced/deepseek-only/quality，默认 inherit（继承宿主）" },
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
      // 运行日志在 finally 中要引用这两个变量，必须声明在函数作用域：
      // 历史上的 ReferenceError: summaryText is not defined 被 finally 里的空 catch 吞掉，
      // 导致 2026-11-06 之后所有运行日志静默停写（已修复，见 v0.34.0 CHANGELOG）。
      let summaryText = null
      let summaryEnabled = PLUGIN_CONFIG.summary !== false && process.env.DSH_INVEST_SUMMARY !== "0"
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
      // 显式串行顺序（可选）：仅保留合法且属于本次 roles 的角色简码
      const sequence = Array.isArray(args.sequence)
        ? args.sequence.filter((code) => typeof code === "string" && ROLE_MAP[code] && roleCodes.includes(code))
        : undefined
      // 问题已明确指定标的（出现 6 位代码）且本轮含深度+上游扫描角色时：深度并入第一组并行，
      // 不必等选股/消息的候选名单（深度对指定标的一条命令自取数据）；总判断仍在最后一组
      const qCodes = extractInvestCodes(String(question || ""))
      const parallelDeep = !sequence && qCodes.length > 0 && roleCodes.includes("深度")
        && (roleCodes.includes("选股") || roleCodes.includes("消息") || roleCodes.includes("波段"))
      if (parallelDeep) routeNotes.push("问题已含标的 " + qCodes.slice(0, 4).join("、") + "：深度与选股/消息并行执行（省约一个上游阶段的时间）")
      const groups = buildGroups(roleCodes, ROLE_MAP, sequence, { parallelDeep })
      // ---- 模型路由解析：preset ← 插件 config ← .dsh-invest/routes.json ← 环境变量 ← 单次调用参数 ----
      const llm = ctx.get("llm")
      const presetName = (typeof args.preset === "string" && args.preset)
        || (typeof PLUGIN_CONFIG.preset === "string" && PLUGIN_CONFIG.preset)
        || (typeof process !== "undefined" && process.env && process.env.DSH_INVEST_PRESET)
        || DEFAULT_PRESET
      const fileRoutesRaw = await readRoutesFile() || {}
      // 模板预设（非 inherit）优先于角色的 inherit 默认；角色显式模型仍覆盖
      const isTemplatePreset = presetName !== "inherit" && presetName !== DEFAULT_PRESET
      const fileRoutes = isTemplatePreset
        ? Object.fromEntries(Object.entries(fileRoutesRaw).filter(([, v]) => String(v).trim().toLowerCase() !== "inherit"))
        : fileRoutesRaw
      const roleRoutes = mergeRoutes(
        presetName,
        PLUGIN_CONFIG.routes,
        fileRoutes,
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
      // 选股环节：把持仓表换成「硬排除清单」，避免海选把已持有标的当新机会重复分析；
      // 深度/总判断/波段仍注入完整账本（需要成本、仓位、止损来做仓位与加减仓判断）。
      const screeningExclusion = heldExclusionLine(await readHeldPositions())
      const historyBlock = await readHistoryBlock(question, context, mode)
      const runStage = async (s) => {
        const t0 = Date.now()
        const parts = ["用户问题：" + question]
        if (context) parts.push("【对话上下文（记忆）】" + context + "\n请结合上述上下文继续分析，保持口径一致。")
        parts.push(anchorLine)
        if (s.code === "选股" && screeningExclusion) parts.push(screeningExclusion)
        else if (holdingsBlock) parts.push(holdingsBlock)
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
            // 阶段超时兜底：宿主 activation 若未能结算，8 分钟后主动 dispose 并转入失败/重试，避免网页任务永久运行
            const result = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                try { Promise.resolve(run.dispose ? run.dispose() : null).catch(() => {}) } catch (e) { /* ignore */ }
                reject(new Error("阶段执行超时（" + Math.round(STAGE_TIMEOUT_MS / 60000) + " 分钟），已主动终止子代理"))
              }, STAGE_TIMEOUT_MS)
              Promise.resolve(run.result).then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
            })
            // stopReason=error 一律视为失败（即使已有部分输出），防止把被 429/异常打断的半截报告当成功
            if (result && result.stopReason === "error") {
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
            const nonRetryable = /40203|429|RATE_LIMIT|exceeded_current_quota|credit balance|无权限|权限不足|超限|频率|quota|forbidden|unauthorized|unauthenticated/i.test(lastErr)
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

      // ===== 报告二次总结：观点先行 + 去重压缩；失败自动回退各阶段原文 =====
      // summaryText / summaryEnabled 已在函数作用域声明（finally 要读写，不能用块级作用域）
      summaryText = null
      let summaryNote = ""
      // 超时运行时可配：settings.json 的 "summaryTimeoutMs"（毫秒）优先，否则用默认（与阶段超时一致，60 分钟）
      let summaryTimeoutMs = SUMMARY_TIMEOUT_MS
      try {
        const s = await readJsonFile(SETTINGS_FILE, {})
        const v = Number(s && s.summaryTimeoutMs)
        if (Number.isFinite(v) && v > 0) summaryTimeoutMs = v
      } catch (e) { /* 配置读取失败用默认 */ }
      const okOutputs = outputs.filter((o) => o.ok && o.text)
      if (summaryEnabled && okOutputs.length) {
        try {
          setProgress({ stage: "报告二次总结", index: groups.length, total: groups.length, status: "summarizing", done: outputs.filter((o) => o.ok).map((o) => ({ stage: o.stage, ms: o.elapsedMs, route: o.route })) })
          const rawForSummary = okOutputs.map((o) => "【" + o.stage + " 完整输出】\n" + o.text).join("\n\n")
          const summaryPrompt = [
            "用户问题：" + question,
            context ? "对话上下文：" + String(context).slice(0, 500) : "",
            "【各阶段输出（唯一依据）】",
            rawForSummary,
            "请按你的角色设定做二次总结，直接输出最终报告 Markdown 正文。",
          ].filter(Boolean).join("\n\n")
          // 总结模型复用本次「总判断」路由（若有），否则继承宿主；不改变用户既有配置
          const summaryRoute = chosenRoutes["总判断"] || null
          const run = await startStage(Object.assign({
            label: "报告二次总结",
            prompt: [{ type: "text", text: summaryPrompt }],
            parent: exec.agent,
            signal: exec.signal,
            persona: P_SUMMARY,
            toolFilter: { deny: ["invest_run", "subagent_fork", "send_message", "interrupt_agent", "list_agents"] },
          }, summaryRoute ? { agentOptions: summaryRoute } : {}))
          const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              try { Promise.resolve(run.dispose ? run.dispose() : null).catch(() => {}) } catch (e) { /* ignore */ }
              reject(new Error("二次总结超时（" + Math.round(summaryTimeoutMs / 60000) + " 分钟）"))
            }, summaryTimeoutMs)
            Promise.resolve(run.result).then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
          })
          if (result && result.stopReason === "error") throw new Error("二次总结子代理失败（stopReason=error）")
          const text = String(extractBoth(result).text || "").trim()
          if (text.length < 80) throw new Error("二次总结输出过短（" + text.length + " 字）")
          summaryText = text.slice(0, 12000)
          summaryNote = "已二次总结（观点先行）｜ 总结模型：" + (summaryRoute ? formatRoute(summaryRoute) : "继承宿主")
        } catch (e) {
          summaryText = null
          summaryNote = "二次总结未生效，已回退各阶段原文：" + String(e).slice(0, 160)
        }
      } else if (!summaryEnabled) {
        summaryNote = "二次总结已按配置关闭"
      }

      // 各阶段完整原文（详版）：主报告只放总结，原文另存，保证可追溯
      const buildStageLines = (title, note) => {
        const arr = ["# " + title, ""]
        if (note) arr.push("- " + note)
        arr.push("- 问题：" + question)
        arr.push("")
        for (const o of outputs) {
          arr.push("## " + o.stage + (o.ok ? "（" + (o.route || "继承宿主") + " ｜ 耗时 " + (o.elapsedMs / 1000).toFixed(1) + "s" + (o.retried ? "，含重试" : "") + "）" : "（失败 ｜ " + (o.route || "继承宿主") + "）"))
          arr.push("")
          arr.push(o.ok ? o.text : ("错误：" + o.error))
          arr.push("")
        }
        if (allCharts.size) {
          arr.push("## 图表")
          for (const c of Array.from(allCharts)) arr.push("- " + c)
          arr.push("")
        }
        arr.push("---")
        arr.push("仅供参考，不构成投资建议。")
        return arr
      }

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
          if (summaryNote) lines.push("- 报告处理：" + summaryNote)
          lines.push("")
          if (summaryText) {
            // 主报告 = 二次总结（观点先行）；各阶段原文另存，避免冗长与重复
            lines.push(summaryText)
            lines.push("")
            lines.push("---")
            lines.push("")
            lines.push("> **各分析师完整原文**：归档于 `_raw/" + stamp + "_" + qkey + ".md`；GUI 卡片亦可直接查看每个 Agent 的完整报告与推理过程。")
          } else {
            for (const o of outputs) {
              lines.push("")
              lines.push("## " + o.stage + (o.ok ? "（" + (o.route || "继承宿主") + " ｜ 耗时 " + (o.elapsedMs / 1000).toFixed(1) + "s" + (o.retried ? "，含重试" : "") + "）" : "（失败 ｜ " + (o.route || "继承宿主") + "）"))
              lines.push("")
              lines.push(o.ok ? o.text : ("错误：" + o.error))
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
          if (summaryText) {
            try {
              const rawTarget = await fs.resolve(REPORTS_RAW_DIR + "/" + stamp + "_" + qkey + ".md")
              await fs.writeText(rawTarget, buildStageLines("各分析师完整原文（归档详版）", "对应总结报告：" + stamp + "_" + qkey + ".md").join("\n"), void 0, void 0, policy)
            } catch (e) { /* 详版失败不阻断主报告 */ }
          }
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
          if (summaryNote) outLines.push("- 报告处理：" + summaryNote)
          outLines.push("")
          if (summaryText) {
            outLines.push(summaryText)
            outLines.push("")
            outLines.push("---")
            outLines.push("")
            outLines.push("> **各分析师完整原文**：见本目录 `各阶段原文.md`，或在 GUI 卡片查看每个 Agent 的完整报告与推理。")
          } else {
            for (const o of outputs) {
              outLines.push("")
              outLines.push("## " + o.stage + (o.ok ? "（" + (o.route || "继承宿主") + " ｜ 耗时 " + (o.elapsedMs / 1000).toFixed(1) + "s" + (o.retried ? "，含重试" : "") + "）" : "（失败 ｜ " + (o.route || "继承宿主") + "）"))
              outLines.push("")
              outLines.push(o.ok ? o.text : ("错误：" + o.error))
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
          if (summaryText) {
            try {
              const rawOut = await fs.resolve(outDir + "/各阶段原文.md")
              await fs.writeText(rawOut, buildStageLines("各分析师完整原文（归档详版）", "对应总结报告：报告.md").join("\n"), void 0, void 0, policy)
            } catch (e) { /* 详版失败不阻断主报告 */ }
          }
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
        // 双通道：优先 DSH fs（带 sandbox policy）；失败时用 node:fs 直接追加，避免运行记录静默丢失
        let runLogLine = ""
        try {
          runLogLine = JSON.stringify({
            ts: new Date().toISOString(),
            mode,
            question: String(question).slice(0, 200),
            callId,
            ok: outputs.length > 0 && outputs.every((o) => o.ok === true),
            elapsedMs: Date.now() - runStart,
            stages: outputs.map((o) => ({ stage: o.stage, ok: o.ok === true, ms: o.elapsedMs || 0, route: o.route || "继承宿主", error: o.ok ? "" : String(o.error || "").slice(0, 200) })),
            routes: routeMap,
            routeNotes,
            charts: allCharts.size,
            reports: reports.length,
            summary: summaryText ? "ok" : (summaryEnabled ? "failed-fallback" : "off"),
          }) + "\n"
        } catch (e) {
          // 曾经这里只写 runLogLine = ""，把 ReferenceError 完全吞掉，导致运行日志静默停写 3 天。
          // 现在：保留错误并在 finally 末尾统一上报（/api/jobs 的 runLogError + UI 提示）。
          lastRunLogError = "运行日志构造失败：" + String(e && e.message || e).slice(0, 200)
        }
        if (runLogLine) {
          lastRunLogError = await appendRunLogLine(runLogLine, policy)
        }
      }
    },
  })

  ctx.effect(() => {
    // 启动自愈：若历史任务缺运行日志，自动补写一次（延迟执行，不阻塞插件加载；
    // unref 保证不拖住进程退出；node --test 下不调度，避免定时器在测试中途改同一临时目录）
    if (process.env.NODE_TEST_CONTEXT || process.env.DSH_INVEST_SKIP_SELF_HEAL === "1") {
      return () => {}
    }
    const timer = setTimeout(() => {
      compactRunLog()
        .then((compact) => repairRunLog().then((result) => ({ compact, result })))
        .then(({ compact, result }) => {
          if ((compact && compact.removed) || (result && result.appended)) lastRunLogError = ""
        })
        .catch(() => {})
    }, 6000)
    if (typeof timer.unref === "function") timer.unref()
    return () => clearTimeout(timer)
  }, "dsh-invest: run-log self-heal")

  ctx.effect(() => {
    // 个股知识库后台自动整理：启动 20 秒后扫一遍未整理的股票，之后每 10 分钟补一次。
    // 串行队列 + 每条之间 1.5 秒间隔，慢慢把历史补齐；测试环境/显式关闭时不调度。
    if (process.env.NODE_TEST_CONTEXT || process.env.DSH_INVEST_AUTO_CURATE === "0") return () => {}
    const boot = setTimeout(() => { void sweepCuration() }, 20000)
    const tick = setInterval(() => { void sweepCuration() }, 10 * 60 * 1000)
    if (typeof boot.unref === "function") boot.unref()
    if (typeof tick.unref === "function") tick.unref()
    return () => { clearTimeout(boot); clearInterval(tick) }
  }, "dsh-invest: stock-kb curation")

  ctx.effect(() => {
    // 磁盘卫生：启动 90 秒后清一次 cache 里超过 30 天的缓存，之后每 24 小时一次。
    // 只动 cache（可再生）；scratch / 根目录临时文件交给 tools/cleanup.js 手动执行。
    if (process.env.NODE_TEST_CONTEXT || process.env.DSH_INVEST_AUTO_CLEAN === "0") return () => {}
    const boot = setTimeout(() => { void sweepCacheFiles() }, 90000)
    const tick = setInterval(() => { void sweepCacheFiles() }, 24 * 60 * 60 * 1000)
    if (typeof boot.unref === "function") boot.unref()
    if (typeof tick.unref === "function") tick.unref()
    return () => { clearTimeout(boot); clearInterval(tick) }
  }, "dsh-invest: cache sweep")

  ctx.effect(() => {
    // 观察仓日检自动调度：开机补跑 + 收盘后定时（每分钟轮询一次，容忍睡眠/唤醒漏拍）
    // node --test 下 effect 会立即执行，这里必须早退，避免定时器在测试中途跑真实行情/LLM
    if (process.env.NODE_TEST_CONTEXT || process.env.DSH_INVEST_WATCH_DAILY === "0") return () => {}
    const boot = setTimeout(() => { void maybeAutoRunWatchDaily("boot") }, 25000)
    const tick = setInterval(() => { void maybeAutoRunWatchDaily("tick") }, 60000)
    if (typeof boot.unref === "function") boot.unref()
    if (typeof tick.unref === "function") tick.unref()
    return () => { clearTimeout(boot); clearInterval(tick) }
  }, "dsh-invest: watch-daily auto")

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
