# 盘中盯盘 + 定时播报（live-watch）设计

- 日期：2026-11-24
- 状态：已获用户批准（m00181），按 P1→P2→P3 实施
- 涉及：`packages/dsh-invest/lib/index.js`（后端调度 + API）、`web/src/*`（概览页改造）

## 1. 问题

现有系统是**批处理形态**：跑 `invest_run` 流水线 → 出报告。行情快速变化时缺三件事：

1. 没有"现在怎么样了"的即时视图（账本 `current_price` 是最后一次刷新的快照，可能一天前）；
2. 没有盘中主动提醒（`watchlist_alerts` 只在手动"刷新现价"或 15:10 日检时才产生）；
3. 没有"为什么变了"的即时问答（`askReport` 只读某份报告、`askStock` 只读知识库，都不取实时数据、不结合账本）。

## 2. 目标与非目标

**目标**：盘中每 60 秒把「现价 vs 账本计划」的事实差距算出来；触发规则时立即提醒；每 30 分钟给一条播报；bad 级事件可按开关调 LLM 解释。全部落在【概览】页，不新增导航页。

**非目标**：
- 不做自动交易、不给新买卖建议（播报只做**事实对照**，不新造目标价/止损）；
- 不在盘中用实时价算技术指标（MA/量能一律用 TuShare 日线收盘）；
- 不替换 `invest_run` 流水线，只是它的高频补充层。

## 3. 三层架构

| 层 | 触发 | 成本 | 产出 |
|---|---|---|---|
| 规则层 | 盘中每 `intervalSec`（默认 60s） | 0 token；1 次腾讯行情请求 + 小文件写 | `monitor.current_price/change_pct`、`watchlist_alerts.jsonl` 事件、`live-log.jsonl` 时间线 |
| 播报层 | 每 `broadcastEveryMin`（默认 30 分钟）+ 事件 | 0 token，模板渲染 | 一条 `kind:"broadcast"` 日志；前端看板刷新 |
| 解释层（P3） | 用户点「为什么」；或 bad 级事件 + `llmExplain` 开关 | 1 次快模型调用（≤90s） | 3 句以内的事实解释 |

## 4. 开关与三档预设

配置文件：`.dsh-invest/store/live-watch.json`

```json
{
  "version": 1,
  "enabled": false,
  "preset": "标准",
  "intervalSec": 60,
  "broadcastEveryMin": 30,
  "confirmTicks": 2,
  "confirmBandPct": 0.3,
  "llmExplain": false,
  "llmMinLevel": "bad",
  "llmDailyCap": 20,
  "notifyLevel": "bad",
  "sessionOnly": true
}
```

| 预设 | 采集/判定 | 例行播报 | 适用 |
|---|---|---|---|
| 极简 | 120s | 关闭（只播事件） | 上班没空看 |
| **标准（默认）** | **60s** | **30 分钟** | 常规盯盘 |
| 盯盘 | 30s | 15 分钟 | 关键日/事件日 |

选择预设时同步写 `intervalSec`/`broadcastEveryMin`；手工改间隔则 `preset` 记为 `自定义`。

**为什么 60s 不算频繁**：A 股连续竞价 4 小时 = 240 次判定/日，纯 CPU + 1 次合并行情请求（11 只标的 ≈2KB）。打扰频率由播报层决定（默认 8 次/日），与采集频率解耦。

## 5. 盘中纪律

1. **时段闸**：工作日 09:30–11:30 / 13:00–15:00 才自动跑；`sessionOnly` 可关。
2. **节流**：两次 tick 间隔 ≥ `intervalSec`；连续失败 3 次进入 5 分钟退避。
3. **防插针**：`stop`/`invalidate`/`target` 三类信号需连续 `confirmTicks`（默认 2）次成立，或破线幅度 ≥ `confirmBandPct`（默认 0.3%）才落提醒；`buy`/`add`/`trim` 不设门槛（机会类，错过成本更高）。
4. **去重**：沿用 `code|kind|ymd` 当日唯一（`appendAlert` 已有）。
5. **静默**：例行播报不发系统通知；只有事件按 `notifyLevel` 走既有 `dispatchAlertNotifications` 通道（前端 60s 轮询 + 浏览器 Notification）。
6. **懒落盘**：只有现价列表或 `last_signal_key` 真的变化时才重写 `watchlist.json`（原实现每 tick 全量重写 48KB ≈ 11.5MB/日）。
7. **不做技术指标**：盘中价只算偏离度；MA/量能用日线收盘。

## 6. 生效止损：只报事实，不替用户决策

同一标的存在三个止损来源，且互相冲突（例：600118 档案 55.70 / 失效价 54.30 / 最新结论 44.50）：

- `position.stop` —— **执行口径**，`evalWatchSignal` 实际比对的就是它 → 看板「距止损」用它；
- `watch.stop` —— 观察期失效价；
- 最新结论 `stop` —— 分析口径，常与档案不一致。

实现：`eff_stop = position.stop ?? watch.stop`；并列显示最新结论止损及其时间；两者相差 >3% 时在行内打 `⚠` 并在看板顶部列出「止损口径冲突」清单。**不自动合并、不静默改写档案**——合并规则属于用户纪律，不属于代码。

## 7. API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-invest/api/live-watch` | 返回 `{ok, settings, session, snapshot, presets, log}` |
| POST | `/dsh-invest/api/live-watch` | patch 设置（enabled/preset/intervalSec/broadcastEveryMin/llmExplain/notifyLevel），返回同 GET |
| POST | `/dsh-invest/api/live-watch/tick` | 手动立即抓一次（不受 enabled/时段限制），返回 `{ok, skipped, fired, snapshot}` |
| POST | `/dsh-invest/api/live-ask` | `{code?, question?}` → 基于快照 + 最新结论 + 今日事件的 3 句解释 |

`snapshot` 结构：

```json
{
  "asof": "2026-11-24T02:35:00.000Z",
  "session": { "inSession": true, "label": "盘中", "hm": "10:35" },
  "account": { "cash": 22228.91, "market_value": 100501, "total_asset": 104730, "position_pct": 73.2, "float_pnl": -3576, "float_pnl_pct": -3.4 },
  "holdings": [{ "code": "000823.SZ", "name": "超声电子", "price": 20.58, "change_pct": 3.2, "cost": 17.999, "shares": 2200, "pnl_pct": 14.34, "market_value": 45276, "weight_pct": 40.1, "eff_stop": 17.35, "eff_stop_src": "档案", "dist_stop_pct": 18.62, "stop_state": "缓冲 18.6%", "concl_stop": 18.45, "concl_ts": "2026-11-24T02:14:29.180Z", "stop_conflict": true, "signal": null }],
  "watch": [{ "code": "002472.SZ", "name": "双环传动", "price": 28.3, "change_pct": -1.1, "buy_low": 29.5, "buy_high": 31.2, "dist_buy_pct": -4.07, "in_buy_zone": false, "signal": null }],
  "events": [],
  "conflicts": ["600118 档案止损 55.70 与最新结论 44.50 相差 20%"]
}
```

## 8. 概览页改造（增删改查）

```
[看板头] 盘中/收盘 · 10:35 · 总资产/现金/仓位/浮动 · 开关 · 三档 · 立即刷新 · 最后 tick
[止损口径冲突条]（仅有冲突时）
[持仓偏离表] 标的 | 现价 | 今日 | 成本 | 浮盈 | 权重 | 生效止损 | 距止损 | 状态 | 为什么
[观察池]     标的 | 现价 | 今日 | 买入区 | 距买区 | 信号
[盘中时间线] 最近 20 条（播报 + 事件）
[上次分析] [最近运行 ×3]
```

- **删**：行业热力面板（快照从未生成；4 只持仓中 2 只是 ETF 无法归类）。后端 API 与生成脚本保留。
- **改**：`watchPanel` 拆为「持仓偏离表 + 观察池」；原来只显示 `dist_stop_pct` 且无今日涨跌。
- 涨跌色沿用现有 `good/warn/bad` 语义（涨=bad？）→ 统一按 A 股惯例：涨红跌绿，用 `.up`/`.down` 类，不复用语义色类。

## 9. 分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| P1 | `refreshWatchPrices` 补 `prev_close/change_pct`；live-watch 设置/调度/tick/播报/日志；4 个 API | `node --check`；手动 tick 返回 4 只持仓 + 7 只观察；关闭开关时自动 tick 直接跳过且 0 请求 |
| P2 | 概览页看板（表 + 时间线 + 开关 + 三档 + 立即刷新） | `pnpm build` 通过；页面可见现价/涨跌/权重/距止损；热力面板消失 |
| P3 | 「为什么」问答（限流 20 次/日） | 点击返回 3 句以内、含具体数字、不新造价位 |

## 10. 回滚

- 后端：`DSH_INVEST_LIVE_WATCH=0` 关闭调度；或 `live-watch.json.enabled=false`。
- 前端：`renderOverview` 里删掉 `livePanel(state)` 一行即回到旧布局（旧函数保留到验收后）。
- 数据：只新增 `live-watch.json` / `live-log.jsonl`，不改既有 schema（`monitor` 只是多两个字段）。

## 11. 实施记录（2026-11-24，v0.76.0）

实际落点与设计稿的差异，均以代码为准：

| 项 | 设计稿 | 实际实现 | 原因 |
|---|---|---|---|
| 涨跌配色 | `.up` / `.down` | `.live-up` / `.live-down`（`var(--red)` / `var(--green)`） | 仓库没有全局 `.up/.down`，新建前缀类避免误伤其他表 |
| 信号徽章 | 新配色类 | 复用 `.watch-signal` + `.watch-sig-good/bad/info` | 同一个 `kind` 在档案页与概览页必须同色 |
| 调度粒度 | 每档一个定时器 | 单个 15 秒定时器 + `liveTick` 内部按 `intervalSec` 节流 | 切档立即生效，不用重挂 timer |
| 前端刷新 | 未定 | 概览页且已开启时 60 秒 GET 一次（静默失败） | 后端已有数据，前端只取快照；关闭时 0 请求 |
| 时间线容量 | 20 条 | 落盘保留 300 行，看板展示最近 12 条 | 300 行足够回看一天，前端不做长列表 |
| 播报去重 | — | `code|kind|ymd` 由 `appendAlert` 负责；播报本身按 `broadcastEveryMin` 与事件双触发 | 事件至少一条播报，例行播报不重复 |
| `notifyLevel` / `llmExplain` | 开关项 | 已接线：`notifyLevel` 由概览页轮询按门槛推系统通知（只推事件、不推例行播报）；`llmExplain` 在 tick 内对达门槛事件自动生成一句解释写入时间线（kind=`explain`），受 `llmDailyCap` 约束 | 两个开关都属于「开关打开才花钱/才打扰」，默认关闭 |

验收期修复：

| 问题 | 现象 | 根因 | 修法 |
|---|---|---|---|
| 三档预设选不中 | 点「盯盘」后 `preset` 变「自定义」，看板不高亮当前档 | `POST /api/live-watch` 的「手改间隔 → 降级自定义」分支在显式选预设时也会跑，覆盖刚写入的 `preset` | 加 `patch.preset === void 0` 前置条件 |
| 盘中快问配额不消耗 | `llmCount` 永远 0，`llmDailyCap` 形同虚设 | 解释层调 `liveAsk` 已 +1 落盘，但同 tick 末尾 patch 用 tick 开始时的旧值覆盖回去 | 末尾重读设置取 `Math.max` |

验证证据（全部实跑）：

```
node --check packages/dsh-invest/lib/index.js   → 0
web: tsc --noEmit -p tsconfig.json             → 0（strict + noUnusedLocals）
web: vite build                                → 36 modules, workbench.js 258.79 kB, css 116.11 kB
node --test                                    → 271 tests, 271 pass, 0 fail
  其中 test/live-watch-api.test.js             → 11 项：快照口径 / 生效止损 / 结论冲突 / 今日信号 /
                                                 观察池排序 / 三档预设 / 自定义降级 / 越界拒绝 / 环回守卫
GET http://127.0.0.1:3080/dsh-invest/api/live-watch → 401 unauthorized
```

关于 401：这不是插件路由缺失（缺路由会是 404），而是 DSH 自身的 Web 鉴权在 `/` 与所有路径前统一拦截；
`dsh-doc` 的验证规范明确禁止去翻 token / 改浏览器配置，因此接口层改由「仓库标准做法」补测
（fake ctx + 直接调 handler，与 `test/sector-heatmap-api.test.js` 同款），页面呈现留给用户肉眼验收。

未完成项（诚实标注）：

1. **HTTP 层未端到端验证**：DSH 的 401 鉴权拦住本机直连；handler 逻辑已由 11 项测试覆盖，但
   「浏览器里打开概览页 → 点开启 → 看到第一帧」这一步需要在已登录的 GUI 里完成。
2. `monitor.prev_close/change_pct` 依赖腾讯行情字段 4 / 32；字段口径变化时静默降级为 `—`，不报错。
3. 节假日不特判：靠「工作日 + 价格不动」自然降级，法定假日会空跑（0 token，只有行情请求）。

### 11.3 规则层真实行情验收（2026-11-24 11:26，盘中）

不碰真实账本：临时 `BASE_DIR` + 拷贝 `scripts/`（`fetchQuotePrices` 按 `BASE_DIR/scripts/realtime_quote.py`
解析，漏拷会报「实时行情脚本退出码 2」），走同一套 route handler。

```
tick#1  status=200 ok=true skipped=null ms=795  missing_prices=0  session=盘中
行情     000823 19.59 -1.51% | 600118 49.44 +4.19% | 159813 0.537 +2.68% | 510500 6.203 +0.70%
账户     total=114763.31 mv=92534.4 cash=22228.91 pos%=80.63 float=-35
权重     37.55 / 21.54 / 13.43 / 8.11（实时价重算，不用账本旧值）
fired    ["510500.SH|stop|20261124","600118.SH|stop|20261124"]  broadcast=yes
tick#2   fired=[]  broadcast=no   settings ticks=2 events=2
```

- 播报正文实渲染：含逐只现价/涨跌/权重/生效止损/状态、「接近买区」三条（风华 3.36%、崇达 3.73%、
  高德 5.90%）、「止损口径冲突 2 项」。
- 闸门行为符合设计：两条止损破线幅度 11.24% / 1.32% ≥ `confirmBandPct` 0.3%，首 tick 直接成立；
  第二 tick 因 `code|kind|ymd` 去重不再触发，且 30 分钟内不重复播报。



