import { emptyState, errorState, pageHeader, runStatusBadge, sectionHeading, skeletonPage, stanceBadge } from './components';
import { escapeHtml, formatDateTime, formatDuration, truncate } from './format';
import { icon } from './icons';
import { allRunRows } from './run-history';
import { reportForRun, sortConclusions } from './selectors';
import type { AppState } from './state';
import type { ConclusionRecord, IndexResponse, LiveHoldingRow, LiveLogEntry, LiveSignalRef, LiveWatchRow, RunRecord, WatchAlert, WatchlistItem } from './types';
import { alertMessageWithQty, alertQty, positionTargetSane, watchDistance, watchDistSwitch, type WatchDistMode } from './watch-metrics';

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

/** 监控规则列：观察 → 买入区间/失效价；持有 → 按当前口径把目标(止盈)或止损放在前面
 *  止盈价倒挂（低于成本/止损）时直接标「价位异常」，不再当正常目标展示（v0.53.0） */
function watchRuleCell(it: WatchlistItem, mode: WatchDistMode): string {
  if (it.state === '观察') {
    const w = it.watch;
    const zone = (w.buy_low !== null && w.buy_high !== null) ? (w.buy_low + ' ~ ' + w.buy_high) : '待补录买入区间';
    return '<div class="target-cell"><span>买区 <b>' + escapeHtml(zone) + '</b></span><small>失效价 ' + escapeHtml(val(w.stop)) + '</small></div>';
  }
  const p = it.position;
  if (mode === 'target' && !positionTargetSane(it)) {
    return '<div class="target-cell"><span>目标 <b class="target-bad" title="止盈目标低于成本或止损价，价位语义异常，请在档案里修正">' + escapeHtml(val(p.target)) + '</b></span><small>价位异常，需修正</small></div>';
  }
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
  // v0.53.0：持有标的止盈价倒挂（低于成本/止损）时在面板顶部亮黄条，点标的进档案修正
  const badLevelItems = items.filter((it) => it.state === '持有' && !positionTargetSane(it) && it.position.target !== null);
  const badLevelBar = badLevelItems.length
    ? '<div class="inline-warning">' + icon('alert', 15) + '<span>' + badLevelItems.length + ' 只持有标的的止盈价低于成本或止损价（价位倒挂，多为回踩位误写）：'
      + badLevelItems.slice(0, 4).map((it) => '<button class="text-button" data-action="select-code" data-code="' + escapeHtml(it.code) + '">' + escapeHtml(it.name || it.code) + '（目标 ' + escapeHtml(val(it.position.target)) + '）</button>').join('、')
      + '。距离计算与止盈提醒已暂停，请在档案「编辑规则」里修正。</span></div>'
    : '';
  return '<section class="panel overview-conclusions" id="overview-watchlist">'
    + sectionHeading('标的档案监控', '观察 + 持仓统一管理 · 每日收盘刷新现价 · 落入区间触发提醒', actions)
    + summary + watchDistSwitch(mode, 'watch-mode-overview') + badLevelBar + unreadBar + table + '</section>';
}


/**
 * 盘中盯盘（live-watch）：把「现价 vs 账本计划」的事实差距放在概览第一屏。
 *
 * 设计取舍：
 * - 只做事实对照，不给新买卖建议；判断权留给人。
 * - 生效止损取「执行口径」= 档案 position.stop ?? watch.stop，因为提醒比对的就是它；
 *   最新结论给的止损并列展示，相差 >3% 打 ⚠ —— 不自动合并（合并规则属于纪律，不属于代码）。
 * - 盘中价只算偏离度，不据此算技术指标（MA/量能一律用日线收盘）。
 */
const liveNumText = (v: number | null, digits = 2): string =>
  (v === null || !Number.isFinite(v)) ? '—' : v.toFixed(digits);

/** 万元口径：看板头要一眼看懂钱，不要 104,731.28 这种数字 */
const liveMoney = (v: number | null): string => {
  if (v === null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 10000) return (v / 10000).toFixed(2) + ' 万';
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
};

/** A 股口径：涨红跌绿 */
const liveTone = (v: number | null): string =>
  (v === null || !Number.isFinite(v) || v === 0) ? 'live-flat' : (v > 0 ? 'live-up' : 'live-down');

const livePctText = (v: number | null, digits = 2): string =>
  (v === null || !Number.isFinite(v)) ? '—' : (v > 0 ? '+' : '') + v.toFixed(digits) + '%';

function liveSignalChip(sig: LiveSignalRef | null): string {
  if (!sig) return '<span class="muted">—</span>';
  // 复用档案页已有的信号配色（watch-sig-*），保证同一个 kind 在两个页面颜色一致
  const tone = sig.kind === 'stop' || sig.kind === 'trim' ? 'watch-sig-bad' : sig.kind === 'buy' || sig.kind === 'target' ? 'watch-sig-good' : 'watch-sig-info';
  return '<span class="watch-signal ' + tone + '" title="' + escapeHtml(sig.at || '') + '">' + escapeHtml(SIGNAL_LABEL[sig.kind] || sig.kind) + '</span>';
}

function liveHoldingRow(h: LiveHoldingRow, asking: string): string {
  const stopTone = h.dist_stop_pct === null ? '' : (h.dist_stop_pct <= 0 ? 'live-bad' : h.dist_stop_pct <= 5 ? 'live-warn' : 'live-flat');
  const conflict = h.stop_conflict
    ? '<span class="live-flag" title="' + escapeHtml('档案/执行止损 ' + val(h.eff_stop) + '（' + h.eff_stop_src + '）与最新结论止损 ' + val(h.concl_stop) + ' 相差超过 3%，请决定以哪个为准') + '">⚠</span>'
    : '';
  return '<tr class="clickable-row" data-action="select-code" data-code="' + escapeHtml(h.code) + '">'
    + '<td><div class="stock-cell"><strong>' + escapeHtml(h.name) + '</strong><small>' + escapeHtml(h.code) + '</small></div></td>'
    + '<td><div class="watch-price"><b>' + escapeHtml(liveNumText(h.price, 3)) + '</b><small class="' + liveTone(h.change_pct) + '">' + escapeHtml(livePctText(h.change_pct)) + '</small></div></td>'
    + '<td><div class="watch-price"><b>' + escapeHtml(liveNumText(h.cost, 3)) + '</b><small>' + escapeHtml(liveNumText(h.shares, 0)) + '股</small></div></td>'
    + '<td class="' + liveTone(h.pnl_pct) + '">' + escapeHtml(livePctText(h.pnl_pct))
    + '<small class="live-sub ' + liveTone(h.pnl) + '">' + escapeHtml(liveMoney(h.pnl)) + '</small></td>'
    + '<td class="num">' + escapeHtml(liveNumText(h.weight_pct, 1)) + '%</td>'
    + '<td><div class="watch-price"><b>' + escapeHtml(liveNumText(h.eff_stop, 3)) + conflict + '</b><small>' + escapeHtml(h.eff_stop_src) + (h.concl_stop !== null && h.stop_conflict ? ' / 结论 ' + escapeHtml(val(h.concl_stop)) : '') + '</small></div></td>'
    + '<td class="' + stopTone + '">' + escapeHtml(h.dist_stop_pct === null ? '—' : livePctText(h.dist_stop_pct))
    + '<small class="live-sub">' + escapeHtml(h.stop_state) + '</small></td>'
    + '<td>' + liveSignalChip(h.signal) + '</td>'
    + '<td class="table-action"><button class="text-button live-why" data-action="live-ask" data-code="' + escapeHtml(h.code) + '"' + (asking === h.code ? ' disabled' : '') + '>' + escapeHtml(asking === h.code ? '思考中…' : '为什么') + '</button></td></tr>';
}

function liveWatchRow(w: LiveWatchRow): string {
  const zone = (w.buy_low !== null && w.buy_high !== null) ? liveNumText(w.buy_low, 3) + ' ~ ' + liveNumText(w.buy_high, 3) : '未设买区';
  const distTone = w.in_buy_zone ? 'live-good' : (w.dist_buy_pct !== null && w.dist_buy_pct > -3 ? 'live-warn' : 'live-flat');
  return '<tr class="clickable-row" data-action="select-code" data-code="' + escapeHtml(w.code) + '">'
    + '<td><div class="stock-cell"><strong>' + escapeHtml(w.name) + '</strong><small>' + escapeHtml(w.code) + '</small></div></td>'
    + '<td><div class="watch-price"><b>' + escapeHtml(liveNumText(w.price, 3)) + '</b><small class="' + liveTone(w.change_pct) + '">' + escapeHtml(livePctText(w.change_pct)) + '</small></div></td>'
    + '<td class="' + (w.in_buy_zone ? 'live-good' : '') + '">' + escapeHtml(zone) + (w.in_buy_zone ? ' <span class="watch-signal watch-sig-good">已到价</span>' : '') + '</td>'
    + '<td class="' + distTone + '">' + escapeHtml(livePctText(w.dist_buy_pct)) + '</td>'
    + '<td>' + liveSignalChip(w.signal) + '</td></tr>';
}

const LIVE_LOG_TAG: Record<string, string> = { broadcast: '播报', event: '事件', 'tick-error': '异常', ask: '快问', explain: '解释' };

function liveLogItem(e: LiveLogEntry): string {
  const tone = e.level === 'bad' ? 'live-bad' : e.level === 'warn' ? 'live-warn' : e.level === 'good' ? 'live-good' : 'live-flat';
  const body = e.kind === 'broadcast' ? (e.text || '')
    : e.kind === 'ask' || e.kind === 'explain' ? '问：' + (e.question || '') + '｜答：' + (e.answer || '')
      : (e.message || e.text || '');
  return '<li class="live-log-item"><span class="live-log-time">' + escapeHtml(formatDateTime(e.ts, true)) + '</span>'
    + '<span class="live-log-tag ' + tone + '">' + escapeHtml(LIVE_LOG_TAG[e.kind] || e.kind) + '</span>'
    + '<span class="live-log-text">' + escapeHtml(truncate(body, 220)) + '</span></li>';
}

function livePanel(state: AppState): string {
  const doc = state.liveWatch;
  if (!doc) {
    // 接口未就绪时退回旧档案面板：页面不会空，也不会因为一次失败就看不到监控状态
    const hint = state.liveWatchLoading ? '正在读取盘中盯盘状态…'
      : (state.liveWatchError || '盘中盯盘接口尚未就绪') + (state.liveWatchError ? '（改动 index.js 后需重启 DSH GUI 才生效）' : '');
    return '<section class="panel live-panel"><div class="live-head"><div class="live-head-main"><span class="live-indicator"><i></i>盘中盯盘未就绪</span></div></div>'
      + '<p class="muted compact">' + escapeHtml(hint) + '</p></section>' + watchPanel(state);
  }
  const s = doc.settings;
  const snap = doc.snapshot;
  const sess = doc.session;
  const running = s.enabled && sess.inSession;
  const a = snap.account;
  const head = '<div class="live-head">'
    + '<div class="live-head-main">'
    + '<span class="' + (running ? 'live-indicator active' : 'live-indicator') + '"><i></i>' + escapeHtml(sess.label) + ' ' + escapeHtml(sess.hm) + (s.enabled ? '' : ' · 已暂停') + '</span>'
    + '<div class="live-account">'
    + '<span>总资产 <b>' + escapeHtml(liveMoney(a.total_asset)) + '</b></span>'
    + '<span>现金 <b>' + escapeHtml(liveMoney(a.cash)) + '</b></span>'
    + '<span>仓位 <b>' + escapeHtml(liveNumText(a.position_pct, 1)) + '%</b></span>'
    + '<span>浮动 <b class="' + liveTone(a.float_pnl) + '">' + escapeHtml((a.float_pnl !== null && a.float_pnl > 0 ? '+' : '') + liveMoney(a.float_pnl)) + '</b></span>'
    + '</div></div>'
    + '<div class="live-actions">'
    + ['极简', '标准', '盯盘'].map((p) => '<button class="live-preset' + (s.preset === p ? ' active' : '') + '" data-action="live-preset" data-preset="' + p + '"' + (state.liveWatchSaving ? ' disabled' : '') + '>' + p + '</button>').join('')
    + '<button class="button ' + (s.enabled ? 'button-secondary' : 'button-primary') + '" data-action="live-toggle"' + (state.liveWatchSaving ? ' disabled' : '') + '>'
    + icon(s.enabled ? 'close' : 'play', 14) + (s.enabled ? ' 暂停盯盘' : ' 开启盯盘') + '</button>'
    + '<button class="button button-secondary" data-action="live-tick"' + (state.liveWatchTicking ? ' disabled' : '') + '>'
    + icon('refresh', 14) + (state.liveWatchTicking ? ' 抓取中…' : ' 立即刷新') + '</button>'
    + '</div></div>';
  const meta = '<p class="live-meta">每 ' + s.intervalSec + ' 秒判定 · 播报节奏 ' + (s.broadcastEveryMin > 0 ? s.broadcastEveryMin + ' 分钟' : '仅事件')
    + ' · 最近 tick ' + escapeHtml(s.lastTickAt ? formatDateTime(s.lastTickAt, true) : '—')
    + ' · 今日 ' + s.tickCount + ' 次判定 / ' + s.eventCount + ' 条事件 / 快问 ' + s.llmCount + '/' + s.llmDailyCap
    + (s.lastError ? ' · <span class="live-bad">上次失败：' + escapeHtml(truncate(s.lastError, 80)) + '</span>' : '')
    + '</p>';
  const conflictBar = snap.conflicts.length
    ? '<div class="inline-warning">' + icon('alert', 15) + '<span><b>' + snap.conflicts.length + ' 项止损口径冲突</b>（档案执行口径 vs 最新结论，未自动合并）：'
      + snap.conflicts.slice(0, 3).map((c) => escapeHtml(c)).join('；') + '。点标的进档案决定以哪个为准。</span></div>'
    : '';
  const holdingsTable = snap.holdings.length
    ? '<div class="table-scroll"><table class="data-table live-table"><thead><tr><th>标的</th><th>现价 / 今日</th><th>成本 / 股数</th>'
      + '<th title="浮动盈亏（元）与收益率">浮盈</th><th>权重</th><th>生效止损</th><th>距止损</th><th>今日信号</th><th></th></tr></thead><tbody>'
      + snap.holdings.map((h) => liveHoldingRow(h, state.liveAsking)).join('') + '</tbody></table></div>'
    : emptyState('账本里没有在持标的', '先在持仓工作区确认账本，盯盘会按账本逐只比对。', 'layers');
  const watchTable = snap.watch.length
    ? '<details class="live-watch-details"><summary>观察池 ' + snap.watch.length + ' 只 · ' + snap.watch.filter((w) => w.in_buy_zone).length + ' 只已到价</summary>'
      + '<div class="table-scroll"><table class="data-table live-table"><thead><tr><th>标的</th><th>现价 / 今日</th><th>买入区</th><th>距买区</th><th>今日信号</th></tr></thead><tbody>'
      + snap.watch.map(liveWatchRow).join('') + '</tbody></table></div></details>'
    : '';
  const log = (doc.log || []).slice(0, 12);
  const timeline = log.length
    ? '<ul class="live-log">' + log.map(liveLogItem).join('') + '</ul>'
    : '<p class="muted compact">还没有播报记录。开启盯盘后，每 ' + s.broadcastEveryMin + ' 分钟会在这里留一条事实对照，触发规则时立即记一条事件。</p>';
  const answer = state.liveAnswer
    ? '<div class="live-answer"><div class="live-answer-head">' + icon('chat', 14) + '<b>' + escapeHtml(state.liveAnswer.code) + '</b><span>盘中快问</span></div>'
      + '<p>' + escapeHtml(state.liveAnswer.text || state.liveAnswer.error || '') + '</p></div>'
    : '';
  return '<section class="panel live-panel" id="overview-live">'
    + sectionHeading('盘中盯盘', '规则层每 ' + s.intervalSec + ' 秒抓一次现价 · 只做事实对照，不给新建议', '')
    + head + meta + conflictBar + holdingsTable + watchTable
    + '<div class="live-log-wrap">' + '<h3 class="live-sub-head">盘中时间线</h3>' + timeline + '</div>'
    + answer
    + '</section>';
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
  const lastAnalysis = lastRun ? '<section class="panel last-analysis"><div class="last-analysis-label"><span>' + icon('sparkles', 15) + '上次分析</span><time>' + formatDateTime(lastRun.ts_local || lastRun.created_at) + (lastBackfilled ? ' · 报告回填' : '') + '</time></div><div class="last-analysis-main"><div class="last-analysis-copy"><div class="last-stock"><strong>' + escapeHtml(stockName(index, lastCode)) + '</strong><span class="mono">' + escapeHtml(lastCode || '—') + '</span>' + (lastRecord ? stanceBadge(lastRecord.stance) : '<span class="stance-badge stance-neutral">未形成结构化结论</span>') + '</div><h2 title="' + escapeHtml(lastRun.question || '未命名研究任务') + '">' + escapeHtml(truncate(lastRun.question || '未命名研究任务', 64)) + '</h2><p>' + escapeHtml(truncate(lastRecord?.thesis || '本次运行没有提取到结论摘要，可直接打开报告查看完整分析。', 180)) + '</p><div class="last-levels"><span>目标 <b>' + escapeHtml(lastRecord?.target ?? '—') + '</b></span><span>止损 <b>' + escapeHtml(lastRecord?.stop ?? '—') + '</b></span><span>耗时 <b>' + formatDuration(lastRun.elapsed_ms) + '</b></span></div></div><div class="last-analysis-actions">' + openLast + askLast + (lastCode ? '<button class="button button-secondary" data-action="select-code" data-code="' + escapeHtml(lastCode) + '">' + icon('archive', 15) + '查看档案</button>' : '') + '</div></div></section>' : '';

  const runItems = rows.slice(0, 3).map((run) => {
    const code = runCode(run, records);
    const record = runConclusion(run, records) || (code ? latestRecords.find((item) => item.code === code) : undefined);
    const hasReport = Boolean(reportForRun(index, run));
    const action = run.backfilled ? 'open-report-id' : 'open-run';
    const actionId = run.backfilled ? String(run.report_id ?? '') : String(run.id);
    return '<button class="recent-run" data-action="' + action + '" data-id="' + escapeHtml(actionId) + '"><span class="recent-run-top"><span class="mode-tag">' + escapeHtml(run.mode || '未标模式') + '</span>' + (record ? stanceBadge(record.stance) : runStatusBadge(run)) + '</span><strong>' + escapeHtml(stockName(index, code)) + '</strong><span class="recent-run-code">' + escapeHtml(code || '组合/市场') + '</span><span class="recent-run-question">' + escapeHtml(truncate(run.question || '未命名研究任务', 48)) + '</span><span class="recent-run-meta"><span>' + formatDateTime(run.ts_local || run.created_at, true) + '</span><span>' + (hasReport ? '可读报告' : '无归档') + ' · ' + formatDuration(run.elapsed_ms) + '</span></span></button>';
  }).join('');
  const recentRuns = '<section class="panel overview-runs">' + sectionHeading('最近运行', '最近 3 次流水线：标的、结论与报告入口', '<button class="text-button" data-action="goto-runs">全部记录' + icon('arrow', 14) + '</button>') + '<div class="recent-run-strip">' + (runItems || emptyState('暂无运行记录', '从一键任务开始第一次分析。', 'runs')) + '</div></section>';

  // 概览第一屏给「现在怎么样了」（盘中盯盘），其次才是「上次分析」。
  // 行业暴露面板已移除：热力快照从未生成过，且 4 只持仓里 2 只是 ETF 无行业分类，
  // 面板长期停在一句「跑脚本生成快照」的提示上，占位置不产生信息。API 与生成脚本保留备用。
  return header + warning + livePanel(state) + lastAnalysis + recentRuns;
}