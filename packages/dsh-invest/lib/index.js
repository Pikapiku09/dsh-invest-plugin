// dsh-invest Host 半部：invest_run 工具 + /api/dsh-invest 路由 + agent 指引
// 常规 Cordis 插件（profile bundle 挂载），所有会话可见
// 宿主私有包（schemastery / dsh-tools）走可选导入：见 host-deps.js（干净 clone / 测试环境缺包时自动降级）
import { z, defineTool } from "./host-deps.js"
import { promises as fsp } from "node:fs"
import { DATA_BASE, TOOL_REDLINE, P_SELECT, P_NEWS, P_DEEP, P_FINAL, P_SWING, P_SUMMARY } from "./prompts.js"
import { extractBoth, collectCharts, buildGroups, isLoopbackRequest, isSafeServePath, extractInvestCodes, parseConclusionBlocks, parseEastmoneyCsv, z2, localYmd, cmpVersion as cmpVersionPure } from "./pure.js"
import { DEFAULT_PRESET, PRESETS, ROLE_CODES, mergeRoutes, formatRoute, formatRouteChain, parseRoute, parseRouteList, parseRoutesJson } from "./routes.js"
import { buildStockNotes, normalizeCode, stockFileName } from "./stock-notes.js"
import { buildCuratePrompt, sanitizeCurated, validateCurated, rawTimelineMarkdown } from "./stock-curator.js"
import {
  DAO_COACH_LABEL, normalizeDaoStore, upsertDaoItem, deleteDaoItem, selectDaoEntries,
  buildDaoBlock, buildDaoBlocks, daoStats, buildCoachPrompt, buildDistillPrompt, parseDistillJson, draftFromText,
} from "./dao.js"
import { num, dedupeByCode, latestDisclosedPeriod, buildFundamentals, CAVEAT, MIN_PEERS } from "./fundamentals.js"

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
  // v0.54.1：这些接口全是「读当前状态」，浏览器不得缓存。
  // 之前没有任何缓存头，重定向/启发式缓存会让「刷新现价」后前端仍读回旧账本，
  // 表现为数字不跳动——数据其实已经落盘了。
  res.setHeader("cache-control", "no-store, max-age=0")
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
/**
 * 宿主服务单点访问（2026-11-20）
 *
 * 为什么要有这一层：插件有几十处要取宿主服务（fs / agents / llm / attachments）。
 * 若哪天 DSH 改了服务名，没有这层就要在几十个地方挨个找，漏一个就是**静默失效**；
 * 有这层，改名只改下面这一行的字符串。
 *
 * 两条设计约束，改这里之前先读：
 * 1. **必须保留「用的时候现取」**。宿主可能先挂插件、后注册服务，若在 apply 时取一次存起来，
 *    会永远拿到空值——那才是真会改坏。所以这里只做转发，不做缓存。
 * 2. **放在模块级并显式接收 ctx**，而不是在 apply 里做闭包。这样不管调用点在 apply 内部
 *    还是外部函数里，都不会因为作用域拿不到 ctx。
 */
function hostService(ctx, name, ...rest) {
  // 必须原样透传多余参数：插件里还有 hostService(ctx, n, true) / hostService(ctx, n, false) 这种
  // 「候选探测」写法，第二个参数是查询标志。吞掉它会让这段静默改变含义。
  return ctx.get(name, ...rest)
}

/**
 * 活的 Agent 列表（`ctx.agents`）。
 *
 * DSH 0.2.x 的 AgentService 只有 list()/get()/create()/register()…，**没有 roots()**
 * （roots() 是 0.1.x 时代的方法）。插件此前一律写 `agents.roots()`，在 0.2.x 上恒为 `[]`，
 * 于是三处静默失效：
 *   ① 沙箱策略候选为空 → fs.writeText 不带策略 → 宿主按「无会话」的部署默认根判定
 *      → 目标在工作区里也不被包含 → `file access denied under workspace-write mode`
 *      （2026-11-23 用户遇到的账本/档案写不进去就是这条）；
 *   ② 子代理拿不到 parent → 抛「没有可用的顶层 Agent」→ 视觉识别不可用，退本地 OCR；
 *   ③ 会话宿主模型继承失效（模型设置里显示不出会话模型）。
 *
 * 这里按「新接口优先、老接口兜底」取值，两个版本都能跑。
 */
function liveAgents(ctx) {
  const agents = hostService(ctx, "agents")
  if (agents === void 0) return []
  for (const method of ["list", "roots"]) {
    if (typeof agents[method] !== "function") continue
    try {
      const out = agents[method]()
      if (Array.isArray(out)) return out
    } catch (e) { /* 试下一个 */ }
  }
  return []
}

/**
 * 构造 DSH 0.2.x `subagents.startActivation(spec)` 的 spec（2026-11-23）。
 *
 * 血泪教训：0.2.x 的 `startActivation` 在 **spec 顶层** 读 `parent`——
 *   dsh-subagent/lib/index.js:3024
 *   `if (this.ctx.get("agents")?.get(spec.parent.id) !== spec.parent) throw ...`
 * 旧代码把 parent 塞进 `spec.request.parent`，于是 `spec.parent === undefined`，
 * 每个阶段子代理都在 15ms 内抛 `TypeError: Cannot read properties of undefined (reading 'id')`
 * ——个股体检一键任务「任务进度中断」就是这么来的（3 个阶段同时失败、耗时 15ms）。
 *
 * 新契约与宿主 `@deepseek-ai/dsh-tool-subagent` 同源：
 *   `{ provider, label, prompt, parent, agentOptions?, cwd?, maxDepth?, signal, delivery }`
 * 注意 person/toolFilter 属于 0.1.x 老字段：角色设定已折进 prompt 文本，toolFilter 不再下发。
 */
function activationSpecFor(spec, text, delivery) {
  if (!spec || !spec.parent) {
    throw new Error("子代理缺少父 Agent（parent 为空）：无法创建阶段子代理；请确认任务 Agent 已创建成功")
  }
  return {
    provider: "spawn",
    label: spec.label,
    prompt: [{ type: "text", text }],
    parent: spec.parent,
    ...(spec.agentOptions ? { agentOptions: spec.agentOptions } : {}),
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    ...(spec.signal !== void 0 ? { signal: spec.signal } : {}),
    delivery,
  }
}

function apply(ctx, config) {
  // ---- 宿主接口自检（2026-11-20）----
  // DSH 升级后若宿主接口改名/删除，插件会在注册阶段抛异常。注册阶段抛异常最坏的结果是
  // **整个 profile 一起挂掉**，连带别的插件。这里先把必需接口查一遍：缺了就打印一份
  // 能照着排查的清单并干净退出（工具与页面都不可用，但 DSH 本身还能起）。
  {
    const missing = []
    if (!ctx || typeof ctx !== "object") missing.push("ctx 本身")
    else {
      if (!ctx.webServer || typeof ctx.webServer.register !== "function") missing.push("ctx.webServer.register")
      if (!ctx.tools || typeof ctx.tools.register !== "function") missing.push("ctx.tools.register")
      if (!ctx.systemPrompt || typeof ctx.systemPrompt.section !== "function") missing.push("ctx.systemPrompt.section")
      if (typeof ctx.effect !== "function") missing.push("ctx.effect")
      if (typeof ctx.get !== "function") missing.push("ctx.get")
    }
    if (missing.length) {
      const msg = "[dsh-invest] 宿主接口不兼容，已跳过挂载：" + missing.join("、")
        + "。多半是 DSH 升级改了插件接口；请对照仓库里的 COMPATIBILITY.md，或回退 DSH/插件版本。"
      try { ctx && typeof ctx.logger?.error === "function" ? ctx.logger.error(msg) : console.error(msg) } catch { console.error(msg) }
      return
    }
    // 服务是请求时才取的，这里只提示缺失的服务名，不阻断——插件在服务缺失时已有多处降级分支
    for (const name of ["fs", "agents", "attachments", "llm"]) {
      try {
        if (hostService(ctx, name) === undefined && name === "fs") {
          const warn = "[dsh-invest] 宿主未提供 fs 服务：账本/缓存/报告读写会降级失败，请检查 DSH 版本。"
          try { ctx && typeof ctx.logger?.warn === "function" ? ctx.logger.warn(warn) : console.warn(warn) } catch { console.warn(warn) }
        }
      } catch { /* 探针失败不影响挂载 */ }
    }
  }
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
  // 量化策略快照（LihuQuantify → 工作台）支持的契约版本区间。
  // v2 equity、v3 swing、v4 overview、v5 backtest、v6 reports、v7 strategy_trials；兼容 v1~v6。
  // 不用「不等于当前版本就拒」：那样 Lihu 一升 v2，工作台旧版本立刻全白。
  const SUPPORTED_HEALTH_SCHEMA = 7
  const MIN_HEALTH_SCHEMA = 1
  // 热力图快照（LihuQuantify 每日巡检写入 data/heatmap_snapshot.json）。
  // 走独立轻量路由而不是塞进 strategy_health 契约：大契约已 80KB，概览页只为一卡片
  // 加载它会明显拖慢首屏；这个文件本身自描述（含 trade_date），不需要 schema 版本。
  const HEATMAP_FILE = "E:/LihuQuantify/data/heatmap_snapshot.json"
  const LIHU_TRIALS_FILE = "E:/LihuQuantify/outputs/strategy_trials.json"
  const LIHU_REAL_PERF_FILE = "E:/LihuQuantify/outputs/monthly_perf.json"

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
  // 子进程 stdout 一次性解码（调用方先把所有 Buffer 收齐再传进来）：
  //   ① 默认按 UTF-8 解；② 出现 U+FFFD 说明脚本按本地代码页输出（中文 Windows 为 GBK），
  //   用 GB18030 再解一次，干净就用它。
  // 历史 bug：逐块 String(chunk) 既会把 GBK 字节按 UTF-8 解成替换符，也会在多字节字符
  // 正好被管道切断时插入 U+FFFD——两者都只毁中文，ASCII 代码/数字完好，伪装成「识别不准」。
  const decodeChildStdout = (buffer) => {
    if (!buffer || buffer.length === 0) return ""
    const utf8 = buffer.toString("utf8")
    if (!utf8.includes("\uFFFD")) return utf8
    try {
      const gbk = new TextDecoder("gb18030").decode(buffer)
      if (!gbk.includes("\uFFFD")) return gbk
    } catch (e) { /* 无完整 ICU 时忽略，保留 utf8 结果 */ }
    return utf8
  }
  // 从子进程攒 Buffer→统一解码；两个 data 收集器都用它，避免重复的 Buffer 判定
  const collectChunks = (stream, sink) => {
    stream.on("data", (chunk) => { sink.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))) })
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
  // 盘中盯盘（live-watch）：开关/三档预设/播报节奏/当日计数；盘中时间线单独一份日志
  const LIVE_WATCH_FILE = BASE_DIR + "/.dsh-invest/store/live-watch.json"
  const LIVE_LOG_FILE = BASE_DIR + "/.dsh-invest/store/live-log.jsonl"
  // 证券名称索引（code → 名称）：结论流水不带 name，观察档案建档时用它补全
  const NAMES_FILE = BASE_DIR + "/.dsh-invest/store/names.json"
  // 个股分析知识库：报告按「个股」切段归集（清单 + 每只股票一份 Markdown）
  const STOCK_NOTES_FILE = BASE_DIR + "/.dsh-invest/store/stock-notes.json"
  const STOCK_NOTES_DIR = BASE_DIR + "/.dsh-invest/store/stocks"
  const WEB_DIST_DIR = BASE_DIR + "/.dsh-invest/web/dist"
  const WEB_DIST_INDEX = WEB_DIST_DIR + "/index.html"
  const WEB_DIST_JS = WEB_DIST_DIR + "/workbench.js"
  const WEB_DIST_CSS = WEB_DIST_DIR + "/workbench.css"
  // 「悟道」条目库：交易心得 / 复盘沉淀，跑流水线时按角色注入（写前留一份 .bak 供手救）
  const DAO_FILE = BASE_DIR + "/.dsh-invest/store/dao.json"
  const DAO_BAK_FILE = BASE_DIR + "/.dsh-invest/store/dao.bak.json"

  // 读取账本 → 紧凑 Markdown 摘要（不存在/损坏时返回空串，绝不阻断流水线）
  const readHoldingsBlock = async () => {
    const fs = hostService(ctx, "fs")
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
    const fs = hostService(ctx, "fs")
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
    const fs = hostService(ctx, "fs")
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
      const fs = hostService(ctx, "fs")
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
    const fs = hostService(ctx, "fs")
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

  // ============ 实例身份（v0.48.0）：多人共用时的来源标识 ============
  // store/instance.json：本机身份 { id, name, createdAt }；id 首次启动随机生成、永久不变，
  // name 可在判断质量页改名。conclusions 落库带 instance=id；导入他机数据时按 id 区分来源。
  // store/instances.json：已知实例映射 { <id>: { name, lastSeen } }——导入时自动登记，
  // 分组表里就能显示对方的名字而不是一串随机短码。
  const INSTANCE_FILE = BASE_DIR + "/.dsh-invest/store/instance.json"
  const INSTANCES_FILE = BASE_DIR + "/.dsh-invest/store/instances.json"
  let instanceCache = null
  const loadInstance = async () => {
    if (instanceCache) return instanceCache
    try {
      const j = JSON.parse(await fsp.readFile(INSTANCE_FILE, "utf8"))
      if (j && typeof j.id === "string" && j.id) { instanceCache = { id: j.id, name: String(j.name || "") }; return instanceCache }
    } catch (e) { /* 首次 */ }
    const inst = { id: "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), name: "", createdAt: new Date().toISOString() }
    try { await fsp.mkdir(BASE_DIR + "/.dsh-invest/store", { recursive: true }); await fsp.writeFile(INSTANCE_FILE, JSON.stringify(inst, null, 2)) } catch (e) { /* 内存兜底 */ }
    instanceCache = { id: inst.id, name: inst.name }
    return instanceCache
  }
  const setInstanceName = async (name) => {
    const inst = await loadInstance()
    const clean = String(name || "").trim().slice(0, 30)
    inst.name = clean
    let prev = {}
    try { prev = JSON.parse(await fsp.readFile(INSTANCE_FILE, "utf8")) } catch (e) { /* 新建 */ }
    try { await fsp.writeFile(INSTANCE_FILE, JSON.stringify({ ...prev, id: inst.id, name: clean }, null, 2)) } catch (e) { /* 内存态已改，落盘失败下次启动丢失 */ }
    return inst
  }
  const loadKnownInstances = async () => {
    try {
      const j = JSON.parse(await fsp.readFile(INSTANCES_FILE, "utf8"))
      if (j && typeof j === "object") return j
    } catch (e) { /* 无 */ }
    return {}
  }
  const rememberInstance = async (id, name) => {
    if (!id) return
    const map = await loadKnownInstances()
    const prev = map[id] || {}
    map[id] = { name: String(name || prev.name || "").slice(0, 30), lastSeen: new Date().toISOString() }
    try { await fsp.writeFile(INSTANCES_FILE, JSON.stringify(map, null, 2)) } catch (e) { /* 尽力而为 */ }
  }
  // 分组显示名：本机 → 自定义名或「本机」；已知他机 → 其名；未知 → 短码
  const instanceLabel = async (id) => {
    const local = await loadInstance()
    const eff = id || local.id // 无 instance 的行是本机旧数据（v0.48.0 之前落库），归本机
    if (eff === local.id) return local.name || "本机"
    const known = (await loadKnownInstances())[eff]
    return (known && known.name) ? known.name : eff.slice(0, 8)
  }

  // ============ 更新检查（v0.50.0）============
  // DSH 没有插件自动更新：宿主半部是进程内加载的，更新后必须重启才生效。
  // 因此这里只做两件事：① 告诉用户「有没有新版」；② 给出与其安装方式匹配的那一条命令。
  // 不下载、不安装、不改文件——一切写操作留给用户自己执行。
  let updateCache = null
  const REPO_URL = "https://github.com/Pikapiku09/dsh-invest-plugin"
  // 读仓库文件的两个来源（v0.51.2）
  //
  // v0.51.0 只用 raw.githubusercontent.com，而本机实测这个域名直接 connect failed
  // （github.com 与 api.github.com 都正常）——「检测更新」会永远报「网络不可用」，
  // 是个从没在真人环境验证过的死路。现在 API 优先、raw 兜底：不同网络环境总有一条能通。
  const REPO_API = "https://api.github.com/repos/Pikapiku09/dsh-invest-plugin/contents"
  const REPO_RAW = "https://raw.githubusercontent.com/Pikapiku09/dsh-invest-plugin/main"
  const readRepoFile = async (relPath) => {
    const errors = []
    try {
      const r = await fetch(REPO_API + "/" + relPath + "?ref=main", {
        signal: AbortSignal.timeout(6000),
        headers: { accept: "application/vnd.github+json", "user-agent": "dsh-invest-plugin" },
      })
      if (!r.ok) throw new Error("api HTTP " + r.status)
      const j = await r.json()
      if (!j || typeof j.content !== "string") throw new Error("api 返回格式异常")
      return Buffer.from(j.content, j.encoding === "base64" ? "base64" : "utf8").toString("utf8")
    } catch (e) { errors.push("api: " + String(e && e.message || e).slice(0, 80)) }
    try {
      const r = await fetch(REPO_RAW + "/" + relPath, {
        signal: AbortSignal.timeout(6000),
        headers: { "cache-control": "no-cache" },
      })
      if (!r.ok) throw new Error("raw HTTP " + r.status)
      return await r.text()
    } catch (e) { errors.push("raw: " + String(e && e.message || e).slice(0, 80)) }
    // 两个来源都断：把两条具体错误都带出去，用户/排查时才知道断在哪一层
    throw new Error(errors.join("；"))
  }
  // 语义化版本比较：统一用 pure.js 的实现（可测试），这里不再重复定义
  const cmpVersion = cmpVersionPure
  // 读本包版本：相对 lib/index.js 的 ../package.json（link: 与 github 安装都成立）
  const localVersion = async () => {
    try {
      const here = new URL("../package.json", import.meta.url)
      const j = JSON.parse(await fsp.readFile(here, "utf8"))
      return String(j.version || "")
    } catch (e) { return "" }
  }
  // 探测安装方式：扫 profiles 下各 package.json 的依赖，找出指向本仓库的那条
  const detectInstall = async () => {
    const home = process.env.USERPROFILE || process.env.HOME || ""
    const dir = home + "/.dsh/profiles"
    let names = []
    try { names = await fsp.readdir(dir) } catch (e) { return { kind: "unknown", profile: "web", command: "" } }
    for (const name of names) {
      let pkg
      try { pkg = JSON.parse(await fsp.readFile(dir + "/" + name + "/package.json", "utf8")) } catch (e) { continue }
      const deps = pkg && pkg.dependencies ? pkg.dependencies : {}
      for (const [key, spec] of Object.entries(deps)) {
        const s = String(spec || "")
        if (!/dsh-invest/i.test(key) && !/dsh-invest-plugin/i.test(s)) continue
        if (s.startsWith("link:") || s.startsWith("file:")) {
          return { kind: "link", profile: name, command: 'dsh plugin --profile ' + name + " install" }
        }
        if (s.startsWith("github:") || s.startsWith("git+")) {
          return { kind: "github", profile: name, command: "dsh plugin --profile " + name + " update " + key }
        }
      }
    }
    return { kind: "unknown", profile: "web", command: "" }
  }
  // 远端「比本机新」的版本变更要点（v0.51.0）
  //
  // 只用于「发现新版本」弹窗里说清改了什么。本机安装的 whats-new.json 只含已装版本及以下，
  // 所以更新版本的内容必须从仓库读。拉不到就返回空数组——绝不因为这一步让更新检查整体失败。
  const remoteHighlights = async (current) => {
    try {
      const j = JSON.parse(await readRepoFile("packages/dsh-invest/lib/whats-new.json"))
      const rels = Array.isArray(j && j.releases) ? j.releases : []
      return rels
        .filter((x) => x && x.version && cmpVersion(String(x.version), current) > 0)
        .sort((a, b) => cmpVersion(String(b.version), String(a.version)))
        .slice(0, 6)
        .map((x) => ({
          version: String(x.version),
          date: String(x.date || ""),
          title: String(x.title || ""),
          items: Array.isArray(x.items) ? x.items.slice(0, 8).map((i) => String(i)) : [],
        }))
    } catch (e) { return [] }
  }
  const checkForUpdate = async () => {
    const current = await localVersion()
    const install = await detectInstall()
    const base = {
      current, repo: REPO_URL, installKind: install.kind, profile: install.profile,
      command: install.command, checkedAt: new Date().toISOString(),
    }
    if (!current) return { ok: false, ...base, error: "无法读取本包版本号" }
    let latest = ""
    try {
      const remote = JSON.parse(await readRepoFile("packages/dsh-invest/package.json"))
      latest = String((remote && remote.version) || "")
      if (!latest) throw new Error("远端 package.json 没有 version 字段")
    } catch (e) {
      return { ok: false, ...base, error: "检查更新失败（网络不可用或仓库不可达）：" + String(e && e.message || e).slice(0, 160) }
    }
    const diff = cmpVersion(latest, current)
    const updateAvailable = diff > 0
    return {
      ok: true, ...base, latest,
      updateAvailable,
      // 有更新才去拉要点：正常无更新时一次网络请求都不多打
      highlights: updateAvailable ? await remoteHighlights(current) : [],
      // 安装方式决定命令；link 方式还要先 git pull，这里给出可直接复制的一行
      hint: install.kind === "link"
        ? "先到插件目录执行 git pull，再跑下面的命令；完成后重启 DSH"
        : install.kind === "github"
          ? "直接跑下面的命令即可拉取 main 最新提交；完成后重启 DSH"
          : "未识别安装方式，请手动更新后重启 DSH",
    }
  }

  // P3：结构化结论落库（v0.45.0 修正采集口径）
  //
  // 旧实现只取「最后一个含结论的成功阶段、最多 3 条」——选股模式四阶段里，
  // 选股师给的候选会被总判断师的 3 条完全覆盖，是真实的数据遗漏点。
  // 新口径：**收集所有成功阶段**的结构化结论，同一标的后出现的阶段覆盖前面的（下游更权威），
  // 去重后最多 20 个标的；同时记录 runId / stage / report，保证每条回测数据都可溯源。
  const persistConclusions = async (mode, question, callId, outputs, reports, policy) => {
    const fs = hostService(ctx, "fs")
    if (fs === void 0) return 0
    const byCode = new Map()
    let anyBlock = false
    for (const o of outputs) {
      if (!o.ok) continue
      const parsed = parseConclusionBlocks(o.text)
      if (!parsed.length) continue
      anyBlock = true
      for (const b of parsed) {
        const code = String(b.code || "").trim().toUpperCase()
        if (!/^\d{6}\.(SH|SZ|BJ)$/.test(code)) continue
        // 后出现的阶段覆盖同标的的旧结论（总判断 > 深度 > 选股）
        byCode.set(code, { block: b, stage: o.stage })
      }
    }
    if (!anyBlock || !byCode.size) return 0
    const cNum = (v, lo, hi) => {
      const n = Number(v)
      return (Number.isFinite(n) && n >= lo && n <= hi) ? Math.round(n * 100) / 100 : null
    }
    const entries = Array.from(byCode.entries()).slice(0, 20)
    const inst = await loadInstance()
    const lines = entries.map(([code, item]) => {
      const b = item.block
      return JSON.stringify({
        ts: new Date().toISOString(), mode, question: String(question).slice(0, 200), callId,
        code, stance: b.stance || "未明",
        // 来源实例（v0.48.0）：多人共享数据时区分「谁的判断」；旧记录无此字段，回测时归本机
        instance: inst.id,
        // 置信度（v0.45.0 新增）：模型自评 0-1，用于回测做校准分析；历史记录没有此字段
        confidence: cNum(b.confidence, 0, 1),
        target: (typeof b.target === "number" ? b.target : null),
        stop: (typeof b.stop === "number" ? b.stop : null),
        buy_low: (typeof b.buy_low === "number" ? b.buy_low : null),
        buy_high: (typeof b.buy_high === "number" ? b.buy_high : null),
        thesis: String(b.thesis || "").slice(0, 200),
        invalidate_if: String(b.invalidate_if || "").slice(0, 200),
        // 反方论证（v0.45.0 新增）：总判断师必须写「如果我错了会怎么错」
        counter_case: String(b.counter_case || "").slice(0, 240),
        stage: item.stage, report: reports[0] || null, source: "invest_run",
      })
    })
    try {
      await withLock("conclusions", async () => {
        const target = await fs.resolve(CONCLUSIONS_LOG)
        let existing = ""
        try { existing = await fs.readText(target) } catch (e) { /* 首次 */ }
        const prefix = existing && !existing.endsWith("\n") ? existing + "\n" : existing
        await fs.writeText(target, prefix + lines.join("\n") + "\n", void 0, void 0, policy)
      })
      // 同步标的档案：只取下游（更权威）阶段的若干条，避免选股候选一次塞几十条进档案
      try {
        const STAGE_RANK = { "总判断师": 5, "股票深度分析师": 4, "波段池管理师": 3, "选股分析师": 2, "市场重点消息获取师": 1 }
        const forSync = entries
          .slice()
          .sort((a, b) => (STAGE_RANK[b[1].stage] || 0) - (STAGE_RANK[a[1].stage] || 0))
          .slice(0, 6)
          .map(([, it]) => it.block)
        await syncWatchlistFromConclusions(forSync)
      } catch (e) { /* 档案同步失败不阻断结论落库 */ }
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
  // ===== 持有期价位语义校验（v0.53.0）=====
  // 结论里的 target / stop 会随 stance 变语义：「减仓 / 离场」给出的往往是回踩位、减仓参考价，
  // 并不是止盈目标。过去无条件覆盖，导致多次分析后出现
  // 「止盈 16.68 < 止损 17.35 < 成本 18.855」这种自相矛盾的档案，还会被当成止盈阈值误报提醒。
  // 成本是账本事实（不由结论写入），拿它当唯一可靠锚点。
  const positionLevelIssue = (pos, field, value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "不是有效正价格"
    const cost = wNum(pos.cost)
    const stop = wNum(pos.stop)
    const target = wNum(pos.target)
    if (field === "target") {
      if (cost !== null && value <= cost) return `低于成本 ${cost}，不能作为止盈目标`
      if (stop !== null && value <= stop) return `不高于止损价 ${stop}，不能作为止盈目标`
      return ""
    }
    if (cost !== null && value >= cost) return `不低于成本 ${cost}，不能作为止损价`
    // 现存的止盈目标本身异常时，不能拿它当锚反过来拒绝一个合理的止损
    if (target !== null && (cost === null || target > cost) && value >= target) return `不低于止盈目标 ${target}，不能作为止损价`
    return ""
  }
  /** 存量脏数据（止盈 ≤ 成本 / ≤ 止损）不得再参与止盈信号比对 */
  const positionLevelSane = (pos) => {
    const target = wNum(pos.target), stop = wNum(pos.stop), cost = wNum(pos.cost)
    if (target === null) return true
    if (cost !== null && target <= cost) return false
    if (stop !== null && target <= stop) return false
    return true
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
      // 止盈目标低于成本/止损时是脏数据（多半由回踩位误写），不得再触发「止盈提醒」误导用户
      if (tg !== null && positionLevelSane(pos) && p >= tg) return { key: it.code + "|target|" + localYmd(), kind: "target", level: "good", qty: heldQty, message: "【止盈提醒】" + nm + " " + it.code + " 现价 " + p + " 达到目标价 " + tg + "，成本 " + f2(wNum(pos.cost)) + "，" + heldText + "。" }
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
      const fs = hostService(ctx, "fs")
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
        // 「减仓 / 离场」结论里的 target 多为回踩位 / 减仓参考价，不是止盈目标：
        // 只更新失效条件与时间戳，不碰持有期价位，避免多次分析把止盈价越改越低。
        if (stance === "持有") {
          for (const field of ["target", "stop"]) {
            if (typeof b[field] !== "number") continue
            const issue = positionLevelIssue(pos, field, b[field])
            if (issue) {
              const ignored = Array.isArray(pos.sync_ignored) ? pos.sync_ignored : (pos.sync_ignored = [])
              ignored.unshift({ ts: now, field, value: b[field], stance, reason: issue })
              pos.sync_ignored = ignored.slice(0, 6)
              changed = true
              continue
            }
            pos[field] = b[field]
            changed = true
          }
        }
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
    const fs = hostService(ctx, "fs")
    if (fs === void 0) return void 0
    try {
      const target = await fs.resolve(ROUTES_FILE)
      return parseRoutesJson(await fs.readText(target))
    } catch (e) { return void 0 }
  }

  // 当日交易日锚点缓存（子代理写入，Host 读取注入）
  const readTradeCache = async () => {
    const fs = hostService(ctx, "fs")
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
  // 名称兜底：本地 OCR 偶发漏字、视觉模型则经常只回代码不回名称，草稿里就会出现一排空白名
  // （用户视角像「内容缺失/显示不正确」）。代码本身是强约束（六位 + 交易所），用本地名称索引
  // 反查是确定性的，不需要再花一次模型调用去补。
  const fillPositionNames = async (positions) => {
    const list = Array.isArray(positions) ? positions : []
    if (!list.some((p) => p && !String(p.name || "").trim())) return list
    const names = await readStockNames()
    return list.map((p) => {
      if (!p || String(p.name || "").trim()) return p
      const name = names[p.code]
      return (typeof name === "string" && name.trim()) ? { ...p, name: name.trim() } : p
    })
  }
  const makeHoldingsDraft = async (source, positions, account, warnings) => {
    const current = await readHoldingsDoc()
    const id = "hd_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7)
    const normAccount = normalizeAccount(account)
    // positions 已先经 normalizePosition，再统一重算计算列，保证草稿永远与 cost/shares/current_price 一致
    const calcPositions = recalcPositions(await fillPositionNames(Array.isArray(positions) ? positions : []), normAccount)
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
    const fs = hostService(ctx, "fs")
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
    let backupOk = false
    try { await writeTextWithPolicyRetry(await fs.resolve(backup), JSON.stringify(current, null, 2) + "\n"); backupOk = true } catch (e) { /* 首次无账本可忽略 */ }
    const updatedAt = d.toISOString()
    await writeJsonFile(HOLDINGS_FILE, { version: 1, updated_at: updatedAt, account, positions })
    let auditWarning = ""
    try {
      await appendHoldingsAudit({ ts: updatedAt, action: "watch-sync", watchAction: action, code, diff, positions, account })
    } catch (e) { auditWarning = "审计日志写入失败：" + String(e && e.message ? e.message : e).slice(0, 200) }
    return { changed: true, action, code, updated_at: updatedAt, backup: backupOk ? backup : null, diff, warnings: auditWarning ? [auditWarning] : [] }
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
    const fs = hostService(ctx, "fs")
    if (fs === void 0) throw new Error("fs unavailable")
    const d = new Date()
    const stamp = localYmd() + "_" + z2(d.getHours()) + z2(d.getMinutes()) + z2(d.getSeconds())
    const backup = HOLDINGS_BACKUP_DIR + "/持仓_" + stamp + ".json"
    let backupOk = false
    try { await writeTextWithPolicyRetry(await fs.resolve(backup), JSON.stringify(current, null, 2) + "\n"); backupOk = true } catch (e) { /* 首次无账本可忽略 */ }
    const updatedAt = d.toISOString()
    const next = { version: 1, updated_at: updatedAt, account: nextAccount, positions }
    await writeJsonFile(HOLDINGS_FILE, next)
    // 账本已落盘 → 审计与档案同步都只回告警，不能把「写审计失败」当成「整次确认失败」：
    // 旧行为下前端提示失败，但 持仓.json 其实已经改了，用户重试是重复写、不重试又缺审计与档案同步。
    let auditWarning = ""
    try {
      await appendHoldingsAudit({ ts: updatedAt, action: "confirm", source: draft.source, draftId, diff, positions, account: nextAccount })
    } catch (e) { auditWarning = "审计日志写入失败：" + String(e && e.message ? e.message : e).slice(0, 200) }
    // 账本已落盘 → 同步标的档案（失败不阻断账本写入，但把错误带回前端）
    let watchSync = []
    let watchSyncError = ""
    try { watchSync = await syncWatchlistFromHoldings(positions) }
    catch (e) { watchSyncError = String(e && e.message ? e.message : e).slice(0, 200) }
    delete holdingsDrafts[draftId]
    return { ok: true, updated_at: updatedAt, backup: backupOk ? backup : null, diff, watchSync, watchSyncError, auditWarning }
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
    const fs = hostService(ctx, "fs")
    if (fs === void 0) throw new Error("fs unavailable")
    const d = new Date()
    const stamp = localYmd() + "_" + z2(d.getHours()) + z2(d.getMinutes()) + z2(d.getSeconds())
    const backup = HOLDINGS_BACKUP_DIR + "/持仓_" + stamp + ".json"
    let backupOk = false
    try { await writeTextWithPolicyRetry(await fs.resolve(backup), JSON.stringify(current, null, 2) + "\n"); backupOk = true } catch (e) { /* 首次无账本可忽略 */ }
    const updatedAt = d.toISOString()
    const next = { version: 1, updated_at: updatedAt, account: nextAccount, positions: recalculated }
    await writeJsonFile(HOLDINGS_FILE, next)
    let auditWarning = ""
    try {
      await appendHoldingsAudit({ ts: updatedAt, action: "refresh-quotes", source: fetched.source || "tencent", prices, diff, positions: recalculated, account: nextAccount })
    } catch (e) { auditWarning = "审计日志写入失败：" + String(e && e.message ? e.message : e).slice(0, 200) }
    let watchSync = []
    let watchSyncError = ""
    try { watchSync = await syncWatchlistFromHoldings(recalculated) }
    catch (e) { watchSyncError = String(e && e.message ? e.message : e).slice(0, 200) }
    return { ok: true, updated_at: updatedAt, updated: hit.length, total: codes.length, missing, prices, fetched_at: fetched.fetchedAt || updatedAt, backup: backupOk ? backup : null, diff, watchSync, watchSyncError, auditWarning }
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
      // 盘中看板要显示「今日涨跌」：腾讯行情 fld[4]=昨收、fld[32]=涨跌幅(%)，一并带出，
      // 免得前端为了算一个百分比再发一次请求。
      quotes.push({
        code: fld[2],
        price: Number.isFinite(price) ? price : null,
        prev_close: wNum(fld[4]),
        change_pct: wNum(fld[32]),
      })
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
      const outChunks = [], errChunks = []
      collectChunks(child.stdout, outChunks)
      collectChunks(child.stderr, errChunks)
      child.on("error", (e) => done({ ok: false, spawnUnavailable: true, reason: "spawn python 不可用：" + String(e && e.message || e) }))
      child.on("close", (code) => {
        if (settled) return
        // 与本地 OCR 同源问题：脚本若按本地代码页输出，逐块 String() 会把中文毁成替换符
        const out = decodeChildStdout(Buffer.concat(outChunks))
        const err = decodeChildStdout(Buffer.concat(errChunks))
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
  // 返回 { doc, refreshed, fired, fetchedAt, changed }；无观察/持有标的时 refreshed=0，不抛错
  //
  // opts.gate(it, sig) → boolean：信号闸门（盘中盯盘用来做「连续 2 次成立 / 破线 ≥0.3%」确认）。
  //   返回 false 时只是不落提醒，last_signal_key 保持不动，下一个 tick 还能再次触发。
  // opts.lazy：无变化（现价与信号键都没变）时不重写 watchlist.json。
  //   盘中 60s 一次的全量重写 ≈ 11.5MB/日，横盘时这些写盘全是噪声。
  const refreshWatchPrices = async (opts) => withLock("watchlist", async () => {
    const options = opts || {}
    const gate = typeof options.gate === "function" ? options.gate : null
    const doc = await readWatchlist()
    // 需要现价的标的：观察 + 持有（已清仓/已移除跳过）
    const active = doc.items.filter((it) => it && (it.state === "观察" || it.state === "持有"))
    if (!active.length) return { doc, refreshed: 0, fired: [], fetchedAt: null, changed: false }
    const before = active.map((it) => String((it.monitor && it.monitor.current_price) ?? "") + ":" + String((it.monitor && it.monitor.last_signal_key) || ""))
    const codes = active.map((it) => it.code)
    const result = await fetchQuotePrices(codes)
    const byDigits = {}
    for (const q of result.quotes) {
      const digits = String(q && q.code != null ? q.code : "").replace(/\D/g, "").slice(0, 6)
      const price = (q == null || q.price === null || q.price === void 0 || q.price === "") ? null : Number(q.price)
      if (digits.length === 6 && price !== null && Number.isFinite(price)) {
        byDigits[digits] = {
          price,
          prev_close: (q && q.prev_close !== void 0) ? wNum(q.prev_close) : null,
          change_pct: (q && q.change_pct !== void 0) ? wNum(q.change_pct) : null,
        }
      }
    }
    const fired = []
    for (const it of active) {
      const digits = String(it.code).replace(/\D/g, "").slice(0, 6)
      const row = byDigits[digits]
      const m = it.monitor || (it.monitor = {})
      if (row) {
        m.current_price = row.price
        m.prev_close = row.prev_close
        m.change_pct = row.change_pct
      } else {
        m.current_price = null
        m.prev_close = null
        m.change_pct = null
      }
      m.refreshed_at = result.fetchedAt || new Date().toISOString()
      deriveWatch(it)
      const sig = evalWatchSignal(it)
      if (sig) {
        if (gate && !gate(it, sig)) continue
        const rec = await appendAlert(doc, it, sig)
        if (rec) fired.push(rec)
      }
    }
    const after = active.map((it) => String((it.monitor && it.monitor.current_price) ?? "") + ":" + String((it.monitor && it.monitor.last_signal_key) || ""))
    const changed = before.join("|") !== after.join("|")
    if (changed || !options.lazy) await writeWatchlist(doc)
    return { doc, refreshed: active.length, fired, fetchedAt: result.fetchedAt || new Date().toISOString(), changed }
  })
  const runVisionSubagent = async (prompt) => runPromptSubagent(prompt, { label: "持仓截图识别", timeoutMs: 120000 })
  // 通用子代理执行（单个阶段式提问）：限流 + 超时 + 禁止递归
  const runPromptSubagent = async (prompt, opts) => {
    const options = opts || {}
    const label = options.label || "投研子任务"
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 120000
    // 父 Agent 优先选「工作区覆盖 BASE_DIR」的那个会话（子代理会继承它的沙箱根与模型）。
    const live = liveAgents(ctx)
    const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    const base = norm(BASE_DIR)
    const coversBase = (ag) => {
      const cwd = ag && ag.session && ag.session.header ? ag.session.header.cwd : ""
      const c = norm(cwd)
      return Boolean(c) && (base === c || base.startsWith(c + "/"))
    }
    const parent = live.filter(coversBase).pop() || live[live.length - 1]
    if (!parent) throw new Error("没有可用的顶层 Agent，无法执行「" + label + "」（宿主 ctx.agents 里没有活跃会话 Agent）")
    const candidates = []
    try { if (ctx.subagents) candidates.push(ctx.subagents) } catch (e) { /* ignore */ }
    for (const n of ["subagents", "subagent"]) {
      try { const v = hostService(ctx, n, true); if (v) candidates.push(v) } catch (e) { /* ignore */ }
      try { const v = hostService(ctx, n, false); if (v) candidates.push(v) } catch (e) { /* ignore */ }
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
      // 0.2.x：startActivation 读 spec 顶层的 parent，不能塞进 request（见 activationSpecFor 注释）
      const promptText = typeof prompt === "string"
        ? prompt
        : (Array.isArray(prompt) ? prompt.map((b) => (b && b.text) || "").join("\n") : String(prompt || ""))
      let act
      try {
        act = await activation.startActivation(activationSpecFor(spec, promptText, "caller"))
      } catch (e) {
        if (/delivery|caller|UNSUPPORTED/i.test(String(e))) act = await activation.startActivation(activationSpecFor(spec, promptText, "parent"))
        else throw e
      }
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
    const fs = hostService(ctx, "fs")
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
        const outChunks = []
        const errChunks = []
        const timer = setTimeout(() => { try { child.kill() } catch (e) { /* ignore */ } reject(new Error("本地 OCR 超时（60 秒）")) }, 60000)
        collectChunks(child.stdout, outChunks)
        collectChunks(child.stderr, errChunks)
        child.on("error", (error) => { clearTimeout(timer); reject(error) })
        child.on("close", (code) => {
          clearTimeout(timer)
          const out = decodeChildStdout(Buffer.concat(outChunks))
          const err = decodeChildStdout(Buffer.concat(errChunks))
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
    const attachments = hostService(ctx, "attachments")
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
    const fs = hostService(ctx, "fs")
    if (fs === void 0) return fallback
    try { return JSON.parse(await fs.readText(await fs.resolve(path))) } catch (e) { return fallback }
  }
  // v0.75.3：所有落到磁盘的写入统一走「多候选沙箱策略 + 记住命中者」
  //
  // v0.75.2 只给 writeJsonFile 加了候选重试，审计（holdings_audit.jsonl）与账本备份仍用
  // getFsPolicy()（= candidates[0]）。本机多工作区并行时 candidates[0] 会解析成「别的会话」的策略，
  // 于是同一个目录里出现「账本写成功、审计行写失败」：
  //   FsError: cannot write "...holdings_audit.jsonl": file access denied under workspace-write mode
  // 现象是磁盘明明可写、账本其实已经改了，用户却看到「确认写入失败」。
  // 现在：写入端逐个候选重试；命中过的候选用下标记住（fsPolicyHint），后续写（含未改造的
  // getFsPolicy() 旧调用点）优先复用它，不必每次都先撞一次拒绝。
  let fsPolicyHint = -1
  const writeTextWithPolicyRetry = async (target, text) => {
    const fs = hostService(ctx, "fs")
    if (fs === void 0) throw new Error("fs unavailable")
    const targetPath = String((target && target.displayPath) || target || "")
    const cands = fsPolicyCandidates(targetPath)
    if (!cands.length) {
      // 没有任何候选带策略（宿主没有 sandboxPolicy 服务，或老版本 API）：交给宿主默认判定。
      // 若宿主默认根不覆盖目标，这里会抛出 FS_SANDBOX_DENIED —— 换成能照着查的话再抛。
      try { await fs.writeText(target, text); return } catch (e) {
        if (!String(e && e.message ? e.message : e).includes("file access denied")) throw e
        throw new Error("写入被沙箱拒绝，且没有可用的会话策略覆盖该路径：" + targetPath
          + "（活跃会话数 " + liveAgents(ctx).length + "；请确认至少有一个会话的工作区包含该目录，或重启 DSH 让插件重新挂载）")
      }
    }
    const list = cands.slice(0, 4)
    if (fsPolicyHint > 0 && fsPolicyHint < list.length) {
      list.unshift(list.splice(fsPolicyHint, 1)[0])
    }
    let firstErr = null
    for (const p of list) {
      try {
        await fs.writeText(target, text, void 0, void 0, p)
        const idx = cands.indexOf(p)
        if (idx >= 0) fsPolicyHint = idx
        return
      } catch (e) {
        if (!firstErr) firstErr = e
      }
    }
    throw firstErr
  }
  const writeJsonFile = async (path, value) => {
    const fs = hostService(ctx, "fs")
    if (fs === void 0) throw new Error("fs unavailable")
    await writeTextWithPolicyRetry(await fs.resolve(path), JSON.stringify(value, null, 2) + "\n")
  }
  // 追加一行 JSONL（审计/日志）：读旧文 → 拼一行 → 全量重写。写入走候选重试，
  // 不要再用单策略 getFsPolicy() —— 那个在「写账本成功之后」失败会把整次操作判成失败。
  const appendJsonlLine = async (target, payload) => {
    const fs = hostService(ctx, "fs")
    if (fs === void 0) throw new Error("fs unavailable")
    let oldLog = ""
    try { oldLog = await fs.readText(target) } catch (e) { /* 首次 */ }
    const line = typeof payload === "string" ? payload : JSON.stringify(payload)
    await writeTextWithPolicyRetry(target, oldLog + (oldLog && !oldLog.endsWith("\n") ? "\n" : "") + line + "\n")
  }
  const appendHoldingsAudit = async (payload) => {
    const fs = hostService(ctx, "fs")
    if (fs === void 0) throw new Error("fs unavailable")
    await appendJsonlLine(await fs.resolve(HOLDINGS_AUDIT), payload)
  }
  // 写文件必须带沙箱 policy（宿主 workspace-write 模式会拒绝无 policy 的写入）。
  //
  // 2026-11-20 修正过「候选顺序」（原来只取最后一个会话根）。
  // 2026-11-23 找到真正病根：候选来源用的是 `agents.roots()`，而 DSH 0.2.x 没有这个方法
  // （AgentService 只有 list()/get()/create()）。于是候选恒为空 → 写入退回「无会话」的
  // 部署默认根 → 工作区内的写全被 FS_SANDBOX_DENIED 拒掉（账本、watchlist、审计、备份都写不进）。
  //
  // 现在：候选来自 liveAgents()（list() 优先，roots() 兜底），并且**按目标路径过滤**——
  // 只保留 workspaceRoot（含 additionalWritableRoots）确实覆盖目标的策略，不再盲试。
  // 一个都不覆盖时也保留「部署默认策略」作为最后候选，让宿主给出它自己的拒因。
  const policyCovers = (policy, targetPath) => {
    if (!policy || !targetPath) return false
    if (policy.mode === "danger-full-access") return true
    if (policy.mode !== "workspace-write") return false
    const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    const target = norm(targetPath)
    if (!target) return false
    const roots = [policy.workspaceRoot].concat(Array.isArray(policy.additionalWritableRoots) ? policy.additionalWritableRoots : [])
    return roots.some((root) => {
      const r = norm(root)
      return Boolean(r) && (target === r || target.startsWith(r + "/"))
    })
  }
  const fsPolicyCandidates = (targetPath) => {
    const out = []
    const push = (policy) => {
      if (policy === void 0 || policy === null) return
      if (policyCovers(policy, targetPath)) {
        const key = String(policy.mode) + "|" + String(policy.workspaceRoot || "")
        if (out.some((item) => String(item.mode) + "|" + String(item.workspaceRoot || "") === key)) return
      } else if (targetPath !== void 0) {
        // 不覆盖目标的策略不进候选：以前盲试会先撞一次拒绝，日志里全是假红
        return
      }
      out.push(policy)
    }
    try {
      const sp = hostService(ctx, "sandboxPolicy")
      if (sp === void 0) return out
      // ① 覆盖目标的活跃会话优先（保证写的是「看得见这个工作区」的那个会话的策略）
      const agents = liveAgents(ctx)
      for (let i = agents.length - 1; i >= 0; i -= 1) {
        const session = agents[i] && agents[i].session
        if (session === void 0) continue
        try { push(sp.resolve({ session })) } catch (e) { /* 单个会话解析失败不影响其他候选 */ }
      }
      // ② 无会话的部署默认策略：覆盖目标时才有意义（不覆盖会在写入端得到宿主的原始拒因）
      try { push(sp.resolve()) } catch (e) { /* ignore */ }
    } catch (e) { /* 服务缺失 → 返回空，退回宿主默认策略 */ }
    return out
  }
  // 遗留的单策略调用点（运行日志 / 结论归档等）：优先用「上次写成功过」的候选。
  const getFsPolicy = (targetPath) => {
    const c = fsPolicyCandidates(targetPath === void 0 ? BASE_DIR : targetPath)
    if (!c.length) return void 0
    if (fsPolicyHint > 0 && fsPolicyHint < c.length) return c[fsPolicyHint]
    return c[0]
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

  // —— 「悟道」条目库（本地单用户）——
  // 读写都走 readJsonFile / writeJsonFile：前者把「文件不存在、被手工改坏」统一降级成空库，
  // 后者带沙箱策略重试（见 v0.75.3 注释），多工作区并行时不会写一半失败。
  const readDaoStore = async () => normalizeDaoStore(await readJsonFile(DAO_FILE, null))

  const daoPayload = (store) => ({ items: store.items, stats: daoStats(store), updated_at: store.updated_at })

  // 读-改-写必须串行：两个标签页同时保存会互相覆盖（沿用 withLock）
  const mutateDao = (fn) => withLock("dao", async () => {
    const current = await readDaoStore()
    const result = fn(current)
    await writeJsonFile(DAO_BAK_FILE, current)
    await writeJsonFile(DAO_FILE, result.store)
    return result
  })

  // 参数问题（400）与模型问题（503）必须分开：前者改输入就能过，后者重试/换模型才有用
  const daoInputError = (message) => Object.assign(new Error(message), { code: "DAO_INPUT" })

  // 对话人格只认「教练」或五个角色简码，避免前端塞进任意 persona 文本
  const daoPersona = (raw) => {
    const value = String(raw || "").trim()
    if (!value || value === "教练" || value === DAO_COACH_LABEL) return { name: DAO_COACH_LABEL, role: "" }
    const role = ROLE_MAP[value]
    if (!role) throw daoInputError("未知的对话人格：" + value.slice(0, 20))
    return { name: role.name, role: role.code }
  }

  const daoMessages = (raw) => (Array.isArray(raw) ? raw : [])
    .filter((turn) => turn && typeof turn.text === "string" && turn.text.trim())
    .slice(-12)
    .map((turn) => ({ role: turn.role === "assistant" ? "assistant" : "user", text: String(turn.text) }))

  const daoChat = async (personaRaw, messagesRaw) => {
    const list = daoMessages(messagesRaw)
    const last = list[list.length - 1]
    if (!last || last.role !== "user") throw daoInputError("请先输入要聊的内容")
    const persona = daoPersona(personaRaw)
    // 教练要能指出「这条纪律是你自己写的」，所以给它看全部条目（按置顶/最近取前 12 条，字数在 prompt 层再收）
    const entries = (await readDaoStore()).items.slice(0, 12)
    const prompt = buildCoachPrompt({
      personaName: persona.name, personaRole: persona.role,
      entries, messages: list.slice(0, -1), question: last.text,
    })
    const started = Date.now()
    const answer = await runPromptSubagent(prompt, { label: "悟道对话", timeoutMs: 180000 })
    return { answer: String(answer || "").trim(), elapsedMs: Date.now() - started, persona: persona.name }
  }

  const daoDistill = async (personaRaw, messagesRaw) => {
    const list = daoMessages(messagesRaw)
    if (!list.length) throw daoInputError("对话为空，没有可沉淀的内容")
    const persona = daoPersona(personaRaw)
    const prompt = buildDistillPrompt({ personaName: persona.name, messages: list.slice(-6) })
    const text = await runPromptSubagent(prompt, { label: "悟道沉淀", timeoutMs: 120000 })
    // 模型偶尔不按 JSON 交付：降级成「首行标题 + 全文正文」的草稿，用户还能改
    const draft = parseDistillJson(text) || draftFromText(text)
    if (!draft) throw daoInputError("模型没有返回可用的条目草稿，请重试或手动填写")
    return { draft }
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
      const live = liveAgents(ctx)
      const host = live[live.length - 1]
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
          const llm = hostService(ctx, "llm")
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
      const idx = JSON.parse(await (hostService(ctx, "fs")).readText(await (hostService(ctx, "fs")).resolve(STORE_INDEX)))
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
      const idx = JSON.parse(await (hostService(ctx, "fs")).readText(await (hostService(ctx, "fs")).resolve(STORE_INDEX)))
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
    // v0.77.0：对比页的「升级为深度对比」落到这里——快速对比（同口径事实表）之外，需要完整报告时的重型路径
    { id: "compare-deep", name: "深度对比", description: "两只票同口径深研 + 结论落档（从对比页升级）", mode: "个股", roles: ["消息", "深度", "总判断"], sequence: ["消息", "深度", "总判断"], preset: "inherit", needsCode: false, placeholder: "如 000823.SZ 002815.SZ", question: "对 {input} 中指定的两只标的做同口径深度对比（代码以用户输入为准，未给则先按账本与观察池里最接近的一对，并明确说明你选的是哪两只）：\n① 用 Tushare 取两票共同的最新交易日数据，统一同一 as-of、同一价格口径（不复权 daily）后再算：价格位置（距 250 日高回撤）、趋势动量（20/60 日相对上证超额）、资金（近 20 日主力净流入）、估值（PE_TTM/PB）、质量（ROE/净利同比/营收同比/毛利率/负债率）；两票数据日期不一致时要显式标注，禁止把不同日期的数字并排比较。\n② 结合持仓账本与现行纪律判断可执行性：单票权重上限 20%；赔率=(目标−现价)/(现价−生效止损)，<3:1 只观察；生效止损以标的档案 position.stop 为准、与最新结论不一致时要同时列出两个值。\n③ 逐只给目标价、止损、失效条件与赔率；再给「如果只能选一只买，选谁、先做什么、仓位多少」。\n④ 若两只都不满足条件，直接说「都不选」，不要为了给答案而凑。\n⑤ 末尾输出两行【结论结构化】JSON（code/stance/target/stop/thesis/invalidate_if），便于落档。\n输出 ≤1200 字，先结论后理由。{input}" },
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
      const fs = hostService(ctx, "fs")
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
    const fs = hostService(ctx, "fs")
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
    const fs = hostService(ctx, "fs")
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
    const fs = hostService(ctx, "fs")
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
  // 方向口径的唯一来源（2026-11-20）：命中率(hit5) 与 赔率(盈亏比/期望值) 必须共用
  // 同一套 stance 定义，否则会出现「命中率一个分母、赔率另一个分母」的同屏矛盾。
  // 观察（以及任何不在两张表里的立场）一律不计方向——它的后续走势单独看。
  const BULLISH_STANCES = ["看多", "持有", "加仓"]
  const BEARISH_STANCES = ["拒绝", "回避", "减仓", "离场"]
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
  // 复权因子（v0.46.0）：Tushare `daily` 返回的是未复权价，除权除息日价格自然下跳，
  // 直接用未复权 close 算区间收益，会把「分红送转」误算成「下跌」。
  // 缓存策略与 btDaily 一致：命中 <BASE_DIR>/.dsh-invest/cache/pack/adj_<code>_<ymd>.json 即离线。
  const btAdj = async (code, token) => {
    const { readdirSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs")
    const dir = BASE_DIR + "/.dsh-invest/cache/pack"
    const prefix = "adj_" + code.replace(/\./g, "_") + "_"
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
        const c = JSON.parse(readFileSync(dir + "/" + best, "utf8"))
        if (Array.isArray(c.rows) && c.rows.length >= 30) return c.rows
        // 负缓存：ETF 等确实没有复权因子，记下来免得每次刷新都再问一次接口
        if (c.noAdj === true) return null
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
        body: JSON.stringify({ api_name: "adj_factor", token, params: { ts_code: code, start_date: ymd(start), end_date: ymd(end) } }),
      })
      const j = JSON.parse(await r.text())
      if (j.code !== 0 || !j.data || !Array.isArray(j.data.items)) return null
      const fields = j.data.fields
      const rows = j.data.items.map((it) => { const o = {}; fields.forEach((k, i) => { o[k] = it[i] }); return o })
        .sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))
      // ETF / 部分新标的没有复权因子，行数不足视为「无因子」，回落到未复权
      try {
        mkdirSync(dir, { recursive: true })
        const body = rows.length < 30 ? { code, endYmd: ymd(end), rows: [], noAdj: true } : { code, endYmd: ymd(end), rows }
        writeFileSync(dir + "/" + prefix + ymd(end) + ".json", JSON.stringify(body))
      } catch (e) { /* 回写失败不影响本次 */ }
      return rows.length < 30 ? null : rows
    } catch (e) { return null }
  }
  const computeBacktest = async () => {
    const fs0 = hostService(ctx, "fs")
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
    const adjRaw = {}
    for (const code of codes) {
      daily[code] = await btDaily(code, token)
      if (!daily[code]) warnings.push(code + "：无日线数据（缓存与 Tushare 均失败）")
      if (daily[code]) adjRaw[code] = await btAdj(code, token)
    }
    // 复权因子索引：trade_date -> adj_factor
    const adjOf = {}
    let adjCovered = 0
    for (const code of codes) {
      if (!Array.isArray(adjRaw[code])) continue
      const m = new Map()
      for (const x of adjRaw[code]) {
        const f = Number(x.adj_factor)
        if (Number.isFinite(f) && f > 0) m.set(String(x.trade_date), f)
      }
      if (m.size) { adjOf[code] = m; adjCovered += 1 }
    }
    if (adjCovered < codes.length) {
      warnings.push("复权因子覆盖 " + adjCovered + "/" + codes.length + " 只；无因子标的（ETF 等）按未复权计算")
    }
    const idx = await btDaily(BACKTEST_IDX_CODE, token, true)
    const idxDates = idx ? idx.map((x) => String(x.trade_date)) : []
    // 市场状态（v0.47.0）：解决「同一周几十条结论共享同一段行情」的同质样本问题。
    // 口径：结论基准日的上证——收盘 vs MA20、20 日涨跌，双确认定上/下行，混合为震荡；
    // 与收益基准同日（多数结论盘后生成，当日收盘即当时可见状态）。指数数据不足 20 根则为 null。
    const regimeAt = (ymd) => {
      if (!idx) return null
      const j = idxDates.findIndex((d) => d >= ymd)
      if (j < 0 || j < 20) return null
      const closes = idx.slice(j - 19, j + 1).map((x) => Number(x.close))
      if (closes.length < 20 || closes.some((v) => !Number.isFinite(v) || v <= 0)) return null
      const ma20 = closes.reduce((a, b) => a + b, 0) / closes.length
      const ret20 = Number(idx[j].close) / Number(idx[j - 20].close) - 1
      if (!Number.isFinite(ret20)) return null
      const c = Number(idx[j].close)
      if (c > ma20 && ret20 > 0) return "上行"
      if (c < ma20 && ret20 < 0) return "下行"
      return "震荡"
    }
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
      // 未复权收益：保留作审计字段，用来对照「复权后差了多少」
      const ret5Raw = fwd5 !== null ? (fwd5 / base - 1) * 100 : null
      const ret20Raw = fwd20 !== null ? (fwd20 / base - 1) * 100 : null
      // 前复权收益：close × adj_factor 才是连续可比价格；缺因子（ETF 等）回落未复权
      const amap = adjOf[c.code]
      const fa = amap ? amap.get(String(r[i].trade_date)) : void 0
      const adjRatio = (n) => {
        if (!amap || i + n >= r.length) return null
        if (typeof fa !== "number" || fa <= 0) return null
        const fb = amap.get(String(r[i + n].trade_date))
        if (typeof fb !== "number" || fb <= 0) return null
        return (Number(r[i + n].close) * fb) / (base * fa)
      }
      const ratio5 = adjRatio(5), ratio20 = adjRatio(20)
      const ret5 = ratio5 !== null ? (ratio5 - 1) * 100 : ret5Raw
      const ret20 = ratio20 !== null ? (ratio20 - 1) * 100 : ret20Raw
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
      const bullish = BULLISH_STANCES.includes(c.stance)
      const bearish = BEARISH_STANCES.includes(c.stance)
      const directional = bullish || bearish
      rows.push({
        ts: c.ts, code: c.code, stance: String(c.stance || ""), stage: String(c.stage || ""), mode: String(c.mode || ""),
        base: btRound(base), target: (typeof c.target === "number" ? c.target : null),
        ret5: btRound(ret5), ret20: btRound(ret20), ex5: btRound(ex5), ex20: btRound(ex20),
        // 审计字段（v0.46.0）：未复权原值 + 本条是否真的应用了复权
        ret5Raw: btRound(ret5Raw), ret20Raw: btRound(ret20Raw),
        adjApplied: ratio5 !== null || ratio20 !== null,
        // 市场状态（v0.47.0）：同质样本拆分的唯一维度
        regime: regimeAt(tsYmd),
        // 来源实例（v0.48.0）：空 = 本机旧数据（v0.48.0 之前落库）
        instance: String(c.instance || ""),
        hit5: (ret5 === null || !directional) ? null : (bullish ? ret5 > 0 : ret5 < 0),
        hit20: (ret20 === null || !directional) ? null : (bullish ? ret20 > 0 : ret20 < 0),
        thesis: String(c.thesis || "").slice(0, 80),
        // 溯源字段（v0.45.0）：每条回测记录都能回到「哪次运行 / 哪份报告 / 哪个阶段」
        runId: String(c.callId || ""), report: c.report ? String(c.report).split(/[\\/]/).pop() : "",
        source: String(c.source || ""),
        // 置信度与反方论证（历史记录可能没有）
        confidence: (typeof c.confidence === "number") ? c.confidence : null,
        counterCase: String(c.counter_case || "").slice(0, 120),
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
      // 方向收益：看多/持有/加仓取 +ret，拒绝/回避/减仓/离场取 -ret（做空视角），观察不计
      // 2026-11-20 修正：原实现只对 bearish 取反、其余一律当看多，观察类被静默算进
      // 胜率/盈亏比/期望值——与 hit5 的口径（bullish||bearish 才算方向）不一致，
      // 于是同一屏出现「命中率 n=33、盈亏比 n=68」两个分母，赔率也被观察类拉偏。
      const directional = []
      for (const x of r5) {
        if (BEARISH_STANCES.includes(x.stance)) directional.push(-x.ret5)
        else if (BULLISH_STANCES.includes(x.stance)) directional.push(x.ret5)
      }
      const wins = directional.filter((v) => v > 0)
      const losses = directional.filter((v) => v <= 0)
      const avgWin = wins.length ? btRound(wins.reduce((a, b) => a + b, 0) / wins.length) : null
      const avgLoss = losses.length ? btRound(Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length)) : null
      const plRatio = (avgWin !== null && avgLoss !== null && avgLoss > 0) ? btRound(avgWin / avgLoss) : null
      const winRate = directional.length ? btRound(wins.length / directional.length * 100) : null
      // 期望值（单笔，%）= 胜率×平均盈利 − 败率×平均亏损
      const expectancy = (winRate !== null && avgWin !== null && avgLoss !== null)
        ? btRound((winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss) : null
      // Wilson 95% 置信区间：小样本命中率必须带区间，否则 1/1=100% 会被误读成「全对」
      const wilson = (k, n) => {
        if (!n) return null
        const z = 1.96, p = k / n
        const den = 1 + z * z / n
        const mid = p + z * z / (2 * n)
        const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
        return { low: btRound(Math.max(0, (mid - margin) / den) * 100), high: btRound(Math.min(1, (mid + margin) / den) * 100) }
      }
      return {
        samples: list.length,
        hits5: h5.length, rate5: h5.length ? btRound(h5.filter((x) => x.hit5).length / h5.length * 100) : null,
        rate5CI: h5.length ? wilson(h5.filter((x) => x.hit5).length, h5.length) : null,
        hits20: h20.length, rate20: h20.length ? btRound(h20.filter((x) => x.hit20).length / h20.length * 100) : null,
        rate20CI: h20.length ? wilson(h20.filter((x) => x.hit20).length, h20.length) : null,
        avgRet5: avg(r5, "ret5"), avgRet20: avg(r20, "ret20"),
        avgEx5: avg(e5, "ex5"), avgEx20: avg(e20, "ex20"),
        dirSamples: directional.length, winRate, avgWin, avgLoss, plRatio, expectancy,
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
    // 来源实例（v0.48.0）：分组显示名解析——本机 → 自定义名；他机 → 导入时登记的名字
    const localInst = await loadInstance()
    const knownInst = await loadKnownInstances()
    const labelOf = (id) => {
      const eff = id || localInst.id // 无 instance 的旧行归本机
      if (eff === localInst.id) return localInst.name || "本机"
      const k = knownInst[eff]
      return (k && k.name) ? k.name : eff.slice(0, 8)
    }
    // 置信度分箱（v0.45.0）：回答「它说很有把握时，是不是真的更准」
    const confBin = (x) => {
      const v = x.confidence
      if (typeof v !== "number") return "无置信度"
      if (v >= 0.8) return "0.8–1.0（高）"
      if (v >= 0.6) return "0.6–0.8（中）"
      return "0–0.6（低）"
    }
    const confGroups = groupAgg(confBin)
      .sort((a, b) => String(b.name).localeCompare(String(a.name)))
    const withConf = rows.filter((x) => typeof x.confidence === "number").length
    return {
      generatedAt: new Date().toISOString(),
      total: conclusions.length, matched: rows.length,
      overall: agg(rows),
      byStage: groupAgg((x) => x.stage), byStance: groupAgg((x) => x.stance),
      byMonth: groupAgg((x) => String(x.ts).slice(0, 7)),
      byRegime: groupAgg((x) => x.regime),
      byInstance: groupAgg((x) => labelOf(x.instance)),
      localInstance: { id: localInst.id, name: localInst.name },
      byConfidence: confGroups, confidenceCoverage: withConf,
      // 复权覆盖：adjCoverage / adjUniverse，用来一眼看出有多少标的真的按前复权算了
      adjCoverage: adjCovered, adjUniverse: codes.length,
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

  // ===== 结论采集审计（v0.45.0）=====
  // 回答一个具体问题：回测页的数据到底从哪来、哪些运行没进库、为什么没进。
  // 采集口径：每次流水线结束时，把各阶段【结论结构化】行写入 store/conclusions.jsonl（append-only）。
  // 因此「遗漏」只可能发生在采集那一刻，事后不会被改写；而历史报告若保留了结构化行，可以回溯补录。
  const computeConclusionAudit = async () => {
    const fs0 = hostService(ctx, "fs")
    const readSafe = async (p) => {
      if (fs0 !== void 0) { try { return await fs0.readText(await fs0.resolve(p)) } catch (e) { /* fallthrough */ } }
      try { const { readFileSync } = await import("node:fs"); return readFileSync(p, "utf8") } catch (e) { return "" }
    }
    const parseLines = (text) => String(text || "").split("\n").filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l) } catch (e) { return null }
    }).filter(Boolean)

    const runs = parseLines(await readSafe(RUNS_LOG)).filter((r) => r && r.ts)
    const conclusions = parseLines(await readSafe(CONCLUSIONS_LOG)).filter((c) => c && c.code)

    const byCall = new Map()
    for (const c of conclusions) {
      const k = String(c.callId || "")
      byCall.set(k, (byCall.get(k) || 0) + 1)
    }

    const byMode = new Map()
    const missing = []
    let withC = 0, without = 0, failedRuns = 0, recoveredRuns = 0
    // 真实运行（排除 recovered 回填）单独统计：覆盖率分母用真实运行才有意义
    let realTotal = 0, realWith = 0
    const recentCut = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
    let recentReal = 0, recentWith = 0
    for (const r of runs) {
      const n = byCall.get(String(r.callId)) || 0
      const mode = String(r.mode || "—")
      if (!byMode.has(mode)) byMode.set(mode, { mode, runs: 0, withConclusions: 0, conclusions: 0, failed: 0 })
      const g = byMode.get(mode)
      g.runs += 1
      g.conclusions += n
      const failedRun = r.ok === false || (Array.isArray(r.stages) && r.stages.length > 0 && r.stages.every((s) => s && s.ok === false))
      if (failedRun) { g.failed += 1; failedRuns += 1 }
      if (r.recovered) recoveredRuns += 1
      else {
        realTotal += 1
        if (n > 0) realWith += 1
        if (String(r.ts).slice(0, 10) >= recentCut) {
          recentReal += 1
          if (n > 0) recentWith += 1
        }
      }
      if (n > 0) { g.withConclusions += 1; withC += 1 } else {
        without += 1
        if (missing.length < 40) {
          missing.push({
            ts: r.ts, mode, question: String(r.question || "").slice(0, 70),
            reason: failedRun ? "运行失败，未产出结论"
              : r.recovered ? "报告回填记录（当时未写运行日志，无结构化结论）"
                : "报告未包含【结论结构化】行",
          })
        }
      }
    }
    const runIds = new Set(runs.map((r) => String(r.callId)))
    const orphans = conclusions.filter((c) => !runIds.has(String(c.callId))).length

    // 结论按日期分布：解释「为什么大部分结论还没有 5 日窗口」
    const dateDist = new Map()
    for (const c of conclusions) {
      const d = String(c.ts || "").slice(0, 10)
      if (d) dateDist.set(d, (dateDist.get(d) || 0) + 1)
    }

    // 可回溯估算：报告目录里有多少份报告、其中多少份能解析出结构化行
    let reportFiles = 0, parseable = 0
    try {
      const { readdirSync, readFileSync } = await import("node:fs")
      const dir = BASE_DIR + "/.dsh-invest/reports"
      const files = readdirSync(dir).filter((f) => f.endsWith(".md"))
      reportFiles = files.length
      for (const f of files.slice(-400)) {
        try {
          const t = readFileSync(dir + "/" + f, "utf8")
          if (t.includes("【结论结构化】")) parseable += 1
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* 目录不存在 */ }

    // 执行率对账（v0.45.0）：建议 vs 实际持仓 —— 回答「它说的到底有没有被执行」
    // 只看每只标的的最新一条结论，避免旧结论干扰
    let execution = { available: false, positions: 0, matched: 0, notExecuted: [], note: "" }
    try {
      const holdText = await readSafe(HOLDINGS_FILE)
      const hold = JSON.parse(holdText || "{}")
      const positions = Array.isArray(hold.positions) ? hold.positions : []
      const held = new Map()
      for (const p of positions) {
        const code = String(p.code || "").toUpperCase()
        if (code) held.set(code, p)
      }
      const latestByCode = new Map()
      for (const c of conclusions) {
        const code = String(c.code || "").toUpperCase()
        const cur = latestByCode.get(code)
        if (!cur || String(c.ts) > String(cur.ts)) latestByCode.set(code, c)
      }
      const bullish = new Set(["看多", "持有", "加仓"])
      const bearish = new Set(["拒绝", "回避", "减仓", "离场"])
      const notExecuted = []
      let matched = 0
      for (const [code, c] of latestByCode.entries()) {
        const st = String(c.stance || "")
        const isHeld = held.has(code)
        if (isHeld) matched += 1
        if (bullish.has(st) && !isHeld) {
          notExecuted.push({ code, stance: st, ts: c.ts, kind: "建议持有但账本无持仓" })
        }
        if (bearish.has(st) && isHeld) {
          notExecuted.push({ code, stance: st, ts: c.ts, kind: "建议减仓/离场但账本仍持有" })
        }
      }
      execution = {
        available: positions.length > 0,
        positions: positions.length,
        matched,
        notExecuted: notExecuted.slice(0, 20),
        note: positions.length
          ? "对比「每只标的最新一条结论」与持仓账本；只做提示，不判断对错——没执行可能是你有更好的理由"
          : "账本为空，无法对账；先在持仓工作区录入持仓",
      }
    } catch (e) { /* 账本不可读则跳过对账 */ }

    return {
      generatedAt: new Date().toISOString(),
      execution,
      runs: {
        total: runs.length, withConclusions: withC, without, failed: failedRuns, recovered: recoveredRuns,
        // 覆盖率用「真实运行」作分母：recovered 回填记录当时没有结构化输出，不能算作遗漏
        realTotal, realWith,
        realCoverage: realTotal ? Math.round(realWith / realTotal * 1000) / 10 : null,
        recentReal, recentWith,
        recentCoverage: recentReal ? Math.round(recentWith / recentReal * 1000) / 10 : null,
        recentWindowDays: 7,
      },
      conclusions: { total: conclusions.length, distinctCodes: new Set(conclusions.map((c) => c.code)).size, orphans, withConfidence: conclusions.filter((c) => typeof c.confidence === "number").length },
      byMode: Array.from(byMode.values()).sort((a, b) => b.runs - a.runs),
      missing: missing.reverse(),
      dateDist: Array.from(dateDist.entries()).map(([date, n]) => ({ date, n })).sort((a, b) => a.date.localeCompare(b.date)),
      reports: { total: reportFiles, parseable },
      lineage: {
        source: "每次流水线结束时，各阶段末尾的【结论结构化】行 → store/conclusions.jsonl（只追加，不改写）",
        window: "回测用结论日后第 5/20 个交易日的收盘价；窗口未走完时 ret 为 null，不计入命中率",
        note: "历史记录只有 2026-11-04 起（结论采集功能上线时间），更早的报告不会自动出现在回测里，除非执行回溯补录",
      },
    }
  }

  // ===== 历史报告回溯补录（v0.45.0）=====
  // 把归档报告里残留的【结论结构化】行补进 conclusions.jsonl。
  // 只补「报告里确实存在的结构化行」，不推断、不编造；按（报告+标的）去重，可反复执行。
  const backfillConclusions = async (apply) => {
    const fs0 = hostService(ctx, "fs")
    const readSafe = async (p) => {
      if (fs0 !== void 0) { try { return await fs0.readText(await fs0.resolve(p)) } catch (e) { /* fallthrough */ } }
      try { const { readFileSync } = await import("node:fs"); return readFileSync(p, "utf8") } catch (e) { return "" }
    }
    const dir = BASE_DIR + "/.dsh-invest/reports"
    let files = []
    try {
      const { readdirSync } = await import("node:fs")
      files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort()
    } catch (e) { return { ok: false, error: "报告目录不可读", added: 0, candidates: 0 } }

    const existing = String(await readSafe(CONCLUSIONS_LOG)).split("\n").filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l) } catch (e) { return null }
    }).filter(Boolean)
    const seen = new Set()
    for (const c of existing) {
      const rep = String(c.report || "").split(/[\\/]/).pop()
      seen.add(rep + "|" + String(c.code || ""))
    }

    const additions = []
    const perReport = []
    for (const f of files) {
      const text = String(await readSafe(dir + "/" + f) || "")
      const blocks = parseConclusionBlocks(text)
      if (!blocks.length) continue
      const m = f.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/)
      const ts = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).toISOString() : new Date().toISOString()
      const modeMatch = text.match(/- 模式：(\S+)/)
      const mode = modeMatch ? modeMatch[1] : "未知"
      let used = 0
      for (const b of blocks) {
        const code = String(b.code || "").trim().toUpperCase()
        if (!/^\d{6}\.(SH|SZ|BJ)$/.test(code)) continue
        const key = f + "|" + code
        if (seen.has(key)) continue
        seen.add(key)
        used += 1
        additions.push(JSON.stringify({
          ts, mode, question: "历史报告回溯补录", callId: "backfill:" + f,
          code, stance: b.stance || "未明",
          confidence: (typeof b.confidence === "number" && b.confidence >= 0 && b.confidence <= 1) ? Math.round(b.confidence * 100) / 100 : null,
          target: (typeof b.target === "number" ? b.target : null),
          stop: (typeof b.stop === "number" ? b.stop : null),
          buy_low: (typeof b.buy_low === "number" ? b.buy_low : null),
          buy_high: (typeof b.buy_high === "number" ? b.buy_high : null),
          thesis: String(b.thesis || "").slice(0, 200),
          invalidate_if: String(b.invalidate_if || "").slice(0, 200),
          counter_case: String(b.counter_case || "").slice(0, 240),
          stage: "历史报告", report: BASE_DIR + "/.dsh-invest/reports/" + f, source: "backfill",
        }))
      }
      if (used) perReport.push({ file: f, blocks: blocks.length, added: used })
    }

    if (!apply || !additions.length) {
      return { ok: true, applied: false, candidates: additions.length, reports: perReport.slice(-20), added: 0 }
    }
    try {
      const fs2 = hostService(ctx, "fs")
      if (fs2 === void 0) return { ok: false, error: "fs 不可用", added: 0, candidates: additions.length }
      await withLock("conclusions", async () => {
        const target = await fs2.resolve(CONCLUSIONS_LOG)
        let cur = ""
        try { cur = await fs2.readText(target) } catch (e) { /* 首次 */ }
        const prefix = cur && !cur.endsWith("\n") ? cur + "\n" : cur
        await fs2.writeText(target, prefix + additions.join("\n") + "\n", void 0, void 0, getFsPolicy())
      })
      return { ok: true, applied: true, added: additions.length, candidates: additions.length, reports: perReport.slice(-20) }
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 200), added: 0, candidates: additions.length }
    }
  }

  const executeJob = async (job) => {
    job.status = "running"
    job.startedAt = Date.now()
    let taskHandle = null
    try {
      const agents = hostService(ctx, "agents")
      // 方案A：为本次任务创建专用执行 Agent，与当前对话彻底隔离（不挂在聊天下）
      let parent = null
      if (agents && typeof agents.create === "function") {
        try {
          const sid = (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
            ? globalThis.crypto.randomUUID()
            : "wb-task-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
          // 专用 Agent 装上宿主模型：使"继承宿主"类角色能继承到有效模型
          // 宿主模型优先级：模型设置里的覆盖（settings.defaultModel）> 当前会话根 Agent 的模型
          const roots0 = liveAgents(ctx)
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
        const live = liveAgents(ctx)
        parent = live[live.length - 1]
      }
      if (!parent) throw new Error("当前没有可用的执行 Agent；请先打开一个 DSH 会话再启动网页任务")
      const controller = new AbortController()
      job.abort = () => controller.abort()
      // 取消闸门：任务在 prepare/create 阶段就被取消时，直接结束，不进入 LLM 流水线
      if (job.cancelRequested) {
        controller.abort()
        job.status = "cancelled"
        job.error = job.error || "已取消：任务在执行前被用户中断"
        return
      }
      const preset = await resolveTemplatePreset(job.templateId, job.preset)
      const result = await tool.execute({ mode: job.mode, question: job.question, roles: job.roles, preset, detail: "full", ...(Array.isArray(job.sequence) && job.sequence.length ? { sequence: job.sequence } : {}) }, { callId: job.id, agent: parent, signal: controller.signal })
      if (job.cancelRequested) {
        // 用户已中断：结果不归档成 done，保留「已取消」状态
        job.status = "cancelled"
        job.error = job.error || "已取消：用户中断，本次分析结果不归档"
      } else {
        job.result = result
        const outs = Array.isArray(result.outputs) ? result.outputs : []
        job.status = result.error || (outs.length && outs.every((o) => !o.ok)) ? "failed" : "done"
        job.error = result.error || (outs.find((o) => !o.ok) || {}).error || ""
      }
    } catch (e) {
      job.status = job.cancelRequested ? "cancelled" : "failed"
      job.error = job.cancelRequested ? (job.error || "已取消：用户中断") : String(e).slice(0, 600)
    } finally {
      job.elapsedMs = Date.now() - job.startedAt
      job.abort = null
      // 最近任务持久化（最近 5 个，跨 web 关闭/DSH 重启保留）
      try { await rememberRecentJob(job) } catch (e) { /* ignore */ }
      // 释放专用任务执行 Agent（该任务的分析子代理已完成）
      if (taskHandle && typeof taskHandle.dispose === "function") {
        try { await taskHandle.dispose() } catch (e) { /* ignore */ }
      }
      // 取消的任务没有新报告，跳过重建索引与知识库整理，尽快回到空闲
      if (job.status !== "cancelled") {
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

  // 取消任务：排队中的直接摘出队列；运行中的立刻 abort（当前阶段终止，结果不归档）
  const cancelJob = (id) => {
    const job = jobStore[id]
    if (!job) return { ok: false, code: 404, error: "任务不存在（可能已被清理）" }
    if (job.status === "cancelled") return { ok: false, code: 409, error: "任务已经是取消状态" }
    if (job.status === "queued") {
      const idx = taskQueue.indexOf(job)
      if (idx >= 0) taskQueue.splice(idx, 1)
      job.cancelRequested = true
      job.status = "cancelled"
      job.elapsedMs = 0
      job.error = "已取消：排队中，未开始执行"
      void rememberRecentJob(job).catch(() => { /* ignore */ })
      return { ok: true, code: 200, job }
    }
    if (job.status === "running") {
      job.cancelRequested = true
      job.status = "cancelled"
      job.error = "已取消：用户手动中断"
      if (typeof job.abort === "function") {
        try { job.abort() } catch (e) { /* ignore */ }
      }
      return { ok: true, code: 200, job }
    }
    return { ok: false, code: 409, error: "任务已结束（" + job.status + "），无法取消" }
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

  // ============ 盘中盯盘 + 定时播报（live-watch）：规则层高频跑，LLM 只做解释 ============
  // 与 watch-daily 的分工：日检管「收盘后要不要重跑分析」，盘中盯盘管「现在偏离计划多远、有没有破线」。
  // 盘中只做两件事：把现价写回档案 + 把「现价 vs 计划」的事实对照播报出来。
  // 不给新买卖建议、不用盘中价算技术指标（MA/量能一律用日线收盘）。
  //
  // 三档预设是「节奏」的唯一事实来源：改了预设就同步写死 intervalSec/broadcastEveryMin，
  // 手改间隔则把 preset 记成「自定义」，避免出现「显示标准、实际跑 30 秒」。
  const LIVE_PRESETS = {
    极简: { intervalSec: 120, broadcastEveryMin: 0 },
    标准: { intervalSec: 60, broadcastEveryMin: 30 },
    盯盘: { intervalSec: 30, broadcastEveryMin: 15 },
  }
  const LIVE_DEFAULTS = {
    version: 1,
    enabled: false,             // 默认关闭：盯盘是用户显式开启的能力，不能默认偷跑
    preset: "标准",             // 极简 / 标准 / 盯盘 / 自定义
    intervalSec: 60,
    broadcastEveryMin: 30,      // 0 = 不例行播报，只在事件发生时播
    confirmTicks: 2,            // 防插针：连续 N 次成立才落提醒（stop/invalidate/target）
    confirmBandPct: 0.3,        // 或破线幅度 ≥ 0.3% 直接成立
    llmExplain: false,          // 解释层默认关闭
    llmMinLevel: "bad",         // 只有 bad 级事件才自动调 LLM
    llmDailyCap: 20,            // 盘中快问每日上限（防烧 token）
    notifyLevel: "bad",         // 系统通知门槛：bad / warn / all（复用既有提醒通道）
    sessionOnly: true,          // 只在交易时段自动跑
    // —— 运行时状态 ——
    ymd: "", tickCount: 0, eventCount: 0, llmCount: 0,
    lastTickAt: "", lastTickStatus: "", lastError: "",
    lastBroadcastAt: "", lastBroadcastNote: "", backoffUntil: "",
  }
  const readLiveWatch = async () => {
    const raw = await readJsonFile(LIVE_WATCH_FILE, {})
    const st = Object.assign({}, LIVE_DEFAULTS, (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {})
    const preset = LIVE_PRESETS[st.preset]
    if (preset) { st.intervalSec = preset.intervalSec; st.broadcastEveryMin = preset.broadcastEveryMin }
    return st
  }
  const patchLiveWatch = async (patch) => {
    const next = Object.assign({}, await readLiveWatch(), patch, { updated_at: new Date().toISOString() })
    await writeJsonFile(LIVE_WATCH_FILE, next)
    return next
  }
  // 交易时段闸：A 股连续竞价 09:30–11:30 / 13:00–15:00，工作日。节假日不特判，靠「价格不动」自然降级。
  const liveSession = (d) => {
    const t = d || new Date()
    const day = t.getDay()
    const weekday = day >= 1 && day <= 5
    const m = t.getHours() * 60 + t.getMinutes()
    const am = m >= 570 && m <= 690
    const pm = m >= 780 && m <= 900
    const inSession = weekday && (am || pm)
    let label = "非交易日"
    if (weekday) {
      if (inSession) label = "盘中"
      else if (m >= 555 && m < 570) label = "集合竞价"
      else if (m > 690 && m < 780) label = "午休"
      else if (m >= 900) label = "已收盘"
      else label = "未开盘"
    }
    return { inSession, label, hm: localHm(t), weekday, minute: m }
  }
  // 盘中时间线：只留最近 300 行，追加时顺手压缩（读-拼-写与 appendJsonlLine 同源策略）
  const LIVE_LOG_MAX_LINES = 300
  const readLiveLog = async (limit) => {
    const fs = hostService(ctx, "fs")
    if (fs === void 0) return []
    let text = ""
    try { text = await fs.readText(await fs.resolve(LIVE_LOG_FILE)) } catch (e) { return [] }
    const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim())
    const out = []
    for (const line of lines.slice(-Math.max(1, Number(limit) || 40))) {
      try { out.push(JSON.parse(line)) } catch (e) { /* 跳过坏行 */ }
    }
    return out.reverse() // 新的在前，前端直接渲染
  }
  const appendLiveLog = async (rec) => {
    try {
      const fs = hostService(ctx, "fs")
      if (fs === void 0) return null
      const target = await fs.resolve(LIVE_LOG_FILE)
      let old = ""
      try { old = await fs.readText(target) } catch (e) { /* 首次 */ }
      const lines = String(old || "").split(/\r?\n/).filter((l) => l.trim())
      const kept = lines.length >= LIVE_LOG_MAX_LINES ? lines.slice(-(LIVE_LOG_MAX_LINES - 1)) : lines
      await writeTextWithPolicyRetry(target, (kept.length ? kept.join("\n") + "\n" : "") + JSON.stringify(rec) + "\n")
      return rec
    } catch (e) { return null }
  }
  // 该标的最近一条结构化结论（只看 code 命中的，取 ts 最大）
  const liveLatestConclusions = async (codes) => {
    const want = new Set((codes || []).map((c) => String(c || "").toUpperCase()).filter(Boolean))
    const out = {}
    for (const b of await readConclusionRecords()) {
      const code = String(b.code || "").toUpperCase()
      if (want.size && !want.has(code)) continue
      const prev = out[code]
      if (!prev || String(b.ts || "") > String(prev.ts || "")) out[code] = b
    }
    return out
  }
  const liveNum = (v) => {
    if (v === null || v === void 0 || v === "") return null
    const n = typeof v === "number" ? v : Number(v)
    return Number.isFinite(n) ? n : null
  }
  const liveFmt = (v, digits) => {
    const n = liveNum(v)
    if (n === null) return "—"
    const d = digits === void 0 ? 0 : digits
    const s = Math.abs(n).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d })
    return (n < 0 ? "-" : "") + s
  }
  const liveRound = (v, d) => {
    const n = liveNum(v)
    if (n === null) return null
    const p = Math.pow(10, d === void 0 ? 2 : d)
    return Math.round(n * p) / p
  }
  // 今日已触发信号（从 last_signal_key 还原，key 形如 code|kind|ymd）
  const liveTodaySignal = (it) => {
    const m = (it && it.monitor) || {}
    const parts = String(m.last_signal_key || "").split("|")
    if (parts.length < 3 || parts[2] !== localYmd()) return null
    return { kind: parts[1], at: m.last_signal_at || null }
  }
  // 盘中快照：持仓偏离 + 观察池到价 + 账户口径（全部用实时价重算，不信账本里的旧 current_price）
  const buildLiveSnapshot = async (doc, opts) => {
    const options = opts || {}
    const wl = doc || await readWatchlist()
    const items = Array.isArray(wl.items) ? wl.items : []
    const ledger = await readHoldingsDoc()
    const positions = (Array.isArray(ledger.positions) ? ledger.positions : []).filter((p) => {
      if (!p || !String(p.code || "").trim()) return false
      if (p.pool && String(p.pool) !== "实盘") return false
      const sh = liveNum(p.shares)
      return sh === null ? false : sh > 0
    })
    const byCode = new Map()
    for (const it of items) byCode.set(String(it.code || "").toUpperCase(), it)
    const concl = await liveLatestConclusions(positions.map((p) => p.code))
    const holdings = []
    const conflicts = []
    let marketValue = 0
    let floatPnl = 0
    let missing = 0
    for (const p of positions) {
      const code = String(p.code || "").toUpperCase()
      const it = byCode.get(code)
      const monitor = (it && it.monitor) || {}
      const price = liveNum(monitor.current_price)
      const shares = liveNum(p.shares) || 0
      const cost = liveNum(p.cost)
      const mv = price === null ? (liveNum(p.market_value) || 0) : price * shares
      marketValue += mv
      if (price === null) missing += 1
      const pnl = (price !== null && cost !== null) ? (price - cost) * shares : null
      if (pnl !== null) floatPnl += pnl
      const pos = (it && it.position) || {}
      const w = (it && it.watch) || {}
      const posStop = liveNum(pos.stop)
      const watchStop = liveNum(w.stop)
      const effStop = posStop !== null ? posStop : watchStop
      const effStopSrc = posStop !== null ? "档案" : (watchStop !== null ? "失效价" : "—")
      const c = concl[code]
      const conclStop = liveNum(c && c.stop)
      const stopConflict = Boolean(effStop && conclStop && Math.abs(conclStop - effStop) / effStop > 0.03)
      if (stopConflict) conflicts.push(code + " " + (p.name || "") + " 档案止损 " + effStop + " 与最新结论 " + conclStop + " 相差 " + Math.abs(Math.round(((conclStop - effStop) / effStop) * 100)) + "%")
      const dist = (price !== null && effStop) ? liveRound(((price - effStop) / effStop) * 100, 2) : null
      holdings.push({
        code, name: p.name || (it && it.name) || code, state: "持有",
        price, prev_close: liveNum(monitor.prev_close), change_pct: liveNum(monitor.change_pct),
        cost, shares, pnl: liveRound(pnl, 2), pnl_pct: (price !== null && cost) ? liveRound(((price - cost) / cost) * 100, 2) : null,
        market_value: liveRound(mv, 2), weight_pct: null,
        eff_stop: effStop, eff_stop_src: effStopSrc,
        dist_stop_pct: dist,
        stop_state: effStop === null ? "未设止损" : (price !== null && price <= effStop ? "已破 " + liveFmt(Math.abs(dist), 2) + "%" : "缓冲 " + liveFmt(dist, 2) + "%"),
        concl_stop: conclStop, concl_ts: (c && c.ts) || null, concl_stance: (c && c.stance) || null,
        stop_conflict: stopConflict,
        signal: liveTodaySignal(it),
      })
    }
    const cash = liveNum(ledger.account && ledger.account.available_cash) ?? liveNum(ledger.account && ledger.account.cash) ?? 0
    const totalAsset = marketValue + cash
    for (const h of holdings) h.weight_pct = totalAsset > 0 ? liveRound((h.market_value / totalAsset) * 100, 2) : null
    const watch = []
    for (const it of items) {
      if (!it || it.state !== "观察") continue
      const m = it.monitor || {}, w = it.watch || {}
      const price = liveNum(m.current_price)
      const lo = liveNum(w.buy_low), hi = liveNum(w.buy_high)
      watch.push({
        code: it.code, name: it.name || it.code, state: "观察",
        price, prev_close: liveNum(m.prev_close), change_pct: liveNum(m.change_pct),
        buy_low: lo, buy_high: hi, ideal_buy: liveNum(w.ideal_buy), buy_qty: liveNum(w.buy_qty),
        dist_buy_pct: liveNum(m.dist_buy_pct),
        in_buy_zone: Boolean(lo !== null && hi !== null && price !== null && price >= lo && price <= hi),
        signal: liveTodaySignal(it),
      })
    }
    watch.sort((a, b) => Math.abs(a.dist_buy_pct ?? 999) - Math.abs(b.dist_buy_pct ?? 999))
    return {
      asof: new Date().toISOString(),
      session: liveSession(),
      account: {
        cash: liveRound(cash, 2), market_value: liveRound(marketValue, 2), total_asset: liveRound(totalAsset, 2),
        position_pct: totalAsset > 0 ? liveRound((marketValue / totalAsset) * 100, 2) : null,
        float_pnl: liveRound(floatPnl, 2),
        float_pnl_pct: marketValue > 0 ? liveRound((floatPnl / marketValue) * 100, 2) : null,
      },
      holdings, watch, conflicts, events: Array.isArray(options.events) ? options.events : [],
      missing_prices: missing,
    }
  }
  // 播报正文：只做事实对照，不写「建议买/卖」——判断权留给用户
  const renderLiveBroadcastText = (snap, explainText) => {
    const a = snap.account
    const lines = []
    lines.push("【盘中播报 " + snap.session.hm + "】持仓 " + snap.holdings.length + " 只 · 市值 " + liveFmt(a.market_value) + " · 现金 " + liveFmt(a.cash) + " · 仓位 " + liveFmt(a.position_pct, 1) + "% · 浮动 " + (a.float_pnl !== null && a.float_pnl > 0 ? "+" : "") + liveFmt(a.float_pnl))
    for (const h of snap.holdings) {
      const chg = h.change_pct === null ? "" : " " + (h.change_pct > 0 ? "+" : "") + liveFmt(h.change_pct, 2) + "%"
      lines.push(h.code.replace(/\..*$/, "") + " " + h.name + " " + liveFmt(h.price, 3) + chg + " · 权重 " + liveFmt(h.weight_pct, 1) + "% · " + (h.eff_stop === null ? "未设止损" : "止损 " + liveFmt(h.eff_stop, 3) + "（" + h.stop_state + "）"))
    }
    const inZone = snap.watch.filter((x) => x.in_buy_zone)
    if (inZone.length) lines.push("观察池进买区 " + inZone.length + " 只：" + inZone.map((x) => x.name + " " + liveFmt(x.price, 3)).join("、"))
    const near = snap.watch.filter((x) => !x.in_buy_zone && x.dist_buy_pct !== null && x.dist_buy_pct > -3).slice(0, 3)
    if (near.length) lines.push("接近买区：" + near.map((x) => x.name + " 距 " + liveFmt(x.dist_buy_pct, 2) + "%").join("、"))
    if (snap.events.length) lines.push("本次事件 " + snap.events.length + " 条：" + snap.events.slice(0, 3).map((e) => String(e.message || "")).join(" / "))
    if (snap.conflicts.length) lines.push("止损口径冲突 " + snap.conflicts.length + " 项（看板已标⚠）")
    if (explainText) lines.push("解释：" + String(explainText).replace(/\s+/g, " ").slice(0, 160))
    return lines.join("\n")
  }
  // 防插针闸门：stop/invalidate/target 要连续 confirmTicks 次成立，或破线幅度 ≥ confirmBandPct。
  // 机会类信号（buy/add/trim）不设门槛——错过买点的成本高于误报。
  let liveTickState = null
  let livePendingSignals = Object.create(null)
  let liveSeenSignals = null
  const liveSignalGate = (it, sig) => {
    const st = liveTickState || {}
    const needConfirm = sig.kind === "stop" || sig.kind === "invalidate" || sig.kind === "target"
    if (!needConfirm) return true
    const price = liveNum(it && it.monitor && it.monitor.current_price)
    const level = sig.kind === "stop" ? liveNum(it.position && it.position.stop)
      : sig.kind === "invalidate" ? liveNum(it.watch && it.watch.stop)
        : liveNum(it.position && it.position.target)
    if (price !== null && level) {
      const band = Math.abs((price - level) / level) * 100
      if (band >= (liveNum(st.confirmBandPct) ?? 0.3)) { if (liveSeenSignals) liveSeenSignals.add(sig.key); return true }
    }
    livePendingSignals[sig.key] = (livePendingSignals[sig.key] || 0) + 1
    if (liveSeenSignals) liveSeenSignals.add(sig.key)
    return livePendingSignals[sig.key] >= Math.max(1, liveNum(st.confirmTicks) ?? 2)
  }
  let liveWatchBusy = false
  let liveFailStreak = 0
  const liveTick = async (opts) => {
    const options = opts || {}
    const manual = Boolean(options.manual)
    if (liveWatchBusy) return { ok: false, skipped: "busy" }
    liveWatchBusy = true
    try {
      const st = await readLiveWatch()
      const now = new Date()
      const sess = liveSession(now)
      if (!manual) {
        if (!st.enabled) return { ok: true, skipped: "disabled", session: sess }
        if (st.sessionOnly && !sess.inSession) return { ok: true, skipped: "off-session", session: sess }
        const lastMs = Date.parse(st.lastTickAt || "") || 0
        const gapMs = Math.max(15, liveNum(st.intervalSec) ?? 60) * 1000
        if (lastMs && now.getTime() - lastMs < gapMs - 1500) return { ok: true, skipped: "throttled", session: sess }
        const boMs = Date.parse(st.backoffUntil || "") || 0
        if (boMs && now.getTime() < boMs) return { ok: true, skipped: "backoff", session: sess }
      }
      liveTickState = st
      liveSeenSignals = new Set()
      let r
      try {
        r = await refreshWatchPrices({ gate: liveSignalGate, lazy: true })
        liveFailStreak = 0
      } catch (e) {
        liveFailStreak += 1
        const msg = String(e && e.message ? e.message : e).slice(0, 200)
        const backoff = liveFailStreak >= 3 ? new Date(now.getTime() + 5 * 60 * 1000).toISOString() : ""
        const patch = { lastTickAt: now.toISOString(), lastTickStatus: "error", lastError: msg }
        if (backoff) patch.backoffUntil = backoff
        try { await patchLiveWatch(patch) } catch (e2) { /* 状态写失败不阻断 */ }
        await appendLiveLog({ ts: now.toISOString(), ymd: localYmd(), kind: "tick-error", level: "warn", text: "行情抓取失败：" + msg + (backoff ? "（连续 " + liveFailStreak + " 次，退避 5 分钟）" : "") })
        return { ok: false, skipped: "error", error: msg, session: sess }
      } finally {
        // 只保留本 tick 仍然成立的待确认信号：价格回到线内就清零，避免「隔一小时又凑够 2 次」
        if (liveSeenSignals) {
          for (const k of Object.keys(livePendingSignals)) if (!liveSeenSignals.has(k)) delete livePendingSignals[k]
        }
        liveSeenSignals = null
      }
      const ymd = localYmd()
      const fresh = st.ymd === ymd
      let tickCount = (fresh ? liveNum(st.tickCount) : 0) ?? 0
      let eventCount = (fresh ? liveNum(st.eventCount) : 0) ?? 0
      const llmCount = (fresh ? liveNum(st.llmCount) : 0) ?? 0
      tickCount += 1
      const events = Array.isArray(r.fired) ? r.fired : []
      eventCount += events.length
      for (const ev of events) {
        await appendLiveLog({
          ts: ev.ts || now.toISOString(), ymd, kind: "event", level: ev.level || "info",
          code: ev.code, name: ev.name, eventKind: ev.kind, qty: ev.qty === void 0 ? null : ev.qty, message: ev.message,
        })
      }
      // 解释层（可选）：只有开关打开 + 事件达门槛 + 当日配额未用完才调模型。
      // 放在播报之前，播报里可以带一句人话解释；解释失败绝不影响规则层产出（规则层已经落盘了）。
      let explainText = ""
      if (st.llmExplain && events.length) {
        const rank = { good: 0, info: 0, warn: 1, bad: 2 }
        const need = rank[String(st.llmMinLevel || "bad")] ?? 2
        const hot = events.filter((ev) => (rank[String(ev.level || "info")] ?? 0) >= need)
        const cap = liveNum(st.llmDailyCap) ?? 20
        const usedNow = (st.ymd === ymd ? liveNum(st.llmCount) : 0) ?? 0
        if (hot.length && usedNow < cap) {
          const first = hot[0]
          const r2 = await liveAsk({ code: first.code, question: "自动解释本次触发：" + String(first.message || ""), auto: true })
          if (r2 && r2.ok && r2.answer) explainText = String(r2.answer)
        }
      }
      const snap = await buildLiveSnapshot(r.doc, { events })
      let broadcast = null
      const every = liveNum(st.broadcastEveryMin) ?? 0
      const allowBroadcast = Boolean(st.enabled)
      if (allowBroadcast) {
        const lastB = Date.parse(st.lastBroadcastAt || "") || 0
        const due = every > 0 ? (now.getTime() - lastB >= every * 60 * 1000) : events.length > 0
        if (due) {
          const text = renderLiveBroadcastText(snap, explainText)
          broadcast = await appendLiveLog({ ts: now.toISOString(), ymd, kind: "broadcast", level: "info", reason: events.length ? "event" : "scheduled", text, snapshot: { account: snap.account, holdings: snap.holdings.length, watch: snap.watch.length } })
        }
      }
      // llmCount 在解释层里由 liveAsk 自己 +1 落盘，这里必须重读后取大值，
      // 否则本 tick 的旧计数会把刚写进去的 +1 覆盖回去（表现为「配额永远用不完」）。
      const freshState = await readLiveWatch()
      const llmFinal = Math.max(llmCount, freshState.ymd === ymd ? (liveNum(freshState.llmCount) ?? 0) : 0)
      const patch = { lastTickAt: now.toISOString(), lastTickStatus: "ok", lastError: "", ymd, tickCount, eventCount, llmCount: llmFinal }
      if (broadcast) { patch.lastBroadcastAt = broadcast.ts; patch.lastBroadcastNote = broadcast.reason }
      try { await patchLiveWatch(patch) } catch (e) { /* 状态写失败不阻断 */ }
      return { ok: true, skipped: null, fired: events, snapshot: snap, broadcast: broadcast ? broadcast.text : null, session: sess, changed: Boolean(r.changed) }
    } finally {
      liveWatchBusy = false
    }
  }
  // 定时器入口：先读设置，关着就直接返回，一次行情请求都不发
  const maybeTickLiveWatch = async () => {
    try {
      const st = await readLiveWatch()
      if (!st.enabled) return
      await liveTick({ manual: false })
    } catch (e) { /* 自动 tick 失败静默：错误已写进时间线 */ }
  }
  // P3 解释层：只依据给定事实说 3 句，禁止新造价位；每日上限 llmDailyCap
  const liveAsk = async (body) => {
    const question = String((body && body.question) || "").trim()
    const code = String((body && body.code) || "").trim().toUpperCase()
    if (!question && !code) return { ok: false, error: "缺少问题或标的" }
    const st = await readLiveWatch()
    const ymd = localYmd()
    const used = (st.ymd === ymd ? liveNum(st.llmCount) : 0) ?? 0
    const cap = liveNum(st.llmDailyCap) ?? 20
    if (used >= cap) return { ok: false, error: "今日盘中快问已用 " + used + "/" + cap + " 次（防烧 token 上限，可在「盘中盯盘」设置里调大）" }
    const log = await readLiveLog(80)
    const todayEvents = log.filter((x) => x && x.kind === "event" && x.ymd === ymd)
    const snap = await buildLiveSnapshot(null, { events: todayEvents })
    const row = code ? (snap.holdings.find((h) => h.code === code) || snap.watch.find((w) => w.code === code)) : null
    const concl = code ? (await liveLatestConclusions([code]))[code] : null
    const lines = []
    lines.push("你是盘中盯盘助手。只依据给定事实回答，不调用任何工具、不编造价格或消息、不新造目标价或止损价。")
    lines.push("回答格式：3 句以内。第一句给结论（是/否/尚未/已破线），第二句给具体数字依据，第三句给下一步该看什么或触发条件。")
    lines.push("【时间】" + snap.session.hm + "（" + snap.session.label + "）")
    lines.push("【问题】" + (question || "这只标的现在偏离计划多远？"))
    if (row) {
      lines.push("【标的】" + row.code + " " + row.name + "：现价 " + liveFmt(row.price, 3) + "，今日 " + (row.change_pct === null ? "—" : liveFmt(row.change_pct, 2) + "%") + "，成本 " + (row.cost === null ? "—" : liveFmt(row.cost, 3)) + "，浮盈 " + (row.pnl_pct === null ? "—" : liveFmt(row.pnl_pct, 2) + "%") + "，权重 " + (row.weight_pct === null ? "—" : liveFmt(row.weight_pct, 2) + "%"))
      if (row.eff_stop !== null) lines.push("【生效止损】" + liveFmt(row.eff_stop, 3) + "（来源 " + row.eff_stop_src + "），距止损 " + (row.dist_stop_pct === null ? "—" : liveFmt(row.dist_stop_pct, 2) + "%") + "，" + row.stop_state)
      if (row.buy_low !== null) lines.push("【买入区】" + liveFmt(row.buy_low, 3) + " ~ " + (row.buy_high === null ? "—" : liveFmt(row.buy_high, 3)) + "，距买区 " + (row.dist_buy_pct === null ? "—" : liveFmt(row.dist_buy_pct, 2) + "%"))
    }
    if (concl) lines.push("【最新结论】" + String(concl.ts || "") + " stance=" + String(concl.stance || "—") + " target=" + (concl.target ?? "—") + " stop=" + (concl.stop ?? "—") + "；逻辑=" + String(concl.thesis || "").slice(0, 140) + "；失效条件=" + String(concl.invalidate_if || "").slice(0, 140))
    if (todayEvents.length) lines.push("【今日已触发】" + todayEvents.slice(0, 5).map((e) => String(e.message || "")).join(" / "))
    const acct = snap.account
    lines.push("【账户】总资产 " + liveFmt(acct.total_asset) + "，现金 " + liveFmt(acct.cash) + "，仓位 " + liveFmt(acct.position_pct, 1) + "%，浮动 " + liveFmt(acct.float_pnl))
    let answer
    try {
      answer = await runPromptSubagent(lines.join("\n"), { label: "盘中快问", timeoutMs: 90000 })
    } catch (e) {
      return { ok: false, error: "解释失败：" + String(e && e.message ? e.message : e).slice(0, 200) }
    }
    const text = String(typeof answer === "string" ? answer : (answer && answer.text) || "").trim()
    await patchLiveWatch({ ymd, llmCount: used + 1 })
    await appendLiveLog({ ts: new Date().toISOString(), ymd, kind: (body && body.auto) ? "explain" : "ask", level: "info", code: code || null, question: question || ("解释 " + code), answer: text })
    return { ok: true, answer: text, code: code || null, used: used + 1, cap }
  }

  // ===== 双票/多票同口径对比（v0.77.0）=====
  // 三层分工：① scripts/compare_pack.js 产数字（同一 as-of 交易日，机器可读）；
  // ② 这里的规则负责判胜负、筛硬约束；③ 模型只负责解释，且禁止新增数字。
  // 模型不可用/超时仍返回纯事实表——看不到数字比听不到解释严重得多。
  const COMPARE_SCRIPT = process.env.DSH_INVEST_COMPARE_SCRIPT || (BASE_DIR + "/scripts/compare_pack.js")
  const COMPARE_LOG_FILE = BASE_DIR + "/.dsh-invest/store/compare-log.jsonl"
  const COMPARE_LOG_MAX_LINES = 120
  const COMPARE_MAX_CODES = 3
  const COMPARE_WEIGHT_CAP = 20   // 用户纪律：单票权重上限
  const COMPARE_MIN_ODDS = 3      // 用户纪律：赔率下限

  let nodeCmdCache = ""
  const resolveNode = async () => {
    const env = String(process.env.DSH_INVEST_NODE || "").trim()
    if (env) return env
    if (nodeCmdCache) return nodeCmdCache
    try {
      const { spawnSync } = await import("node:child_process")
      for (const cmd of ["node", "node.exe"]) {
        try {
          const probe = spawnSync(cmd, ["-v"], { stdio: "ignore", windowsHide: true })
          if (probe && probe.status === 0) { nodeCmdCache = cmd; return cmd }
        } catch (e) { /* 试下一个 */ }
      }
    } catch (e) { /* 探测失败走默认 */ }
    nodeCmdCache = "node"
    return nodeCmdCache
  }
  const normalizeCompareCode = (raw) => {
    const c = String(raw || "").trim().toUpperCase()
    if (!c) return ""
    if (/^\d{6}\.(SH|SZ|BJ)$/.test(c)) return c
    const d = c.replace(/\D/g, "")
    if (d.length !== 6) return ""
    if (/^[569]/.test(d)) return d + ".SH"
    if (/^[48]/.test(d)) return d + ".BJ"
    return d + ".SZ"
  }
  const compareCodes = (raw) => {
    const src = Array.isArray(raw) ? raw : String(raw || "").split(/[,\s，]+/)
    const list = []
    for (const x of src) {
      const code = normalizeCompareCode(x)
      if (code && !list.includes(code)) list.push(code)
    }
    if (list.length < 2) throw new Error("至少需要 2 只标的（有效代码 " + list.length + " 个）")
    if (list.length > COMPARE_MAX_CODES) throw new Error("最多对比 " + COMPARE_MAX_CODES + " 只（收到 " + list.length + " 只）")
    return list
  }
  const runComparePack = async (codes) => {
    const node = await resolveNode()
    const { spawn } = await import("node:child_process")
    const child = spawn(node, [COMPARE_SCRIPT, ...codes], {
      cwd: BASE_DIR,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.assign({}, process.env, { DSH_INVEST_BASE_DIR: BASE_DIR }),
    })
    const out = []
    const err = []
    collectChunks(child.stdout, out)
    collectChunks(child.stderr, err)
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        try { child.kill() } catch (e) { /* ignore */ }
        finish(reject, new Error("对比取数超时（45 秒）"))
      }, 45000)
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value) }
      child.on("error", (e) => finish(reject, e))
      child.on("close", () => {
        const text = decodeChildStdout(Buffer.concat(out)).trim()
        const errText = decodeChildStdout(Buffer.concat(err)).trim()
        const line = text.split(/\r?\n/).filter((l) => l.trim()).pop() || ""
        if (!line) { finish(reject, new Error("取数脚本无输出" + (errText ? "：" + errText.slice(0, 200) : ""))); return }
        let data = null
        try { data = JSON.parse(line) } catch (e) {
          finish(reject, new Error("取数脚本输出不是 JSON：" + line.slice(0, 200)))
          return
        }
        if (!data || data.ok !== true) { finish(reject, new Error(String((data && data.error) || "取数失败").slice(0, 300))); return }
        finish(resolve, data)
      })
    })
  }
  // 知识库摘录：只作模型背景，不进表格数字
  const compareKbExcerpt = async (code) => {
    let md = ""
    try { md = await readCurated(code) } catch (e) { return "" }
    return plainSnippet(md, 1400)
  }
  const compareFacts = async (rawCodes) => {
    const codes = compareCodes(rawCodes)
    const pack = await runComparePack(codes)
    const wl = await readWatchlist()
    const items = Array.isArray(wl.items) ? wl.items : []
    const byCode = new Map()
    for (const it of items) byCode.set(String(it.code || "").toUpperCase(), it)
    const ledger = await readHoldingsDoc()
    const account = (ledger && ledger.account) || {}
    const totalAsset = liveNum(account.total_asset)
    const cash = liveNum(account.cash) ?? liveNum(account.available_cash)
    const heldMap = new Map()
    for (const p of (Array.isArray(ledger && ledger.positions) ? ledger.positions : [])) {
      const code = String(p.code || "").toUpperCase()
      if (!code) continue
      if (p.pool && String(p.pool) !== "实盘") continue
      const sh = liveNum(p.shares)
      if (sh === null || sh <= 0) continue
      heldMap.set(code, p)
    }
    const concl = await liveLatestConclusions(codes)
    const stocks = []
    for (const s of (pack.stocks || [])) {
      const code = String(s.code || "").toUpperCase()
      const it = byCode.get(code) || null
      const pos = (it && it.position) || {}
      const watch = (it && it.watch) || {}
      const led = heldMap.get(code) || null
      const c = concl[code] || null
      const close = liveNum(s.close)
      const shares = liveNum(led && led.shares)
      const cost = liveNum(led && led.cost)
      const mv = (shares !== null && close !== null) ? shares * close : null
      const weight = (mv !== null && totalAsset) ? liveRound(mv / totalAsset * 100, 2) : null
      const pnlPct = (cost && close !== null) ? liveRound((close / cost - 1) * 100, 2) : null
      const posStop = liveNum(pos.stop)
      const watchStop = liveNum(watch.stop)
      const effStop = posStop !== null ? posStop : watchStop
      const effStopSrc = posStop !== null ? "档案" : (watchStop !== null ? "失效价" : "—")
      const target = liveNum(pos.target) ?? liveNum(watch.target) ?? liveNum(c && c.target)
      const odds = (target !== null && close !== null && effStop !== null && close > effStop)
        ? liveRound((target - close) / (close - effStop), 2) : null
      const conclStop = liveNum(c && c.stop)
      let stopConflict = false
      let stopConflictNote = ""
      if (effStop !== null && conclStop !== null) {
        const diff = Math.abs(effStop - conclStop) / Math.max(effStop, conclStop) * 100
        if (diff > 3) {
          stopConflict = true
          stopConflictNote = "档案/失效价 " + liveFmt(effStop, 3) + " 与最新结论 " + liveFmt(conclStop, 3) + " 相差 " + liveFmt(diff, 1) + "%"
        }
      }
      const roomPct = shares !== null && shares > 0
        ? (weight === null ? null : liveRound(Math.max(0, COMPARE_WEIGHT_CAP - weight), 2))
        : (totalAsset && cash !== null ? liveRound(Math.min(COMPARE_WEIGHT_CAP, cash / totalAsset * 100), 2) : null)
      stocks.push({
        code, name: s.name || (it && it.name) || code,
        industry: s.industry || "", market: s.market || "", list_date: s.list_date || "",
        asof: s.asof || pack.asof, stale: !!s.stale,
        close, chg_pct: s.chg_pct, ma5: s.ma5, ma10: s.ma10, ma20: s.ma20, ma60: s.ma60,
        dist_ma20_pct: s.dist_ma20_pct, pct5: s.pct5, pct20: s.pct20, pct60: s.pct60,
        hi250: s.hi250, lo250: s.lo250, drawdown_pct: s.drawdown_pct,
        pe: s.pe, pe_ttm: s.pe_ttm, pb: s.pb, total_mv_yi: s.total_mv_yi, circ_mv_yi: s.circ_mv_yi,
        turnover_rate: s.turnover_rate, volume_ratio: s.volume_ratio,
        mf5_wan: s.mf5_wan, mf20_wan: s.mf20_wan, mf_latest_date: s.mf_latest_date,
        fina_end_date: s.fina_end_date, roe: s.roe, netprofit_yoy: s.netprofit_yoy,
        or_yoy: s.or_yoy, gpm: s.gpm, debt_ratio: s.debt_ratio,
        excess20: s.excess20, excess60: s.excess60,
        plan: {
          held: shares !== null && shares > 0,
          shares, cost, mv: mv === null ? null : liveRound(mv, 0), pnl_pct: pnlPct,
          weight_pct: weight, room_pct: roomPct,
          buy_low: liveNum(watch.buy_low), buy_high: liveNum(watch.buy_high), ideal_buy: liveNum(watch.ideal_buy),
          eff_stop: effStop, eff_stop_src: effStopSrc,
          target, odds,
          stance: String((c && c.stance) || watch.stance || "").slice(0, 40),
          thesis: String((c && c.thesis) || watch.thesis || "").slice(0, 300),
          invalidate_if: String((c && c.invalidate_if) || watch.invalidate_if || "").slice(0, 300),
          concl_ts: c ? String(c.ts || "") : "",
          stop_conflict: stopConflict,
          stop_conflict_note: stopConflictNote,
          kb_excerpt: await compareKbExcerpt(code),
        },
      })
    }
    // —— 规则判定：六维谁赢 + 硬约束（严禁综合加权分）——
    const dims = []
    const addDim = (key, label, pick, lowerIsBetter) => {
      const vals = stocks
        .map((s) => ({ code: s.code, v: pick(s) }))
        .filter((x) => x.v !== null && Number.isFinite(x.v) && !(lowerIsBetter && x.v <= 0))
      if (vals.length < 2) {
        dims.push({ key, label, winner: null, values: {}, note: vals.length ? "只有一只可算，不判胜" : "缺少数据" })
        return
      }
      const best = vals.reduce((a, b) => (lowerIsBetter ? (b.v < a.v ? b : a) : (b.v > a.v ? b : a)))
      const tie = vals.filter((x) => x.v === best.v)
      const values = {}
      for (const x of vals) values[x.code] = x.v
      dims.push({ key, label, winner: tie.length === 1 ? best.code : null, values, note: tie.length === 1 ? "" : "两者持平" })
    }
    addDim("position", "价格位置（距 250 日高回撤）", (s) => s.drawdown_pct, false)
    addDim("momentum", "趋势动量（20 日超额 vs 上证）", (s) => s.excess20, false)
    addDim("flow", "资金（近 20 日主力净流入/万元）", (s) => s.mf20_wan, false)
    addDim("valuation", "估值（PE_TTM）", (s) => s.pe_ttm, true)
    addDim("quality", "质量（ROE）", (s) => s.roe, false)
    addDim("plan", "计划与赔率（赔率）", (s) => (s.plan && s.plan.odds !== null) ? s.plan.odds : null, false)
    const score = {}
    for (const s of stocks) score[s.code] = 0
    for (const d of dims) if (d.winner && score[d.winner] !== void 0) score[d.winner] += 1
    const counts = stocks.map((s) => score[s.code] || 0)
    const tied = new Set(counts).size === 1 && counts.length > 1
    // 硬约束：只报能由事实判定的；失效条件只提示原文（是否触发由用户认定）
    const gates = []
    for (const s of stocks) {
      const p = s.plan || {}
      if (p.held && p.weight_pct !== null && p.weight_pct > COMPARE_WEIGHT_CAP) {
        gates.push({ code: s.code, name: s.name, rule: "H1", level: "bad", text: "权重 " + liveFmt(p.weight_pct, 1) + "% 超 " + COMPARE_WEIGHT_CAP + "% 上限，不宜加仓；换股要先减" })
      }
      if (!p.held && totalAsset && cash !== null) {
        const maxPct = liveRound(Math.min(COMPARE_WEIGHT_CAP, cash / totalAsset * 100), 1)
        gates.push({ code: s.code, name: s.name, rule: "H1", level: "info", text: "空仓标的，按现金口径最多可建仓约 " + liveFmt(maxPct, 1) + "% 权重" })
      }
      if (p.odds !== null && p.odds < COMPARE_MIN_ODDS) {
        gates.push({ code: s.code, name: s.name, rule: "H3", level: "warn", text: "赔率 " + liveFmt(p.odds, 2) + ":1 < " + COMPARE_MIN_ODDS + ":1，按纪律只能观察" })
      }
      if (p.target === null) {
        gates.push({ code: s.code, name: s.name, rule: "H4", level: "warn", text: "没有目标价，赔率无法计算，只能谈观察" })
      }
      if (p.eff_stop === null) {
        gates.push({ code: s.code, name: s.name, rule: "H3", level: "warn", text: "没有生效止损，无法计算赔率" })
      }
      if (p.invalidate_if) {
        gates.push({ code: s.code, name: s.name, rule: "H2", level: "info", text: "失效条件（需人工核对是否已触发）：" + p.invalidate_if })
      }
      if (p.stop_conflict) {
        gates.push({ code: s.code, name: s.name, rule: "STOP", level: "warn", text: "止损口径冲突：" + p.stop_conflict_note })
      }
    }
    const sorted = stocks.slice().sort((a, b) => (score[b.code] || 0) - (score[a.code] || 0))
    const leader = sorted[0]
    const dimSummary = stocks.map((s) => s.name + " " + (score[s.code] || 0) + " 胜").join(" / ")
    return {
      ok: true,
      asof: pack.asof,
      price_basis: "unadj",
      stocks,
      verdict: {
        dims, score, tied, gates,
        summary_hint: (tied ? "六维打平（" : "维度胜场：") + dimSummary + (tied ? "）" : "") +
          (leader && !tied ? "，" + leader.name + " 领先" : "") +
          (gates.filter((g) => g.level !== "info").length ? "；" + gates.filter((g) => g.level !== "info").length + " 条硬约束需先处理" : ""),
      },
      warnings: pack.warnings || [],
    }
  }
  const appendCompareLog = async (rec) => {
    try {
      const fs = hostService(ctx, "fs")
      if (fs === void 0) return null
      const target = await fs.resolve(COMPARE_LOG_FILE)
      let old = ""
      try { old = await fs.readText(target) } catch (e) { /* 首次 */ }
      const lines = String(old || "").split(/\r?\n/).filter((l) => l.trim())
      const kept = lines.length >= COMPARE_LOG_MAX_LINES ? lines.slice(-(COMPARE_LOG_MAX_LINES - 1)) : lines
      await writeTextWithPolicyRetry(target, (kept.length ? kept.join("\n") + "\n" : "") + JSON.stringify(rec) + "\n")
      return rec
    } catch (e) { return null }
  }
  const readCompareLog = async (limit) => {
    const fs = hostService(ctx, "fs")
    if (fs === void 0) return []
    let text = ""
    try { text = await fs.readText(await fs.resolve(COMPARE_LOG_FILE)) } catch (e) { return [] }
    const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim())
    const out = []
    for (const line of lines.slice(-Math.max(1, Number(limit) || 10))) {
      try { out.push(JSON.parse(line)) } catch (e) { /* 跳过坏行 */ }
    }
    return out.reverse()
  }
  const compareBrief = (s) => ({
    code: s.code, name: s.name, industry: s.industry,
    close: s.close, chg_pct: s.chg_pct,
    ma5: s.ma5, ma10: s.ma10, ma20: s.ma20, ma60: s.ma60, dist_ma20_pct: s.dist_ma20_pct,
    pct5: s.pct5, pct20: s.pct20, pct60: s.pct60, drawdown_250d_pct: s.drawdown_pct,
    pe_ttm: s.pe_ttm, pb: s.pb, total_mv_yi: s.total_mv_yi, turnover_rate: s.turnover_rate, volume_ratio: s.volume_ratio,
    mf5_wan: s.mf5_wan, mf20_wan: s.mf20_wan,
    roe: s.roe, netprofit_yoy: s.netprofit_yoy, or_yoy: s.or_yoy, gpm: s.gpm, debt_ratio: s.debt_ratio,
    excess20: s.excess20, excess60: s.excess60,
    plan: {
      held: s.plan.held, shares: s.plan.shares, cost: s.plan.cost, weight_pct: s.plan.weight_pct, room_pct: s.plan.room_pct,
      buy_low: s.plan.buy_low, buy_high: s.plan.buy_high, eff_stop: s.plan.eff_stop, eff_stop_src: s.plan.eff_stop_src,
      target: s.plan.target, odds: s.plan.odds, stance: s.plan.stance, invalidate_if: s.plan.invalidate_if,
    },
  })
  const compareAsk = async (body) => {
    const facts = await compareFacts(body && body.codes)
    const question = String((body && body.question) || "").trim().slice(0, 600) ||
      "结合我当前的持仓、现金与纪律，如果只能选一只买，选谁？先做什么？"
    let answer = null
    let answerError = null
    if (!(body && body.withAnswer === false)) {
      const lines = []
      lines.push("你是 A 股同口径对比助手。只依据下方【同口径事实】作答：禁止新增、换算、推测任何未给出的数字；缺失一律写「—（待核实）」。")
      lines.push("硬性纪律（用户的）：① 单票权重上限 " + COMPARE_WEIGHT_CAP + "%；② 赔率=(目标−现价)/(现价−生效止损)，< " + COMPARE_MIN_ODDS + ":1 不建仓；③ 失效条件只有用户能最终认定，你只能引用原文提示。")
      lines.push("输出五段，总长 ≤600 字，不要复述整张表：")
      lines.push("① 结论卡：一句话（选谁／都不选／先解决持仓超限），点明触发几条硬约束。")
      lines.push("② 维度解读：价格位置、趋势动量、资金、估值、质量、计划与赔率，各一句并带数字。")
      lines.push("③ 关键差异：3 条，必须带数字。")
      lines.push("④ 执行建议：结合现有持仓与现金，给加/减/观察/换股的具体动作，并说明先做哪一步。")
      lines.push("⑤ 各自失效条件：两只票各一句，引用原文。")
      // 追问：把上一两轮的问与答带上（只带文字，不带数字来源不明的补充）；
      // 模型仍受同口径事实约束，不能拿"用户上一轮没说过的数"当依据。
      const history = Array.isArray(body && body.history) ? body.history.slice(-4) : []
      const historyLines = history
        .map((h) => {
          const role = h && h.role === "assistant" ? "你" : "用户"
          const text = String((h && h.text) || "").trim().slice(0, 1200)
          return text ? role + "：" + text : ""
        })
        .filter(Boolean)
      if (historyLines.length) lines.push("", "【此前的问答】", ...historyLines.slice(-4))
      lines.push("")
      lines.push("【问题】" + question)
      lines.push("【同口径事实 as-of " + facts.asof + "｜价格口径：不复权（TuShare daily）】")
      for (const s of facts.stocks) {
        lines.push(JSON.stringify(compareBrief(s)))
        if (s.plan.kb_excerpt) lines.push("【知识库摘录·" + s.name + "】" + s.plan.kb_excerpt)
      }
      lines.push("【规则判定】" + facts.verdict.dims.map((d) => d.label + "→" + (d.winner ? ((facts.stocks.find((x) => x.code === d.winner) || {}).name || d.winner) : "不判")).join("；") + "；胜场 " + JSON.stringify(facts.verdict.score))
      if (facts.verdict.gates.length) lines.push("【硬约束】" + facts.verdict.gates.map((g) => "[" + g.rule + "]" + g.name + "：" + g.text).join(" / "))
      try {
        const r = await runPromptSubagent(lines.join("\n"), { label: "对比分析", timeoutMs: 120000 })
        answer = String(typeof r === "string" ? r : (r && r.text) || "").trim() || null
      } catch (e) {
        answerError = String(e && e.message ? e.message : e).slice(0, 240)
      }
    }
    await appendCompareLog({
      ts: new Date().toISOString(),
      codes: facts.stocks.map((s) => s.code),
      asof: facts.asof,
      question,
      answer: answer ? answer.slice(0, 400) : null,
      answer_error: answerError,
    })
    return Object.assign({}, facts, { question, answer, answerError })
  }

  // 口径：行业横截面分位（同 Tushare industry 分类），不联网算分——分位算在纯函数 fundamentals.js 里，
  // 这里只负责「把全市场三张表拉下来缓存好」。一次刷新 = 3 次 API 调用覆盖全市场，
  // 单只股票查询是纯查表，毫秒级、0 token。
  const FUND_DIR = BASE_DIR + "/.dsh-invest/cache/fundamentals"
  const FUND_STORE = BASE_DIR + "/.dsh-invest/store/fundamentals"
  /** 全市场快照内存缓存：{ key, at, snapshot } */
  let fundMemo = null
  /** 同一时刻只允许一个刷新在跑，避免多标签页同时点刷新把 Tushare 打爆 */
  let fundInflight = null

  const fundToken = async () => {
    try {
      const { readFileSync } = await import("node:fs")
      const t = String(readFileSync(BASE_DIR + "/.dsh-invest/tushare.token", "utf8")).trim()
      if (t) return t
    } catch (e) { /* 文件缺失，退回环境变量 */ }
    return String((process.env && process.env.TUSHARE_TOKEN) || "").trim()
  }
  const fundReadJson = async (file) => {
    try {
      const { readFileSync } = await import("node:fs")
      return JSON.parse(readFileSync(file, "utf8"))
    } catch (e) { return null }
  }
  const fundWriteJson = async (file, data) => {
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs")
      mkdirSync(FUND_DIR, { recursive: true })
      writeFileSync(file, JSON.stringify(data), "utf8")
    } catch (e) { /* 缓存写失败不影响本次结果 */ }
  }
  /** 调 Tushare 并把 fields/items 转成对象数组 */
  const fundApi = async (api_name, params, fields, token) => {
    const r = await fetch("https://api.tushare.pro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_name, token, params, fields }),
    })
    const j = JSON.parse(await r.text())
    if (j.code !== 0) return { ok: false, error: String(j.msg || "tushare error").slice(0, 160), rows: [] }
    if (!j.data || !Array.isArray(j.data.items)) return { ok: true, rows: [] }
    const f = j.data.fields
    const rows = j.data.items.map((it) => {
      const o = {}
      f.forEach((k, i) => { o[k] = it[i] })
      return o
    })
    return { ok: true, rows }
  }
  /** 最近交易日：从今天往前退，最多试 12 天（含长假），零成交也照常返回该日期 */
  let fundTradeDateMemo = null
  const fundLatestTradeDate = async (token) => {
    if (fundTradeDateMemo && Date.now() - fundTradeDateMemo.at < 30 * 60 * 1000) return fundTradeDateMemo.date
    const { readdirSync } = await import("node:fs")
    // 先看本地日线缓存里最新的日期，省一次 API 调用
    try {
      let best = ""
      for (const f of readdirSync(BASE_DIR + "/.dsh-invest/cache/pack")) {
        const m = f.match(/^daily_\d{6}_[A-Z]{2}_(\d{8})\.json$/)
        if (m && m[1] > best) best = m[1]
      }
      if (best) { fundTradeDateMemo = { date: best, at: Date.now() }; return best }
    } catch (e) { /* 没缓存 */ }
    const d = new Date()
    for (let i = 0; i < 12; i++) {
      const ymd = "" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0")
      const r = await fundApi("daily_basic", { trade_date: ymd }, "ts_code", token)
      if (r.ok && r.rows.length > 100) { fundTradeDateMemo = { date: ymd, at: Date.now() }; return ymd }
      d.setDate(d.getDate() - 1)
    }
    fundTradeDateMemo = { date: "", at: Date.now() }
    return ""
  }

  /**
   * 全市场快照：stock_basic（7 天缓存）+ fina_indicator_vip（按报告期缓存）+ daily_basic（按交易日缓存）
   * 返回 { period, periodLabel, tradeDate, basic, fina, dailyBasic, warnings, cachedAt }
   */
  const loadFundSnapshot = async (force) => {
    const token = await fundToken()
    if (!token) throw new Error("缺少 Tushare token（.dsh-invest/tushare.token）")
    const { period, label } = latestDisclosedPeriod()
    // 先看快照缓存：命中就直接返回，连交易日都不必重新探测（省掉一串 daily_basic 试探）
    if (!force && fundMemo && fundMemo.period === period && Date.now() - fundMemo.at < 30 * 60 * 1000) {
      return { ...fundMemo.snapshot, memo: true }
    }
    const tradeDate = await fundLatestTradeDate(token)
    const key = period + "|" + tradeDate
    if (!force && fundMemo && fundMemo.key === key && Date.now() - fundMemo.at < 30 * 60 * 1000) {
      return { ...fundMemo.snapshot, memo: true }
    }
    if (fundInflight) return fundInflight
    fundInflight = (async () => {
      const warnings = []
      const ymd = (d) => "" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0")
      const today = ymd(new Date())

      // 1) 行业分类：低频数据，7 天内复用
      let basicRows = []
      const basicFile = FUND_DIR + "/basic_" + today + ".json"
      let basicCache = force ? null : await fundReadJson(basicFile)
      if (!basicCache && !force) {
        // 复用最近 7 天内的任意一份（行业分类是低频数据）
        // 注意：force=1 时必须跳过这段，否则「刷新」会被这里的 7 天复用悄悄抵消
        try {
          const { readdirSync } = await import("node:fs")
          const files = readdirSync(FUND_DIR).filter((f) => /^basic_\d{8}\.json$/.test(f)).sort()
          for (let i = files.length - 1; i >= 0; i--) {
            const stamp = files[i].slice(6, 14)
            const diff = (Date.parse(today.slice(0, 4) + "-" + today.slice(4, 6) + "-" + today.slice(6, 8))
              - Date.parse(stamp.slice(0, 4) + "-" + stamp.slice(4, 6) + "-" + stamp.slice(6, 8))) / 86400000
            if (diff <= 7) { basicCache = await fundReadJson(FUND_DIR + "/" + files[i]); break }
          }
        } catch (e) { /* 目录还没建 */ }
      }
      if (basicCache && Array.isArray(basicCache.rows)) {
        basicRows = basicCache.rows
      } else {
        const r = await fundApi("stock_basic", { list_status: "L" }, "ts_code,name,industry,market", token)
        if (r.ok) {
          basicRows = r.rows
          await fundWriteJson(basicFile, { rows: basicRows, at: new Date().toISOString() })
        } else warnings.push("行业分类拉取失败：" + r.error)
      }

      // 2) 财报：按报告期缓存，报告期内不会变
      const finaFile = FUND_DIR + "/fina_" + period + ".json"
      let finaRows = []
      const finaCache = force ? null : await fundReadJson(finaFile)
      if (finaCache && Array.isArray(finaCache.rows) && finaCache.rows.length) {
        finaRows = finaCache.rows
      } else {
        const r = await fundApi("fina_indicator_vip", { period },
          "ts_code,ann_date,end_date,roe,roe_yearly,grossprofit_margin,netprofit_margin,netprofit_yoy,dt_netprofit_yoy,or_yoy,debt_to_assets,current_ratio,ocfps,eps,profit_dedt,bps", token)
        if (r.ok) {
          finaRows = r.rows
          await fundWriteJson(finaFile, { rows: finaRows, at: new Date().toISOString() })
        } else warnings.push("财务指标拉取失败（可能无 fina_indicator_vip 权限）：" + r.error)
      }

      // 3) 估值：按交易日缓存
      let dbRows = []
      if (tradeDate) {
        const dbFile = FUND_DIR + "/db_" + tradeDate + ".json"
        const dbCache = force ? null : await fundReadJson(dbFile)
        if (dbCache && Array.isArray(dbCache.rows) && dbCache.rows.length) {
          dbRows = dbCache.rows
        } else {
          const r = await fundApi("daily_basic", { trade_date: tradeDate }, "ts_code,pe_ttm,pb,total_mv,dv_ttm", token)
          if (r.ok) {
            dbRows = r.rows
            await fundWriteJson(dbFile, { rows: dbRows, at: new Date().toISOString() })
          } else warnings.push("估值拉取失败：" + r.error)
        }
      } else {
        warnings.push("未能确定最近交易日，估值维度将缺失")
      }

      const snapshot = { period, periodLabel: label, tradeDate, basic: basicRows, fina: finaRows, dailyBasic: dbRows, warnings }
      fundMemo = { key, period, at: Date.now(), snapshot }
      return snapshot
    })().finally(() => { fundInflight = null })
    return fundInflight
  }

  /** 读本股历史评级快照（JSONL，追加写） */
  const readFundHistory = async (code) => {
    try {
      const { readFileSync } = await import("node:fs")
      const text = readFileSync(FUND_STORE + "/" + code.replace(/\./g, "_") + ".jsonl", "utf8")
      return text.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean)
    } catch (e) { return [] }
  }
  /** 追加一条评级快照；同一报告期只保留最后一次 */
  const appendFundHistory = async (code, snap) => {
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs")
      const prev = await readFundHistory(code)
      const kept = prev.filter((h) => h && h.period !== snap.period)
      kept.push(snap)
      kept.sort((a, b) => String(b.period).localeCompare(String(a.period)))
      mkdirSync(FUND_STORE, { recursive: true })
      writeFileSync(FUND_STORE + "/" + code.replace(/\./g, "_") + ".jsonl",
        kept.slice(0, 12).map((h) => JSON.stringify(h)).join("\n") + "\n", "utf8")
      return kept.slice(0, 12)
    } catch (e) { return [] }
  }

  /** 单只股票：查表 + 算分 + 落历史快照 */
  const fundamentalsFor = async (code, force) => {
    const upper = String(code || "").trim().toUpperCase()
    // ETF / LOF 没有财报主体，基本面评级不适用。若不特判，会走成「全空评级」——
    // 用户持仓里就有 510500、159813 这类，看到一张空卡片会以为功能坏了。
    const isFund = /^(5\d{5}\.SH|1[5-6]\d{4}\.SZ)$/.test(upper)
    if (isFund) {
      return {
        ok: true, code: upper, name: upper, industry: "", peerCount: 0,
        period: "", periodLabel: "", announceDate: "", priceDate: "",
        total: null, grade: "—", gradeLabel: "不适用", coverage: "—",
        dims: [],
        flags: [{
          level: "info",
          label: "ETF / 基金不适用基本面评级",
          note: "该标的没有财报主体（一篮子持仓），ROE/毛利/负债率等指标无从计算。要看质地请穿透到成分股或看跟踪指数的估值分位。",
        }],
        warnings: ["ETF / 基金不做基本面评级"],
        history: [], delta: null, caveat: CAVEAT,
        cachedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
      }
    }
    const snap = await loadFundSnapshot(force)
    const basicMap = new Map(snap.basic.map((b) => [String(b.ts_code || "").toUpperCase(), b]))
    const basic = basicMap.get(upper) || {}
    const industry = String(basic.industry || "")

    // 财报按股票去重（同报告期可能有多条公告版本）
    const finaMap = dedupeByCode(snap.fina)
    const me = finaMap.get(upper) || null

    // 同业集合：同一 industry 分类
    const peerCodes = new Set()
    for (const [c, b] of basicMap) if (String(b.industry || "") === industry && industry) peerCodes.add(c)
    const peers = []
    for (const c of peerCodes) { const row = finaMap.get(c); if (row) peers.push(row) }

    // 细分行业太小（白酒 19 只、水泥 20 只上下）时，硬套行业分位会让整片行业拿不到评级。
    // 退回全市场分位：基准更宽松，但至少可比，且必须明确告诉用户换了基准。
    const peerLabel = { kind: "industry", industry }
    let effectivePeers = peers
    const extraWarnings = []
    if (peers.length < MIN_PEERS) {
      effectivePeers = Array.from(finaMap.values())
      peerLabel.kind = "market"
      extraWarnings.push(
        `「${industry || "未知行业"}」同业仅 ${peers.length} 只（少于 ${MIN_PEERS} 只），`
        + `已退回全市场分位——基准比同业更宽松，读数仅供参考`,
      )
    }

    const dbMap = new Map(snap.dailyBasic.map((d) => [String(d.ts_code || "").toUpperCase(), d]))
    const meDb = dbMap.get(upper) || null
    const peerDb = []
    if (peerLabel.kind === "industry") {
      for (const c of peerCodes) { const row = dbMap.get(c); if (row) peerDb.push(row) }
    } else {
      for (const row of dbMap.values()) peerDb.push(row)
    }

    // 近几期（趋势 + 连续亏损判定）：按股票单独查，缓存到报告期
    let periodRows = []
    const stockFile = FUND_DIR + "/stock_" + upper.replace(/\./g, "_") + ".json"
    const stockCache = force ? null : await fundReadJson(stockFile)
    if (stockCache && Array.isArray(stockCache.rows) && stockCache.rows.length) {
      periodRows = stockCache.rows
    } else if (me) {
      const token = await fundToken()
      const end = new Date()
      const start = new Date(end.getTime() - 500 * 86400000)
      const p2 = (n) => String(n).padStart(2, "0")
      const ymd = (d) => "" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate())
      const r = await fundApi("fina_indicator", { ts_code: upper, start_date: ymd(start), end_date: ymd(end) },
        "ts_code,ann_date,end_date,roe,roe_yearly,grossprofit_margin,netprofit_margin,netprofit_yoy,dt_netprofit_yoy,or_yoy,debt_to_assets,current_ratio,ocfps,eps,profit_dedt,bps", token)
      if (r.ok && r.rows.length) {
        periodRows = r.rows
        await fundWriteJson(stockFile, { rows: periodRows, at: new Date().toISOString() })
      }
    }
    // 按报告期去重排序（新→旧），取最新一期作为 me 的补充
    const byEnd = new Map()
    for (const row of periodRows) {
      const k = String(row.end_date || "")
      const prev = byEnd.get(k)
      if (!prev || String(row.ann_date || "") > String(prev.ann_date || "")) byEnd.set(k, row)
    }
    const sortedPeriods = Array.from(byEnd.entries()).sort((a, b) => b[0].localeCompare(a[0])).map(([, v]) => v)
    if (me && sortedPeriods.length) {
      // 趋势：近三期净利同比是升还是降
      const yoys = sortedPeriods.slice(0, 3).map((r) => num(r.netprofit_yoy)).filter((v) => v !== null)
      if (yoys.length >= 2) me.__trend = yoys[0] > yoys[1] ? 1 : yoys[0] < yoys[1] ? -1 : 0
    }

    const history = await readFundHistory(upper)
    const out = buildFundamentals({
      code: upper,
      name: String(basic.name || (me && me.name) || upper),
      industry,
      peerCount: effectivePeers.length,
      period: snap.period,
      periodLabel: snap.periodLabel,
      announceDate: me ? String(me.ann_date || "") : "",
      priceDate: snap.tradeDate,
      me, peers: effectivePeers, meDb, peerDb,
      periodRows: sortedPeriods,
      history,
      cachedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
    })
    out.warnings = (out.warnings || []).concat(extraWarnings, snap.warnings || [])
    // 告诉前端这一版用的是哪种基准（同业 / 全市场），界面要如实标注
    out.peerBaseline = peerLabel.kind === "industry" ? "industry" : "market"
    // 落快照：只在拿到分时写，避免把「数据不足」也记进历史污染升降对比
    if (out.total !== null) {
      const kept = await appendFundHistory(upper, {
        period: out.period, periodLabel: out.periodLabel, total: out.total, grade: out.grade,
        at: new Date().toISOString().slice(0, 10),
      })
      out.history = kept
      const prev = kept.find((h) => h.period !== out.period) || null
      out.delta = prev && prev.total !== null ? {
        periodLabel: prev.periodLabel || prev.period,
        total: prev.total,
        change: Math.round((out.total - prev.total) * 100) / 100,
      } : null
    }
    return out
  }

  const routes = [
    {
      // 盘中盯盘：读设置 + 实时快照 + 时间线。快照每次都用实时价重算，
      // 不复用账本里可能已经过期的 current_price / weight_pct。
      kind: "exact",
      path: "/dsh-invest/api/live-watch",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method === "GET") {
          try {
            const settings = await readLiveWatch()
            const snapshot = await buildLiveSnapshot()
            const log = await readLiveLog(40)
            writeJson(res, 200, { ok: true, settings, session: liveSession(), snapshot, presets: LIVE_PRESETS, log })
          } catch (e) {
            writeJson(res, 500, { error: String(e && e.message ? e.message : e).slice(0, 200) })
          }
          return
        }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          const patch = {}
          if (body && typeof body.enabled === "boolean") patch.enabled = body.enabled
          if (body && typeof body.sessionOnly === "boolean") patch.sessionOnly = body.sessionOnly
          if (body && typeof body.llmExplain === "boolean") patch.llmExplain = body.llmExplain
          if (body && typeof body.notifyLevel === "string" && ["bad", "warn", "all"].includes(body.notifyLevel)) patch.notifyLevel = body.notifyLevel
          if (body && body.preset !== void 0) {
            const name = String(body.preset)
            if (!LIVE_PRESETS[name]) { writeJson(res, 400, { error: "未知预设：" + name.slice(0, 20) }); return }
            patch.preset = name
            patch.intervalSec = LIVE_PRESETS[name].intervalSec
            patch.broadcastEveryMin = LIVE_PRESETS[name].broadcastEveryMin
          }
          // 手改间隔：预设退化为「自定义」，否则读回来的仍是预设值，看起来像没保存
          const numField = (key, min, max) => {
            if (!body || body[key] === void 0) return
            const n = liveNum(body[key])
            if (n === null || n < min || n > max) throw new Error(key + " 需在 " + min + "~" + max + " 之间")
            patch[key] = n
          }
          numField("intervalSec", 15, 3600)
          numField("broadcastEveryMin", 0, 240)
          numField("confirmTicks", 1, 10)
          numField("confirmBandPct", 0, 10)
          numField("llmDailyCap", 1, 200)
          // 手改间隔：预设退化为「自定义」，否则读回来的仍是预设值，看起来像没保存。
          // 注意：显式选了预设时绝不能走这段，否则刚写进去的 preset 会被覆盖成「自定义」。
          if (patch.preset === void 0 && (patch.intervalSec !== void 0 || patch.broadcastEveryMin !== void 0)) {
            const cur = await readLiveWatch()
            const p = LIVE_PRESETS[cur.preset]
            const sameAsPreset = p && (patch.intervalSec ?? p.intervalSec) === p.intervalSec && (patch.broadcastEveryMin ?? p.broadcastEveryMin) === p.broadcastEveryMin
            patch.preset = sameAsPreset ? cur.preset : "自定义"
          }
          const settings = await patchLiveWatch(patch)
          const snapshot = await buildLiveSnapshot()
          writeJson(res, 200, { ok: true, settings, session: liveSession(), snapshot, presets: LIVE_PRESETS })
        } catch (e) {
          writeJson(res, 400, { error: String(e && e.message ? e.message : e).slice(0, 200) })
        }
      },
    },
    {
      // 手动立即抓一次：不受 enabled / 交易时段限制（用户点了就是要看现在的数）
      kind: "exact",
      path: "/dsh-invest/api/live-watch/tick",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const r = await liveTick({ manual: true })
          writeJson(res, r.ok ? 200 : 500, r)
        } catch (e) {
          writeJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) })
        }
      },
    },
    {
      // 盘中快问（P3）：只依据快照 + 最新结论 + 今日事件，3 句以内，不新造价位
      kind: "exact",
      path: "/dsh-invest/api/live-ask",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          const r = await liveAsk(body || {})
          writeJson(res, r.ok ? 200 : 429, r)
        } catch (e) {
          writeJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) })
        }
      },
    },
    {
      // 同口径对比：POST 出事实表 + 解释；GET 回最近几次对比记录
      kind: "exact",
      path: "/dsh-invest/api/compare",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method === "GET") {
          try {
            const log = await readCompareLog(10)
            writeJson(res, 200, { ok: true, log })
          } catch (e) {
            writeJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) })
          }
          return
        }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          const r = await compareAsk(body || {})
          writeJson(res, 200, r)
        } catch (e) {
          // 取数/校验失败：400 让前端直接展示原因（不动用 LLM 配额）
          writeJson(res, 400, { ok: false, error: String(e && e.message ? e.message : e).slice(0, 300) })
        }
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-invest/chart",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const url = new URL(req.url ?? "/", "http://localhost")
        const p = queryParam(url, "path") ?? ""
        if (!/\.(svg|png)$/i.test(p) || !p.startsWith(CHARTS_DIR)) { writeJson(res, 400, { error: "denied" }); return }
        const fs = hostService(ctx, "fs")
        if (fs === void 0) { writeJson(res, 503, { error: "fs unavailable" }); return }
        try {
          // PNG 走 node:fs 直读（路径已通过 startsWith 白名单 + 扩展名校验）；
          // fs.resolve 返回的是 DSH fs 的句柄对象，node:fs 吃不了，只能传字符串路径。
          if (/\.png$/i.test(p)) {
            const buf = await fsp.readFile(p)
            if (buf.length > 4_000_000) { writeJson(res, 413, { error: "too large" }); return }
            writeJson(res, 200, { path: p, png: buf.toString("base64") })
            return
          }
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
      // 影子交易（v0.68.0）：把「AI 结论 → 照做会怎样」接到判断质量页。
      // 只回 summary + rules + 真正建仓的那几笔，不回 91 条原始记录：
      // 其中 76 条是「非买入」，对页面无信息量，全量下发会让载荷从 4KB 涨到 62KB。
      kind: "exact",
      path: "/dsh-invest/api/strategy-trials",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const settings = await readJsonFile(SETTINGS_FILE, {})
        const cfg = (settings && settings.strategyTrials) || {}
        const target = String(cfg.path || process.env.DSH_INVEST_TRIALS || LIHU_TRIALS_FILE)
        const body = { ok: false, path: target, reason: null, generated_at: null,
          rules: null, summary: null, portfolio: null, trials: [] }
        let raw
        try {
          raw = await fsp.readFile(target, "utf8")
        } catch {
          body.reason = "missing"
          body.hint = "在 LihuQuantify 跑：python scripts/run_strategy_trials.py"
          writeJson(res, 200, body); return
        }
        let data
        try { data = JSON.parse(raw) } catch {
          body.reason = "invalid_json"
          writeJson(res, 200, body); return
        }
        if (!data || !Array.isArray(data.records) || data.records.length === 0) {
          body.reason = "empty"
          writeJson(res, 200, body); return
        }
        body.ok = true
        body.generated_at = data.generated_at || null
        body.rules = data.rules || null
        body.summary = data.summary || null
        body.portfolio = data.portfolio || null
        body.trials = data.records.filter((r) => r && (r.status === "open" || r.status === "closed"))
        writeJson(res, 200, body)
      },
    },
    {
      // 实盘绩效（v0.68.0）：只读 Lihu 用真实交割单重建的 monthly_perf.json。
      // 这条数据此前没有任何页面在展示 —— 系统能说清模拟盘、AI、回测，唯独自家的钱没地方看。
      // 曲线降采样到 250 点；口径与限制（limitations / valuation_jumps）原样透传。
      kind: "exact",
      path: "/dsh-invest/api/real-performance",
      handler: async (req, res) => {
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        const settings = await readJsonFile(SETTINGS_FILE, {})
        const cfg = (settings && settings.realPerformance) || {}
        const target = String(cfg.path || process.env.DSH_INVEST_REAL_PERF || LIHU_REAL_PERF_FILE)
        const body = { ok: false, path: target, reason: null }
        let raw
        try {
          raw = await fsp.readFile(target, "utf8")
        } catch {
          body.reason = "missing"
          body.hint = "在 LihuQuantify 跑：python scripts/monthly_perf.py"
          writeJson(res, 200, body); return
        }
        let data
        try { data = JSON.parse(raw) } catch {
          body.reason = "invalid_json"
          writeJson(res, 200, body); return
        }
        if (!data || typeof data !== "object" || !data.totals) {
          body.reason = "empty"
          writeJson(res, 200, body); return
        }
        const curve = Array.isArray(data.equity_curve) ? data.equity_curve : []
        const LIMIT = 250
        let sampled = curve
        if (curve.length > LIMIT) {
          const step = (curve.length - 1) / (LIMIT - 1)
          const idx = new Set()
          for (let i = 0; i < LIMIT; i += 1) idx.add(Math.min(curve.length - 1, Math.round(i * step)))
          sampled = [...idx].sort((a, b) => a - b).map((i) => curve[i])
        }
        body.ok = true
        body.generated_at = data.generated_at || null
        body.totals = data.totals
        body.max_drawdown = data.max_drawdown || null
        body.benchmark = data.benchmark || null
        body.monthly = Array.isArray(data.monthly) ? data.monthly : []
        body.equity_curve = sampled
        body.equity_points_total = curve.length
        body.limitations = Array.isArray(data.limitations) ? data.limitations : []
        body.valuation_jumps = Array.isArray(data.valuation_jumps) ? data.valuation_jumps : []
        body.assumptions = data.assumptions || null

        // 持仓账本（2026-11-18）：monthly_perf 是「按交割单重建的模型」，
        // 其期末权益与券商账本对不上（实测 123,656.63 vs 110,442.71，差 1.3 万）。
        // 账本是权威口径，这里一并下发，让页面能并列显示、并把差额摆出来，
        // 而不是让用户在两页看到两个数还以为其中一个是对的。
        try {
          const holdingsPath = String(cfg.holdingsPath || process.env.DSH_INVEST_HOLDINGS || (BASE_DIR + "/.dsh-invest/持仓.json"))
          const raw2 = await fsp.readFile(holdingsPath, "utf8")
          const hd = JSON.parse(raw2)
          const acc = (hd && hd.account) || {}
          body.current = {
            source: holdingsPath,
            updated_at: hd && hd.updated_at ? hd.updated_at : null,
            total_asset: typeof acc.total_asset === "number" ? acc.total_asset : null,
            market_value: typeof acc.market_value === "number" ? acc.market_value : null,
            available_cash: typeof acc.available_cash === "number" ? acc.available_cash : null,
            holding_pnl: typeof acc.holding_pnl === "number" ? acc.holding_pnl : null,
            position_pct: typeof acc.position_pct === "number" ? acc.position_pct : null,
          }
        } catch {
          body.current = null
        }
        writeJson(res, 200, body)
      },
    },
    {
      // 行业热力（v0.67.0）：只读 LihuQuantify 的 data/heatmap_snapshot.json，
      // 聚合成行业维度并保留逐只明细，供概览页做「持仓行业暴露」。
      //
      // 为什么单独一个路由：strategy_health 契约已 80KB，概览页只为一个卡片加载它太亏。
      // 这个文件自描述（每行带 trade_date），不需要 schema 版本；只读、不写、可配路径。
      kind: "exact",
      path: "/dsh-invest/api/sector-heatmap",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const settings = await readJsonFile(SETTINGS_FILE, {})
        const cfg = (settings && settings.sectorHeatmap) || {}
        const target = String(cfg.path || process.env.DSH_INVEST_HEATMAP || HEATMAP_FILE)
        const body = { ok: false, path: target, as_of: null, universe: 0, industries: [], by_code: {}, reason: null }
        let raw
        try {
          raw = await fsp.readFile(target, "utf8")
        } catch {
          body.reason = "missing"
          body.hint = "在 LihuQuantify 跑：python scripts/refresh_heatmap_snapshot.py"
          writeJson(res, 200, body); return
        }
        let rows
        try { rows = JSON.parse(raw) } catch {
          body.reason = "invalid_json"
          writeJson(res, 200, body); return
        }
        if (!Array.isArray(rows) || rows.length === 0) {
          body.reason = "empty"
          writeJson(res, 200, body); return
        }
        const byCode = {}
        const groups = new Map()
        for (const r of rows) {
          if (!r || !r.ts_code) continue
          const pct = typeof r.pct_chg === "number" ? r.pct_chg : null
          const ind = r.industry || "未知"
          byCode[r.ts_code] = { industry: ind, name: r.name || null, pct_chg: pct, amount: r.amount ?? null }
          let g = groups.get(ind)
          if (!g) { g = { name: ind, n: 0, sum: 0, counted: 0, amount: 0, up: 0, down: 0 }; groups.set(ind, g) }
          g.n += 1
          g.amount += Number(r.amount) || 0
          if (pct !== null) {
            g.sum += pct
            g.counted += 1
            if (pct > 0) g.up += 1
            else if (pct < 0) g.down += 1
          }
        }
        const industries = [...groups.values()]
          .map((g) => ({
            name: g.name, n: g.n, up: g.up, down: g.down,
            amount: g.amount,
            pct_avg: g.counted ? Math.round((g.sum / g.counted) * 100) / 100 : null,
          }))
          .sort((a, b) => b.amount - a.amount)
        const dates = rows.map((r) => r.trade_date).filter(Boolean).sort()
        body.ok = true
        body.as_of = dates.length ? dates[dates.length - 1] : null
        body.universe = rows.length
        body.industries = industries
        body.by_code = byCode
        writeJson(res, 200, body)
      },
    },
    {
      // 策略健康（v0.59.0，2026-11-16）：只读消费 LihuQuantify 导出的契约快照。
      //
      // 为什么是「读文件」而不是「连 Lihu 的库或 HTTP」：
      //   - Lihu 前端把 /api/ 与 /static/ 全写成根绝对路径，任何前缀反代都会打断它的 SPA；
      //   - Lihu 没有 CORS，浏览器跨源 fetch 会被直接拦；
      //   - DuckDB 由 Lihu 自己的 scheduler 独占写，第三方读会引入锁与漂移。
      // 唯一低风险耦合面 = 它主动导出的 outputs/strategy_health.json（schema_version=1）。
      //
      // 账本边界（硬规则）：本接口只反映 Lihu 的**模拟盘**（account_type="paper"），
      // 绝不与 BASE_DIR/.dsh-invest/持仓.json（实盘）混账；指向实盘会被这里的护栏拒掉。
      kind: "exact",
      path: "/dsh-invest/api/strategy-health",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const settings = await readJsonFile(SETTINGS_FILE, {})
        const cfg = (settings && settings.strategyHealth) || {}
        const url = new URL(req.url ?? "/", "http://localhost")
        // 路径三级回退：settings.json → 环境变量 → 默认。不把 E:\LihuQuantify 写死在
        // 代码里（跨仓硬编码是已知的隐性耦合来源，见 merge-survey/C）。
        const target = String(
          queryParam(url, "path") || cfg.path
          || process.env.DSH_INVEST_LIHU_HEALTH
          || "E:/LihuQuantify/outputs/strategy_health.json",
        )
        const body = {
          ok: false,
          path: target,
          supported_schema: SUPPORTED_HEALTH_SCHEMA,
          stale_hours: null,
          data: null,
        }
        // 数据缺失/损坏一律回 200 + ok:false：这是「状态查询」接口，
        // 让前端渲染可读的失败态，而不是在控制台里留一个 500。
        let raw
        try {
          raw = await fsp.readFile(target, "utf8")
        } catch {
          body.reason = "missing"
          body.hint = "先在 LihuQuantify 跑：python scripts/export_strategy_health.py"
          writeJson(res, 200, body); return
        }
        let data
        try { data = JSON.parse(raw) } catch {
          body.reason = "invalid_json"
          writeJson(res, 200, body); return
        }
        if (!data || typeof data !== "object"
          || typeof data.schema_version !== "number"
          || data.schema_version < MIN_HEALTH_SCHEMA
          || data.schema_version > SUPPORTED_HEALTH_SCHEMA) {
          body.reason = "schema_mismatch"
          body.found_schema = (data && data.schema_version) ?? null
          writeJson(res, 200, body); return
        }
        if (data.account_type !== "paper") {
          body.reason = "not_paper_account"
          body.found_account_type = data.account_type ?? null
          body.hint = "该快照不是模拟盘，拒绝展示以免与实盘账本混账"
          writeJson(res, 200, body); return
        }
        try {
          const st = await fsp.stat(target)
          body.stale_hours = Math.round((Date.now() - st.mtimeMs) / 36e5 * 10) / 10
        } catch { /* 拿不到 mtime 不影响主数据 */ }
        body.ok = true
        body.data = data
        writeJson(res, 200, body)
      },
    },
    {
      // 个股知识库「相关图表」（v0.53.0）：按 6 位代码扫描 charts 目录，
      // 只回 svg/png，按修改时间倒序。图表散落在运行报告里时用户找不到，这里按标的归集。
      kind: "exact",
      path: "/dsh-invest/api/stock-charts",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const url = new URL(req.url ?? "/", "http://localhost")
        const code = String(queryParam(url, "code") || "").trim().toUpperCase()
        const digits = code.replace(/[^0-9]/g, "").slice(0, 6)
        if (digits.length !== 6) { writeJson(res, 400, { error: "股票代码格式错误：" + code }); return }
        try {
          const entries = await fsp.readdir(CHARTS_DIR, { withFileTypes: true })
          const hits = []
          for (const entry of entries) {
            if (!entry.isFile() || !/\.(svg|png)$/i.test(entry.name) || !entry.name.includes(digits)) continue
            const full = CHARTS_DIR + entry.name
            const stat = await fsp.stat(full)
            hits.push({ path: full, name: entry.name, mtime: stat.mtimeMs, size: stat.size })
          }
          hits.sort((a, b) => b.mtime - a.mtime)
          writeJson(res, 200, { code, charts: hits.slice(0, 24), total: hits.length })
        } catch (e) {
          if (e && e.code === "ENOENT") { writeJson(res, 200, { code, charts: [], total: 0 }); return }
          writeJson(res, 500, { error: String(e).slice(0, 200) })
        }
      },
    },
    {
      // 基本面评级（v0.58.0）：行业横截面分位 + 风险标记。
      // 定位是「排雷与理解质地」，不是买卖信号——响应里始终带 caveat，前端必须常驻展示。
      kind: "exact",
      path: "/dsh-invest/api/fundamentals",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const url = new URL(req.url ?? "/", "http://localhost")
        const code = String(queryParam(url, "code") || "").trim().toUpperCase()
        if (!/^\d{6}\.(SH|SZ|BJ)$/.test(code)) { writeJson(res, 400, { error: "股票代码格式错误：" + code }); return }
        const force = /[?&]refresh=1(?:&|$)/.test(String(req.url || ""))
        try {
          writeJson(res, 200, await fundamentalsFor(code, force))
        } catch (e) {
          // 取数失败也要把契约字段补齐，前端才能稳定渲染错误态而不是炸掉
          writeJson(res, 200, {
            ok: false, error: String(e && e.message ? e.message : e).slice(0, 300),
            code, name: code, industry: "", peerCount: 0, period: "", periodLabel: "",
            announceDate: "", priceDate: "", total: null, grade: "—", gradeLabel: "数据不足",
            coverage: "0/5 维", dims: [], flags: [], warnings: [], history: [], delta: null,
            caveat: CAVEAT, cachedAt: "",
          })
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
        const fs = hostService(ctx, "fs")
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
        const fs = hostService(ctx, "fs")
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
        const fs = hostService(ctx, "fs")
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
        const fs = hostService(ctx, "fs")
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
      // 悟道条目列表（页面首屏；坏文件也返回空库，页面不至于打不开）
      kind: "exact",
      path: "/dsh-invest/api/dao",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          writeJson(res, 200, Object.assign({ ok: true }, daoPayload(await readDaoStore())))
        } catch (e) { writeJson(res, 500, { error: String(e && e.message ? e.message : e).slice(0, 300) }) }
      },
    },
    {
      // 新建 / 更新条目：带 id 即更新（id 不存在会报错，避免把已删条目写回来）
      kind: "exact",
      path: "/dsh-invest/api/dao/entry",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          const result = await mutateDao((store) => upsertDaoItem(store, body, new Date().toISOString()))
          writeJson(res, 200, Object.assign({ ok: true, item: result.item }, daoPayload(result.store)))
        } catch (e) { writeJson(res, 400, { error: String(e && e.message ? e.message : e).slice(0, 400) }) }
      },
    },
    {
      kind: "exact",
      path: "/dsh-invest/api/dao/delete",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          const result = await mutateDao((store) => deleteDaoItem(store, body.id))
          writeJson(res, 200, Object.assign({ ok: true, removed: result.removed }, daoPayload(result.store)))
        } catch (e) { writeJson(res, 400, { error: String(e && e.message ? e.message : e).slice(0, 400) }) }
      },
    },
    {
      // 悟道对话：教练或某个分析师人格；不传工具，只带用户自己的条目
      kind: "exact",
      path: "/dsh-invest/api/dao/chat",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          writeJson(res, 200, Object.assign({ ok: true }, await daoChat(body.persona, body.messages)))
        } catch (e) {
          const message = String(e && e.message ? e.message : e).slice(0, 400)
          if (e && e.code === "DAO_INPUT") writeJson(res, 400, { error: message })
          else writeJson(res, 503, { error: "模型暂不可用：" + message.slice(0, 160) })
        }
      },
    },
    {
      // 把一段对话沉淀成条目草稿（返回草稿，用户确认后走 /dao/entry 入库）
      kind: "exact",
      path: "/dsh-invest/api/dao/distill",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          writeJson(res, 200, Object.assign({ ok: true }, await daoDistill(body.persona, body.messages)))
        } catch (e) {
          const message = String(e && e.message ? e.message : e).slice(0, 400)
          if (e && e.code === "DAO_INPUT") writeJson(res, 400, { error: message })
          else writeJson(res, 503, { error: "模型暂不可用：" + message.slice(0, 160) })
        }
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
        const fs = hostService(ctx, "fs")
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
        const fs = hostService(ctx, "fs")
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
      // 结论采集审计：哪些运行进了库、哪些没进、为什么（v0.45.0）
      kind: "exact",
      path: "/dsh-invest/api/conclusions-audit",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        try { writeJson(res, 200, await computeConclusionAudit()) } catch (e) { writeJson(res, 500, { error: String(e).slice(0, 300) }) }
      },
    },
    {
      // 历史报告回溯补录：把报告里残留的【结论结构化】行补进结论库（v0.45.0）
      // 默认 dry-run，只有 apply=true 才写盘；按（报告+标的）去重，可反复执行
      kind: "exact",
      path: "/dsh-invest/api/conclusions-backfill",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          writeJson(res, 200, await backfillConclusions(body && body.apply === true))
        } catch (e) { writeJson(res, 500, { error: String(e).slice(0, 300) }) }
      },
    },
    {
      // 实例改名（v0.48.0）：多人共享数据时给本机起个名字，分组表里显示这个名字
      kind: "exact",
      path: "/dsh-invest/api/instance-name",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          const inst = await setInstanceName(body && body.name)
          writeJson(res, 200, { ok: true, instance: inst })
        } catch (e) { writeJson(res, 500, { error: String(e).slice(0, 300) }) }
      },
    },
    {
      // 结论导出（v0.48.0）：一键导出单文件 jsonl，微信/网盘直接转发。
      // 第一行是 _manifest（来源实例/导出时间/条数），其余为结论行原样——只含结论，
      // 不含 token、持仓账本、报告正文；question/thesis 字段是流水线判断内容本身。
      kind: "exact",
      path: "/dsh-invest/api/conclusions-export",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          let text = ""
          try { text = await fsp.readFile(CONCLUSIONS_LOG, "utf8") } catch (e) { /* 空库 */ }
          const lines = String(text || "").split("\n").filter((l) => l.trim())
          if (!lines.length) { writeJson(res, 400, { error: "结论库还是空的：先跑几次带结构化结论的任务再导出" }); return }
          const inst = await loadInstance()
          const manifest = JSON.stringify({
            _manifest: true, instance: inst.id, name: inst.name, exportedAt: new Date().toISOString(),
            count: lines.length, kind: "dsh-invest-conclusions", note: "dsh-invest 判断质量数据：仅含结构化结论，不含持仓与凭证",
          })
          const body = manifest + "\n" + lines.join("\n") + "\n"
          const d = new Date()
          const stamp = "" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0")
          res.statusCode = 200
          res.setHeader("content-type", "application/x-ndjson; charset=utf-8")
          res.setHeader("cache-control", "no-store")
          res.setHeader("content-disposition", 'attachment; filename="conclusions-' + inst.id.slice(0, 8) + '-' + stamp + '.jsonl"')
          res.end(body)
        } catch (e) { writeJson(res, 500, { error: String(e).slice(0, 300) }) }
      },
    },
    {
      // 结论导入（v0.48.0）：导入他人导出的 jsonl——按（callId+标的）去重、只追加不改写，
      // 与 conclusions.jsonl 的 append-only 纪律一致；导入来源登记进 instances.json 供分组显示。
      kind: "exact",
      path: "/dsh-invest/api/conclusions-import",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req, 8 * 1048576)
          const text = String((body && body.text) || "")
          if (!text.trim()) { writeJson(res, 400, { error: "导入内容为空" }); return }
          const localInst = await loadInstance()
          const inLines = text.split(/\r?\n/).filter((l) => l.trim())
          if (inLines.length > 5000) { writeJson(res, 400, { error: "单次导入上限 5000 条" }); return }
          // manifest：来源身份（缺 instance 的行是导出方的旧数据，导入时归到导出方名下）
          let srcId = "", srcName = ""
          for (const l of inLines) {
            try {
              const j = JSON.parse(l)
              if (j && j._manifest === true) {
                if (typeof j.instance === "string" && j.instance) srcId = j.instance
                if (typeof j.name === "string") srcName = j.name
                break
              }
            } catch (e) { /* 非法行后面统一算 */ }
          }
          const fs0 = hostService(ctx, "fs")
          if (fs0 === void 0) { writeJson(res, 500, { error: "文件系统不可用" }); return }
          const result = await withLock("conclusions", async () => {
            const target = await fs0.resolve(CONCLUSIONS_LOG)
            let existing = ""
            try { existing = await fs0.readText(target) } catch (e) { /* 首次 */ }
            const have = new Set()
            for (const l of String(existing || "").split("\n")) {
              if (!l.trim()) continue
              try { const j = JSON.parse(l); if (j && j.callId && j.code) have.add(j.callId + "|" + j.code) } catch (e) { /* 忽略坏行 */ }
            }
            const add = []
            let skippedDup = 0, skippedInvalid = 0
            for (const l of inLines) {
              let j = null
              try { j = JSON.parse(l) } catch (e) { skippedInvalid += 1; continue }
              if (!j || j._manifest === true) continue
              if (typeof j.code !== "string" || !/^\d{6}\.(SH|SZ|BJ)$/.test(j.code) || !j.ts || !j.callId || !j.stance) { skippedInvalid += 1; continue }
              if (have.has(j.callId + "|" + j.code)) { skippedDup += 1; continue }
              have.add(j.callId + "|" + j.code)
              // 归属：行自带 instance 优先；否则用导出方 manifest 的 instance；再否则不补（无法判断来源）
              const row = { ...j }
              if (!row.instance && srcId && srcId !== localInst.id) row.instance = srcId
              add.push(JSON.stringify(row))
            }
            if (add.length) {
              const prefix = existing && !existing.endsWith("\n") ? existing + "\n" : existing
              await fs0.writeText(target, prefix + add.join("\n") + "\n", void 0, void 0, getFsPolicy())
            }
            return { imported: add.length, skippedDup, skippedInvalid }
          })
          if (srcId && srcId !== localInst.id) await rememberInstance(srcId, srcName)
          writeJson(res, 200, {
            ok: true, ...result,
            source: { instance: srcId, name: srcName },
            note: "导入只追加不覆盖；同一份文件重复导入会全部跳过，无副作用",
          })
        } catch (e) { writeJson(res, 500, { error: String(e).slice(0, 300) }) }
      },
    },
    {
      // 更新检查（v0.50.0）：本包版本 vs GitHub main 上的版本，并给出与「安装方式」对应的准确命令。
      // 只读、不执行任何更新动作；网络失败一律静默降级为 { ok:false }，不影响工作台。
      // 有 30 分钟内存缓存，避免每次刷新都打网络。
      kind: "exact",
      path: "/dsh-invest/api/update-check",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const now = Date.now()
          // ?force=1 = 用户手动点「检测更新」，绕过 30 分钟缓存（v0.51.0）。
          // 只缓存成功结果：一次网络抖动不该把「已知有新版」抹掉，也不该让下次重试等 30 分钟。
          const force = /[?&]force=1(?:&|$)/.test(String(req.url || ""))
          if (!force && updateCache && now - updateCache.at < 30 * 60 * 1000) {
            writeJson(res, 200, { ...updateCache.value, cached: true })
            return
          }
          const result = await checkForUpdate()
          if (result.ok) updateCache = { at: now, value: result }
          writeJson(res, 200, result)
        } catch (e) { writeJson(res, 200, { ok: false, error: String(e).slice(0, 200) }) }
      },
    },
    {
      // 「本次更新」说明（v0.50.0）：内容由 tools/gen-whats-new.js 从 CHANGELOG.md 生成，
      // 随包分发（仓库根的 CHANGELOG 不在 files 里，装到别处就读不到了）。
      kind: "exact",
      path: "/dsh-invest/api/whats-new",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          // 与 index.js 同级（lib/whats-new.json）；../ 会指到包根，别写错
          const here = new URL("./whats-new.json", import.meta.url)
          const j = JSON.parse(await fsp.readFile(here, "utf8"))
          writeJson(res, 200, { ok: true, ...j })
        } catch (e) {
          // 说明文件缺失不影响使用：前端拿不到就不弹
          writeJson(res, 200, { ok: false, releases: [], error: "缺少 whats-new.json（发布前需跑 tools/gen-whats-new.js）" })
        }
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
      path: "/dsh-invest/api/job/cancel",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "POST") { writeJson(res, 405, { error: "method not allowed" }); return }
        try {
          const body = await readRequestJson(req)
          const outcome = cancelJob(String(body.id || "").trim())
          if (!outcome.ok) { writeJson(res, outcome.code, { ok: false, error: outcome.error }); return }
          const job = outcome.job
          writeJson(res, 200, { ok: true, status: job.status, id: job.id, elapsedMs: job.elapsedMs || 0, error: job.error || "" })
        } catch (e) { writeJson(res, 400, { ok: false, error: String(e && e.message ? e.message : e).slice(0, 300) }) }
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
          const fs = hostService(ctx, "fs")
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
          const fs = hostService(ctx, "fs")
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
          const fs = hostService(ctx, "fs")
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
                // 编码事故兜底：名称里出现 U+FFFD 说明中文已在传输链路上毁掉。
                // 注意此时 warnings 也一起毁了，而 Python 侧的 confidence 门禁是靠中文子串
                // （"未能反查代码"/"不一致"/"校验不符"）匹配判定的——中文一毁它就恒等于「无阻塞」，
                // 于是乱码草稿会假通过 high。这里改用「数据本身是否可读」来兜底，宁可回退视觉模型。
                const garbled = rows.some((p) => p && typeof p.name === "string" && p.name.includes("\uFFFD"))
                const usable = ocr && ocr.ok === true && ocr.confidence === "high" && !garbled && rows.some((p) => p && p.code && Number(p.shares) > 0)
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
      const fs = hostService(ctx, "fs")
      const sp = hostService(ctx, "sandboxPolicy")
      const policy = (sp !== void 0 && exec.agent !== void 0) ? sp.resolve({ session: exec.agent.session }) : void 0
      // 运行日志在 finally 中要引用这两个变量，必须声明在函数作用域：
      // 历史上的 ReferenceError: summaryText is not defined 被 finally 里的空 catch 吞掉，
      // 导致 2026-11-06 之后所有运行日志静默停写（已修复，见 v0.34.0 CHANGELOG）。
      let summaryText = null
      let summaryEnabled = PLUGIN_CONFIG.summary !== false && process.env.DSH_INVEST_SUMMARY !== "0"
      try {
      // 2026-10-28 修复（第二版）：插件已在 inject 中声明 subagents，属性访问 ctx.subagents 取得的才是
      // 带 start() 的运行时（与宿主 dsh-tool-subagent 的 runtimeCtx.subagents 同源）；ctx.get() 取到的形态不带 start()。
      // 候选顺序：属性访问 → hostService(ctx, n, true) → hostService(ctx, n, false)，取第一个带 start() 的实例；
      // 都不可用时把探测到的键名写进错误便于定位。
      const candidatesOf = (n) => {
        const out = []
        try { out.push(ctx[n]) } catch (e) { /* 未声明 inject 时会抛错，忽略 */ }
        if (typeof ctx.get === "function") {
          try { out.push(hostService(ctx, n, true)) } catch (e) { /* 忽略 */ }
          try { out.push(hostService(ctx, n, false)) } catch (e) { /* 忽略 */ }
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
      // 2026-11-23 修复（第四版）：0.2.x 的 startActivation 在 spec 顶层读 parent，
      // 旧代码塞进 request.parent 导致 spec.parent 为 undefined → 阶段子代理全部 TypeError
      // （Cannot read properties of undefined (reading 'id')）。详见 activationSpecFor 的注释。
      const startStage = async (spec) => {
        if (nativeStart !== void 0) return nativeStart.start("spawn", spec)
        const plain = Array.isArray(spec.prompt)
          ? spec.prompt.map((b) => (b && b.text) || "").join("\n")
          : String(spec.prompt || "")
        const text = spec.persona ? "【角色设定】\n" + spec.persona + "\n\n" + plain : plain
        // maxDepth 不显式传：继承宿主设置（默认 1 = 本级允许、孙代被拒，等效旧的“禁止递归”）。
        // 实测 maxDepth:0 表示“禁止本级”——子代深度 1 会直接 SubagentDepthError。
        const call = (delivery) => activationHost.startActivation(activationSpecFor(spec, text, delivery))
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
      const llm = hostService(ctx, "llm")
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
      // 「悟道」预计算：读一次条目库，按本次角色各挑一份（置顶优先、字数封顶）；
      // 空库时块为空串，下面按需注入，不影响任何既有运行。
      const daoStore = await readDaoStore()
      const daoPicked = buildDaoBlocks(daoStore, roleCodes)
      const daoBlocks = daoPicked.blocks
      const daoCounts = daoPicked.counts
      const daoSummaryEntries = selectDaoEntries(daoStore, "总判断", { maxChars: 800 })
      const runStage = async (s) => {
        const t0 = Date.now()
        const parts = ["用户问题：" + question]
        if (context) parts.push("【对话上下文（记忆）】" + context + "\n请结合上述上下文继续分析，保持口径一致。")
        parts.push(anchorLine)
        // 「悟道」纪律放在账本/历史之前：后面这些块又长又多，纪律排在后段容易被模型忽略
        if (daoBlocks[s.code]) parts.push(daoBlocks[s.code])
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
        // v0.75.7：工具红线前置（见 CHANGELOG；防止阶段子代理误用桌面自动化开窗口）
        const basePrompt = TOOL_REDLINE + "\n\n" + parts.join("\n\n")
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
            // 总结模型看不到各阶段的 prompt，纪律要在这里再带一次，否则「总结」最容易把纪律丢掉
            buildDaoBlock(daoSummaryEntries, "总判断"),
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
          // 留痕：报告要能回答「这次分析受哪些纪律约束」，否则事后无法复盘注入是否生效
          const daoInjected = roleCodes.filter((c) => daoCounts[c] > 0).map((c) => c + "=" + daoCounts[c] + " 条")
          if (daoSummaryEntries.length) daoInjected.push("二次总结=" + daoSummaryEntries.length + " 条")
          if (daoInjected.length) lines.push("- 悟道注入：" + daoInjected.join(" ｜ "))
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
    // 盘中盯盘调度：每 15 秒叫一次，真正的节流（默认 60s/30s/120s）在 liveTick 里按预设判。
    // 用 15 秒的粗粒度轮询而不是给每个预设单独建定时器：切档立刻生效，不用重挂 timer。
    // node --test 下 effect 会立即执行，必须早退，避免测试中途跑真实行情。
    if (process.env.NODE_TEST_CONTEXT || process.env.DSH_INVEST_LIVE_WATCH === "0") return () => {}
    const boot = setTimeout(() => { void maybeTickLiveWatch() }, 30000)
    const tick = setInterval(() => { void maybeTickLiveWatch() }, 15000)
    if (typeof boot.unref === "function") boot.unref()
    if (typeof tick.unref === "function") tick.unref()
    return () => { clearTimeout(boot); clearInterval(tick) }
  }, "dsh-invest: live-watch auto")

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

export { name, inject, apply, Config, activationSpecFor }
