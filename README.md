# dsh-invest-plugin

DSH（DeepSeek Harness）**多角色 A 股投研流水线插件**：`invest_run` 工具由 4 个角色子代理接力完成投研分析，每个角色通过自己的 `pwsh` 工具调用 Tushare Pro API 实时取数，产出逐层传递，最终给出综合投资建议。GUI 聊天区显示专属工具卡片：阶段进度实时可见、每个 Agent 的完整报告与推理过程可展开、SVG 图表内联渲染并可点击放大。

```
用户提问
  └─ invest_run 工具
       ├─ ① 选股分析师       （全市场扫描 / 指定个股 / 多标的对比 → 候选名单+交易计划）
       ├─ ② 市场重点消息获取师 （消息面收集 + 可信度核验）
       ├─ ③ 股票深度分析师     （六维诊断 + L1-L4 目标价 + 分级止损）
       └─ ④ 总判断师          （综合三份上游 → 最终投资决策建议）
```

**当前版本：v0.12.1**

---

## 功能特性

- 5 种运行模式：`选股` / `消息` / `深度分析` / `总判断` / `all`（默认，选股∥消息并行执行）
- **全上游传递**：总判断师可见选股 + 消息 + 深度三份完整产出（各阶段输出与推理过程可在 GUI 卡片分阶段查看）
- **detail 开关**：`summary`（默认，模型侧摘要、省 ~70% token）/ `full`（模型侧全量）——GUI 卡片始终显示完整报告
- **context 记忆追问**：传入上一轮结论，支持"接着上次的分析继续/对比"式对话
- **失败分类重试**：网络/超时类自动重试 1 次；权限/频率类（40203 等）直接如实标注
- **日期锚定铁律**：`index_daily` 最大 trade_date 锚定真实最新交易日（防日期/价格错位）
- **数据覆盖铁律**：必须真实取数后才能给价格，接口受限如实标注（防编造）
- **三级缓存**：交易日锚点缓存（Host 注入）+ 行情响应文件缓存（跨阶段/跨运行复用，命中标 [缓存命中]）
- **报告统一归档**：每轮自动输出到 `invest-outputs\<时间戳>_<问题>\`（报告.md + 图表\ 副本），历史分析一目了然
- 效率纪律：取数合并请求、接口调用上限、输出压缩（全流程约 6-8 分钟，缓存命中更快）

## 目录结构

```
dsh-invest-plugin/
├── packages/dsh-invest/   # ★ 常规 Cordis 插件包（推荐安装方式，profile bundle 挂载）
│   ├── package.json       #    dsh.bundle.patch 声明 + dsh.client 声明
│   ├── cordis.patch.yml   #    插件行：- id: invest, name: dsh-invest
│   └── lib/
│       ├── index.js       #    Host 半部：invest_run 工具 + /api/dsh-invest 路由 + agent 指引
│       ├── client.js      #    Client 半部：GUI 工具卡片（分阶段标签/推理/图表）
│       └── prompts.js     #    4 角色 System Prompt（纯数据，可改）
├── src/                   # 动态插件形态源码（与 packages 同源）
│   ├── prompts.js / host.js / client.js
├── dist/                  # 动态插件形态产物（build 生成，可粘贴 cordis_define）
├── tools/build.js         # 构建脚本：node tools/build.js
├── docs/使用指南.md        # 面向最终用户的 13 节使用说明
├── CHANGELOG.md
└── README.md
```

## 安装与加载（推荐：常规插件，一次安装永久生效）

> 常规插件安装在 DSH 的 profile 层（如 `web`），**所有会话共享**——任何新建会话都能看到 `invest_run` 工具，
> 且每个会话的 Agent 会自动收到插件使用指引（类似 dsh-ssh 的提示），不需要每次手动提及。

**前置条件**：DSH ≥ 0.1.0（使用 `web` profile），本机已配置 Tushare token（见[配置](#配置)）。

```powershell
# 1. 进入插件仓库
cd E:\Dsh_WorkSapce\Dify_Agents\dsh-invest-plugin

# 2. 安装到 web profile（pnpm link 方式，后续改代码即时生效）
dsh plugin --profile web add "link:E:\Dsh_WorkSapce\Dify_Agents\dsh-invest-plugin\packages\dsh-invest"

# 3. 确认 bundles 已包含 dsh-invest（pnpm add 会自动追加）
#    检查 C:\Users\<你>\.dsh\profiles\web\package.json → dsh.profile.bundles 应有 "dsh-invest"

# 4. 验证组合树中出现 invest 行
dsh --profile web --dump-config   # 应看到：- id: invest / name: dsh-invest

# 5. 重启 DSH（dsh web）
```

重启后即可使用：新会话里直接提问投研问题，Agent 会自动调用 `invest_run`。
**卸载**：`dsh plugin --profile web remove dsh-invest` 后重启。

### 备用：动态插件方式（单会话临时，重启失效）

适合快速体验或调试（不推荐长期使用）：

1. `node tools/build.js` 生成 `dist/`
2. 在会话中用 `cordis_define` 注册：`code.host` ← `dist/invest-run.host.js` 内容，`code.client` ← `dist/invest-run.client.js` 内容
3. `cordis_run` 激活（Client 半部需 GUI 批准一次）
4. 重启后需重新注册

## 配置

| 配置项 | 位置 | 说明 |
|---|---|---|
| Tushare token | `E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/tushare.token` | 明文单行；在 [tushare.pro](https://tushare.pro) 个人中心获取后覆写即可 |
| 图表工作区 | `E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/charts/` | 子代理生成的 SVG 图表（内部工作区） |
| 行情缓存 | `E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/cache/` | 交易日锚点 + 行情响应缓存（当日有效） |
| **对外统一输出** | **`E:/Dsh_WorkSapce/Dify_Agents/invest-outputs/`** | **每轮分析一个子目录 `<时间戳>_<问题>\`，含 `报告.md` + `图表\` 副本** |

> 路径写死在 `packages/dsh-invest/lib/index.js` 顶部常量中；迁移到其他机器时全局替换
> `E:/Dsh_WorkSapce/Dify_Agents` 为你自己的目录即可（token、缓存、输出均在其下）。

## 使用案例

**案例：分析一只股票是否值得买入**

用户（新会话，无需任何提示词）：
```
请对长江电力(600900.SH)做深度分析，给出操作建议
```

Agent 自动调用 `invest_run(mode="all", question="请对长江电力(600900.SH)做深度分析，给出操作建议")`，
4 个角色子代理并行/接力运行（约 6-8 分钟），之后你得到：

1. **聊天区工具卡片**（点击展开）：4 个阶段标签 `[1. 选股分析师] [2. 市场消息获取师] [3. 深度分析师] [4. 总判断师]`，每个标签含完整报告 + 💭 推理过程折叠区；顶部图表可点击放大
2. **综合投资建议**：如 *"长江电力 2026Q1 净利 +30.5% 业绩加速、PE_TTM 19.05 处历史中位偏上；短线缩量企稳未确认、中线增持短线观望；27.5-27.8 分批低吸、止损 27.0、目标 29.5-30.4；8 月底中报为方向验证点"*
3. **统一归档**：`invest-outputs\20260817_0048_请对长江电力_600900_SH\`（`报告.md` + `图表\` 多张 SVG）

**案例：多标的对比 + 追问**

```
对比分析长江电力和中国平安哪只更值得买入      → 双标的逐一深度分析 + 对比结论表
那华能水电呢？对比三只                    → 自动携带上次结论（context 记忆）继续分析
这次用全量模式                          → detail=full，模型总结更精细（token 略多）
```

## 修改提示词

1. 编辑 `packages/dsh-invest/lib/prompts.js`（或同源的 `src/prompts.js`）
2. 同步另一处（两处同源，改动需一致）
3. 常规插件：改完重启 DSH 生效（link 安装无需重装）；动态插件：`node tools/build.js` + 重新注册

## 已知限制

- Tushare `news` / `anns_d` / `research_report` 需更高积分，低积分账号返回 40203 无权限（非本插件问题）
- `major_news` 接口每日 40 次频率上限
- 图表依赖子代理在报告正文中写出完整绝对路径（prompts 已强制要求）
- 所有分析基于真实最新交易日收盘数据，非实时盘中

## 版本

见 [CHANGELOG.md](CHANGELOG.md)。当前 **v0.12.1**。

## 免责声明

本插件输出的所有分析内容仅供参考，不构成任何投资建议。投资有风险，入市需谨慎。
