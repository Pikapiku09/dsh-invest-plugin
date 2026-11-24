// 行情数据源适配层：Tushare（需 token）与腾讯自选股（免费、免 token）。
//
// 设计原则：
// ① 输出统一成 Tushare `daily` 的行形状（ts_code / trade_date / open / high / low /
//    close / pre_close / change / pct_chg / vol / amount），下游回测代码一行都不用改。
// ② 纯函数与网络分离：parse/build 全部可单测，fetch 才碰网络。
// ③ 腾讯接口拿的是前复权（qfq）价，等价于「复权因子恒为 1」——所以走腾讯时不需要
//    再乘 adj_factor，btAdj 返回 null 即正确。
//
// 已知能力缺口（必须如实标注，不得静默降级）：
// - 腾讯无财务报表；PE/PB/市值等基本面字段缺失。
// - 腾讯成交量单位为「手」，与 Tushare 的 vol 同量纲。

export const TENCENT_KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
export const TENCENT_QUOTE_URL = "https://qt.gtimg.cn/q="

/** 600000.SH → sh600000；已带前缀则原样返回；未知后缀默认加 sh */
export function toTencentCode(code) {
  const s = String(code || "").trim().toLowerCase()
  const m = s.match(/^(\d{6})\.(sh|sz|bj)$/)
  if (m) return m[2] + m[1]
  if (/^(sh|sz|bj)\d{6}$/.test(s)) return s
  if (/^\d{6}$/.test(s)) {
    if (/^(60|68|90|50|51|58)/.test(s)) return "sh" + s
    if (/^(00|30|20|15|16|18)/.test(s)) return "sz" + s
    if (/^(43|83|87|88|92)/.test(s)) return "bj" + s
    return "sh" + s
  }
  return s
}

/** sh600000 → 600000.SH（回传下游时统一成大写的 Tushare 风格） */
export function fromTencentCode(code) {
  const s = String(code || "").trim().toLowerCase()
  const m = s.match(/^(sh|sz|bj)(\d{6})$/)
  if (!m) return String(code || "")
  return m[2] + "." + m[1].toUpperCase()
}

/** 20261124 → 2026-11-24 */
export function toDashed(ymd) {
  const s = String(ymd || "")
  return /^\d{8}$/.test(s) ? s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8) : s
}

/** 2026-11-24 → 20261124 */
export function toCompact(dashed) {
  const s = String(dashed || "")
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.replace(/-/g, "") : s
}

/** K 线请求地址；days 上限 800（腾讯接口再大会截断） */
export function buildTencentKlineUrl(code, isIndex, days) {
  const tc = toTencentCode(code)
  const n = Math.max(30, Math.min(800, Number(days) || 400))
  const param = tc + ",day,,," + n + "," + (isIndex ? "" : "qfq")
  return TENCENT_KLINE_URL + "?param=" + encodeURIComponent(param)
}

/**
 * 解析腾讯 K 线响应 → Tushare daily 行（升序）。
 * 个股复权请求的键是 qfqday，指数请求的键是 day；两者都兼容。
 * 行格式：[日期, 开, 收, 高, 低, 成交量(手)]
 */
export function parseTencentKline(text, code, isIndex) {
  let j
  try { j = typeof text === "string" ? JSON.parse(text) : text } catch (e) { return [] }
  if (!j || j.code !== 0 || !j.data) return []
  const tc = toTencentCode(code)
  const node = j.data[tc] || j.data[Object.keys(j.data)[0]]
  if (!node || typeof node !== "object") return []
  const raw = (isIndex ? null : node.qfqday) || node.day || node.qfqday || []
  if (!Array.isArray(raw) || !raw.length) return []

  const rows = []
  for (const r of raw) {
    if (!Array.isArray(r) || r.length < 5) continue
    const trade_date = toCompact(r[0])
    if (!/^\d{8}$/.test(trade_date)) continue
    const open = Number(r[1])
    const close = Number(r[2])
    const high = Number(r[3])
    const low = Number(r[4])
    const vol = Number(r[5])
    if (![open, close, high, low].every((v) => Number.isFinite(v) && v > 0)) continue
    rows.push({ ts_code: fromTencentCode(tc), trade_date, open, high, low, close, vol: Number.isFinite(vol) ? vol : null })
  }
  if (!rows.length) return []
  rows.sort((a, b) => a.trade_date.localeCompare(b.trade_date))
  // pre_close / change / pct_chg 只能由前一行推出来；首行没有前收，留空而不是编造
  for (let i = 0; i < rows.length; i += 1) {
    const prev = i > 0 ? rows[i - 1].close : null
    if (prev && prev > 0) {
      rows[i].pre_close = prev
      rows[i].change = Number((rows[i].close - prev).toFixed(3))
      rows[i].pct_chg = Number((((rows[i].close - prev) / prev) * 100).toFixed(4))
    } else {
      rows[i].pre_close = null
      rows[i].change = null
      rows[i].pct_chg = null
    }
    // 腾讯不给成交额，留 null；下游若用 amount 需自行按 close×vol 估算并标注口径
    rows[i].amount = null
  }
  return rows
}

/**
 * 离线开关：置 DSH_INVEST_OFFLINE=1 时所有网络兜底直接跳过。
 * 用途有两个——① 让人在断网/受限网络下主动关掉外呼；
 * ② 让测试可以稳定复现「离线时优雅降级」这条语义，不被真实网络干扰。
 */
export function offlineMode() {
  try {
    return typeof process !== "undefined" && !!process.env && !!process.env.DSH_INVEST_OFFLINE
  } catch (e) {
    return false
  }
}

/**
 * 拉腾讯日线。失败返回 []（绝不抛），由调用方决定降级或提示。
 * fetchImpl 可注入，便于测试与宿主环境复用。
 */
export async function fetchTencentDaily(code, isIndex, days, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null)
  if (!doFetch || offlineMode()) return []
  try {
    const r = await doFetch(buildTencentKlineUrl(code, isIndex, days), {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" },
    })
    if (!r || !r.ok) return []
    return parseTencentKline(await r.text(), code, isIndex)
  } catch (e) {
    return []
  }
}

/** 复权因子的语义：走腾讯时拿的是前复权价，不需要再乘因子 */
export function needsAdjFactor(sourceName) {
  return sourceName !== "tencent"
}

/**
 * 数据源说明文案：进报告头，让人一眼看出这次结论是用什么数据算的。
 * 降级时必须出现，不允许静默变差。
 */
export function describeSource(state) {
  const s = state && typeof state === "object" ? state : {}
  const daily = s.daily || ""
  const parts = []
  if (!daily || daily === "none") {
    parts.push("数据源：未就绪（既无 Tushare token，腾讯行情也未连通）")
  } else if (daily === "tencent") {
    parts.push("数据源：腾讯自选股（免费源；Tushare 未配置，日线为前复权口径）")
  } else {
    parts.push("数据源：Tushare")
  }
  if (s.fundamentals === "missing" || (daily === "tencent" && s.fundamentals !== "tushare")) {
    parts.push("基本面字段缺失，深度分析按「无财务数据」处理")
  }
  if (s.error) parts.push("最近一次取数失败：" + String(s.error).slice(0, 120))
  return parts.join("；")
}

/** 给用户看的一次性引导：无 token 时不是报错，而是告诉他两条路 */
export function buildOnboardingHint(hasToken) {
  if (hasToken) return ""
  return [
    "【首次使用提示】还没有配置 Tushare token，已自动切换到腾讯自选股免费行情。",
    "现在就能跑：日线、现价、指数都有，回测可用。",
    "缺的是财务/基本面字段（PE、PB、营收增速等），深度分析会按「无财务数据」处理并在报告头标注。",
    "想要完整数据：到 tushare.pro 注册 → 个人中心复制 token → 写入：",
    "  <BASE_DIR>/.dsh-invest/tushare.token",
    "保存后无需重启，下一次运行自动改用 Tushare。",
  ].join("\n")
}
