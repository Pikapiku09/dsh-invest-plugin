# dsh-invest-plugin

DSH（DeepSeek Harness）动态 Cordis 插件：**多角色 A 股投研流水线**。

由 4 个角色子代理按顺序接力完成投研分析，每个角色通过自己的 `pwsh` 工具调用
Tushare Pro API 实时取数，产出逐层传递，最终给出综合投资建议。
GUI 聊天区显示专属工具卡片：阶段进度实时可见、SVG 图表内联渲染、报告可展开。

```
用户提问
  └─ invest_run 工具
       ├─ ① 选股分析师      （全市场扫描 / 指定个股分析 → 候选名单+交易计划）
       ├─ ② 市场重点消息获取师（消息面收集 + 可信度核验）
       ├─ ③ 股票深度分析师    （六维诊断 + L1-L4 目标价 + 止损方案）
       └─ ④ 总判断师         （综合三份上游 → 最终投资决策建议）
```

## 功能特性

- 5 种运行模式：`选股` / `消息` / `深度分析` / `总判断` / `all`（默认）
- 全上游传递：总判断师可见选股 + 消息 + 深度三份完整产出
- 阶段失败自动重试 1 次（带错误上下文）
- **日期锚定铁律**：`index_daily` 最大 trade_date 锚定真实最新交易日（防日期/价格错位）
- **数据覆盖铁律**：必须真实取数后才能给价格，接口受限如实标注（防编造）
- **两级缓存**：交易日锚点缓存（Host 注入）+ 行情响应文件缓存（子代理读写，跨阶段/跨运行复用）
- **实时进度**：运行中卡片显示「进行中 2/4：市场重点消息获取师」+ 已完成阶段耗时徽章
- **SVG 图表内联渲染**：Agent 手写 SVG 图表直接在卡片里显示成图片
- 效率纪律：取数合并请求、接口调用上限、输出压缩（全流程约 5-8 分钟）

## 目录结构

```
dsh-invest-plugin/
├── src/
│   ├── prompts.js   # 4 角色 System Prompt（纯数据，可改）
│   ├── host.js      # Host 半部：invest_run 工具 + 流水线编排 + 2 个 RPC
│   └── client.js    # Client 半部：invest_run 专属工具卡片（进度 + 图表）
├── dist/            # build 产物：完整函数体（可直接粘贴到 cordis_define）
│   ├── invest-run.host.js
│   └── invest-run.client.js
├── tools/build.js   # 构建脚本：node tools/build.js
├── docs/使用指南.md  # 面向最终用户的使用说明
├── package.json
├── CHANGELOG.md
└── README.md
```

## 安装与加载（DSH 动态插件方式）

本插件以「DSH 动态 Cordis 插件」方式运行，即在 DSH 会话中通过 cordis 工具注册：

1. **（首次）重新生成 dist**（仅当你改过 `src/` 后需要）：
   ```powershell
   node tools/build.js
   ```
2. 在 DSH 会话中让 Agent 用 `cordis_define` 注册插件：
   - `code.host` ← `dist/invest-run.host.js` 的**函数体内容**（不含文件头注释也可）
   - `code.client` ← `dist/invest-run.client.js` 的内容
   - `plugin.kind: "new"`，`idPrefix` 建议 `invr`（实际 ID 由 Host 分配）
3. `cordis_run` 激活（Client 半部首次激活需在 GUI 批准一次）
4. 之后直接向 Agent 提问即可自动调用 `invest_run`：
   ```
   请对长江电力(600900.SH)做完整投研分析，给出最终投资建议
   ```

> 提示：动态插件定义只存在于当前 DSH 进程，进程重启后需重新执行上述步骤。

## 配置

| 配置项 | 位置 | 说明 |
|---|---|---|
| Tushare token | `E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/tushare.token` | 明文单行；在 [tushare.pro](https://tushare.pro) 个人中心获取后覆写即可 |
| 图表输出 | `E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/charts/` | Agent 生成 SVG 图表的目录 |
| 缓存目录 | `E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/cache/` | 交易日锚点 + 行情响应缓存（当日有效） |

> 路径写死在 `src/host.js` 顶部 `CACHE_DIR` 与 `src/prompts.js` 中；迁移到其他机器时全局替换
> `E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest` 为你自己的目录即可。

## 修改提示词

1. 编辑 `src/prompts.js`（4 角色角色卡 + 数据获取铁律 + 输出格式）
2. 运行 `node tools/build.js` 重新生成 dist
3. 在 DSH 会话中为同一 pluginId 追加新 Package（`cordis_define` kind:"existing"）并 `cordis_run` mode:"update"

## 已知限制

- Tushare `news` / `anns_d` / `research_report` 需更高积分，低积分账号返回 40203 无权限（非本插件问题）
- `major_news` 接口每日 40 次频率上限
- 图表依赖子代理在报告正文中写出完整绝对路径（prompts 已强制要求）
- 动态插件为进程级临时注册，无持久化安装（重启后需重新加载）

## 版本

见 [CHANGELOG.md](CHANGELOG.md)。当前 **v0.7.1**。

## 免责声明

本插件输出的所有分析内容仅供参考，不构成任何投资建议。投资有风险，入市需谨慎。
