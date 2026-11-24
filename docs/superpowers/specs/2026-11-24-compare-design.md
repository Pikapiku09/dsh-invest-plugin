# 两只票同口径对比（v0.77.0）设计说明

> 2026-11-24。用户诉求原话：「我现在想要对比一下崇达技术和超声电子，哪个更好，那我现在是没办法对比的啊」。
> 本文记录当时的设计取舍与实现落点，供以后改这块的人对照，不代替 CHANGELOG。

## 1. 问题

插件原有两种"看一只票"的能力，都不能回答"A 和 B 哪个更好"：

| 能力 | 为什么不够 |
| --- | --- |
| `mode:"个股"`（深度角色） | 一次一只，产出单票报告；两只各跑一次得到两份报告，对比靠人眼 |
| `mode:"深度分析"`（选股+深度） | 虽可带多码，但产出仍是并列报告；两份报告的 as-of 与口径不保证一致 |
| `askStock` 个股知识库追问 | 只读某一只票的知识库，无横截面 |

真正的风险不是"没有对比功能"，而是**人眼拼两张不同日期的表**：一只票停在昨天收盘、另一只已到
今天，PE、涨跌、回撤并排放，看起来像同一时点，结论却是错的。

另一条硬约束来自用户对入口的判断（m00867）：「加了新的nav会有点冗余，新开不如在原来已有的nav上进行
更好更合理的优化，你可以给出方案，如果没办法的话，就再新增」。

## 2. 决策

1. **不新增 nav**：对比成为【个股知识库】页的第二个模式。左侧本来就是全体标的索引 + 搜索 + 持仓/观察
   标记，是现成的选股器；右侧从"单票工作区"扩成"单票 / 对比"两态。新增 nav 仅作兜底，最终未使用。
2. **数字只出自脚本**：事实层由 `scripts/compare_pack.js` 生成，一次取齐多票、统一 as-of、统一价格口径；
   模型拿到的只有事实层字段，prompt 明确"禁止新增数字"。
3. **胜负由规则判，不做加权综合分**：六维各判一个胜者，`score` 是胜场数；缺数据的维度记空并写原因。
   不做 `0.3*动量 + 0.2*估值 …` 这类拍脑袋加权——那只会制造伪精确。
4. **先过硬约束再谈好坏**：单票 20% 上限、赔率 < 3:1、无生效止损、无目标价、档案止损与最新结论打架，
   一律在六维表之前列出，模型无权豁免。
5. **解释层可失败**：模型挂了仍返回完整事实表 + 规则判定（`withAnswer:false` 也能主动跳过模型，0 token）。

## 3. 三层分工

```
事实层  scripts/compare_pack.js        Tushare 取数 → 统一 as-of → 六维数值 → 单行 JSON
   ↓
规则层  index.js: compareFacts()       六维胜负 / 赔率 / 权重余量 / 硬约束 / 止损口径冲突
   ↓
解释层  index.js: compareAsk()         只读事实层，五段式输出；失败降级 answerError
```

## 4. 事实层契约（`scripts/compare_pack.js`）

- 用法：`node compare_pack.js [--no-cache] <code> <code> [code]`，2–3 只；`DSH_INVEST_BASE_DIR` 决定 base；
  token 取 `.dsh-invest/tushare.token` 或 `TUSHARE_TOKEN`。
- **统一 as-of**：各票先取 `daily` 最新交易日，`asof = min(各票 latest)`；按 `trade_date <= asof` 截断后
  再算 MA、涨跌、超额。某票最新 < asof → `stale:true` 且进 `stale_codes`。
- 数据源：`daily`（420 天回溯）/ `daily_basic` / `moneyflow_dc` / `fina_indicator` / `stock_basic` /
  `index_daily(000001.SH)`。
- 输出字段（节选）：`asof, stocks[{code,name,industry,stale,close,chg_pct,ma5..ma60,dist_ma20_pct,
  pct5/20/60,hi250,lo250,drawdown_pct,pe,pe_ttm,pb,total_mv_yi,turnover_rate,volume_ratio,
  mf5_wan,mf20_wan,fina_end_date,roe,netprofit_yoy,or_yoy,gpm,debt_ratio,excess20,excess60}],
  stale_codes, warnings, cachePath`。
- 缓存：`cache/compare/compare_<codes>.json`（6 小时内复用）、`cache/compare/daily_<code>_<ymd>.json`。

**两个坑（已修，勿回退）**

1. 不要复用 `cache/pack/daily_*.json`：那份可能由 `stockchart.js` 写成只有 `trade_date`+`close` 的精简行，
   导致 open/high/low 全 null、回撤算成 −100。读自己的缓存前也要校验最近 5 行 `close` 与 `high` 非空。
2. `Math.max.apply(null, [])` 得 `-Infinity`（真值），`close / -Infinity` 同样让回撤变 −100。
   先 filter 再判空，`hi250 > 0` 守卫。

## 5. 规则层（`index.js: compareFacts`）

- 六维与胜者口径：

| key | 指标 | 胜者 |
| --- | --- | --- |
| `position` | `drawdown_pct`（距 250 日高） | 回撤更小（更抗跌） |
| `momentum` | `excess20`（20 日相对上证） | 更高 |
| `flow` | `mf20_wan`（近 20 日主力净流入） | 更高 |
| `valuation` | `pe_ttm` | 更低 |
| `quality` | `roe` | 更高 |
| `plan` | `odds` | 更高 |

  并列 → `winner:null` 并写 `note`；缺数 → `note:"缺少数据"`，不补 0。

- `plan` 侧字段：`held, shares, cost, mv, pnl_pct, weight_pct, room_pct, buy_low/high, ideal_buy,
  eff_stop, eff_stop_src, target, odds, stance, thesis, invalidate_if, concl_ts, stop_conflict,
  stop_conflict_note, kb_excerpt`。
- `eff_stop = position.stop ?? watch.stop`（档案优先，其次失效价）；
  `odds = (target − close) / (close − eff_stop)`；
  `room_pct`：持有 = `max(0, 20 − weight_pct)`、空仓 = `min(20, 现金/总资产)`。
- `stop_conflict`：`eff_stop` 与最新结论 stop 相差 > 3%（`diff / max(effStop, conclStop)`），note 同时给出两个值。
- `gates`（`H1` 权重超限 / `H2` 失效条件 / `H3` 赔率或止损缺失 / `H4` 无目标 / `STOP` 口径冲突），
  level ∈ `bad|warn|info`；前端按 level 显示左边色条。

## 6. 接口

- `POST /dsh-invest/api/compare`
  `{codes:[2..3], question?, history?, withAnswer?}` →
  `{ok, asof, price_basis:"unadj", stocks, verdict, warnings, question, answer, answerError}`。
  非环回 403；非 GET/POST 405；代码非法 / 脚本失败 400（中文 error）。
- `GET /dsh-invest/api/compare` → `{ok, log}`（`store/compare-log.jsonl`，上限 120 条）。
- 每次对比都落日志（codes / asof / question / answer / answer_error），便于回看"当时问了什么"。

## 7. 前端

- 页头 segmented「知识库 | 对比」（`data-action="ask-mode"`）；对比模式下左侧 `stockRow` 改发
  `compare-pick`，行尾显示 A/B 角标。
- 槽位：新增点行先填 A、再填 B；两槽满时替换 A；点已选中的票 = 清空该槽；`compare-swap` 交换。
  任何槽位变化都清空 `compareResult` 与追问线程（防止"槽位是新的、表是旧的"）。
- 结果区顺序：结论卡 → 两张计划卡 → 六维表（胜者格高亮）→ 硬约束 → 模型解释 → 追问 → 页脚
  （as-of / 口径 / 财务截止 / `warnings`）。
- 扣子：`只看数据`（`withAnswer:false`，0 token）、`开始对比`（一次模型，约 30–90s）、
  `升级为深度对比`（`compare-deep` 模板 → `api.run` → 跳一键任务页）。
- 持久化：A/B 存 `localStorage['dsh-invest.comparePair']`；从标的档案/持仓工作区的「加入对比」
  预填 A（A 已占用则填 B）。
- 容错：缺数显示 `—`；解释缺失渲染 `compare-answer-missing`，事实表与规则判定照常展示。

## 8. 深度对比模板（`compare-deep`）

`mode:"个股"`、`roles:["消息","深度","总判断"]`、`sequence` 同名、`needsCode:false`（两码写进 question）。
prompt 要求：统一 as-of 与不复权口径、用 20% 上限与赔率 <3:1 判可执行性、逐只给目标/止损/失效条件/赔率、
明确「只能选一只选谁、先做什么、仓位多少」、都不满足就说都不选、末尾两行【结论结构化】JSON、≤1200 字。

## 9. 验收证据（2026-11-24，as-of 20261124）

- 真实数据两票均非 stale、无 warning：
  - 崇达 002815：close 14.38、回撤 −45.24%、PE_TTM 26.94、PB 1.92、主力 20 日净流入 94,818.71 万、
    ROE 7.17、净利同比 107.33%、20 日超额 −10.06、60 日超额 +16.23。
  - 超声 000823：close 19.10、回撤 −35.84%、PE_TTM 28.68、PB 1.95、主力 20 日净流入 64,212.9 万、
    ROE 6.57、净利同比 97.52%、20 日超额 +10.04、60 日超额 +38.97。
- `test/compare-api.test.js` 8 项全绿；`node --test` 279/279；`node --check` 0；`tsc --noEmit` 0；
  `vite build` 36 modules。

## 10. 已知限制（未做）

- **只支持 2–3 只**：四只以上没有"两两矩阵"视图，需要多轮。
- **技术面只到日线**：盘中价不参与六维计算（与"盘中价不做技术指标"的盘子纪律一致）；秒级强弱不在范围内。
- **行业分类用 Tushare `industry`**：ETF 无行业，故 ETF 只作为普通标的参与价格/动量维，估值与质量维为空。
- **硬约束不含资金账户级校验**：`room_pct` 只是"20% 上限 − 现有权重"的算术，不含保证金/可用资金冻结等。
- **模型解释不可复现**：同一对标的两次跑，措辞会不同；数字不变，但不要拿两段解释做 diff。

## 11. 回滚

单次提交可回滚（`git revert`）：新增文件仅 `scripts/compare_pack.js`、`test/compare-api.test.js`，
其余为改动；`compare-deep` 模板与 `/api/compare` 路由互不依赖既有功能，回滚不影响 `invest_run`、
盘中盯盘与个股知识库原模式。
