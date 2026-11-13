# dsh-invest — A股多角色投研流水线 + 投研工作台

> DSH（DeepSeek Harness）插件。把「选股 → 消息 → 深度诊断 → 综合决策」做成一条可复用的多角色子代理流水线，
> 并配一个本机网页工作台：一键任务、模型配置、持仓管理、结论记忆、标的档案、明暗主题。

**当前版本：v0.52.0**

---

## 一、这是什么

一套完整的 A 股投研基础设施，分两层：

| 层 | 形态 | 说明 |
|---|---|---|
| **invest_run 工具** | 对话内 | 4–5 个角色子代理接力分析，每个角色自己调 Tushare 实时取数，产出逐层传递 |
| **投研工作台** | 本机网页 | 一键任务、模型配置、持仓导入、结论链、标的档案、主题切换 |

两层共用同一套**数据层**（SQLite + JSON 投影）与**脚本层**（Tushare 取数、实时行情、持仓账本、SVG 图表）。

```
用户提问 / 网页一键任务
   └─ invest_run 流水线
        ├─ ① 选股分析师          全市场扫描 / 指定个股 / 多标的对比 → 候选名单+交易计划
        ├─ ② 市场重点消息获取师    消息面收集 + 可信度核验
        ├─ ③ 股票深度分析师        六维诊断 + L1-L4 目标价 + 分级止损 + 九转序列 + MACD 背离
        ├─ ④ 总判断师             综合上游 → 最终投资决策
        └─ ⑤ 波段池管理师          中长周期（3周-6个月）建池与跟踪
```

---

## 二、能力总览

| 能力 | 入口 | 状态 |
|---|---|---|
| 7 种运行模式（个股/选股/消息/深度分析/总判断/all/波段池） | invest_run | ✅ |
| 7 个一键任务模板（含每日观察仓日检） | 工作台 | ✅ |
| 任务隔离执行（不污染对话上下文） | 工作台 | ✅ |
| 模型配置（按角色 + 按模板） | 工作台 / invest_config | ✅ |
| 持仓管理（截图 / 东财CSV / 手动 四入口） | 工作台 | ✅ |
| 结论链（历史注入 + 差异分析） | 工作台 / 流水线 | ✅ |
| 标的档案（股票名索引，198/233） | 工作台 | ✅ |
| 个股分析知识库（报告按股票切段归集 + 首字母索引） | 工作台 | ✅ |
| 股票名输入（代码或名称） | 工作台 | ✅ |
| 明暗主题手动切换 | 工作台 | ✅ |
| SVG 图表（走势图 + MACD 背离） | 流水线 | ✅ |
| 报告统一归档 | 流水线 | ✅ |

---

## 三、invest_run 工具

### 3.1 流水线角色

| # | 角色 | 职责 | 默认模型（balanced） |
|---|---|---|---|
| ① | 选股分析师 | 全市场海选、指定个股、多标的对比 → 候选+交易计划 | deepseek-flash @low |
| ② | 市场重点消息获取师 | 消息面收集 + 可信度核验 | deepseek-flash @low |
| ③ | 股票深度分析师 | 六维诊断、L1-L4 目标价、分级止损、九转、MACD 背离 | deepseek-v4-pro @high |
| ④ | 总判断师 | 综合上游 → 最终决策 | glm-5.3 @max（回退 v4-pro@max） |
| ⑤ | 波段池管理师 | 3周-6个月建池与跟踪（持仓≤4只、可空仓） | 继承宿主 |

### 3.2 运行模式（7 种）

| mode | 作用 | 默认角色 |
|---|---|---|
| `个股` | 单只/两只个股深度分析（最常用） | 深度 |
| `选股` | 全市场海选、短线强势股推荐 | 选股 |
| `消息` | 消息面收集 | 消息 |
| `深度分析` | 选股初筛 + 深度逐只 | 选股 → 深度 |
| `总判断` | 基于已有盘面给综合决策 | 总判断 |
| `all` | 完整流水线（选股∥消息 → 深度 → 总判断） | 全部 |
| `波段池` | 中长周期建池/跟踪 | 波段 |

### 3.3 参数

```ts
invest_run({
  mode: "个股",                    // 必填：7 种模式之一
  question: "分析 600519 贵州茅台", // 必填：投研问题（可多只）
  roles: ["深度","总判断"],         // 可选：自定义角色组合
  context: "上一轮结论…",           // 可选：记忆与追问
  routes: { "总判断": "zai-coding-cn/glm-5.3@max" }, // 可选：按角色覆盖模型
  preset: "inherit",               // 可选：inherit/fast/budget/balanced/deepseek-only/quality
  detail: "summary",               // 可选：summary（省 token）/ full（全量）
})
```

### 3.4 模型路由（4 层配置，后者覆盖前者）

1. **插件 config**（`cordis.patch.yml` 的 `config.routes`）
2. **工作区文件** `.dsh-invest/routes.json`
3. **环境变量** `DSH_INVEST_ROUTES` / `DSH_INVEST_PRESET`
4. **单次调用** `routes` / `preset`

值格式 `provider/model@effort`，`|` 写备选链，写 `inherit` 表示继承宿主。
任一环不可用 → 静默回退继承宿主并标注，**流水线不会整体失败**。

---

## 四、投研工作台（网页端）

### 4.1 地址与启动

**在 DSH 里直接用（v0.49.0 起，推荐）**：重启并刷新 DSH 后，左侧栏会多一个**「投研工作台」**图标，
点一下主面板就是工作台，不必再手输地址。面板顶部有「刷新」与「新窗口」两个按钮
（并排看盘时用新窗口）。

机制（DSH 原生 slot 契约，非自创）：往 `sidebar.panellist`（list, root）注册图标入口
（`id` / `order` / `label`），再用**同一个 id** 往布局的 `main`（keyed, root）注册面板组件。
`main` 除了保留键 `conversation` 外不绑 Session，所以工作台是全局页而不是会话页。
我们包在 `dsh.client.inject` 里声明依赖 `dsh-client-ui-sidebar` 与 `dsh-client-ui-layout`，
保证这两个 slot 的声明先于我们到达；旧版 DSH 没有这两个 seat 时静默跳过，不影响工具卡片。

**直接开浏览器（仍然可用）**：

```
http://127.0.0.1:<DSH端口>/dsh-invest/app
```

- 仅 loopback（`isLoopbackRequest` 守卫），未做公网/多用户/自动下单。
- 前端产物 `dist/index.html + workbench.js + workbench.css`，插件**每次请求实时读取**（`no-store`），
  改前端后 `pnpm build` 即生效，**无需重启**；改插件 JS 需重启。
- 工作台路由未设 `X-Frame-Options`/CSP，因此可被同源 iframe 内嵌。

### 4.2 一键任务（7 模板）

| 模板 | 名称 | 流程 | 预设 | 需代码 |
|---|---|---|---|---|
| `stock-review` | 个股体检 | 消息 → 深度 → 总判断 | inherit | 是 |
| `stock-quick` | 个股快诊 | 深度 → 总判断 | fast | 是 |
| `portfolio-review` | 组合体检 | 消息 → 深度 → 总判断 | inherit | 否 |
| `morning-news` | 早盘异动 | 消息 → 选股 | fast | 否 |
| `swing-weekly` | 波段周检 | 波段 → 总判断 | inherit | 否 |
| `watch-daily` | 观察仓日检 | 深度 → 总判断（每日自动） | balanced | 否 |
| `market-screen-full` | 海选·全流程 | 选股 → 消息 → 深度 → 总判断 | balanced | 否 |

- **观察仓日检（`watch-daily`）**：针对标的档案里 `state=观察` 的标的，**开机补跑 + 每天 `at`（默认 15:10）收盘后各跑一次**（各自每天一次，工作日闸；节假日靠"没有新日线"自然降级）。两层执行：规则层先刷新观察仓现价并比对买区/失效价（免 token），**只有进入买区或跌破失效价的标的**才入队 LLM 判断，其余只留提醒。开关、定时时刻与上次结果存 `.dsh-invest/store/watch-daily.json`，工作台一键任务页顶部常驻状态条可开关/改时刻/立即运行。
- 任务进入内存队列**最多并发 2**（超出排队），页面轮询进度，完成后自动重建索引。
- 支持浏览器通知（任务完成提醒）。
- `portfolio-review` / `morning-news` / `swing-weekly` 的 question 会注入当前持仓账本摘要。

### 4.3 任务隔离执行（方案 A）

**问题**：网页任务若挂在当前对话的 Agent 下，会让任务子代理污染对话上下文、并与对话抢模型额度。

**方案**：每个网页任务用 `agents.create({sessionId, agentOptions})` 创建**专用执行 Agent**：

- 分析子代理挂在专用 Agent 下，**不进对话** → 对话 0 污染、上下文不膨胀；
- 专用 Agent 会话补 `sandbox/mode = danger-full-access`（同对话会话），子代理可**写文件/起终端**
  （Tushare 取数、SVG 图表、报告归档全部正常）；
- 任务完成即 `dispose`，不残留；
- 创建失败自动**回退顶层 Agent**（旧路径，不阻断）。

> 实测：任务启动后对话会话的 `subagent/*` 事件 = 0，且 Tushare/报告/结论全部正常。

### 4.4 模型配置

工作台「模型」页：**按角色** + **按模板** 两处配置，写入 `.dsh-invest/routes.json` 与 `.dsh-invest/settings.json`（立即生效）。

- 角色：选股/消息/深度/总判断/波段，各选 provider/model/effort；
- 模板：6 个模板各选预设（inherit/fast/budget/balanced/deepseek-only/quality）；
- 优先级：**单次请求 > 模板预设 > 角色显式配置 > 全局预设 > 继承宿主**；
- 写文件经 `sandboxPolicy.resolve` 拿策略，避免「file access denied」。

### 4.5 持仓管理（四入口，全部「草稿 → 差异 → 手动确认 → 写入」）

| 入口 | 说明 |
|---|---|
| 截图上传 | 多模态模型识别持仓截图（原图不留档）；**任务运行中禁用**并提示 |
| 东财 CSV | 交割单自动解析成交流水，生成持仓+现金（支持 ETF） |
| 手动编辑 | 行内改股数/成本/止损，提交生成草稿 |
| 手动新增 | 加一条持仓 |

- 草稿不落库；确认时展示 **added / removed / modified / unchanged** 差异与 warnings，再写 `.dsh-invest/持仓.json`。
- 账本为跨会话唯一真相，流水线每次自动注入摘要。
- 截图入口在**有任务 queued/running 时**返回 409「分析任务进行中，模型暂不可用，请稍后再导入截图」。

### 4.6 结论链

- 每次流水线末尾强制输出 `【结论结构化】{"code","stance","target","stop","thesis","invalidate_if"}`。
- 落 `.dsh-invest/conclusions.jsonl` + SQLite `records` 表。
- 同一标的再次分析时，自动注入上次结论/目标/止损/失效条件，并要求说明本次变化。

### 4.7 标的档案（股票名索引 + 双向同步）

- 索引 `index.codes` 每个标的带 `name`：优先取持仓账本，再取腾讯行情分批补全，缓存到 `store/names.json`。
- 当前 **198/233** 个标的已有名称，档案列表显示「名称 + 代码」。
- 个股体检/快诊输入框支持**代码或股票名**：`GET /api/stock/resolve?query=贵州茅台` → `{code:"600519.SH", name:"贵州茅台", found:true}`。

**双向同步**（2026-11-11 补齐）：持仓账本是资金事实，标的档案是监控视图，两边任一改动都会回写另一边。

| 方向 | 触发点 | 行为 |
|---|---|---|
| 账本 → 档案 | 确认持仓 / 刷新持仓现价 / 刷新观察仓现价 / 观察仓日检 | 新票自动建「持有」档案；消失的「持有」转「已清仓」；重新买入的「已清仓」回到「持有」；股数/成本/现价回写 |
| 档案 → 账本 | `POST /watchlist/update`（改状态、填股数成本） | `已清仓` → 从账本移除；`持有` → 按档案股数/成本 upsert；`观察/已移除` 不动账本，只回提示 |

- 档案 → 账本的写入与「确认持仓」同口径：**先备份**（`store/backups/持仓_*_watch.json`）、**再落盘**、**追加审计**（`holdings_audit.jsonl` 的 `watch-sync` 行）。
- 账本空壳（无 `updated_at`）时跳过对账，避免把全部「持有」档案误判成已清仓。
- 反击入口在档案编辑表单的「持有期规则」：填成本/股数 + 状态切「持有」＝建仓；状态切「已清仓」＝卖出清账。

### 4.8 主题切换

- 顶栏月亮/太阳按钮，`.theme-light` 完整浅色配色（白底卡片、柔和阴影、浅边框、深灰文字）。
- localStorage `workbench-theme` 持久化；默认跟随系统 `prefers-color-scheme`，手动切换后以手动为准。
- 首屏内联脚本防闪烁。

### 4.9 个股知识库（报告按股票归集 + 二次整理 + 直接追问）

「个股知识库」页左侧是**按股票名排序**的清单（拼音首字母分组可折叠 + 右缘 A-Z 索引），
右侧是**追问工作区**，整理稿收在右上角入口里，点开即放大查看（v0.52.0 起的布局）。

- **左侧高亮在管标的（v0.52.0）**：读「标的档案」的 watchlist，状态为「持有」/「观察」的标的在索引里
  加左侧色条 + 文字标签（绿=持有、琥珀=观察），左栏汇总显示「在管 N 只」；已清仓/已移除不打标。
  watchlist 未加载时安静跳过，加载完成后重绘即可出现。
- **右侧以追问为主体（v0.52.0）**：整理稿不再内联占据半屏，改到右上角与「重新整理」并排的
  「知识库」按钮，点击后在阅读器弹层放大显示全文；页面里留一行说明告诉用户去哪看。
  同时去掉「原始记录」折叠栏（摘要信息对判断没有增量）。追问区改为 flex 撑满剩余高度，
  输入框固定在底部。

- **生成期定格式**：提示词模板 `KB_MARK` 要求每个角色把个股内容包进 `<!--stock:600519.SH|贵州茅台-->` … `<!--/stock-->`，
  二次总结需原样保留标记；正文渲染时标记行自动隐藏。
- **归因三级**：① 显式标记 → ② 含代码的小标题（`## 股票深度分析：华能国际（600011.SH）`）→ ③ 行级提及节选（历史报告）。
  主报告被总结抹掉标记时，回退 `reports/_raw/<同名>.md` 详版找回分段。
- **二次整理**：新分析入库后调用 `opencode-go/deepseek-v4.1-flash@low`（可在「模型设置 → 知识库整理」用下拉改模型/推理强度），
  把「既有整理稿 + 新材料」重写成固定结构：一句话结论 / 核心逻辑 / 关键价位 / 持仓与纪律 / 分歧与变化 / 时间线 / 待核实。
  只记录**真正喂进模型**的段落，剩余的下次继续；结构校验不过就保留上一版并标错误，不毁库。
- **后台自动整理**：启动 20 秒后扫一遍未整理的股票，之后每 10 分钟补一次；**默认 3 只并发**（每只一个子代理，
  可在「模型设置」选 1/2/3/4/6），连续失败 3 次自动冷却 60 秒；默认开启，「模型设置 → 知识库整理」可关闭。
  知识库全文在右上角「知识库」按钮，点开后由阅读器弹层放大显示（沿用报告阅读器，明暗主题都适配）。
- **文件分层**：`store/stocks/<代码>.md` 是整理稿，`store/stocks/<代码>.raw.md` 是原始记录；`store/stocks/_curation.json` 记整理状态与已收录段落。
- **追问**：`POST /api/stock-ask`，线程按 `stock:<代码>` 持久化；知识库没写的会明说「未涉及」，涉及更新之后的行情会提示去跑任务。
- 没有任何个股归属的报告（大盘/组合类）不进知识库，仍在「运行记录」里看报告。

### 4.10 判断质量（回测）与读数须知

「判断质量」页用历史结论验证这套流水线准不准。**数据链路**：每次流水线结束时，各阶段报告末尾的
`【结论结构化】` 行追加写入 `store/conclusions.jsonl`（只追加、从不改写）→ 回测时联 `daily` +
`adj_factor`，以「结论日后第一个交易日收盘」为基准算第 5/20 个交易日前复权收益，超额 = 个股 − 上证同区间。

页面五块：① 数据从哪来（采集审计 + 未进库运行及原因）② 执行率对账 ③ 总体指标 ④ 分组（角色/置信度/立场/月份/市场状态）⑤ 逐条明细（含溯源）。

> **读数须知（S0/S1 纪律）**
>
> 1. **单桶 30 条以下只算记录，不算结论。** 表格 ⚠ 标记即此意；置信区间再宽也是诚实，不是保守。
> 2. **样本多 ≠ 样本独立。** 同一周内的几十条结论共享同一段行情（1 个市场状态下的 N 次抽样），
>    判断「准不准」要跨市场状态看（按市场状态分组），不要只看总数。
> 3. **命中率高于 50% 也可能亏钱**：盈亏比 < 1 时，胜率越高亏得越稳。胜率、盈亏比、单笔期望三者一起看。
> 4. **置信度校准的门槛**：单桶 ≥ 30 条且分布 ≥ 6 周，才允许看「高置信度是否更准」；
>    在此之前「按置信度」分组只作记录。
> 5. **观察类不计入命中率**（它没有方向），但保留在样本里看后续走势。

**多人共享数据（v0.48.0）**：「导出数据」生成单文件 `conclusions-*.jsonl`，发给另一位装了同款插件的朋友，
对方「导入数据」即可合并。规矩只有三条：

1. **只追加不改写**，按 `(callId + code)` 去重，重复导入无副作用；
2. **只交换结论**——文件里不含 token、持仓账本、报告正文；
3. **记得改本机标识**（面板上的输入框），否则「按来源」分组里你会显示成「本机」、对方显示成随机短码。

> 提醒：两人同时间跑，**市场状态维度不会变多**（同一个行情），增量在个股层面与跨实例一致性。
> 别指望靠人多提前跨过 S1 门槛。

---

## 五、数据层

| 存储 | 路径 | 作用 |
|---|---|---|
| SQLite 主库 | `.dsh-invest/store/invest.db` | runs / reports / records / codes / meta |
| 索引投影 | `.dsh-invest/store/index.json` | 服务端读取的 JSON 投影（含 stocks/codes） |
| 名缓存 | `.dsh-invest/store/names.json` | 股票名缓存 |
| 结论事件 | `.dsh-invest/conclusions.jsonl` | 结构化结论日志 |
| 持仓账本 | `.dsh-invest/持仓.json` | 跨会话唯一真相 |
| 运行日志 | `.dsh-invest/runs.jsonl` | 每阶段实际模型、耗时、状态 |
| 图表 | `.dsh-invest/charts/` | 由 `scripts/stockchart.js` 生成的 SVG 与数据 JSON |
| 取数包 | `.dsh-invest/cache/pack/` | `scripts/fetch_pack.js` 落盘的完整原始数据（按标的+日期） |
| 报告归档 | `.dsh-invest/reports/` + `invest-outputs/<时间戳>_<问题>/` | 报告.md + 图表副本 |

索引重建：`python tools/index_store.py`（SQLite + index.json 一次生成）。

---

## 六、API 参考

所有接口仅 loopback 可访问。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-invest/app` | 工作台页面 |
| GET | `/dsh-invest/workbench.js` / `.css` | 前端产物 |
| GET | `/dsh-invest/api/index` | 索引投影 |
| GET | `/dsh-invest/api/holdings` | 持仓账本 |
| GET | `/dsh-invest/api/report` | 报告原文（白名单路径） |
| GET | `/dsh-invest/api/templates` | 7 模板（含生效预设） |
| POST | `/dsh-invest/api/run` | 触发一键任务 |
| GET | `/dsh-invest/api/job` | 单任务详情（进度/结果） |
| GET | `/dsh-invest/api/jobs` | 任务列表 |
| POST | `/dsh-invest/api/reindex` | 重建索引 |
| GET | `/dsh-invest/api/conclusions` | 最近结论 |
| GET | `/dsh-invest/api/watchlist` | 标的档案（观察+持仓）+ 未读提醒 |
| POST | `/dsh-invest/api/watchlist/refresh` | 批量刷新现价 + 比对信号 |
| POST | `/dsh-invest/api/watchlist/update` | 更新监控规则 / 新建档案 |
| GET | `/dsh-invest/api/watch-daily` | 观察仓日检状态（开关/时刻/上次结果） |
| POST | `/dsh-invest/api/watch-daily/settings` | 日检开关 + 收盘后时刻（HH:MM） |
| POST | `/dsh-invest/api/watch-daily/run` | 立即跑一次日检 |
| GET | `/dsh-invest/api/stock-notes` | 个股知识库清单（段数 / 整理状态 / 未并入段数） |
| GET | `/dsh-invest/api/stock-note` | 单只个股的知识库（整理稿 + 整理状态 + 原始记录摘要） |
| POST | `/dsh-invest/api/stock-note/curate` | 触发二次整理（异步，`full` 可全量重写） |
| POST | `/dsh-invest/api/stock-ask` | 就个股知识库追问（线程按股票保存） |
| POST | `/dsh-invest/api/stock-notes/rebuild` | 重建知识库（`?full=1` 全量重解析） |
| GET | `/dsh-invest/api/backtest` | 判断质量回测：结构化结论 × 日线 → 5/20 日命中率与超额；收益按**前复权**（close × adj_factor）计算（v0.44.0 上线，v0.46.0 修口径） |
| GET | `/dsh-invest/api/conclusions-export` | 导出结论单文件 jsonl（首行 `_manifest`，v0.48.0） |
| POST | `/dsh-invest/api/conclusions-import` | 导入他机结论：按 `(callId+code)` 去重、只追加（v0.48.0） |
| POST | `/dsh-invest/api/instance-name` | 修改本机实例显示名（v0.48.0） |
| GET/POST | `/dsh-invest/api/model-settings` | 读/写角色+模板模型配置 |
| POST | `/dsh-invest/api/holdings/import` | CSV/截图/手动 → 草稿 |
| POST | `/dsh-invest/api/holdings/draft` | 手动编辑 → 草稿 |
| POST | `/dsh-invest/api/holdings/confirm` | 确认草稿写入账本 |
| GET | `/dsh-invest/api/stock/resolve` | 代码或股票名 → 代码+名称 |
| GET | `/api/dsh-invest/chart` | SVG 图表（白名单） |
| GET | `/api/dsh-invest/progress` | 任务进度 SSE |

---

## 七、脚本工具

| 脚本 | 用法 | 作用 |
|---|---|---|
| `scripts/tushare_query.py` | `python tushare_query.py <api> k=v …` | Tushare 取数，输出 `{ok,code,msg,fields,rows}` |
| `scripts/realtime_quote.py` | `python realtime_quote.py 600519 000768.SZ` | 腾讯财经实时行情兜底 |
| `scripts/holdings.py` | `sync / list / add / update / remove / set-account` | 持仓账本维护 |
| `scripts/chart.py` | `python chart.py <data.json> <out.svg>` | **通用 SVG 图表生成器**（price 走势图 / macd 背离图） |
| `scripts/fetch_pack.js` | `node fetch_pack.js 600519.SH [天数]` | **一次调用取全套个股数据**，输出单位统一的排版摘要（价格/均线/估值/资金/财务/业绩/龙虎榜/融资/相对强度） |
| `scripts/stockchart.js` | `node stockchart.js 600519.SH [price\|macd\|both] [根数]` | **一条命令出图**：取数 + MA/MACD/九转/关键价位/背离 → SVG，并返回可直接引用的技术面摘要 |
| `tools/cleanup.js` | `node tools/cleanup.js`（预演）/ `--apply`（执行） | **磁盘卫生**：cache / scratch / 根目录临时文件 / 旧备份；默认预演，执行时移入 `.dsh-invest/trash/` 可回滚 |

> 这两个 Node 脚本由仓库 `scripts/` 托管，`node tools/build.js` 时自动同步到 `<BASE_DIR>/scripts/`。
> 设计动机见 CHANGELOG v0.42.0：此前图表数据 JSON（145 天 × 7 数组 ≈ 13 KB）由模型手写，
> 单标的深度分析因此多耗 80–160 秒且存在手算误差；现全部改为确定性计算。

### chart.py 数据格式

```jsonc
// price 型
{ "type":"price", "title":"贵州茅台 600519.SH 2026-08-01~2026-11-04", "code":"600519.SH",
  "dates":["20261104", ...], "close":[...], "ma5":[...], "ma10":[...], "ma20":[...], "ma60":[...],
  "levels":[{"value":1568,"label":"L2止盈"},{"value":1380,"label":"止损"}],
  "nine":[{"index":3,"dir":"sell","count":7}] }

// macd 型
{ "type":"macd", "title":"…", "code":"600519.SH", "dates":[...],
  "dif":[...], "dea":[...], "hist":[...],
  "divergences":[{"index":2,"dir":"top","label":"顶背离"}] }
```

> **重要**：图表必须「先 write 数据 JSON，再 `python chart.py` 短命令生成」。
> 严禁在命令行内联长 SVG/长脚本——长命令会被终端截断（这是历史故障，已在提示词中明令禁止）。

---

## 八、安装与部署

### 常规插件（推荐，一次安装永久生效）

```powershell
cd E:\Dsh_WorkSapce\Dify_Agents\dsh-invest-plugin
powershell -ExecutionPolicy Bypass -File scripts\link-deps.ps1
# 在 profile 的 package.json dependencies 加入 link: 指向 packages/dsh-invest，然后 pnpm install
# 在 profile 的 cordis.patch.yml 追加：
#   - insert:
#       - id: invest
#         name: 'dsh-invest'
dsh --profile web --dump-config   # 应看到 - id: invest / name: dsh-invest
# 重启 DSH
```

### 动态插件（单会话临时）

```powershell
node tools/build.js               # 生成 dist/
# cordis_define：code.host ← dist/invest-run.host.js，code.client ← dist/invest-run.client.js
# cordis_run 激活（Client 半部需 GUI 批准一次）
```

### 前端构建（工作台）

源码在仓库内 `web/`（v0.40.1 起纳入版本管理）；**产物输出到工作区运行目录** `.dsh-invest/web/dist`，
插件从那里实时读取（`cache-control: no-store`），改前端只需重新构建 + 刷新页面，不用重启 DSH。

```powershell
cd web
pnpm install                      # 首次
pnpm build                        # = tsc --noEmit && vite build → ../../.dsh-invest/web/dist/
# 或回到仓库根：pnpm web:build / pnpm web:dev
```

产物路径可用 `DSH_INVEST_BASE_DIR`（工作区）或 `DSH_INVEST_WEB_DIST`（精确到 dist）覆盖。

---

## 九、配置

| 配置项 | 位置 | 说明 |
|---|---|---|
| Tushare token | `.dsh-invest/tushare.token` | 明文单行（**不能带尾随换行**，否则 40101） |
| 角色路由 | `.dsh-invest/routes.json` | `{"深度":"inherit"}`，写 inherit 恢复继承 |
| 模板预设 | `.dsh-invest/settings.json` | `{"templates":{"stock-quick":"fast"}}` |
| 持仓账本 | `.dsh-invest/持仓.json` | 唯一真相 |
| 图表工作区 | `.dsh-invest/charts/` | SVG |
| 行情缓存 | `.dsh-invest/cache/` | 当日有效 |
| 统一输出 | `invest-outputs/` | 每轮 `报告.md` + `图表/` |

> 路径写死在 `packages/dsh-invest/lib/index.js` 顶部常量；迁移机器时全局替换 `E:/Dsh_WorkSapce/Dify_Agents`。

---

## 十、已知限制

- 仅本机（loopback）可用，无公网/多用户/自动交易。
- Tushare `news`/`anns_d`/`research_report` 需更高积分，低积分返回 40203。
- `major_news` 每日 40 次上限。
- 所有指标基于日线收盘，非实时盘中；盘中实时价仅作参考（腾讯兜底）。
- 缓存目录超过 30 天的文件自动清理（宿主 fs 不支持删除则静默跳过）。
- 图表需要在报告中引用完整绝对路径（提示词已强制）。

> **⚠ 命名硬约束（v0.49.2 踩过，别再踩）**：下面三个名字**必须完全一致**，否则客户端半部静默不加载——
> 右侧栏图标、工具卡片都不会出现，且**没有任何报错提示**（包被判定为「不是客户端包」）。
>
> | 位置 | 当前值 |
> |---|---|
> | `cordis.patch.yml` 的 Loader 行名 | `dsh-invest` |
> | `packages/dsh-invest/package.json` 的 `name` | `dsh-invest` |
> | `lib/client.js` 里 `__ModuleLoader__.load({ id })` | `dsh-invest` |
>
> 原因：`dsh-client-modules` 的 `resolveMeta()` 用 Loader 行名推出期望包名，
> `nearestPackage()` 向上找 `package.json` 并要求 `name` **严格相等**；不等则返回 `undefined`，
> `pkg.dsh.client` 根本不会被读取。`test/client-bundle.test.js` 已把三者一致性写成断言。

---

## 十一、更新与升级（v0.51.0）

**DSH 没有插件自动更新**：宿主半部是进程内加载的，**任何更新都必须重启 DSH 才生效**。
因此这里只把「发现」和「执行」两步做顺，不做假装的热更新。

### 11.1 从 GitHub 源安装（推荐，更新只需一条命令）

```bash
dsh plugin --profile web add "github:Pikapiku09/dsh-invest-plugin#main&path:/packages/dsh-invest"
```

之后每次更新：

```bash
dsh plugin --profile web update dsh-invest
```

`#main` 让 pnpm 跟踪分支最新提交（锁文件里记录的是具体 commit，`update` 会重新解析）。
比「本地 clone + `link:`」省事：不用找目录、不用 `git pull`。

### 11.2 本地克隆安装（开发用）

```bash
dsh plugin --profile web add "link:<仓库路径>/packages/dsh-invest"
```

更新 = 在仓库里 `git pull`，再 `dsh plugin --profile web install`，然后重启。

### 11.3 更新流程（v0.51.0 定稿）

界面上两条触发路径，**都不自动跳转、不自动执行任何写操作**：

| 时机 | 行为 |
| --- | --- |
| **启动 DSH**（每次） | 静默查一次远端版本，30 分钟内存缓存，失败**静默**。有新版本只在左上角挂红点，**不弹窗** |
| 首次见到某个新版本 | 启动 1.5 秒后弹一次「发现新版本」询问；点「稍后再说」后该版本不再主动问，只留红点 |
| **使用中点「检测更新」** | 绕过缓存取实时结果。已是最新 → 明确回一句提示；有新版 → 弹「发现新版本」；网络失败 → 明说失败原因 |

读取远端版本走**双通道**：先 `api.github.com` 的 contents 接口，失败回退 `raw.githubusercontent.com`
（后者在国内网络常被阻断，实测本机直连 `fetch failed`）。两条都断时错误信息会同时给出两层的具体原因。

左上角控件（`vX.Y.Z` 与「检测更新」并排）：

- **红点 + 琥珀色** = 检测到比本机新的版本；
- 点 **版本号** → 随时重看「本次更新」说明（不受「已读」限制）；
- 点 **检测更新** → 立即实时复查。

「发现新版本」弹层里给的是**可复制的更新命令**（按 `link:` / `github:` 安装方式自动匹配），
并写明「更新完成后需重启 DSH」。**没有「一键升级」按钮**，因为 DSH 插件无法在运行中替换自己，
放一个点了没反应的按钮比不给更糟。

**两个弹层都只能由用户显式关闭**（底部按钮 / 右上角 ×）。点遮罩不关，也没有任何定时器 ——
v0.50.0 曾把关闭动作挂在整个遮罩上，用户想看清内容时随手一点就关掉，且同时写入「已读」，
内容就此永久消失；v0.51.0 修掉了。

### 11.4 发版纪律（新增一步）

```bash
node tools/gen-whats-new.js      # 从 CHANGELOG.md 生成 lib/whats-new.json
```

`CHANGELOG.md` 是更新说明的**唯一事实来源**，`lib/whats-new.json` 随包分发（仓库根的 CHANGELOG
不在 `files` 里，装到别处读不到）。**改了版本号必须重新生成**，否则
`test/update-check.test.js` 会因 `whats-new.latest !== package.json.version` 而失败。

生成器两条排版规则（防「说明读起来像机器拼的」）：中文折行直接相连、不补空格（否则会出现
「内容时 随手一点」这种断词）；单条要点超过 220 字在句号处收口，不在句中硬截。

---

## 十二、版本与变更

见 [CHANGELOG.md](CHANGELOG.md)。当前 **v0.52.0**（个股知识库改版：在管标的高亮 + 追问为主体 + 知识库放大层）。

> **维护约定（勿跳过）**：版本号只有一个事实来源 —— `packages/dsh-invest/package.json`。
> 每次发版必须同步：① 根 `package.json` 与 `package-lock.json`；② 本文件顶部「当前版本」与本节摘要；
> ③ `CHANGELOG.md` 新条目；④ **改了版本号必须重跑 `npm --prefix web run build`**——工作台左上角的版本徽标
> 是构建期从 `packages/dsh-invest/package.json` 注入的，不重建就还是旧号（v0.44.0 实测踩到）。
> `test/version-sync.test.js` 会硬校验 ①–③，任何一处漏改都会让 `node --test` 失败；④ 需人工确认。

---

## 免责声明

本插件输出的所有分析内容仅供参考，不构成任何投资建议。投资有风险，入市需谨慎。
