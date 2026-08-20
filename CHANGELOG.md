# Changelog

本文件记录 dsh-invest-plugin 的版本演进（与 DSH 会话内动态插件 invt-11 的包版本对应）。

## v0.14.1（2026-08-20）

- **client fetch 超时**：图表/进度请求加 `AbortController` 10s 超时，图表超时显示「图表加载超时」而非无限等待（常规形态浏览器 fetch；动态形态 `host.call` 走 Cordis RPC 自身机制，不变）
- **分节优先 meta.stages**：卡片分节优先用 tool-private `meta.stages` 构造（阶段名/顺序/文本可信），旧调用无 meta 时回退到 render 文本 `=== 阶段名 ===` 正则切分——阶段名含特殊字符或文本被截断不再导致分节错位
- **ROLE_MAP/DEFAULT_ROLES 提模块级**：角色定义与默认角色组合改为模块级常量（src 与 packages 同步），execute 不再每次调用重建
- **chart 路由 startsWith 白名单**：`p.startsWith(CHARTS_DIR)` 强校验替代 `indexOf('.dsh-invest')/indexOf('charts')` 弱校验，只有 charts 目录内的 SVG 路径可被读取（动态 `chart-content` 与常规 `/api/dsh-invest/chart` 同步加固）

## v0.14.0（2026-08-20）

- **统一构建消灭源码重复**：新增 `src/lib/pure.js` 纯函数集合（`extractBoth`/`collectCharts`/`buildGroups`/`isLoopbackRequest`/`z2`/`localYmd`/`fmt`/`isSepRow`/`splitBlocks`），`tools/build.js` 一次构建产出四件套——`dist/`（动态形态，PROMPTS+pure 内联）+ `packages/dsh-invest/lib/prompts.js` + `packages/dsh-invest/lib/pure.js`（CJS→ESM 自动转换）；`packages/lib/index.js` 改为 import 共享模块，删除本地重复定义
- **纯函数单元测试**：`test/pure.test.js` 覆盖 8 个纯函数 19 条用例，用 Node 内置 `node:test` 运行（`npm test`），零新增依赖（避免引入 vitest 依赖树被 pnpm supply-chain 策略拦截）
- **结构化运行日志**：每次流水线结束（无论成败）向 `.dsh-invest/runs.jsonl` 追加一行 JSON（时间/mode/问题/阶段成败/各阶段耗时/图表数/报告数/总耗时），`try/finally` 内尽力而为不阻断主流程
- **配置化最小化**：`DSH_INVEST_BASE_DIR` 环境变量覆盖工作区基目录（默认 `E:/Dsh_WorkSapce/Dify_Agents`）；提示词路径改用 `{{BASE_DIR}}` 占位符，Host 运行时替换，token/缓存/图表路径随基目录联动
- **沙箱策略提前解析**：`fs`/`sandboxPolicy`/`policy` 提到 execute `try` 块外，供报告归档与运行日志共用，`outputs`/`allCharts`/`reports` 也提前以支撑 `finally` 日志

## v0.13.1（2026-08-20）

- **修复：阶段子代理无法启动（tools.restrict() 校验失败）**——`toolFilter.deny` 中移除本运行时不存在的工具名（`subagent_report`/`subagent_control`/`cordis_*`），仅保留实际存在的工具，流水线全角色恢复正常
- **新增：开仓强制Checklist 闸门**——「选股分析师（候选硬约束：单票≤25%+止损位）/ 股票深度分析师 / 总判断师」三个角色在给出任何"建议买入/加仓"结论前，必须输出完整 Checklist（仓位/板块/止损/止盈/频率/追高/基本面/心理 8 项）并过闸，任一栏"拒绝"则结论强制为"拒绝买入"；账户类数据只能来自用户提供，严禁编造
- **文档入库**：`docs/` 新增《开仓前强制Checklist》《交易铁律》《月度复盘模板》三份个人交易纪律文档（与闸门同源）
- **修复：行情缓存 key 碰撞**——缓存文件命名由 `<接口>_<ts_code>_<end_date>.json` 改为 `<接口>_<ts_code>_<end_date>_<start_date或na>.json`，避免同一标的同日不同查询区间（如 60 日 vs 120 日）互相覆盖、下游误用错误区间数据
- **修复：报告/输出目录覆盖**——`reports/` 与 `invest-outputs/` 时间戳加秒 + 4 位随机后缀，同一分钟内多次运行不再互相覆盖
- **修复：progressStore 内存泄漏**——execute 主体包 `try/finally`，流水线结束（无论成败）即清理进度条目
- **安全加固**：`.gitignore` 忽略 `*.token` / `.dsh-invest/` / `invest-outputs/`（防 Tushare token 与运行时数据入库）

## v0.13.0（2026-08-17）

- **九转序列（TD Sequential）指标**：深度分析师计算序列计数（收盘价与 4 根前收盘价比较，1-9 计数，9 为衰竭点），报告第 10 节输出序列状态；图表 K 线上下标注计数数字
- **MACD 顶/底背离指标**：对比价格高低点与 MACD 柱/DIF 峰值谷值，检测并标注顶背离/底背离（日期+幅度+级别），纳入评分与风险提示
- **图表强制规范**：每张图必须有标题/图例/坐标说明；走势图必须标注目标止盈价（L1/L2）、止损价、支撑位、阻力位（水平虚线+文字）；每轮至少生成走势图 + 九转序列图 + MACD 背离图
- 反思修复：旧版 holdings_trend.svg 无标题/图例/价位标注，信息传达失败——现由图表规范强制避免
- 工作区清理：.dsh-invest 根下散落脚本/原始数据归入 scratch/；持仓图表补迁移至 invest-outputs

## v0.12.2（2026-08-17）

- **新增 `个股` 模式**：单只/两只个股深度分析只运行「股票深度分析师」一个角色（最省时，2-4 分钟）
- **模式选择规则**：Agent 指引明确按问题类型自动选 mode——
  单股分析→`个股`；消息收集→`消息`；全市场海选/短线推荐→`选股`；多标的对比→`深度分析`；持仓复盘/完整决策→`all`
- README 使用案例修正：单股深度分析不再跑全流程；短线选股场景用全流程

## v0.12.1（2026-08-17）

- **统一对外输出**：每轮分析自动生成 `invest-outputs\<时间戳>_<问题>\`（`报告.md` + `图表\` SVG 副本），历史报告与图片集中可查
- 工作区目录整理：部署脚本归 `deploy/`、调试产物归 `archive/`、文档归 `docs/`（配合 DSH 工作区整理）

## v0.12.0（2026-08-17）

- **常规插件化**：新增 `packages/dsh-invest` 常规 Cordis 插件包（profile bundle 挂载）
  - 安装：`dsh plugin --profile web add link:<本包路径>`，一次安装**所有会话共享**
  - Host：`invest_run` 工具 + `systemPrompt.section` agent 指引（新会话自动知道何时调用）+ `/api/dsh-invest/*` 路由
  - Client：GUI 工具卡片（fetch 走路由，替代动态插件的 host.call）
- **detail 开关**：`summary`（默认，模型侧 2500 字摘要，省 ~70% token）/ `full`（模型侧全量）——GUI 卡片始终显示完整报告
- 完整报告与推理过程经 presentationMeta（tool-private）传递，不占模型 token

## v0.11.0（2026-08-16）

- render 输出紧凑摘要（每阶段 2500 字），完整报告改走 meta 通道（省 token，卡片体验不变）

## v0.10.0（2026-08-16）

- **每个 Agent 输出完整可见**：卡片分阶段标签页（完整报告不截断）+ 💭 推理过程折叠区
- 推理过程（reasoning）提取后经 meta 通道展示并写入归档文件

## v0.9.0（2026-08-16）

- **多标的批量**：问题含多只股票时选股师逐一取数分析、深度师逐只输出 + 对比结论（实测长江电力 vs 中国平安）
- **消息师 end_date 参数加固**：修复"用过期日期取数后宣称数据滞后"的问题（上一轮发现的实测缺陷）
- **卡片 Markdown 表格真实渲染**：展开后表格以原生 `<table>` 显示（表头高亮），其余文本保留 pre-wrap
- **图表点击放大**：点击图表弹出全屏放大层，点击任意处关闭
- **图表数量上限 6 张**：presentationMeta/render 截断，防止卡片过重

## v0.8.2（2026-08-16）

- 修复报告归档被沙箱拒绝：`fs.writeText` 显式携带会话 `sandboxPolicy.resolve({session})`
- 归档失败原因经 `reportError` 字段暴露（不再静默）

## v0.8.0（2026-08-16）

- **选股+消息并行编排**：A 组（选股+消息并行）→ B 组（深度）→ C 组（总判断），all 模式省 2-3 分钟
- **context 记忆追问参数**：传入上一轮结论/追问背景，注入各阶段 prompt 保持口径一致
- **失败分类重试**：权限/频率类错误（40203/无权限/超限等）不再无意义重试，直接标注失败；其余错误保留 1 次重试
- **报告自动归档**：每轮流水线生成 `.dsh-invest/reports/<时间戳>_<问题关键词>.md`（含各阶段报告+图表清单）
- 实测：长江电力 all 模式四阶段全成功、总判断师正确综合三份上游；深度师独立纠偏消息师数据滞后

## v0.7.1（2026-08-16）

- 修复 `progress` RPC 返回 `elapsedMs: undefined` 导致 JSON 克隆失败的问题（仅返回 JSON 安全字段）

## v0.7.0（2026-08-16）

- **交易日锚点缓存**：子代理首次锚定后写入 `cache/last-trade-date.json`，Host 读取后注入后续阶段/运行，跳过重复 `index_daily` 锚定
- **行情响应文件缓存**：`cache/quotes/<接口>_<ts_code>_<end_date>.json`，子代理取数前查缓存、取数后写缓存，跨阶段跨运行复用（命中标注 [缓存命中]）
- **阶段进度实时可见**：`progress` RPC + Client 卡片 2 秒轮询；运行中显示「进行中 x/4：阶段名」+ 已完成阶段耗时徽章
- 顺带修复：图表路径收集挪到文本截断之前（防超长报告图表漏收集）
- 实测：中国平安深度分析第二/第三阶段缓存全套命中，深度师耗时 135s → 94s（-30%）

## v0.6.1（2026-08-16）

- 提示词强制图表路径写完整绝对路径（修复图表收集遗漏）

## v0.6.0（2026-08-16）

- **GUI 图表卡片**（首次 Client 半部）：`tool.call.toolview` 注册 invest_run 专属卡片
  - SVG 图表经 `chart-content` RPC 按需拉取、data URI 内联渲染成图片
  - `presentationMeta` 携带 mode/阶段耗时/图表路径（tool-private，不占模型 token）
  - 折叠卡片：阶段徽章 + 图表图片 + 可展开报告
- render 输出精炼摘要（每阶段 ≤4000 字符）

## v0.5.0（2026-08-16）

- 子代理输出提取纯文本（剥离 reasoning），下游拿干净文本
- 图表路径自动收集（`charts` 数组）
- 输出结构精简（`outputs[].text` 替代嵌套 JSON）

## v0.4.0（2026-08-16）

- 效率纪律：取数脚本合并请求、接口调用次数上限、输出 ≤2500 字
- 全流程耗时 25-35 分钟 → 约 6.8 分钟

## v0.3.0（2026-08-15）

- 全上游传递：总判断师可见选股 + 消息 + 深度三份产出
- 阶段失败自动重试 1 次（带错误上下文）
- 每阶段耗时统计（elapsedMs）

## v0.2.0（2026-08-15）

- 4 角色完整流水线 + 模式路由（选股/消息/深度分析/总判断/all）+ 上游串联

## v0.1.0（2026-08-15）

- 原型：invest_run 工具，选股分析师子代理 + Tushare 实时取数
