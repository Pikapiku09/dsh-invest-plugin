// 使用说明（v0.72.1）
//
// 每个页面一段功能说明，全局按钮可打开、可翻页查看其余页面。
//
// 为什么写成常量而不是从后端取：
// 说明描述的是**界面结构**，界面改了说明就得改，两者必须同一次提交——放后端会出现
// 「代码已改、线上说明还是旧的」。放在前端源码里，改界面的人就在同一个文件树里。
//
// 文案约定：
// - 正式书面语，分段落书写，每段只讲一件事，便于扫读
// - **不出现脚本名、函数名、字段名**。使用者不该知道 export_strategy_health 是什么，
//   要写「策略快照导出任务」；同理 run_strategy_trials 写「结论验证任务」，
//   refresh_heatmap_snapshot 写「行业热力刷新任务」
// - 只写界面上真实存在的区块；不确定的说法宁可删掉，不写「大概、可能」
import { escapeHtml } from './format';
import { icon } from './icons';

export interface HandbookPage {
  /** 与导航的 view 键一致；用于「打开时定位到当前页」 */
  view: string;
  title: string;
  /** 分段正文：一段一个意思，渲染成多个 <p>，避免整块文字墙 */
  paragraphs: string[];
}

export const HANDBOOK_PAGES: HandbookPage[] = [
  {
    view: 'overview',
    title: '概览',
    paragraphs: [
      '本页为工作台首页，用于回顾最近一次研究结论，并识别需要处置的信号。',
      '页面上方展示上次分析的标的、立场、目标价与止损价，可直接阅读报告或发起追问。中部「行业暴露」将实盘持仓映射至所属行业的当日涨跌，用于判断仓位是否集中于走弱板块；「最近运行」列出最近五次流水线记录；「标的档案监控」列出观察与持有标的的买入区间或止盈止损、当前距离及最新信号。',
      '「行业暴露」所需数据由 LihuQuantify 的行业热力刷新任务提供。若该区域显示为空，需先在 LihuQuantify 执行一次热力刷新。',
    ],
  },
  {
    view: 'archive',
    title: '标的档案',
    paragraphs: [
      '本页用于追溯单一标的的历史判断，并确认当前是否应当操作。',
      '左侧分为实时持仓、观察清单与标的索引。标的索引最多展示 80 个，可通过搜索缩小范围。',
      '选定标的后，「结论链时间线」按时间顺序列出每次判断的立场、目标价、止损价、核心论据、失效条件及与上次结论的差异，可跳转原文；「相关运行」列出该标的的全部任务记录；监控规则支持切换观察或持有状态、录入买入区间或止盈止损，价格进入区间时触发提醒，价位倒挂时显示警示条。',
      '基本面评级仅用于排除风险，其卡片声明不构成买卖信号。',
    ],
  },
  {
    view: 'backtest',
    title: '判断质量',
    paragraphs: [
      '本页衡量 AI 结论的准确程度，不涉及策略回测。',
      '每条结论以其后第 5、20 个交易日的实际走势为基准，计算命中率、盈亏比与单笔期望，并标注样本数与 95% 置信区间。样本少于 30 条的分组仅作记录，不作结论。顶部「数据从哪来」列示覆盖率与未入库的运行，支持导出与导入；中部按角色、市场状态、置信度与立场分组。',
      '页面底部为执行结果。「影子交易」按次日收盘价买入 100 股，依据止盈、止损或持有期限离场，结果为毛收益；「撮合模拟」在此基础上叠加单票资金上限、同时持仓数量、佣金、印花税与滑点，得到净收益。',
      '上述两项数据由 LihuQuantify 的结论验证任务生成，未运行时该区域为空。',
    ],
  },
  {
    view: 'strategy-health',
    title: '量化策略',
    paragraphs: [
      '本页为 LihuQuantify 模拟盘的只读镜像，与实盘账户严格分离，页面常驻模拟盘标识。',
      '数据由 LihuQuantify 的策略快照导出任务提供。超过 48 小时未更新时，页面会提示数据陈旧，此时需重新导出一次。',
      '页面分三个子页。「总览」包含今日巡检、权益与回撤、风控集中度、研究纪律与行为体检；其中「短线策略闸门」仅作用于短线策略，波段池不设市场闸门，其约束为高价股价格上限与赔率不低于 3:1。「波段池」页顶部为证伪横幅，该策略已暂停实盘、仅作纸面跟踪，不应据以建仓。「回测」页依次展示实盘策略指标与参数网格，并常驻提示结果存在幸存者偏差、不可外推。',
    ],
  },
  {
    view: 'tasks',
    title: '一键任务',
    paragraphs: [
      '本页用于发起投研流水线。选择模板卡、补充所需标的代码后点击「开始分析」，进度可在「最近任务」查看，完成后可阅读报告或发起追问。',
      '页面顶部为「观察仓日检」：每日定时由规则层刷新观察仓现价与买入区间，仅将进入买入区间或跌破失效价的标的排入深度判断，其余不消耗模型调用。该入口不在模板网格中，位于顶部状态条。',
      '模板自带的模式与角色不可在页面修改；如需变更，须在对话中明确指定角色。',
    ],
  },
  {
    view: 'ask',
    title: '个股知识库',
    paragraphs: [
      '本页用于按标的检索已沉淀的结论与问答。',
      '左侧支持按名称或代码搜索、按首字母分组，持有与观察中的标的带标记，已生成内容的标的显示段数。选定标的后，右侧为追问区；知识库与图表位于右上角「知识库」入口。',
      '回答仅依据该标的知识库：未覆盖的内容会明确说明，涉及更晚行情时会提示更新。本页为追问检索，不提供实时行情；知识库超过 3 天或存在未并入的新分析时会提示整理。',
    ],
  },
  {
    view: 'model-settings',
    title: '模型设置',
    paragraphs: [
      '本页用于配置模型路由，分为宿主模型、知识库整理、角色与模板三部分。',
      '「继承宿主」的角色与一键任务均使用宿主模型，也可选择跟随会话宿主。知识库整理单独配置模型、推理强度、并发数与后台自动整理。五个角色可分别指定模型与强度，强度默认为「不下发」，由模型自行决定；每个模板可另选预设档。',
      '修改内容为路由配置，须点击「保存设置」方可生效，仅作用于此后发起的任务，已生成的报告不会重算。',
    ],
  },
  {
    view: 'holdings',
    title: '持仓工作区',
    paragraphs: [
      '本页为实盘账户视图。顶部「实盘绩效」取自真实交割单，非回测亦非模拟盘，包含权益曲线、近十二个月收益与回撤。',
      '该区域包含两个口径，须区分：「当前总资产」取自持仓账本，为权威数值；「重建模型累计」为依据交割单重算的路径，其初始资金 11 万元为假设值，且不含天天宝理财与银证转账。两者不一致时页面会标注差额，重建模型的绝对权益不可视为账户事实。',
      '下方依次为账户汇总、当前账本与导入入口。当前账本可自定义列、排序与刷新现价；导入支持截图、东财 CSV、手动改表与手动新增四种来源，均须通过差异预览并确认后，方可写入账本。',
    ],
  },
];

/** 由页面 view 键定位到对应说明；找不到时回到第一页 */
export function handbookIndexForView(view: string): number {
  const i = HANDBOOK_PAGES.findIndex((p) => p.view === view);
  return i >= 0 ? i : 0;
}

export function renderHandbookPanel(index: number): string {
  const total = HANDBOOK_PAGES.length;
  const i = ((index % total) + total) % total;   // 循环翻页，不越界
  const page = HANDBOOK_PAGES[i];
  const body = page.paragraphs.map((p) => `<p class="handbook-para">${escapeHtml(p)}</p>`).join('');
  return `<div class="whatsnew-mask" data-modal="handbook">
    <div class="whatsnew-card handbook-card" role="dialog" aria-modal="true" aria-label="使用说明">
      <div class="whatsnew-head">
        <span class="whatsnew-h">${icon('book', 16)} 使用说明 · ${escapeHtml(page.title)}</span>
        <button class="whatsnew-x" type="button" data-action="handbook-close" aria-label="关闭">${icon('close', 16)}</button>
      </div>
      <div class="whatsnew-body">
        ${body}
        <div class="handbook-pager">
          <button class="button button-secondary" type="button" data-action="handbook-prev">上一页</button>
          <span class="handbook-count">${i + 1} / ${total} · ${escapeHtml(page.title)}</span>
          <button class="button button-secondary" type="button" data-action="handbook-next">下一页</button>
        </div>
      </div>
    </div>
  </div>`;
}
