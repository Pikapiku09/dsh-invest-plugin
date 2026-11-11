import { emptyState, errorState, pageHeader, runStatusBadge, sectionHeading, skeletonPage, stanceBadge } from './components';
import { escapeHtml, formatDateTime, formatDuration, truncate } from './format';
import { icon } from './icons';
import { allRunRows } from './run-history';
import { reportForRun, sortConclusions } from './selectors';
import type { AppState } from './state';
import type { ConclusionRecord, IndexResponse, RunRecord, WatchAlert, WatchlistItem } from './types';
import { alertMessageWithQty, alertQty, watchDistance, watchDistSwitch, type WatchDistMode } from './watch-metrics';

function stockName(index: IndexResponse, code?: string): string {
  return code ? (index.codes?.[code]?.name || code) : '未识别标的';
}

function runCode(run: RunRecord, records: ConclusionRecord[]): string {
  return run.codes?.[0] || records.find((record) => String(record.run_id) === String(run.id))?.code || '';
}

function runConclusion(run: RunRecord, records: ConclusionRecord[]): ConclusionRecord | undefined {
  const code = runCode(run, records);
  return sortConclusions(records.filter((record) => String(record.run_id) === String(run.id) && (!code || record.code === code)))[0];
}


function latestPerCode(records: ConclusionRecord[]): ConclusionRecord[] {
  const seen = new Set<string>();
  return sortConclusions(records).filter((record) => {
    if (!record.code || seen.has(record.code)) return false;
    seen.add(record.code);
    return true;
  });
}

const val = (v: unknown): string => (v === null || v === undefined || v === '') ? '—' : String(v);
const pctText = (v: number | null): string => (v === null || !Number.isFinite(v)) ? '—' : (v > 0 ? '+' : '') + v + '%';

/** 监控规则列：观察 → 买入区间/失效价；持有 → 按当前口径把目标(止盈)或止损放在前面 */
function watchRuleCell(it: WatchlistItem, mode: WatchDistMode): string {
  if (it.state === '观察') {
    const w = it.watch;
    const zone = (w.buy_low !== null && w.buy_high !== null) ? (w.buy_low + ' ~ ' + w.buy_high) : '待补录买入区间';
    return '<div class="target-cell"><span>买区 <b>' + escapeHtml(zone) + '</b></span><small>失效价 ' + escapeHtml(val(w.stop)) + '</small></div>';
  }
  const p = it.position;
  return mode === 'target'
    ? '<div class="target-cell"><span>目标 <b>' + escapeHtml(val(p.target)) + '</b></span><small>止损 ' + escapeHtml(val(p.stop)) + '</small></div>'
    : '<div class="target-cell"><span>止损 <b>' + escapeHtml(val(p.stop)) + '</b></span><small>目标 ' + escapeHtml(val(p.target)) + '</small></div>';
}

/** 距离列：观察 → 距买点；持有 → 按口径距止盈/距止损（正值 = 尚有空间） */
function watchDistCell(it: WatchlistItem, mode: WatchDistMode): string {
  const d = watchDistance(it, mode);
  if (d === null) return '<span class="muted">—</span>';
  // 观察：现价已低于/触及买区下沿（d<=0）值得关注；持有：剩余空间 <=3% 值得关注
  const near = it.state === '观察' ? d <= 0 : d <= 3;
  return '<span class="watch-dist ' + (near ? 'watch-dist-near' : '') + '">' + escapeHtml(pctText(d)) + '</span>';
}

const SIGNAL_LABEL: Record<string, string> = { buy: '买入', invalidate: '观察失效', stop: '止损', target: '止盈', add: '加仓', trim: '减仓' };

/** 最新信号列：取该标的最近一条提醒，未读高亮；标注购买仓位数 */
function watchSignalCell(it: WatchlistItem, alerts: WatchAlert[]): string {
  const a = alerts.find((x) => x.code === it.code);
  if (!a) return '<span class="muted">—</span>';
  const tone = a.level === 'bad' ? 'watch-sig-bad' : a.level === 'good' ? 'watch-sig-good' : 'watch-sig-info';
  const qtyValue = alertQty(a, [it]);
  const qty = qtyValue === null ? '' : qtyValue + '股';
  return '<span class="watch-signal ' + tone + (a.read ? '' : ' unread') + '" title="' + escapeHtml(a.message) + '">'
    + escapeHtml(SIGNAL_LABEL[a.kind] || a.kind) + (qty ? ' · ' + escapeHtml(qty) : '') + ' · ' + escapeHtml(formatDateTime(a.ts, true)) + '</span>';
}

function watchRow(it: WatchlistItem, alerts: WatchAlert[], mode: WatchDistMode): string {
  const m = it.monitor;
  return '<tr class="clickable-row" data-action="select-code" data-code="' + escapeHtml(it.code) + '">'
    + '<td>' + stanceBadge(it.state) + '</td>'
    + '<td><div class="stock-cell"><strong>' + escapeHtml(it.name || it.code) + '</strong><small>' + escapeHtml(it.code) + '</small></div></td>'
    + '<td><div class="watch-price"><b>' + escapeHtml(val(m.current_price)) + '</b><small>' + (m.refreshed_at ? escapeHtml(formatDateTime(m.refreshed_at, true)) : '未刷新') + '</small></div></td>'
    + '<td>' + watchRuleCell(it, mode) + '</td>'
    + '<td>' + watchDistCell(it, mode) + '</td>'
    + '<td>' + watchSignalCell(it, alerts) + '</td>'
    + '<td class="table-action">' + icon('arrow', 15) + '</td></tr>';
}

/** 标的档案监控面板：替代原「最近结论」+「最新观点分布」，消除重复列表 */
function watchPanel(state: AppState): string {
  const doc = state.watchlist;
  if (!doc) {
    return '<section class="panel overview-conclusions" id="overview-watchlist">'
      + sectionHeading('标的档案监控', '观察 + 持仓统一管理 · 每日收盘刷新现价 · 落入区间触发提醒')
      + (state.watchlistLoading ? '<p class="muted compact">正在读取标的档案…</p>'
        : emptyState('标的档案尚未就绪', state.watchlistError
          ? '监控接口读取失败：' + state.watchlistError + '（改动 index.js 后需重启 DSH GUI 才生效）'
          : '完成一次投研或手动建档后，这里会显示观察与持仓标的的监控状态。', 'layers'))
      + '</section>';
  }
  // 名称兜底：结论流水不带 name 时档案 name 会退化成代码，用主库索引补全
  const index = state.index;
  const items = (doc.items || [])
    .filter((it) => it.state === '观察' || it.state === '持有')
    .map((it) => ({ ...it, name: (it.name && it.name !== it.code) ? it.name : (index ? stockName(index, it.code) : it.code) }));
  const alerts = doc.alerts || [];
  const unread = alerts.filter((a) => !a.read).length;
  const watchCount = items.filter((it) => it.state === '观察').length;
  const holdCount = items.filter((it) => it.state === '持有').length;
  const actions = '<div class="watch-actions">'
    + (unread ? '<span class="watch-unread">' + icon('alert', 14) + ' ' + unread + ' 条未读</span><button class="text-button" data-action="watch-alerts-read">全部已读</button>' : '')
    + '<button class="button button-secondary" data-action="refresh-watchlist"' + (state.watchlistRefreshing ? ' disabled' : '') + '>'
    + icon('sparkles', 14) + (state.watchlistRefreshing ? ' 刷新中…' : ' 刷新现价') + '</button></div>';
  const summary = '<div class="watch-summary">观察 <b>' + watchCount + '</b> · 持有 <b>' + holdCount + '</b> · 今日信号 <b>' + alerts.length + '</b>'
    + ' · 档案更新 ' + escapeHtml(doc.updated_at ? formatDateTime(doc.updated_at, true) : '—') + '</div>';
  const mode = state.watchDistMode;
  const distHead = mode === 'target' ? '距止盈' : '距止损';
  const table = items.length
    ? '<div class="table-scroll"><table class="data-table"><thead><tr><th>状态</th><th>标的</th><th>现价</th><th>监控规则</th>'
      + '<th title="正值＝尚有空间；观察标的按买入区间计算">' + distHead + '</th><th>最新信号</th><th></th></tr></thead><tbody>'
      + items.map((it) => watchRow(it, alerts, mode)).join('') + '</tbody></table></div>'
    : emptyState('档案中暂无观察或持有标的', '观察/看多结论会自动建档，也可在标的档案页手动新建。', 'layers');
  const unreadBar = unread ? '<div class="watch-unread-bar">' + icon('alert', 15)
    + alerts.filter((a) => !a.read).slice(0, 3).map((a) => '<span class="watch-unread-item ' + (a.level === 'bad' ? 'watch-sig-bad' : 'watch-sig-good') + '">' + escapeHtml(alertMessageWithQty(a, items)) + '</span>').join('')
    + '</div>' : '';
  return '<section class="panel overview-conclusions" id="overview-watchlist">'
    + sectionHeading('标的档案监控', '观察 + 持仓统一管理 · 每日收盘刷新现价 · 落入区间触发提醒', actions)
    + summary + watchDistSwitch(mode, 'watch-mode-overview') + unreadBar + table + '</section>';
}

export function renderOverview(state: AppState): string {
  if (state.indexLoading && !state.index) return skeletonPage();
  if (!state.index) return pageHeader('投研概览', '聚合研究结论、运行记录与归档报告。') + errorState('暂时无法读取主库索引', state.indexError || '索引接口尚未就绪，请稍后重试。');

  const { index } = state;
  const records = sortConclusions(index.records || []);
  // 运行历史统一走 run-history：索引 runs + 缺日志的近期报告回填，避免停在最后一次成功写日志的时间
  const rows = allRunRows(index);
  const latestRecords = latestPerCode(records);
  const lastRun = rows[0];
  const lastCode = lastRun ? runCode(lastRun, records) : '';
  // 回填行没有 run_id，退化为「该代码最新一条结构化结论」
  const lastRecord = lastRun ? (runConclusion(lastRun, records) || (lastCode ? latestRecords.find((record) => record.code === lastCode) : undefined)) : undefined;
  const lastReport = lastRun ? reportForRun(index, lastRun) : null;
  const lastBackfilled = lastRun?.backfilled === true;
  const warning = state.indexError ? '<div class="inline-warning">' + icon('alert', 16) + '索引刷新失败，当前展示上次数据：' + escapeHtml(state.indexError) + '</div>' : '';
  const header = pageHeader('投研概览', '先看最近判断，再追溯证据；每一次分析都能一键回到标的、报告，或直接追问。', '<button class="button button-primary" data-action="navigate" data-view="tasks">' + icon('sparkles', 16) + '发起新分析</button>');
  // 顶部统计卡已移除（标的档案 / 待处理提醒 / 累计运行）：档案规模与待处理提醒在下方监控面板可见，
  // 累计运行改为左侧栏环形进度（含任务类型分类），概览只保留「上次分析 + 最近运行 + 档案监控」三段式。

  const openLast = lastBackfilled
    ? '<button class="button button-primary" data-action="open-report-id" data-id="' + escapeHtml(lastRun?.report_id ?? '') + '">' + icon('file', 15) + '阅读报告</button>'
    : (lastReport ? '<button class="button button-primary" data-action="open-run" data-id="' + escapeHtml(lastRun?.id ?? '') + '">' + icon('file', 15) + '阅读报告</button>' : '');
  const askLast = lastReport ? '<button class="button button-secondary" data-action="ask-report" data-path="' + escapeHtml(lastReport.path) + '">' + icon('chat', 15) + '追问这份报告</button>' : '';
  const lastAnalysis = lastRun ? '<section class="panel last-analysis"><div class="last-analysis-label"><span>' + icon('sparkles', 15) + '上次分析</span><time>' + formatDateTime(lastRun.ts_local || lastRun.created_at) + (lastBackfilled ? ' · 报告回填' : '') + '</time></div><div class="last-analysis-main"><div class="last-analysis-copy"><div class="last-stock"><strong>' + escapeHtml(stockName(index, lastCode)) + '</strong><span class="mono">' + escapeHtml(lastCode || '—') + '</span>' + (lastRecord ? stanceBadge(lastRecord.stance) : '<span class="stance-badge stance-neutral">未形成结构化结论</span>') + '</div><h2>' + escapeHtml(lastRun.question || '未命名研究任务') + '</h2><p>' + escapeHtml(truncate(lastRecord?.thesis || '本次运行没有提取到结论摘要，可直接打开报告查看完整分析。', 180)) + '</p><div class="last-levels"><span>目标 <b>' + escapeHtml(lastRecord?.target ?? '—') + '</b></span><span>止损 <b>' + escapeHtml(lastRecord?.stop ?? '—') + '</b></span><span>耗时 <b>' + formatDuration(lastRun.elapsed_ms) + '</b></span></div></div><div class="last-analysis-actions">' + openLast + askLast + (lastCode ? '<button class="button button-secondary" data-action="select-code" data-code="' + escapeHtml(lastCode) + '">' + icon('archive', 15) + '查看档案</button>' : '') + '</div></div></section>' : '';

  const runItems = rows.slice(0, 5).map((run) => {
    const code = runCode(run, records);
    const record = runConclusion(run, records) || (code ? latestRecords.find((item) => item.code === code) : undefined);
    const hasReport = Boolean(reportForRun(index, run));
    const action = run.backfilled ? 'open-report-id' : 'open-run';
    const actionId = run.backfilled ? String(run.report_id ?? '') : String(run.id);
    return '<button class="recent-run" data-action="' + action + '" data-id="' + escapeHtml(actionId) + '"><span class="recent-run-top"><span class="mode-tag">' + escapeHtml(run.mode || '未标模式') + '</span>' + (record ? stanceBadge(record.stance) : runStatusBadge(run)) + '</span><strong>' + escapeHtml(stockName(index, code)) + '</strong><span class="recent-run-code">' + escapeHtml(code || '组合/市场') + '</span><span class="recent-run-question">' + escapeHtml(truncate(run.question || '未命名研究任务', 48)) + '</span><span class="recent-run-meta"><span>' + formatDateTime(run.ts_local || run.created_at, true) + '</span><span>' + (hasReport ? '可读报告' : '无归档') + ' · ' + formatDuration(run.elapsed_ms) + '</span></span></button>';
  }).join('');
  const recentRuns = '<section class="panel overview-runs">' + sectionHeading('最近运行', '最近 5 次流水线：标的、结论与报告入口', '<button class="text-button" data-action="goto-runs">全部记录' + icon('arrow', 14) + '</button>') + '<div class="recent-run-strip">' + (runItems || emptyState('暂无运行记录', '从一键任务开始第一次分析。', 'runs')) + '</div></section>';

  return header + warning + lastAnalysis + recentRuns + watchPanel(state);
}