// 「悟道」条目库：纯逻辑（无 I/O、无 ctx）
//
// 为什么单独成模块：这些条目每次投研运行都会拼进 prompt，选错条、拼脏字、超预算
// 都会直接影响模型输出，规则必须能被单测钉住；文件读写留在 index.js（那里才有 fs 服务），
// 这里只负责数据形状、排序、预算与提示词拼装。
const DAO_VERSION = 1
// 条目类型：纪律（必须遵守）/ 反思（我犯过的错）/ 复盘（一次交易的得失）/ 心得（一般认知）
const DAO_KINDS = ["纪律", "反思", "复盘", "心得"]
// 归属角色 + 通用；空 tags 等价于通用，即注入所有分析师
const DAO_ROLES = ["选股", "消息", "深度", "总判断", "波段", "通用"]
const DAO_MAX_ITEMS = 200
const DAO_ITEM_MAX_CHARS = 4000
// 注入时单条正文摘要长度：条目原文可能很长，注入只取能勾住模型记忆的那一段
const DAO_ITEM_IN_BLOCK_CHARS = 160
const DAO_INJECT_MAX_ITEMS = 8
const DAO_INJECT_MAX_CHARS = 1200

const z2 = (n) => String(n).padStart(2, "0")
const nowIso = () => new Date().toISOString()

// 展示用本地日期：时间是 ISO（UTC），但用户看到的日子应当是本地日历日
const localDate = (iso) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso || "").slice(0, 10)
  return d.getFullYear() + "-" + z2(d.getMonth() + 1) + "-" + z2(d.getDate())
}

const trimText = (v, max) => {
  const text = String(v == null ? "" : v).replace(/\r\n/g, "\n").trim()
  return max && text.length > max ? text.slice(0, max) : text
}

const normalizeTags = (tags) => {
  const list = Array.isArray(tags) ? tags : []
  const out = []
  for (const raw of list) {
    const tag = trimText(raw, 8)
    if (DAO_ROLES.includes(tag) && !out.includes(tag)) out.push(tag)
  }
  // 通用就是「注入所有角色」，再挂具体角色没有额外含义，收敛成单标签更不容易误读
  if (out.includes("通用")) return ["通用"]
  return out.slice(0, 3)
}

const newId = () => "dao_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)

// 归一化时不想把老条目的时间刷成「刚刚」，所以 keepTimes 单独一条路径
const buildItem = (input, now, existing, keepTimes) => {
  const src = input && typeof input === "object" ? input : {}
  const body = trimText(src.body, DAO_ITEM_MAX_CHARS)
  if (!body) throw new Error("条目正文不能为空")
  const title = trimText(src.title, 60) || body.slice(0, 20)
  const kind = DAO_KINDS.includes(src.kind) ? src.kind : "心得"
  const tags = normalizeTags(src.tags)
  const createdAt = keepTimes && trimText(src.created_at, 40) ? trimText(src.created_at, 40) : (existing && existing.created_at) || now
  const updatedAt = keepTimes && trimText(src.updated_at, 40) ? trimText(src.updated_at, 40) : now
  return {
    id: (keepTimes && trimText(src.id, 60)) || (existing && existing.id) || newId(),
    title,
    body,
    kind,
    tags,
    pinned: src.pinned === true,
    source: src.source === "chat" ? "chat" : "manual",
    persona: trimText(src.persona, 20),
    created_at: createdAt,
    updated_at: updatedAt,
  }
}

const sortItems = (items) => items.slice().sort((a, b) => {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  const byUpdated = String(b.updated_at || "").localeCompare(String(a.updated_at || ""))
  if (byUpdated !== 0) return byUpdated
  return String(b.created_at || "").localeCompare(String(a.created_at || ""))
})

// 脏文件（手工改坏、写到一半）不该让页面打不开：丢掉坏条目，保留能救的
const normalizeDaoStore = (raw) => {
  const now = nowIso()
  const src = raw && typeof raw === "object" ? raw : {}
  const seen = new Set()
  const items = []
  for (const it of Array.isArray(src.items) ? src.items : []) {
    try {
      const item = buildItem(it, now, null, true)
      if (seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
    } catch (e) { /* 缺正文的条目直接跳过 */ }
  }
  return {
    version: DAO_VERSION,
    updated_at: trimText(src.updated_at, 40) || (items[0] && items[0].updated_at) || "",
    items: sortItems(items),
  }
}

const sanitizeDaoItem = (input, opts) => {
  const o = opts || {}
  const now = o.now || nowIso()
  return buildItem(input, now, o.existing || null, false)
}

const upsertDaoItem = (store, input, now) => {
  const base = normalizeDaoStore(store)
  const stamp = now || nowIso()
  const id = trimText(input && input.id, 60)
  const existing = id ? base.items.find((item) => item.id === id) : null
  if (id && !existing) throw new Error("条目不存在或已被删除，刷新页面后再试")
  const item = sanitizeDaoItem(Object.assign({}, input, { id: id || undefined }), { now: stamp, existing })
  const items = existing ? base.items.map((one) => (one.id === item.id ? item : one)) : [item].concat(base.items)
  if (items.length > DAO_MAX_ITEMS) throw new Error("条目已达上限 " + DAO_MAX_ITEMS + " 条，先删掉不再适用的再新增")
  return { store: { version: DAO_VERSION, updated_at: stamp, items: sortItems(items) }, item }
}

const deleteDaoItem = (store, id) => {
  const base = normalizeDaoStore(store)
  const target = trimText(id, 60)
  const items = base.items.filter((item) => item.id !== target)
  const removed = base.items.length - items.length
  return { store: { version: DAO_VERSION, updated_at: removed ? nowIso() : base.updated_at, items }, removed }
}

// 命中规则：没打标签 / 标了通用 / 标了该角色；置顶与最近更新已在 normalize 时排好
const selectDaoEntries = (store, role, opts) => {
  const o = opts || {}
  const maxItems = o.maxItems || DAO_INJECT_MAX_ITEMS
  const maxChars = o.maxChars || DAO_INJECT_MAX_CHARS
  const target = trimText(role, 12)
  const matched = normalizeDaoStore(store).items.filter((item) => {
    if (!item.tags.length) return true
    return item.tags.includes("通用") || (target ? item.tags.includes(target) : false)
  })
  const picked = []
  let used = 0
  for (const item of matched) {
    if (picked.length >= maxItems) break
    const cost = String(item.title || "").length + Math.min(String(item.body || "").length, DAO_ITEM_IN_BLOCK_CHARS) + 24
    // 第一条无条件收（哪怕超预算），之后严格按预算截断：宁可少一条，也不把前一条砍半
    if (picked.length && used + cost > maxChars) break
    picked.push(item)
    used += cost
  }
  return picked
}

const buildDaoBlock = (entries, role) => {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : []
  if (!list.length) return ""
  const title = "【我的悟道·交易纪律（用户长期沉淀，逐条对照，不得违反取数铁律与工具红线）】"
  const meta = "（命中角色「" + (trimText(role, 12) || "通用") + "」，共 " + list.length + " 条 ｜ 按置顶与最近更新排序）"
  const lines = list.map((item, i) => {
    const flag = item.pinned ? "·置顶" : ""
    const digest = String(item.body || "").replace(/\s*\n+\s*/g, " ").slice(0, DAO_ITEM_IN_BLOCK_CHARS)
    return (i + 1) + ". [" + item.kind + flag + "] " + item.title + " —— " + localDate(item.updated_at) + "\n   " + digest
  })
  return [title, meta].concat(lines).concat(["如与本次行情数据或事实冲突，以数据为准，但必须在结论里点出这处冲突。"]).join("\n")
}

// 一次运行要按本次角色各拼一份；放在纯层是为了让「角色 → 注入内容」能被单测钉住
const buildDaoBlocks = (store, roles) => {
  const blocks = {}
  const counts = {}
  for (const role of Array.isArray(roles) ? roles : []) {
    const picked = selectDaoEntries(store, role)
    blocks[role] = buildDaoBlock(picked, role)
    counts[role] = picked.length
  }
  return { blocks, counts }
}

const daoStats = (store) => {
  const items = normalizeDaoStore(store).items
  const byRole = {}
  const byKind = {}
  for (const item of items) {
    const roles = item.tags.length ? item.tags : ["通用"]
    for (const role of roles) byRole[role] = (byRole[role] || 0) + 1
    byKind[item.kind] = (byKind[item.kind] || 0) + 1
  }
  return { total: items.length, pinned: items.filter((item) => item.pinned).length, byRole, byKind }
}

const briefEntries = (entries, maxChars) => {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : []
  if (!list.length) return ""
  const budget = maxChars || 2000
  const lines = []
  let used = 0
  for (const item of list) {
    const line = "- [" + item.kind + "] " + item.title + "：" + String(item.body || "").replace(/\s*\n+\s*/g, " ").slice(0, 140)
    if (used + line.length > budget) break
    lines.push(line)
    used += line.length
  }
  return lines.join("\n")
}

const DAO_COACH_LABEL = "悟道教练"

// 固定回答准则：优先用 prompts/dao-coach.md（或 .dsh-invest/dao-coach.md 覆盖），
// 文件读不到时用这段精简版兜底——任何安装形态下，悟道都得有稳定的说话方式。
// 没有这一段，模型会本能地把「知道的都摆出来」：小标题、要点列表、三列大表，
// 看着全面，实际上把判断稀释掉了。
const DEFAULT_COACH_GUIDE = [
  "① 结论先行：第一行就是判断，加粗；不写开场白、不复述问题。",
  "② 一条回答只讲一件事：最多三条依据，每条一句话。",
  "③ 最后给一条今天就能执行的动作，写清动作、时点、触发条件。",
  "④ 不罗列、不堆要点；表格只在两个以上对象需要多维度对比时用，最多 3 列、最多一张，表后必须有自己的结论。",
  "⑤ 引用用户自己的条目原文（加引号）指出冲突，不要泛泛说「你之前也说过」。",
  "⑥ 默认 400 字以内；不确定就说不确定，并说明还缺什么信息。",
].join("\n")

// 对话人格：不复用分析型 persona（P_DEEP 那些含取数铁律、工具约定、输出模板，
// 拿来聊天会一直要求「先跑取数脚本」，把对话带成流水线）
const buildCoachPrompt = (opts) => {
  const o = opts || {}
  const personaName = trimText(o.personaName, 20) || DAO_COACH_LABEL
  const isCoach = personaName === DAO_COACH_LABEL
  // 角色简码与显示名不一定同形（市场重点消息获取师 / 总判断师），由调用方显式给，别靠截字符串
  const role = isCoach ? "" : (trimText(o.personaRole, 12) || personaName)
  const guide = trimText(o.guide, 6000) || DEFAULT_COACH_GUIDE
  const history = (Array.isArray(o.messages) ? o.messages : []).slice(-8)
    .map((turn) => (turn && turn.role === "assistant" ? "助手：" : "我：") + trimText(turn && turn.text, 1200))
    .join("\n")
  const entries = briefEntries(o.entries, 2000)
  const identity = isCoach
    ? "你是「悟道」交易教练，陪用户复盘交易认知与纪律。你的价值是把模糊的感受逼成可执行的动作，不是替用户选股。"
    : "你是「悟道」里的" + personaName + "，以" + role + "的视角与用户聊交易心得，只谈方法论、纪律与复盘；涉及具体标的只讲判断框架，不给点位。"
  return [
    identity,
    "硬约束：① 只依据用户说的事实与下面的「我的悟道条目」，不编造行情、财报、消息；② 不确定就直说不确定，并说明需要什么信息；③ 不调用任何工具，不联网取数。",
    "【回答准则】（优先级高于任何默认文风）\n" + guide,
    entries ? "【我的悟道条目（用户沉淀，可引用）】\n" + entries : "",
    history ? "【对话历史】\n" + history : "",
    "【本轮问题】" + trimText(o.question, 1500),
  ].filter(Boolean).join("\n\n")
}

const buildDistillPrompt = (opts) => {
  const o = opts || {}
  const personaName = trimText(o.personaName, 20) || DAO_COACH_LABEL
  const turns = (Array.isArray(o.messages) ? o.messages : []).slice(-6)
    .map((turn) => (turn && turn.role === "assistant" ? "助手：" : "我：") + trimText(turn && turn.text, 1500))
    .join("\n\n")
  return [
    "请把下面这段对话里最值得复用的一条经验，提炼成一条「悟道」条目，只输出 JSON，不要任何解释或代码块。",
    '格式：{"title":"不超过 24 字","body":"不超过 300 字，第一人称，写清触发条件与具体做法","kind":"纪律或反思或复盘或心得","tags":["深度"]}',
    "tags 从 选股/消息/深度/总判断/波段/通用 里选，最多 2 个；与具体角色无关就填 通用。",
    "【对话（来源人格：" + personaName + "）】\n" + turns,
  ].filter(Boolean).join("\n\n")
}

// 模型很爱在 JSON 外面裹一句「好的，这是提炼结果：」甚至 ```json 代码块，
// 这里只认第一个 { 到最后一个 }，解析失败交给调用方降级成原文草稿
const parseDistillJson = (text) => {
  const s = String(text || "")
  const start = s.indexOf("{")
  const end = s.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(s.slice(start, end + 1))
    if (!obj || typeof obj !== "object") return null
    return {
      title: trimText(obj.title, 60),
      body: trimText(obj.body, DAO_ITEM_MAX_CHARS),
      kind: DAO_KINDS.includes(obj.kind) ? obj.kind : "心得",
      tags: normalizeTags(obj.tags),
    }
  } catch (e) { return null }
}

const draftFromText = (text) => {
  const body = trimText(text, DAO_ITEM_MAX_CHARS)
  if (!body) return null
  const first = body.split("\n").map((line) => line.replace(/^[#>*\-\s]+/, "").trim()).filter(Boolean)[0] || body
  return { title: first.slice(0, 24), body, kind: "心得", tags: [] }
}

export {
  DAO_VERSION, DAO_KINDS, DAO_ROLES, DAO_MAX_ITEMS, DAO_ITEM_MAX_CHARS,
  DAO_ITEM_IN_BLOCK_CHARS, DAO_INJECT_MAX_ITEMS, DAO_INJECT_MAX_CHARS,
  DAO_COACH_LABEL,
  normalizeDaoStore, sanitizeDaoItem, upsertDaoItem, deleteDaoItem,
  selectDaoEntries, buildDaoBlock, buildDaoBlocks, daoStats,
  briefEntries, buildCoachPrompt, buildDistillPrompt, parseDistillJson, draftFromText, localDate,
}
