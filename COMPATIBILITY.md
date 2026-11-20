# DSH 升级兼容性

这份文件回答一个问题：**DSH 升级后，这个插件还能不能用，怎么提前知道。**

插件不是独立进程。它跑在 DSH 的 cordis 容器里，靠宿主提供接口。宿主接口一变，插件就可能半死不活——
页面白屏、工具消失、或者最糟：注册阶段抛异常，把整个 profile 一起拖下水。

---

## 一、插件到底依赖 DSH 什么（实测清单）

`node tools/compat-check.mjs` 的输出就是这份清单，改动依赖面后请同步更新这里。

### 注册期接口（缺一个就挂不上）

| 接口 | 用途 | 缺失后果 |
|---|---|---|
| `ctx.webServer.register` | 注册 49 条 HTTP 路由（工作台全部数据） | 页面全部 404 |
| `ctx.tools.register` | 注册 `invest_run` 工具 | 模型无法发起流水线 |
| `ctx.systemPrompt.section` | 注入投研角色提示 | 角色行为退化 |
| `ctx.effect` | 生命周期托管（6 处） | 热更新/卸载时资源泄漏 |

### 请求期服务（按名取，取不到降级）

| 服务 | 用途 | 缺失后果 |
|---|---|---|
| `ctx.get('fs')` | 账本、缓存、报告、JSONL 读写（39 处调用） | 核心功能全废 |
| `ctx.get('agents')` | 子代理调度 | 流水线跑不起来 |
| `ctx.get('llm')` | 模型调用 | 同上 |
| `ctx.get('attachments')` | 附件读取 | 个股知识库等受影响 |
| `ctx.subagents` | 子代理注册/列举 | 角色编排受影响 |

### 客户端注入（工作台前端）

`dsh.client.inject` 依赖 5 个 `@deepseek-ai/dsh-client-*` 包（runtime / connection / ui-tool / ui-sidebar / ui-layout），
配 `cordis.patch.yml` 挂到 profile。这些包改名或改 API，工作台会挂不上；但**后端路由仍可用**，
表现为「接口有数据、页面打不开」——这类问题最容易被误判成数据坏了。

---

## 二、三道防线

### 防线 1：声明式拦截 —— `engines.dsh`

`package.json` 已声明：

```json
"engines": { "dsh": ">=0.2.0 <0.3.0" }
```

DSH 支持 `engines.dsh`（也支持按 DSH 同行包名声明）。不满足时**拒绝安装/激活**，
并回报 `incompatible-version`，列出具体缺哪条要求。

意义：把「装上去之后才发现坏了」变成「装之前就拦住，并告诉你去改哪一行」。

> 注意：这只在 DSH 走 install/activation 校验的路径上生效。若插件以 profile bundle 方式
> 直接挂载、绕过校验，则防线 1 不触发——所以还需要防线 2、3。

### 防线 2：离线自检 —— `tools/compat-check.mjs`

```bash
node tools/compat-check.mjs        # 人读
node tools/compat-check.mjs --json # 机器读，退出码 0/1
```

它用假 ctx 跑一遍 `apply()`，断言：模块可加载、`apply()` 不抛、effect 内无异常、
路由都注册（含 7 条关键路由点名检查）、工具注册、提示段注册，并打印**依赖面清单**。

能提前发现：Node 版本不兼容、自有代码语法/导入问题、路由注册路径变动、注册顺序依赖被打断。
**不能**发现：DSH 内部服务改名——因为假 ctx 是我们自己造的，它永远「配合」。

### 防线 3：运行期守卫 —— 缺接口时干净退出

`apply()` 开头会先检查 `webServer / tools / systemPrompt / effect / get`。
缺任何一个：打印一份可照着排查的中文清单，然后**直接 return，不抛异常**。

意义：注册阶段抛异常会连带整个 profile（别的插件一起挂）。改成干净退出后，
最坏情况是「这个插件不可用、DSH 本身还能起」，你能进 GUI 看到日志再决定回退。

---

## 三、升级 DSH 的标准动作

不要边用边升。按这个顺序：

1. **记录当前可用组合**：DSH 版本 + 插件版本 + git tag
   ```bash
   # 插件目录
   git rev-parse --short HEAD
   git tag   # 确认有对应版本标签
   ```
2. **升级 DSH**
3. **先跑离线自检**
   ```bash
   node tools/compat-check.mjs
   ```
   红了就停，先看报错指名道姓缺什么，别急着开工作台。
4. **重启 DSH，验三条**
   - `invest_run` 工具在不在（模型侧能否调用）
   - 工作台页面能否打开（客户端注入是否正常）
   - 任取一条数据接口：`/dsh-invest/api/index` 是否返回 `ok:true`
5. **观察一轮真实任务**（一条个股分析），确认报告归档、图表、知识库都正常
6. 全部通过后再把 `engines.dsh` 的区间放宽到新版本

---

## 四、回滚

插件是 git 仓库，回滚是一步：

```bash
cd E:/Dsh_WorkSapce/Dify_Agents/dsh-invest-plugin
git log --oneline -5          # 找到上一个可用提交
git checkout <可用提交>        # 或 git revert 具体提交
npm --prefix web run build    # 前端产物必须重建
# 重启 DSH
```

**关键提醒**：前端产物在 `.dsh-invest/web/dist/`，回滚源码后**必须重新 build**，
否则页面还是新版本，会以为是回滚失败。

数据不受影响：工作台数据都在 `E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/`，
插件升回滚不会动它。

---

## 五、仍然不可控的部分（如实说明）

1. **客户端注入包的 API**：5 个 `dsh-client-*` 包一旦重构，工作台挂不上，而后端接口仍正常。
   目前只能靠「升级后打开页面看一眼」这一步发现，没有自动检测手段。
2. **`cordis.patch.yml` 的 patch 语法**：属 DSH 内部约定，没有版本号可依。变了会静默失效。
3. **`hostProtocolVersion`**：DSH 运行时清单里有这个字段（当前为 4），但**没有对插件暴露声明入口**，
   因此插件侧无法据此自我校验，只能靠上面三道防线。
4. **LihuQuantify 侧**：那个仓库没有 CI，接口靠文件契约（`schema_version`）。
   插件侧已对 `schema_version` 做范围校验（v1~v7），不匹配会返回 `schema_mismatch` 而不是崩。

---

## 六、一句话版本

**每次升级 DSH，先跑 `node tools/compat-check.mjs`，绿了再开工作台；红了按报错回退，别硬上。**
