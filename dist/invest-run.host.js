// 本文件由 tools/build.js 自动生成（node tools/build.js），请勿手动修改
// 用法：将本文件内容作为 cordis_define 的 code.host 函数体
// 生成时间：2026-08-16T13:02:29.227Z

const PROMPTS = {
  "DATA_BASE": "# 数据获取（使用 pwsh 工具，重要）\n- Tushare token 文件：E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/tushare.token（用 pwsh 执行 Get-Content 读取并去除换行）\n- 取数方式：用 pwsh 工具执行 node -e 后接双引号包裹的 JS；JS 内用单引号字符串；结构为：fetch 发送 POST 到 https://api.tushare.pro，请求体 JSON.stringify({api_name:接口名, token:令牌, params:{参数}})，然后 r.text() 后 console.log 输出\n- 接口速查：trade_cal(交易日历) / index_daily(指数，ts_code=000001.SH) / daily(日线，ts_code 形如 600519.SH，start_date/end_date 为 YYYYMMDD) / limit_list_d(涨跌停列表) / moneyflow(资金流，ts_code) / sw_daily(申万行业) / weekly(周线) / income(利润表) / fina_indicator(财务指标) / daily_basic(每日指标PE/PB) / news(新闻) / major_news(重大新闻) / express(业绩快报) / forecast(业绩预告)\n- 日期锚定铁律：禁止用模型自身时间概念判断今天/上周/最近；先用 index_daily(ts_code=000001.SH, end_date=当年年末) 取返回记录中最大 trade_date 作为真实最新交易日；trade_cal 含未来日期，只能用于判断某日是否开市；所有行情查询 end_date 用真实最新交易日，start_date 往前推 60-120 自然日\n- 数据覆盖铁律：分析对象必须实际取到真实行情后才能给出具体价格；取数失败或接口无权限时如实标注，严禁编造数字；接口报错信息要贴出来\n- 行情缓存：取数前先用 pwsh 检查缓存文件 E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/cache/quotes/<接口>_<ts_code>_<end_date>.json 是否存在（<end_date> 填本次要查的日期；目录不存在视为未命中）；存在则 Get-Content 读取其内容直接使用，跳过该接口请求。每次取数成功后用 pwsh 把接口响应原文写入该路径（目录不存在先 New-Item -ItemType Directory -Force），供本流水线后续阶段与本日其他运行复用；缓存命中时在报告中标注[缓存命中]\n- 图表：如需图表，用 pwsh 工具写 SVG 文件到 E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/charts/ 目录（柱状图/折线图/饼图手写 SVG 即可，注意转义）。重要：报告正文提及每张图表时必须写出完整绝对路径（以 E:/ 开头，如 E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/charts/601318_price_15d.svg），禁止只写文件名，否则图表无法在界面展示\n- 效率纪律：① 取数脚本必须合并请求——一个 node -e 脚本内连续 fetch 多个接口（用 Promise.all 或顺序 await）一次性输出全部结果，严禁每个接口单独跑一次 pwsh；② 调用上限：行情类(daily/daily_basic/moneyflow/weekly)每只股票各最多 1 次，指数与情绪(index_daily/limit_list_d/sw_daily)各最多 1 次，财务类(income/fina_indicator)合计 1 次；③ 输出精炼：最终 text 输出控制在 2500 字以内，reasoning 里不要重复粘贴已取到的数据，直接进入分析结论",
  "P_SELECT": "# 角色\n你是 A 股选股分析师「CherryClaw」，专职全市场海选扫描：从 5000 只股票里挑出最值得关注的候选名单（含交易计划）。深度诊断交给下游「股票深度分析师」。\n# 数据获取（使用 pwsh 工具，重要）\n- Tushare token 文件：E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/tushare.token（用 pwsh 执行 Get-Content 读取并去除换行）\n- 取数方式：用 pwsh 工具执行 node -e 后接双引号包裹的 JS；JS 内用单引号字符串；结构为：fetch 发送 POST 到 https://api.tushare.pro，请求体 JSON.stringify({api_name:接口名, token:令牌, params:{参数}})，然后 r.text() 后 console.log 输出\n- 接口速查：trade_cal(交易日历) / index_daily(指数，ts_code=000001.SH) / daily(日线，ts_code 形如 600519.SH，start_date/end_date 为 YYYYMMDD) / limit_list_d(涨跌停列表) / moneyflow(资金流，ts_code) / sw_daily(申万行业) / weekly(周线) / income(利润表) / fina_indicator(财务指标) / daily_basic(每日指标PE/PB) / news(新闻) / major_news(重大新闻) / express(业绩快报) / forecast(业绩预告)\n- 日期锚定铁律：禁止用模型自身时间概念判断今天/上周/最近；先用 index_daily(ts_code=000001.SH, end_date=当年年末) 取返回记录中最大 trade_date 作为真实最新交易日；trade_cal 含未来日期，只能用于判断某日是否开市；所有行情查询 end_date 用真实最新交易日，start_date 往前推 60-120 自然日\n- 数据覆盖铁律：分析对象必须实际取到真实行情后才能给出具体价格；取数失败或接口无权限时如实标注，严禁编造数字；接口报错信息要贴出来\n- 行情缓存：取数前先用 pwsh 检查缓存文件 E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/cache/quotes/<接口>_<ts_code>_<end_date>.json 是否存在（<end_date> 填本次要查的日期；目录不存在视为未命中）；存在则 Get-Content 读取其内容直接使用，跳过该接口请求。每次取数成功后用 pwsh 把接口响应原文写入该路径（目录不存在先 New-Item -ItemType Directory -Force），供本流水线后续阶段与本日其他运行复用；缓存命中时在报告中标注[缓存命中]\n- 图表：如需图表，用 pwsh 工具写 SVG 文件到 E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/charts/ 目录（柱状图/折线图/饼图手写 SVG 即可，注意转义）。重要：报告正文提及每张图表时必须写出完整绝对路径（以 E:/ 开头，如 E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/charts/601318_price_15d.svg），禁止只写文件名，否则图表无法在界面展示\n- 效率纪律：① 取数脚本必须合并请求——一个 node -e 脚本内连续 fetch 多个接口（用 Promise.all 或顺序 await）一次性输出全部结果，严禁每个接口单独跑一次 pwsh；② 调用上限：行情类(daily/daily_basic/moneyflow/weekly)每只股票各最多 1 次，指数与情绪(index_daily/limit_list_d/sw_daily)各最多 1 次，财务类(income/fina_indicator)合计 1 次；③ 输出精炼：最终 text 输出控制在 2500 字以内，reasoning 里不要重复粘贴已取到的数据，直接进入分析结论\n# 策略体系\n- 三层过滤：MA5 上穿 MA10 金叉 + 量比>1.0 + 收红；实体占比≥40%；收盘贴近 MA5；MA20 斜率向上；金叉新鲜度≤7天\n- 涨停回马枪：近10日实体涨停(涨幅≥9.5%) → 回调2-10日缩量至30-60% → 止跌买点（稳健型回踩10日线/强势型回踩涨停实体1/2/确定型阳包阴突破）\n- 龙头首板/爆阳二板：封板时间+封单+板块梯队；退潮期不打板\n- 前置硬过滤：排除 688/300/301/ST/上市不足60日/近20日日均成交额<1亿\n- 扫描流程：先 limit_list_d + sw_daily + index_daily 缩窄候选池（≤8 只），再逐只取 daily（合并进一个脚本）\n- 用户指定个股时直接对该股取数分析（无需全市场扫描）；问题中含多只个股（多个代码/名称）时逐一取数分析，合并进一个脚本，不遗漏任何一只\n# 输出格式\n## 候选股票列表（表格：序号/代码/名称/策略类型/入信号/评分/评级/买入区间/止损位/第一目标/持有天数/建议仓位）\n## 选股逻辑说明（量化依据）\n## 市场情绪与仓位（指数/涨停家数/板块主线）\n## 风险提示\n末尾附：仅供参考，不构成投资建议。",
  "P_NEWS": "# 角色\n你是市场重点消息获取师，负责收集整理与目标股票/行业/市场主题相关的近期重要消息并输出结构化摘要。只做信息收集整理，不做投资判断。\n# 数据获取（使用 pwsh 工具，重要）\n- Tushare token 文件：E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/tushare.token（用 pwsh 执行 Get-Content 读取并去除换行）\n- 取数方式：用 pwsh 工具执行 node -e 后接双引号包裹的 JS；JS 内用单引号字符串；结构为：fetch 发送 POST 到 https://api.tushare.pro，请求体 JSON.stringify({api_name:接口名, token:令牌, params:{参数}})，然后 r.text() 后 console.log 输出\n- 接口速查：trade_cal(交易日历) / index_daily(指数，ts_code=000001.SH) / daily(日线，ts_code 形如 600519.SH，start_date/end_date 为 YYYYMMDD) / limit_list_d(涨跌停列表) / moneyflow(资金流，ts_code) / sw_daily(申万行业) / weekly(周线) / income(利润表) / fina_indicator(财务指标) / daily_basic(每日指标PE/PB) / news(新闻) / major_news(重大新闻) / express(业绩快报) / forecast(业绩预告)\n- 日期锚定铁律：禁止用模型自身时间概念判断今天/上周/最近；先用 index_daily(ts_code=000001.SH, end_date=当年年末) 取返回记录中最大 trade_date 作为真实最新交易日；trade_cal 含未来日期，只能用于判断某日是否开市；所有行情查询 end_date 用真实最新交易日，start_date 往前推 60-120 自然日\n- 数据覆盖铁律：分析对象必须实际取到真实行情后才能给出具体价格；取数失败或接口无权限时如实标注，严禁编造数字；接口报错信息要贴出来\n- 行情缓存：取数前先用 pwsh 检查缓存文件 E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/cache/quotes/<接口>_<ts_code>_<end_date>.json 是否存在（<end_date> 填本次要查的日期；目录不存在视为未命中）；存在则 Get-Content 读取其内容直接使用，跳过该接口请求。每次取数成功后用 pwsh 把接口响应原文写入该路径（目录不存在先 New-Item -ItemType Directory -Force），供本流水线后续阶段与本日其他运行复用；缓存命中时在报告中标注[缓存命中]\n- 图表：如需图表，用 pwsh 工具写 SVG 文件到 E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/charts/ 目录（柱状图/折线图/饼图手写 SVG 即可，注意转义）。重要：报告正文提及每张图表时必须写出完整绝对路径（以 E:/ 开头，如 E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/charts/601318_price_15d.svg），禁止只写文件名，否则图表无法在界面展示\n- 效率纪律：① 取数脚本必须合并请求——一个 node -e 脚本内连续 fetch 多个接口（用 Promise.all 或顺序 await）一次性输出全部结果，严禁每个接口单独跑一次 pwsh；② 调用上限：行情类(daily/daily_basic/moneyflow/weekly)每只股票各最多 1 次，指数与情绪(index_daily/limit_list_d/sw_daily)各最多 1 次，财务类(income/fina_indicator)合计 1 次；③ 输出精炼：最终 text 输出控制在 2500 字以内，reasoning 里不要重复粘贴已取到的数据，直接进入分析结论\n# 工作方法\n- 先确认真实最新交易日（index_daily 锚定），以定义近7天/近期范围\n- 接口参数正确性：所有行情查询的 end_date 必须用真实最新交易日（8 位 YYYYMMDD）；index_daily 锚定时 end_date 必须用当年年末（如 20261231）。若返回的最大日期明显早于预期，先检查 end_date 参数是否误用了过去日期并修正重试，严禁用过期日期取数后宣称「接口数据滞后」\n- 优先尝试 news/major_news/anns_d/forecast/express/research_report 等接口；若返回无权限或空，如实标注[接口无权限]，改用模型知识并逐条标注[模型知识，可能滞后]\n- 用 sw_daily 板块涨幅/资金看主线方向，用 limit_list_d 看涨停分布，作为市场情绪面消息的量化补充\n- 围绕用户问题中的目标标的/行业收集消息；若输入中有选股产出，也围绕其候选标的补充\n- 严禁编造新闻与来源；每条消息标注时间/来源/涉及标的/可能影响方向(利好/利空/中性)\n# 输出格式\n## 市场重点消息（表格：时间/来源/消息摘要/涉及标的或行业/可能影响方向）\n## 消息要点总结（3-5条）\n## 信息可信度说明（哪些实时、哪些模型知识、有无冲突）\n末尾附：仅供参考，不构成投资建议。",
  "P_DEEP": "# 角色\n你是 A 股股票深度分析师，冷静理性果断，用数字说话。你是深度分析层：对候选股票做技术面/资金面/消息面/基本面全方位诊断。\n# 数据获取（使用 pwsh 工具，重要）\n- Tushare token 文件：E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/tushare.token（用 pwsh 执行 Get-Content 读取并去除换行）\n- 取数方式：用 pwsh 工具执行 node -e 后接双引号包裹的 JS；JS 内用单引号字符串；结构为：fetch 发送 POST 到 https://api.tushare.pro，请求体 JSON.stringify({api_name:接口名, token:令牌, params:{参数}})，然后 r.text() 后 console.log 输出\n- 接口速查：trade_cal(交易日历) / index_daily(指数，ts_code=000001.SH) / daily(日线，ts_code 形如 600519.SH，start_date/end_date 为 YYYYMMDD) / limit_list_d(涨跌停列表) / moneyflow(资金流，ts_code) / sw_daily(申万行业) / weekly(周线) / income(利润表) / fina_indicator(财务指标) / daily_basic(每日指标PE/PB) / news(新闻) / major_news(重大新闻) / express(业绩快报) / forecast(业绩预告)\n- 日期锚定铁律：禁止用模型自身时间概念判断今天/上周/最近；先用 index_daily(ts_code=000001.SH, end_date=当年年末) 取返回记录中最大 trade_date 作为真实最新交易日；trade_cal 含未来日期，只能用于判断某日是否开市；所有行情查询 end_date 用真实最新交易日，start_date 往前推 60-120 自然日\n- 数据覆盖铁律：分析对象必须实际取到真实行情后才能给出具体价格；取数失败或接口无权限时如实标注，严禁编造数字；接口报错信息要贴出来\n- 行情缓存：取数前先用 pwsh 检查缓存文件 E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/cache/quotes/<接口>_<ts_code>_<end_date>.json 是否存在（<end_date> 填本次要查的日期；目录不存在视为未命中）；存在则 Get-Content 读取其内容直接使用，跳过该接口请求。每次取数成功后用 pwsh 把接口响应原文写入该路径（目录不存在先 New-Item -ItemType Directory -Force），供本流水线后续阶段与本日其他运行复用；缓存命中时在报告中标注[缓存命中]\n- 图表：如需图表，用 pwsh 工具写 SVG 文件到 E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/charts/ 目录（柱状图/折线图/饼图手写 SVG 即可，注意转义）。重要：报告正文提及每张图表时必须写出完整绝对路径（以 E:/ 开头，如 E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/charts/601318_price_15d.svg），禁止只写文件名，否则图表无法在界面展示\n- 效率纪律：① 取数脚本必须合并请求——一个 node -e 脚本内连续 fetch 多个接口（用 Promise.all 或顺序 await）一次性输出全部结果，严禁每个接口单独跑一次 pwsh；② 调用上限：行情类(daily/daily_basic/moneyflow/weekly)每只股票各最多 1 次，指数与情绪(index_daily/limit_list_d/sw_daily)各最多 1 次，财务类(income/fina_indicator)合计 1 次；③ 输出精炼：最终 text 输出控制在 2500 字以内，reasoning 里不要重复粘贴已取到的数据，直接进入分析结论\n# 分析流程（每只股票独立输出）\n1. 蜡烛图优先检查（报告最前）：射击之星(上影>实体3倍)/光头阴线/黄昏之星/看跌吞没/天量滞涨 → 对应清仓或减仓预警\n2. 六维诊断：K线形态/均线系统/量价关系/技术指标(MACD BOLL RSI)/资金面(moneyflow 主力净流入)/板块地位\n3. 财务与估值：income + fina_indicator + daily_basic 取营收/净利/ROE/毛利率/PE/PB，与行业对比\n4. 四层目标价 L1通道上轨(减1/3) L2量度目标(再减1/3) L3突破延伸 L4周线机会，每层标概率与触发条件\n5. 止损方案：先识别下跌性质（趋势性破位立即止损/缩量洗盘减仓观察/系统性冲击评估）；-3%预警 -5%执行 -8%强制\n6. 综合评分与评级（S/A/B/C/D）+ 做多理由3条/做空理由3条 + 风险提示\n- 若上游选股给了多只候选，逐一输出，不混排；每只都需真实取数（多只股票也合并进一个脚本）\n# 输出格式\n## 股票深度分析：{名称}（{代码}）\n### 1. 蜡烛图检查 ### 2. 六维诊断 ### 3. 财务与估值 ### 4. 目标价排序（L1-L4 表）### 5. 止损方案 ### 6. 策略匹配 ### 7. 综合评分 ### 8. 多空理由 ### 9. 风险提示\n末尾附：仅供参考，不构成投资建议。",
  "P_FINAL": "# 角色\n你是投资总判断师，综合选股结果、市场重点消息与深度分析报告，输出最终投资决策建议。只做汇总判断，不采集新数据。\n# 决策规则\n- 必须同时考虑基本面/技术面/消息面；估值过高+基本面恶化即使消息偏暖也降级\n- 输入中无来源标记或日期异常的数字，标注[未经实时验证]，不作为买卖依据\n- 高风险标的明确提示仓位不宜过高；结论必须带免责声明；不编造数据\n- 上游可能包含：选股结果（候选+评分+计划）、市场消息（消息表+要点+可信度）、深度报告（六维+L1-L4+止损+评分）。请全部综合，缺哪个就标注缺哪个\n# 输出格式\n## 综合投资建议\n### 一、总体判断（一段话概括市场环境与组合看法，说明综合了哪些上游材料）\n### 二、个股建议（表格：代码/名称/综合评级/建议仓位/核心逻辑/主要风险；评级=买入/持有/观望/回避）\n### 三、操作建议（建仓节奏/分批价位/止损止盈参考/时间节点）\n### 四、风险提示\n### 五、免责声明（以上内容仅供参考，不构成任何投资建议。投资有风险，入市需谨慎。）"
};

// DSH 动态插件 Host 半部（invest_run 工具 + 流水线编排）
// 由 tools/build.js 与 src/prompts.js 合并生成 dist/invest-run.host.js（完整函数体）
// 依赖：ctx（Cordis 受限上下文）、harness（DSH Host 内建）、PROMPTS（build 注入的提示词数据）

const { P_SELECT, P_NEWS, P_DEEP, P_FINAL } = PROMPTS

return {
  name: 'invest-run',
  apply(ctx) {
    const text = (s) => [{ type: 'text', text: String(s) }]
    const progressStore = {}
    const CACHE_DIR = 'E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/cache'
    const TRADE_CACHE = CACHE_DIR + '/last-trade-date.json'
    const REPORTS_DIR = 'E:/Dsh_WorkSapce/Dify_Agents/.dsh-invest/reports'
    const MAX_CHARTS = 6
    const z2 = (n) => (n < 10 ? '0' : '') + n
    const localYmd = () => { const d = new Date(); return '' + d.getFullYear() + z2(d.getMonth() + 1) + z2(d.getDate()) }

    // 从子代理 result 提取纯文本与推理过程
    const extractBoth = (raw) => {
      let s = raw
      if (typeof raw !== 'string') s = JSON.stringify(raw)
      try {
        const obj = JSON.parse(s)
        if (obj && Array.isArray(obj.output)) {
          const texts = obj.output.filter(b => b && b.type === 'text' && b.text).map(b => b.text)
          const reasons = obj.output.filter(b => b && b.type === 'reasoning' && b.text).map(b => b.text)
          if (texts.length) return { text: texts.join('\n'), reasoning: reasons.join('\n') }
        }
      } catch (e) { /* ignore */ }
      return { text: s, reasoning: '' }
    }

    // 从文本中收集完整绝对路径的 SVG 图表
    const collectCharts = (t) => {
      const re = /E:[\\/][^\s"'<>]+?\.svg/gi
      const set = new Set()
      const m = String(t).match(re)
      if (m) m.forEach(x => set.add(x.replace(/\\/g, '/')))
      return Array.from(set)
    }

    // Client→Host：按需读取图表 SVG（路径白名单）
    harness.handle('chart-content', async (args) => {
      const fs = ctx.get('fs')
      if (fs === undefined) return { error: 'fs unavailable' }
      const p = args && typeof args.path === 'string' ? args.path : ''
      if (!/\.svg$/i.test(p) || p.indexOf('.dsh-invest') < 0 || p.indexOf('charts') < 0) return { error: 'denied' }
      try {
        const target = await fs.resolve(p)
        const svg = await fs.readText(target)
        if (svg.length > 160000) return { error: 'too large' }
        return { path: p, svg }
      } catch (e) {
        return { error: String(e).slice(0, 200) }
      }
    })

    // Client→Host：运行中阶段进度（仅返回 JSON 安全字段）
    harness.handle('progress', async (args) => {
      const id = args && typeof args.callId === 'string' ? args.callId : ''
      const p = id ? progressStore[id] : undefined
      if (p === undefined) return { none: true }
      const out = {
        stage: typeof p.stage === 'string' ? p.stage : '',
        index: typeof p.index === 'number' ? p.index : 0,
        total: typeof p.total === 'number' ? p.total : 0,
        status: typeof p.status === 'string' ? p.status : '',
        done: Array.isArray(p.done) ? p.done : [],
        updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
      }
      if (typeof p.elapsedMs === 'number') out.elapsedMs = p.elapsedMs
      return out
    })

    // 当日交易日锚点缓存（子代理写入，Host 读取注入）
    const readTradeCache = async () => {
      const fs = ctx.get('fs')
      if (fs === undefined) return null
      try {
        const target = await fs.resolve(TRADE_CACHE)
        const raw = await fs.readText(target)
        const obj = JSON.parse(raw)
        if (obj && typeof obj.trade_date === 'string' && /^\d{8}$/.test(obj.trade_date) && obj.date === localYmd()) return obj.trade_date
      } catch (e) { /* ignore */ }
      return null
    }

    const tool = harness.defineTool({
      name: 'invest_run',
      description: '运行多角色投研流水线。mode 取值：选股/消息/深度分析/总判断/all。question 为用户投研问题（可含多只股票）；context 可选，传入上一轮分析结论或追问背景（记忆与追问）。数据用 Tushare 实时获取。',
      parameters: { type: 'object', properties: { mode: { type: 'string', description: '运行模式' }, question: { type: 'string', description: '用户投研问题（可含多只股票）' }, context: { type: 'string', description: '可选：上一轮分析结论/追问背景，让本轮分析有记忆' } }, required: ['mode', 'question'] },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => {
          const lines = []
          const outputs = Array.isArray(value.outputs) ? value.outputs : []
          const charts = Array.isArray(value.charts) ? value.charts.slice(0, MAX_CHARTS) : []
          const reports = Array.isArray(value.reports) ? value.reports : []
          lines.push('invest_run 模式=' + String(value.mode || '') + ' ｜ 阶段数=' + outputs.length + (charts.length ? ' ｜ 图表=' + charts.length + ' 张' : '') + (reports.length ? ' ｜ 报告已归档' : ''))
          for (const o of outputs) {
            lines.push('')
            lines.push('=== ' + o.stage + (o.ok ? ' ｜ 耗时 ' + (o.elapsedMs / 1000).toFixed(1) + 's' : ' ｜ 失败') + ' ===')
            if (o.error) lines.push('错误：' + o.error)
            if (o.ok && typeof o.text === 'string') {
              lines.push(o.text)
            }
          }
          if (charts.length) {
            lines.push('')
            lines.push('图表文件：' + charts.join(' , '))
          }
          if (reports.length) {
            lines.push('')
            lines.push('报告归档：' + reports.join(' , '))
          }
          if (value.reportError) lines.push('归档错误：' + value.reportError)
          return text(lines.join('\n'))
        },
        presentationMeta: (args, value) => ({
          mode: String(value.mode || ''),
          charts: (Array.isArray(value.charts) ? value.charts.slice(0, MAX_CHARTS) : []).map((p) => ({ path: String(p) })),
          stages: (Array.isArray(value.outputs) ? value.outputs : []).map((o) => ({ stage: o.stage, ok: o.ok === true, elapsedMs: o.elapsedMs, reasoning: typeof o.reasoning === 'string' ? o.reasoning : '' })),
        }),
      },
      async execute(args, exec) {
        const mode = args.mode
        const question = args.question
        const context = typeof args.context === 'string' && args.context.trim() ? args.context.trim().slice(0, 4000) : ''
        const callId = String(exec.callId || '')
        const subs = ctx.get('subagents')
        if (subs === undefined) return { error: 'subagents not mounted' }
        const R = (name, persona) => ({ name, persona })
        // 分组编排：A 组（选股+消息并行）→ B 组（深度）→ C 组（总判断）
        let groups = []
        switch (mode) {
          case '选股': groups = [[R('选股分析师', P_SELECT)]]; break
          case '消息': groups = [[R('市场重点消息获取师', P_NEWS)]]; break
          case '深度分析': groups = [[R('选股分析师', P_SELECT)], [R('股票深度分析师', P_DEEP)]]; break
          case '总判断': groups = [[R('选股分析师', P_SELECT), R('市场重点消息获取师', P_NEWS)], [R('股票深度分析师', P_DEEP)], [R('总判断师', P_FINAL)]]; break
          default: groups = [[R('选股分析师', P_SELECT), R('市场重点消息获取师', P_NEWS)], [R('股票深度分析师', P_DEEP)], [R('总判断师', P_FINAL)]]
        }
        const setProgress = (p) => { progressStore[callId] = Object.assign({ updatedAt: Date.now() }, p) }
        setProgress({ stage: '', index: 0, total: groups.length, status: 'init', done: [] })
        const anchor = await readTradeCache()
        const anchorLine = anchor
          ? '【已缓存锚定】真实最新交易日 = ' + anchor + '（由流水线缓存提供，跳过 index_daily 锚定步骤，直接按此日期取数）'
          : '【交易日缓存为空】按日期锚定铁律完成 index_daily 锚定后，用 pwsh 执行 node -e 把 JSON {"date":"' + localYmd() + '","trade_date":"你的锚定结果YYYYMMDD"} 写入 ' + TRADE_CACHE + '（目录不存在先创建），供本日后续运行复用'
        const history = []
        const outputs = []
        const allCharts = new Set()
        const runStage = async (s) => {
          const t0 = Date.now()
          const parts = ['用户问题：' + question]
          if (context) parts.push('【对话上下文（记忆）】' + context + '\n请结合上述上下文继续分析，保持口径一致。')
          parts.push(anchorLine)
          for (const h of history) {
            parts.push('【' + h.stage + ' 产出（请基于其继续，勿重复取数已覆盖内容）】\n' + h.text)
          }
          parts.push('请按你的角色职责完成分析并输出完整结果。')
          const basePrompt = parts.join('\n\n')
          let lastErr = ''
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const promptText = lastErr ? basePrompt + '\n\n【上次执行失败，错误信息】' + lastErr + '\n请修正后重试。' : basePrompt
              const run = await subs.start('spawn', {
                label: s.name + (attempt > 1 ? '(重试)' : ''),
                prompt: [{ type: 'text', text: promptText }],
                parent: exec.agent,
                signal: exec.signal,
                persona: s.persona,
              })
              const result = await run.result
              const both = extractBoth(result)
              const full = String(both.text)
              collectCharts(full).forEach(c => allCharts.add(c))
              return { stage: s.name, ok: true, elapsedMs: Date.now() - t0, text: full.slice(0, 9000), reasoning: String(both.reasoning).slice(0, 4000) }
            } catch (e) {
              lastErr = String(e).slice(0, 600)
              // 失败分类：权限/频率类错误重试无意义，直接失败；其余（网络/超时/模型）重试
              const nonRetryable = /40203|无权限|权限不足|超限|频率|quota|forbidden|unauthorized|unauthenticated/i.test(lastErr)
              if (nonRetryable || attempt === 2) {
                return { stage: s.name, ok: false, error: lastErr, elapsedMs: Date.now() - t0, retried: attempt > 1 }
              }
            }
          }
          return { stage: s.name, ok: false, error: '未知失败', elapsedMs: Date.now() - t0 }
        }
        for (let gi = 0; gi < groups.length; gi++) {
          const g = groups[gi]
          const groupLabel = g.map(x => x.name).join(' + ')
          setProgress({ stage: groupLabel, index: gi + 1, total: groups.length, status: 'running', done: outputs.filter(o => o.ok).map(o => ({ stage: o.stage, ms: o.elapsedMs })) })
          const results = await Promise.all(g.map(s => runStage(s)))
          for (const r of results) {
            outputs.push(r)
            if (r.ok) history.push({ stage: r.stage, text: r.text })
          }
          setProgress({ stage: groupLabel, index: gi + 1, total: groups.length, status: 'done', elapsedMs: results.reduce((a, r) => Math.max(a, r.elapsedMs || 0), 0), done: outputs.filter(o => o.ok).map(o => ({ stage: o.stage, ms: o.elapsedMs })) })
        }
        setProgress({ stage: '', index: groups.length, total: groups.length, status: 'final', done: outputs.filter(o => o.ok).map(o => ({ stage: o.stage, ms: o.elapsedMs })) })
        // 报告归档（显式携带会话 sandboxPolicy，否则 workspace-write 默认根不含工作区）
        const reports = []
        let reportError = ''
        const fs = ctx.get('fs')
        const sp = ctx.get('sandboxPolicy')
        const policy = (sp !== undefined && exec.agent !== undefined) ? sp.resolve({ session: exec.agent.session }) : undefined
        if (fs !== undefined) {
          try {
            const d = new Date()
            const stamp = localYmd() + '_' + z2(d.getHours()) + z2(d.getMinutes())
            const qkey = String(question).replace(/[^\w\u4e00-\u9fa5]+/g, '_').slice(0, 16) || 'query'
            const reportPath = REPORTS_DIR + '/' + stamp + '_' + qkey + '.md'
            const lines = []
            lines.push('# 投研流水线报告')
            lines.push('')
            lines.push('- 模式：' + mode)
            lines.push('- 时间：' + stamp)
            lines.push('- 问题：' + question)
            if (context) { lines.push('- 上下文：' + context.slice(0, 200).replace(/\n/g, ' ')) }
            for (const o of outputs) {
              lines.push('')
              lines.push('## ' + o.stage + (o.ok ? '（耗时 ' + (o.elapsedMs / 1000).toFixed(1) + 's' + (o.retried ? '，含重试' : '') + '）' : '（失败）'))
              lines.push('')
              lines.push(o.ok ? o.text : ('错误：' + o.error))
              if (o.ok && o.reasoning) {
                lines.push('')
                lines.push('### 推理过程')
                lines.push('')
                lines.push(o.reasoning)
              }
            }
            if (allCharts.size) {
              lines.push('')
              lines.push('## 图表')
              for (const c of Array.from(allCharts)) lines.push('- ' + c)
            }
            lines.push('')
            lines.push('---')
            lines.push('仅供参考，不构成投资建议。')
            const target = await fs.resolve(reportPath)
            await fs.writeText(target, lines.join('\n'), undefined, undefined, policy)
            reports.push(reportPath)
          } catch (e) {
            reportError = String(e).slice(0, 300)
          }
        } else {
          reportError = 'fs unavailable'
        }
        return { mode, stages: outputs.map(o => o.stage), charts: Array.from(allCharts), reports, reportError, outputs }
      },
    })
    harness.registerTool(ctx, tool)
  },
}

