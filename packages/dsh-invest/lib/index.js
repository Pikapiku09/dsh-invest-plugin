// dsh-invest Host 半部：invest_run 工具 + /api/dsh-invest 路由 + agent 指引
// 常规 Cordis 插件（profile bundle 挂载），所有会话可见
import { defineTool } from "@deepseek-ai/dsh-tools"
import { DATA_BASE, P_SELECT, P_NEWS, P_DEEP, P_FINAL } from "./prompts.js"
import { extractBoth, collectCharts, buildGroups, isLoopbackRequest, z2, localYmd } from "./pure.js"

/** Stable cordis plugin name. */
const name = "invest"

/** Services required before the invest surfaces can mount. */
const inject = ["webServer", "tools", "systemPrompt"]

/** Model-facing announcement: plugin presence, capabilities, and limits. */
const INVEST_GUIDANCE = "本机已安装 dsh-invest 插件（A 股多角色投研流水线）：invest_run 工具由 4 个角色子代理（选股分析师 → 市场重点消息获取师 → 股票深度分析师 → 总判断师）用 Tushare 实时数据逐层分析，自动生成 SVG 图表并在 GUI 卡片内联显示（卡片可查看每个 Agent 的完整报告与推理过程）。参数：mode 按问题类型选择（见下）；question=投研问题（可含多只股票对比）；roles=可选的自定义角色组合（['选股','消息','深度','总判断'] 的子集，如 ['深度','总判断']，省略则按 mode 默认）；context=上一轮结论（记忆与追问）；detail=summary（默认，模型侧摘要省 token）/full（模型侧全量）。【模式选择规则】① 单只/两只个股的深度分析、操作建议、值不值得买（问题已指定具体代码）→ mode=个股（仅股票深度分析师，最省时）；② 收集某标的/行业/市场消息 → mode=消息；③ 全市场海选、短线强势股/下周可买标的推荐、需要候选名单的扫描 → mode=选股；④ 多只股票对比、需要选股初筛+深度逐只 → mode=深度分析；⑤ 持仓复盘、市场全景、需要完整流水线与最终综合建议、不确定时 → mode=all（选股∥消息 → 深度 → 总判断）。【角色选择规则】用户问题中明确列出了角色（如「用深度分析师和总判断师分析XX」）→ 必须按所列角色传 roles 组合执行，不得额外加角色；用户要求「让我选角色/自定义角色/勾选角色」→ 先用 ask_user_question 列出 4 个角色（多选）让用户选择，再按选择传 roles；用户没提角色 → 按模式选择规则默认执行。【触发】用户问任何与 A 股个股/持仓/板块/市场相关的分析、选股、买卖建议、消息面、深度诊断、多标的对比、持仓复盘时，直接用 invest_run 执行，不要凭模型知识作答；数据锚定真实最新交易日，接口受限如实标注。用户提到「投研 / 选股 / 持仓分析 / 股票分析」时即指本插件，请据此协作。"

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
 */
function apply(ctx) {
  const progressStore = {}
  // 工作区基目录：默认 E:/Dsh_WorkSapce/Dify_Agents，可用 DSH_INVEST_BASE_DIR 覆盖
  const BASE_DIR = (typeof process !== "undefined" && process.env && process.env.DSH_INVEST_BASE_DIR) || "E:/Dsh_WorkSapce/Dify_Agents"
  const CACHE_DIR = BASE_DIR + "/.dsh-invest/cache"
  const TRADE_CACHE = CACHE_DIR + "/last-trade-date.json"
  const REPORTS_DIR = BASE_DIR + "/.dsh-invest/reports"
  const OUTPUT_ROOT = BASE_DIR + "/invest-outputs"
  const RUNS_LOG = BASE_DIR + "/.dsh-invest/runs.jsonl"
  const MAX_CHARTS = 6
  // 提示词里的 {{BASE_DIR}} 占位符 → 实际基目录（token/缓存/图表路径）
  const resolveDir = (t) => String(t).split("{{BASE_DIR}}").join(BASE_DIR)

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

  const routes = [
    {
      kind: "exact",
      path: "/api/dsh-invest/chart",
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "forbidden: loopback-only" }); return }
        if (req.method !== "GET") { writeJson(res, 405, { error: "method not allowed" }); return }
        const url = new URL(req.url ?? "/", "http://localhost")
        const p = queryParam(url, "path") ?? ""
        if (!/\.svg$/i.test(p) || p.indexOf(".dsh-invest") < 0 || p.indexOf("charts") < 0) { writeJson(res, 400, { error: "denied" }); return }
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
  ]

  const tool = defineTool({
    name: "invest_run",
    description: "运行多角色投研流水线。mode：个股（单只股票深度分析，最常用）/选股（全市场海选）/消息（消息面收集）/深度分析（选股+深度）/总判断/all（完整流水线）。question 为用户投研问题（可含多只股票）；roles 可选：自定义角色组合（如 ['深度','总判断']，省略则按 mode 默认）；context 可选，传入上一轮分析结论或追问背景（记忆与追问）；detail 可选：full=模型侧全量输出（token 多），summary=摘要输出省 token（默认，GUI 卡片始终显示完整报告）。数据用 Tushare 实时获取。",
    parameters: {
      mode: { type: "string", description: "运行模式", required: true },
      question: { type: "string", description: "用户投研问题（可含多只股票）", required: true },
      roles: { type: "array", items: { type: "string" }, description: "可选：自定义角色组合，取值 ['选股','消息','深度','总判断'] 的子集（如 ['深度','总判断']）；省略则按 mode 默认角色。用户问题中明确列出角色时按所列角色执行；用户要求选择角色时用 ask_user_question 询问后再传" },
      context: { type: "string", description: "可选：上一轮分析结论/追问背景，让本轮分析有记忆" },
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
        lines.push("invest_run 模式=" + String(value.mode || "") + " ｜ 阶段数=" + outputs.length + (charts.length ? " ｜ 图表=" + charts.length + " 张" : "") + (reports.length ? " ｜ 报告已归档" : "") + " ｜ detail=" + detail)
        for (const o of outputs) {
          lines.push("")
          lines.push("=== " + o.stage + (o.ok ? " ｜ 耗时 " + (o.elapsedMs / 1000).toFixed(1) + "s" : " ｜ 失败") + " ===")
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
        stages: (Array.isArray(value.outputs) ? value.outputs : []).map((o) => ({ stage: o.stage, ok: o.ok === true, elapsedMs: o.elapsedMs, text: typeof o.text === "string" ? o.text : "", reasoning: typeof o.reasoning === "string" ? o.reasoning : "" })),
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
      // 沙箱策略提前解析（报告归档与运行日志共用）
      const fs = ctx.get("fs")
      const sp = ctx.get("sandboxPolicy")
      const policy = (sp !== void 0 && exec.agent !== void 0) ? sp.resolve({ session: exec.agent.session }) : void 0
      try {
      const subs = ctx.get("subagents")
      if (subs === void 0) return { error: "subagents not mounted" }
      const R = (name, persona) => ({ name, persona })
      // 角色定义：简码 → { 显示名, persona }
      const ROLE_MAP = {
        "选股": R("选股分析师", P_SELECT),
        "消息": R("市场重点消息获取师", P_NEWS),
        "深度": R("股票深度分析师", P_DEEP),
        "总判断": R("总判断师", P_FINAL),
      }
      // 默认角色组合（按 mode）
      const DEFAULT_ROLES = {
        "个股": ["深度"],
        "选股": ["选股"],
        "消息": ["消息"],
        "深度分析": ["选股", "深度"],
        "总判断": ["选股", "消息", "深度", "总判断"],
      }
      let roleCodes
      if (Array.isArray(args.roles) && args.roles.length) {
        roleCodes = args.roles.filter((r) => ROLE_MAP[r])
        if (!roleCodes.length) return { error: "无效的角色列表：" + JSON.stringify(args.roles) + "，可选：选股/消息/深度/总判断" }
      } else {
        roleCodes = DEFAULT_ROLES[mode] || DEFAULT_ROLES["总判断"]
      }
      const groups = buildGroups(roleCodes, ROLE_MAP)
      const setProgress = (p) => { progressStore[callId] = Object.assign({ updatedAt: Date.now() }, p) }
      setProgress({ stage: "", index: 0, total: groups.length, status: "init", done: [] })
      const anchor = await readTradeCache()
      const anchorLine = anchor
        ? "【已缓存锚定】真实最新交易日 = " + anchor + "（由流水线缓存提供，跳过 index_daily 锚定步骤，直接按此日期取数）"
        : "【交易日缓存为空】按日期锚定铁律完成 index_daily 锚定后，用 pwsh 执行 node -e 把 JSON {\"date\":\"" + localYmd() + "\",\"trade_date\":\"你的锚定结果YYYYMMDD\"} 写入 " + TRADE_CACHE + "（目录不存在先创建），供本日后续运行复用"
      const history = []
      const runStage = async (s) => {
        const t0 = Date.now()
        const parts = ["用户问题：" + question]
        if (context) parts.push("【对话上下文（记忆）】" + context + "\n请结合上述上下文继续分析，保持口径一致。")
        parts.push(anchorLine)
        if (allCharts.size) {
          parts.push("【上游图表（同类图表直接引用其完整绝对路径，严禁重复生成同类图）】" + Array.from(allCharts).join(" , "))
        }
        for (const h of history) {
          parts.push("【" + h.stage + " 产出（请基于其继续，勿重复取数已覆盖内容）】\n" + h.text)
        }
        parts.push("请按你的角色职责完成分析并输出完整结果。")
        const basePrompt = parts.join("\n\n")
        let lastErr = ""
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const promptText = lastErr ? basePrompt + "\n\n【上次执行失败，错误信息】" + lastErr + "\n请修正后重试。" : basePrompt
            const run = await subs.start("spawn", {
              label: s.name + (attempt > 1 ? "(重试)" : ""),
              prompt: [{ type: "text", text: promptText }],
              parent: exec.agent,
              signal: exec.signal,
              persona: resolveDir(s.persona),
              // 关键：禁止阶段子代理递归——移除所有子代理/流水线/cordis 类工具，
              // 子代理只能用自己的 pwsh/read 等取数工具，不能再 spawn 子代理或调用 invest_run
              toolFilter: {
                deny: [
                  "invest_run", "subagent", "subagent_fork",
                  "send_message", "interrupt_agent", "list_agents", "ralph", "workflow",
                ],
              },
            })
            const result = await run.result
            const both = extractBoth(result)
            const full = String(both.text)
            collectCharts(full).forEach((c) => allCharts.add(c))
            return { stage: s.name, ok: true, elapsedMs: Date.now() - t0, text: full.slice(0, 9000), reasoning: String(both.reasoning).slice(0, 4000) }
          } catch (e) {
            lastErr = String(e).slice(0, 600)
            const nonRetryable = /40203|无权限|权限不足|超限|频率|quota|forbidden|unauthorized|unauthenticated/i.test(lastErr)
            if (nonRetryable || attempt === 2) {
              return { stage: s.name, ok: false, error: lastErr, elapsedMs: Date.now() - t0, retried: attempt > 1 }
            }
          }
        }
        return { stage: s.name, ok: false, error: "未知失败", elapsedMs: Date.now() - t0 }
      }
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi]
        const groupLabel = g.map((x) => x.name).join(" + ")
        setProgress({ stage: groupLabel, index: gi + 1, total: groups.length, status: "running", done: outputs.filter((o) => o.ok).map((o) => ({ stage: o.stage, ms: o.elapsedMs })) })
        const results = await Promise.all(g.map((s) => runStage(s)))
        for (const r of results) {
          outputs.push(r)
          if (r.ok) history.push({ stage: r.stage, text: r.text })
        }
        setProgress({ stage: groupLabel, index: gi + 1, total: groups.length, status: "done", elapsedMs: results.reduce((a, r) => Math.max(a, r.elapsedMs || 0), 0), done: outputs.filter((o) => o.ok).map((o) => ({ stage: o.stage, ms: o.elapsedMs })) })
      }
      setProgress({ stage: "", index: groups.length, total: groups.length, status: "final", done: outputs.filter((o) => o.ok).map((o) => ({ stage: o.stage, ms: o.elapsedMs })) })
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
          for (const o of outputs) {
            lines.push("")
            lines.push("## " + o.stage + (o.ok ? "（耗时 " + (o.elapsedMs / 1000).toFixed(1) + "s" + (o.retried ? "，含重试" : "") + "）" : "（失败）"))
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
          for (const o of outputs) {
            outLines.push("")
            outLines.push("## " + o.stage + (o.ok ? "（耗时 " + (o.elapsedMs / 1000).toFixed(1) + "s" + (o.retried ? "，含重试" : "") + "）" : "（失败）"))
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
      return { mode, stages: outputs.map((o) => o.stage), charts: Array.from(allCharts), reports, reportError, outputs }
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
              stages: outputs.map((o) => ({ stage: o.stage, ok: o.ok === true, ms: o.elapsedMs || 0 })),
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

export { name, inject, apply }
