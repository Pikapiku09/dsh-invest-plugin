import { emptyState, errorState, loadingBlock, pageHeader, runStatusBadge, sectionHeading, skeletonPage, stanceBadge } from './components';
import { displayValue, escapeHtml, formatDateTime, formatDuration, formatNumber, truncate } from './format';
import { icon } from './icons';
import { notifyEnabled, notifyPermission } from './notify';
import { codeEntries, recordsForCode, reportForRun, runsForCode, sortConclusions } from './selectors';
import { latestReportForCode } from './run-history';
import type { AppState } from './state';
import type { ConclusionRecord, WatchAlert, WatchlistItem } from './types';
import { alertMessageWithQty, alertQty, alertQtyIsCurrent, positionTargetSane, watchDistance, watchDistLabel, watchDistSwitch } from './watch-metrics';

/** 提醒类型 → 中文标签（止盈/止损/买入…） */
const ALERT_KIND_LABEL: Record<string, string> = {
  buy: '买入', invalidate: '观察失效', stop: '止损', target: '止盈', add: '加仓', trim: '减仓',
};

/** 该标的最新的相关提醒（alerts 已按时间倒序）：优先未读，其次最近一条 */
function alertForCode(alerts: WatchAlert[], code: string): WatchAlert | undefined {
  const mine = alerts.filter((alert) => alert.code === code);
  return mine.find((alert) => !alert.read) || mine[0];
}

function alertTone(alert: WatchAlert): string {
  return alert.level === 'bad' ? 'hl-bad' : alert.level === 'good' ? 'hl-good' : 'hl-warn';
}

/** 提醒徽标：类型 + 购买仓位数（买入=计划买入股数；止盈/止损=持仓股数）
 *  历史提醒没有 qty 时按当前档案补齐并标注「当前」，避免误读为触发时仓位 */
function alertBadge(alert: WatchAlert | undefined, items: WatchlistItem[]): string {
  if (!alert) return '';
  const qty = alertQty(alert, items);
  const current = qty !== null && alertQtyIsCurrent(alert) ? '（当前）' : '';
  const qtyText = qty !== null ? `<em>${qty}股${current}</em>` : '';
  return `<span class="alert-badge ${alertTone(alert)}${alert.read ? ' is-read' : ''}" title="${escapeHtml(alert.message)}">`
    + `${escapeHtml(ALERT_KIND_LABEL[alert.kind] || alert.kind)}${qtyText}</span>`;
}

/** 系统通知开关（Windows 通知）：区分「待授权（点一下就申请）」/ 已授权 / 已拒绝 */
function notifyToggle(): string {
  const enabled = notifyEnabled();
  const permission = notifyPermission();
  const label = !enabled ? '系统通知：关'
    : permission === 'granted' ? '系统通知：开'
      : permission === 'denied' ? '系统通知：未授权'
        : '系统通知：待授权';
  return `<button class="button button-secondary notify-toggle ${enabled && permission === 'granted' ? 'is-on' : ''}" data-action="toggle-notify" title="触发止盈/止损/买入提醒时弹出 Windows 通知（需在浏览器允许通知）">${icon('alert', 14)}${label}</button>`;
}

function activeAlerts(state: AppState): WatchAlert[] {
  return state.watchlist?.alerts || [];
}

function holdingPanel(state: AppState): string {
  if (state.holdingsLoading && !state.holdings) return `<section class="archive-holdings"><h3>${icon('wallet', 16)}实时持仓</h3>${loadingBlock('读取账本')}</section>`;
  if (state.holdingsError && !state.holdings) return `<section class="archive-holdings"><h3>${icon('wallet', 16)}实时持仓</h3><p class="compact-error">${escapeHtml(state.holdingsError)}</p></section>`;
  const holdings = state.holdings;
  const positions = holdings?.positions || [];
  const mode = state.watchDistMode;
  const alerts = activeAlerts(state);
  const rows = positions.map((position) => {
    const it = (state.watchlist?.items || []).find((x) => x.code === position.code && x.state === '持有');
    const d = it ? watchDistance(it, mode) : null;
    const label = it ? watchDistLabel(it, mode) : '距止盈';
    const distHtml = it
      ? `<span class="holding-dist ${d !== null && d <= 3 ? 'watch-dist-near' : ''}">${escapeHtml(label)} <b>${d === null ? '—' : (d > 0 ? '+' : '') + d + '%'}</b></span>`
      : '<span class="holding-dist">未建档</span>';
    const alert = alertForCode(alerts, position.code);
    return `<div class="holding-item ${state.selectedCode === position.code ? 'selected' : ''} ${alert ? 'alert-hl ' + alertTone(alert) : ''}">
      <button class="holding-item-main" data-action="select-code" data-code="${escapeHtml(position.code)}"><span><strong>${escapeHtml(position.name || position.code)}</strong><small>${escapeHtml(position.code)} · 成本 ${escapeHtml(position.cost ?? '—')}</small></span><span class="holding-qty">${position.shares !== undefined ? `${formatNumber(position.shares)} 股` : position.weight_pct !== undefined ? `${position.weight_pct}%` : '—'}<small>${escapeHtml(position.status || '')}</small>${distHtml}${alertBadge(alert, state.watchlist?.items || [])}</span></button>
      <button class="holding-quick" data-action="quick-check" data-code="${escapeHtml(position.code)}" title="对该持仓发起个股快检">${icon('sparkles', 13)} 快检</button>
    </div>`;
  }).join('');
  return `<section class="archive-holdings"><div class="archive-section-title"><h3>${icon('wallet', 16)}实时持仓</h3><span>${positions.length} 项</span></div>
    ${positions.length ? `<div class="holding-list">${rows}</div>` : '<p class="muted compact">账本暂无持仓</p>'}
    <div class="holding-footer">${holdings?.account?.total_asset !== undefined ? `<span>总资产 <b>${escapeHtml(holdings.account.total_asset)}</b></span>` : '<span>持仓账本实时读取</span>'}<small>${formatDateTime(holdings?.updated_at, true)}</small></div>
    <div class="holding-footer"><span>点击「快检」直接对已有持仓发起个股快诊</span></div>
  </section>`;
}

/** 观察栏：最近扫描出来的观察标的，按最近结论时间倒序，支持一键个股快检 */
function watchPanel(state: AppState): string {
  const head = `<div class="archive-section-title"><h3>${icon('search', 16)}观察</h3><span>最近扫描</span></div>`;
  const doc = state.watchlist;
  const items = (doc?.items || [])
    .filter((it) => it.state === '观察')
    .slice()
    .sort((a, b) => String(b.watch?.last_conclusion_ts || b.watch?.created_at || '')
      .localeCompare(String(a.watch?.last_conclusion_ts || a.watch?.created_at || '')));
  if (!items.length) {
    return `<section class="archive-holdings">${head}<p class="muted compact">暂无观察标的。扫描或分析后，观察/看多结论会自动进入这里。</p></section>`;
  }
  const alerts = activeAlerts(state);
  const rows = items.map((it) => {
    const w = it.watch;
    const zone = (w.buy_low !== null && w.buy_high !== null) ? `${w.buy_low} ~ ${w.buy_high}` : '买区待补录';
    const ts = w.last_conclusion_ts || w.created_at;
    const name = (it.name && it.name !== it.code) ? it.name : (state.index?.codes?.[it.code]?.name || it.code);
    const alert = alertForCode(alerts, it.code);
    const qtyText = (typeof w.buy_qty === 'number' && Number.isFinite(w.buy_qty)) ? ` · 计划 ${w.buy_qty} 股` : '';
    return `<div class="holding-item ${state.selectedCode === it.code ? 'selected' : ''} ${alert ? 'alert-hl ' + alertTone(alert) : ''}">
      <button class="holding-item-main" data-action="select-code" data-code="${escapeHtml(it.code)}"><span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(it.code)} · 买区 ${escapeHtml(zone)}${escapeHtml(qtyText)}</small></span><span class="holding-qty"><small>${ts ? escapeHtml(formatDateTime(ts, true)) : '—'}</small>${alertBadge(alert, state.watchlist?.items || [])}</span></button>
      <button class="holding-quick" data-action="quick-check" data-code="${escapeHtml(it.code)}" title="对该观察标的发起个股快检">${icon('sparkles', 13)} 快检</button>
    </div>`;
  }).join('');
  return `<section class="archive-holdings">${head}<div class="holding-list">${rows}</div>
    <div class="holding-footer"><span>${items.length} 只观察 · 最近扫描在前 · 点击快检直接发起个股快诊</span></div></section>`;
}

function conclusionTimeline(records: ConclusionRecord[]): string {
  if (!records.length) return emptyState('暂无结构化结论', '可查看下方相关运行原文；新任务完成后会自动补充结论链。', 'layers');
  return `<div class="timeline">${records.map((record, index) => {
    const invalidation = record.invalidate_if;
    const difference = record.diff_from_previous ?? record.diff ?? record.changes;
    return `<article class="timeline-item"><div class="timeline-marker"><i></i><span></span></div><div class="timeline-card">
      <div class="timeline-head"><div>${stanceBadge(record.stance)}<time>${formatDateTime(record.asof || record.ts)}</time></div><span class="run-reference">${record.run_id ? `RUN #${escapeHtml(record.run_id)}` : record.callId ? `CALL ${escapeHtml(record.callId)}` : 'STRUCTURED'}</span></div>
      <div class="trade-levels"><div><small>目标 L1</small><strong>${escapeHtml(record.target ?? '—')}</strong></div><div><small>止损 / 风险线</small><strong>${escapeHtml(record.stop ?? '—')}</strong></div></div>
      <div class="thesis-block"><h4>核心论据</h4><p>${escapeHtml(record.thesis || '报告未提供论据摘要。')}</p></div>
      ${invalidation ? `<div class="invalid-block"><h4>${icon('alert', 14)}失效条件</h4><p>${escapeHtml(displayValue(invalidation))}</p></div>` : ''}
      ${difference ? `<div class="diff-block"><h4>与上次差异</h4><p>${escapeHtml(displayValue(difference))}</p></div>` : ''}
      <div class="timeline-foot"><span>${record.source ? `来源：${escapeHtml(record.source)}` : index === 0 ? '最新结论' : '历史结论'}</span>${record.report_id ? `<button class="text-button" data-action="open-report-id" data-id="${escapeHtml(record.report_id)}">阅读报告${icon('arrow', 14)}</button>` : ''}</div>
    </div></article>`;
  }).join('')}</div>`;
}

const v = (x: unknown): string => (x === null || x === undefined || x === '') ? '—' : String(x);

/** 编辑表单里的一个数字/文本输入（data-field 供全量重绘后恢复焦点与光标） */
function watchField(label: string, field: string, value: unknown, placeholder = ''): string {
  const raw = (value === null || value === undefined) ? '' : String(value);
  return `<label class="watch-field"><span>${escapeHtml(label)}</span><input data-field="watch-edit-${escapeHtml(field)}" data-watch-field="${escapeHtml(field)}" type="text" inputmode="decimal" value="${escapeHtml(raw)}" placeholder="${escapeHtml(placeholder)}" /></label>`;
}

/** 标的档案监控卡片：状态机 + 现价 + 监控规则 + 编辑 + 最近信号 */
function monitorPanel(state: AppState, code: string): string {
  const head = `<div class="archive-section-title"><h3>${icon('sparkles', 16)}监控规则</h3><span>标的档案</span></div>`;
  const doc = state.watchlist;
  const it: WatchlistItem | undefined = doc?.items.find((x) => x.code === code);
  if (!it) {
    return `<section class="panel watch-monitor">${head}
      <p class="muted compact">该标的尚未进入标的档案。观察/看多结论会自动建档；也可手动建立观察档案后补录买入区间。</p>
      <button class="button button-secondary" data-action="watch-create" data-code="${escapeHtml(code)}">${icon('sparkles', 14)} 建立观察档案</button></section>`;
  }
  const m = it.monitor, w = it.watch, p = it.position;
  const alerts = (doc?.alerts || []).filter((a) => a.code === code).slice(0, 3);
  const mode = state.watchDistMode;
  const d = watchDistance(it, mode);
  const distLabel = watchDistLabel(it, mode);
  const stateSelect = `<select class="watch-state-select" data-watch-state data-code="${escapeHtml(code)}" aria-label="档案状态">`
    + ['观察', '持有', '已清仓', '已移除'].map((s) => `<option value="${s}"${it.state === s ? ' selected' : ''}>${s}</option>`).join('') + '</select>';
  const top = `<div class="watch-monitor-top">
    <div class="watch-monitor-state">${stanceBadge(it.state)}${stateSelect}</div>
    <div class="watch-monitor-price"><span>现价 <b>${escapeHtml(v(m.current_price))}</b></span><small>${m.refreshed_at ? escapeHtml(formatDateTime(m.refreshed_at, true)) : '未刷新'}</small></div>
    <div class="watch-monitor-dist"><span>${escapeHtml(distLabel)}</span><b>${escapeHtml(d === null ? '—' : (d > 0 ? '+' : '') + d + '%')}</b></div>
    <button class="button button-secondary" data-action="quick-check" data-code="${escapeHtml(code)}">${icon('sparkles', 14)} 个股快检</button>
    <button class="button button-secondary" data-action="watch-toggle-edit">${state.watchEditOpen ? '收起编辑' : '编辑规则'}</button>
  </div>`;
  const facts: Array<[string, string]> = it.state === '观察'
    ? [['买入区间', (w.buy_low !== null && w.buy_high !== null) ? (w.buy_low + ' ~ ' + w.buy_high) : '待补录'],
       ['理想买点 / 购买仓位数', v(w.ideal_buy) + ' / ' + (typeof w.buy_qty === 'number' && Number.isFinite(w.buy_qty) ? w.buy_qty + ' 股' : '待定')],
       ['失效价', v(w.stop)],
       ['结论目标 / 止损', v(w.target) + ' / ' + v(w.stop)],
       ['失效条件', w.invalidate_if || '—'], ['核心逻辑', w.thesis || '—']]
    : [['成本 / 股数', v(p.cost) + ' / ' + (p.shares !== null ? p.shares + ' 股' : '—')],
       // 止盈价倒挂（低于成本/止损）时直接标注，不当作正常目标展示（v0.53.0）
       ['止盈目标', p.target !== null && !positionTargetSane(it) ? `${v(p.target)}（价位异常）` : v(p.target)],
       ['止损价', v(p.stop)],
       ['加仓区间', (p.add_low !== null && p.add_high !== null) ? (p.add_low + ' ~ ' + p.add_high) : '待补录'],
       ['减仓线 / 移动止盈', v(p.trim_line) + ' / ' + v(p.trailing_stop)],
       ['失效条件', w.invalidate_if || '—']];
  // 价位倒挂或存在被拒绝的同步值时给出解释与入口，不静默（v0.53.0）
  const levelWarning = (p.target !== null && !positionTargetSane(it))
    ? `<div class="inline-warning">${icon('alert', 15)}止盈目标 ${v(p.target)} 低于成本或止损价（价位倒挂，多为回踩位被误当止盈目标写入）。距止盈计算与止盈提醒已暂停，请在「编辑规则」里修正目标价。</div>`
    : '';
  const ignored = Array.isArray(p.sync_ignored) ? p.sync_ignored.slice(0, 3) : [];
  const ignoredBar = ignored.length
    ? `<div class="watch-sync-ignored"><small>近期有 ${ignored.length} 条结论价位因语义异常未写入（如低于成本的止盈价），原始值保留在结论库：</small>${ignored.map((g) => `<small>${escapeHtml(g.field === 'target' ? '目标' : '止损')} ${escapeHtml(String(g.value))}（${escapeHtml(g.reason)}）</small>`).join('')}</div>`
    : '';
  const factsHtml = `<div class="watch-facts">${facts.map(([k, value]) => `<div class="watch-fact"><small>${escapeHtml(k)}</small><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>`;
  const signalHtml = alerts.length
    ? `<div class="watch-alerts">${alerts.map((a) => `<div class="watch-alert ${a.level === 'bad' ? 'watch-sig-bad' : a.level === 'good' ? 'watch-sig-good' : 'watch-sig-info'}"><span>${escapeHtml(alertMessageWithQty(a, doc?.items || []))}</span><small>${escapeHtml(formatDateTime(a.ts, true))}</small></div>`).join('')}</div>`
    : '<p class="muted compact">暂无触发信号。每日收盘刷新现价后，落入规则区间会在此提醒。</p>';
  const editForm = state.watchEditOpen ? `<div class="watch-edit">
    <div class="watch-edit-grid">
      <label class="watch-field"><span>名称</span><input data-field="watch-edit-name" data-watch-field="name" type="text" value="${escapeHtml(it.name)}" /></label>
      <label class="watch-field"><span>信号提醒</span><label class="watch-check"><input data-watch-notify type="checkbox"${m.notify ? ' checked' : ''} /> 启用（关闭后不再比对）</label></label>
    </div>
    <h4>观察期规则（买入区间监控）</h4>
    <div class="watch-edit-grid">
      ${watchField('买入区间下沿', 'buy_low', w.buy_low, '如 51.5')}
      ${watchField('买入区间上沿', 'buy_high', w.buy_high, '如 53.5')}
      ${watchField('理想买点', 'ideal_buy', w.ideal_buy)}
      ${watchField('计划买入股数', 'buy_qty', w.buy_qty, '如 500（买入提醒标注购买仓位数）')}
      ${watchField('失效价', 'stop', w.stop, '跌破触发观察失效')}
      <label class="watch-field wide"><span>失效条件</span><input data-field="watch-edit-invalidate_if" data-watch-field="invalidate_if" type="text" value="${escapeHtml(w.invalidate_if)}" /></label>
    </div>
    <h4>持有期规则（建仓后生效）</h4>
    <div class="watch-edit-grid">
      ${watchField('成本', 'pos.cost', p.cost)}
      ${watchField('股数', 'pos.shares', p.shares)}
      ${watchField('目标价（止盈）', 'pos.target', p.target)}
      ${watchField('止损价', 'pos.stop', p.stop)}
      ${watchField('加仓下沿', 'pos.add_low', p.add_low)}
      ${watchField('加仓上沿', 'pos.add_high', p.add_high)}
      ${watchField('减仓线', 'pos.trim_line', p.trim_line)}
      ${watchField('移动止盈', 'pos.trailing_stop', p.trailing_stop)}
    </div>
    <div class="watch-edit-actions">
      <button class="button button-primary" data-action="watch-save" data-code="${escapeHtml(code)}">${state.watchlistSaving ? '保存中…' : '保存监控规则'}</button>
      <button class="button button-secondary" data-action="watch-toggle-edit">取消</button>
    </div></div>` : '';
  const modeRow = `<div class="watch-mode-row">${watchDistSwitch(mode, 'watch-mode-archive')}<span class="field-help">正值＝尚有空间；切换后「监控规则」优先级与距离同步变化，观察标的按买入区间计算</span></div>`;
  return `<section class="panel watch-monitor">${head}${top}${modeRow}${levelWarning}${factsHtml}${ignoredBar}${signalHtml}${editForm}</section>`;
}

function archiveDetail(state: AppState): string {
  const code = state.selectedCode;
  if (!code || !state.index) return `<section class="panel archive-placeholder">${emptyState('选择一个标的', '从左侧持仓或标的索引进入，查看完整结论链与相关运行。', 'archive')}</section>`;
  const position = state.holdings?.positions?.find((item) => item.code === code);
  const displayName = position?.name || state.index.codes?.[code]?.name || code;
  // 防御性过滤：接口串码或上一标的异步残留均不得混入当前档案
  const sourceRecords = state.archiveRecords.length || state.archiveLoading || state.archiveError ? state.archiveRecords : recordsForCode(state.index, code);
  const records = sortConclusions(sourceRecords.filter((record) => record.code === code));
  const runs = runsForCode(state.index, code);
  // 每次运行都带「追问该份报告」入口：气泡直接跳到报告追问页并选中对应报告，
  // 与「运行记录」页行尾气泡同一套交互（行本身仍点开报告全文）
  const runRows = runs.slice(0, 12).map((run) => {
    const reportPath = reportForRun(state.index, run)?.path || '';
    const askButton = reportPath
      ? `<button class="icon-button small" data-action="ask-report" data-path="${escapeHtml(reportPath)}" title="查看该报告所属个股的知识库" aria-label="查看该报告所属个股的知识库">${icon('chat', 15)}</button>`
      : '<span class="muted" title="该次运行没有归档报告">—</span>';
    return `<tr data-action="open-run" data-id="${escapeHtml(run.id)}" tabindex="0" class="clickable-row"><td class="table-date">${formatDateTime(run.ts_local || run.created_at, true)}</td><td><span class="mode-tag">${escapeHtml(run.mode || '—')}</span></td><td>${escapeHtml(truncate(run.question || '—', 42))}</td><td>${formatDuration(run.elapsed_ms)}</td><td>${runStatusBadge(run)}</td><td class="table-action"><span class="row-actions">${askButton}<button class="icon-button small" data-action="open-run" data-id="${escapeHtml(run.id)}" title="打开报告全文" aria-label="打开报告全文">${icon('external', 14)}</button></span></td></tr>`;
  }).join('');
  const latestReport = latestReportForCode(state.index, code);
  return `<div class="archive-detail"><section class="panel symbol-summary"><div><div class="symbol-code">${escapeHtml(displayName)} <small>${escapeHtml(code)}</small></div><p>${position ? `${escapeHtml(displayName)} · ${position.shares !== undefined ? `持仓 ${formatNumber(position.shares)} 股` : '在持仓账本中'} · 成本 ${escapeHtml(position.cost ?? '—')}` : '当前不在实时持仓账本中'}</p></div><div class="symbol-metrics"><span><b>${records.length}</b> 条结论</span><span><b>${runs.length}</b> 次相关运行</span>${records[0] ? '<span class="symbol-stance">' + stanceBadge(records[0].stance) + '</span><div class="symbol-levels"><span>目标 <b>' + escapeHtml(records[0].target ?? '—') + '</b></span><span>止损 <b>' + escapeHtml(records[0].stop ?? '—') + '</b></span></div>' : ''}</div>
    <div class="symbol-actions"><button class="button button-secondary" data-action="ask-latest-report" data-code="${escapeHtml(code)}" ${latestReport ? '' : 'disabled title="该标的还没有归档报告"'}>${icon('chat', 15)}个股知识库</button></div></section>
    ${monitorPanel(state, code)}
    ${state.archiveNotice ? `<div class="inline-warning">${icon('alert', 15)}${escapeHtml(state.archiveNotice)}</div>` : ''}
    <section class="panel timeline-panel">${sectionHeading('结论链时间线', '最新判断在前 · 跟踪目标、风险线及观点变化')}${state.archiveLoading ? loadingBlock('正在读取结构化结论链') : state.archiveError && !records.length ? errorState('结论链读取失败', state.archiveError) : conclusionTimeline(records)}</section>
    <section class="panel">${sectionHeading('相关运行', '该标的出现于以下研究任务')}${runs.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>时间</th><th>模式</th><th>问题</th><th>耗时</th><th>状态</th><th></th></tr></thead><tbody>${runRows}</tbody></table></div>` : emptyState('没有相关运行', '该标的尚未关联到历史研究任务。', 'runs')}</section>
  </div>`;
}

export function renderArchive(state: AppState): string {
  if (state.indexLoading && !state.index) return skeletonPage();
  if (!state.index) return pageHeader('标的档案', '持仓、结论与运行记录的统一视图。', notifyToggle()) + errorState('暂时无法读取标的索引', state.indexError || '索引接口尚未就绪。');
  const entries = codeEntries(state.index, state.archiveQuery);
  const visible = entries.slice(0, 80);
  const alerts = activeAlerts(state);
  return pageHeader('标的档案', '沿时间追溯每一次判断，实时持仓与历史研究不再脱节。', notifyToggle()) + `<div class="archive-layout"><aside class="panel archive-browser">
    <div class="search-field">${icon('search', 16)}<input data-field="archive-query" value="${escapeHtml(state.archiveQuery)}" placeholder="搜索代码或名称" aria-label="过滤标的" /></div>
    ${holdingPanel(state)}
    ${watchPanel(state)}
    <section class="archive-codes"><div class="archive-section-title"><h3>${icon('archive', 16)}标的索引</h3><span>${entries.length} 个</span></div>
      <div class="code-list">${visible.map(({ code, entry }) => {
        const alert = alertForCode(alerts, code);
        return `<button class="code-list-item ${state.selectedCode === code ? 'selected' : ''} ${alert ? 'alert-hl ' + alertTone(alert) : ''}" data-action="select-code" data-code="${escapeHtml(code)}"><span><strong>${escapeHtml(entry.name || code)}</strong><small>${escapeHtml(code)}</small>${alertBadge(alert, state.watchlist?.items || [])}</span><span class="code-counts">${entry.records?.length || 0} 结论<small>${entry.runs?.length || 0} 运行</small></span></button>`;
      }).join('') || emptyState('没有匹配标的', '试试输入完整代码或缩短关键词。', 'search')}</div>
      ${entries.length > visible.length ? `<p class="list-limit">仅显示前 80 个，请继续输入以缩小范围</p>` : ''}
    </section>
  </aside>${archiveDetail(state)}</div>`;
}
