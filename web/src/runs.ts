import { codeTags, emptyState, errorState, pageHeader, runStatusBadge, sectionHeading, skeletonPage } from './components';
import { escapeHtml, formatDateTime, formatDuration, truncate } from './format';
import { icon } from './icons';
import { allRunRows, backfilledRuns, runReportPath } from './run-history';
import type { RunRow } from './run-history';
import type { AppState } from './state';

function filterPanel(state: AppState, modes: string[], query: string, backfillCount: number): string {
  return `<section class="panel filter-panel"><div class="filter-search search-field">${icon('search', 16)}<input data-field="run-query" value="${escapeHtml(state.runQuery)}" placeholder="搜索问题、代码或运行 ID" aria-label="搜索运行记录" /></div>
    <label class="select-field"><span>运行模式</span><select data-field="run-mode"><option value="all">全部模式</option>${modes.map((mode) => `<option value="${escapeHtml(mode)}" ${state.runMode === mode ? 'selected' : ''}>${escapeHtml(mode)}</option>`).join('')}</select></label>
    <label class="select-field"><span>执行状态</span><select data-field="run-status"><option value="all" ${state.runStatus === 'all' ? 'selected' : ''}>全部状态</option><option value="success" ${state.runStatus === 'success' ? 'selected' : ''}>仅成功</option><option value="failed" ${state.runStatus === 'failed' ? 'selected' : ''}>仅失败</option></select></label>
    <label class="watch-check backfill-toggle" title="隐藏按报告回填的「报告归档」条目，只看真实运行日志"><input type="checkbox" data-field="run-hide-backfill" ${state.runHideBackfill ? 'checked' : ''} /> 隐藏报告回填${backfillCount ? `（${backfillCount}）` : ''}</label>
    ${query || state.runMode !== 'all' || state.runStatus !== 'all' || state.runHideBackfill ? `<button class="text-button clear-filter" data-action="clear-run-filters">清除过滤</button>` : ''}
  </section>`;
}

function runRowsTable(runs: RunRow[]): string {
  if (!runs.length) return emptyState('没有匹配的运行记录', '调整关键词或过滤条件后再试。', 'search');
  const rows = runs.slice(0, 150).map((run) => {
    const stages = (run.stages || []).map((stage) => `${stage.stage}${stage.ok === false ? ' ×' : ''}`).join(' →');
    const backfilledRun = run.backfilled === true;
    // 回填行没有 run 记录，点开直接进对应报告
    const action = backfilledRun ? 'open-report-id' : 'open-run';
    const actionId = String(backfilledRun ? run.report_id : run.id);
    const reportPath = runReportPath(run);
    const idCell = backfilledRun ? `<span title="缺运行日志，按报告回填">R${escapeHtml(run.report_id)}</span>` : `#${escapeHtml(run.id)}`;
    const askButton = reportPath
      ? `<button class="icon-button small" data-action="ask-report" data-path="${escapeHtml(reportPath)}" title="针对这份报告追问" aria-label="针对报告追问">${icon('chat', 15)}</button>`
      : '';
    return `<tr class="clickable-row" data-action="${action}" data-id="${escapeHtml(actionId)}" tabindex="0">
      <td class="run-id">${idCell}</td><td class="table-date">${formatDateTime(run.ts_local || run.created_at, true)}</td>
      <td><span class="mode-tag">${escapeHtml(run.mode || '—')}</span></td><td class="question-cell" title="${escapeHtml(run.question || '')}">${escapeHtml(truncate(run.question || '—', 52))}</td>
      <td>${codeTags(run.codes || [])}</td><td class="stage-cell" title="${escapeHtml(stages)}">${escapeHtml(truncate(stages || '—', 28))}</td>
      <td class="numeric">${formatDuration(run.elapsed_ms)}</td><td>${runStatusBadge(run)}</td>
      <td class="table-action"><span class="row-actions">${askButton}<button class="icon-button small" data-action="${action}" data-id="${escapeHtml(actionId)}" aria-label="打开运行报告">${icon('external', 15)}</button></span></td>
    </tr>`;
  }).join('');
  return `<div class="table-scroll"><table class="data-table runs-table"><thead><tr><th>ID</th><th>时间</th><th>模式</th><th>研究问题</th><th>标的</th><th>执行阶段</th><th>耗时</th><th>状态</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${runs.length > 150 ? '<div class="table-footer">为保持页面流畅，仅显示前 150 条，请使用过滤器缩小范围。</div>' : ''}`;
}

/** 运行记录区（可独立成页，也可嵌入一键任务页） */
export function runsSection(state: AppState, embedded = false): string {
  const backfilled = backfilledRuns(state.index);
  const allRuns = allRunRows(state.index);
  const modes = Array.from(new Set(allRuns.map((run) => run.mode).filter((mode): mode is string => Boolean(mode)))).sort();
  const query = state.runQuery.trim().toLowerCase();
  const runs = allRuns.filter((run) => {
    const failed = run.ok === false || run.status === 'failed';
    if (state.runStatus === 'success' && failed) return false;
    if (state.runStatus === 'failed' && !failed) return false;
    if (state.runHideBackfill && run.backfilled === true) return false;
    if (state.runMode !== 'all' && run.mode !== state.runMode) return false;
    return !query || `${run.id} ${run.question || ''} ${run.mode || ''} ${(run.codes || []).join(' ')}`.toLowerCase().includes(query);
  });
  const backfillNote = backfilled.length && !state.runHideBackfill
    ? `<div class="inline-warning">${icon('alert', 15)}另有 ${backfilled.length} 次任务只有报告、没有运行日志（旧版本写入缺陷，已在 v0.31 修复），已按报告回填为「报告归档」条目——报告本身完整可读。可勾选「隐藏报告回填」只看真实运行记录。</div>`
    : '';
  const heading = sectionHeading('运行记录', '每次流水线的阶段、耗时与报告入口；点右侧气泡可针对报告追问', `<span class="record-count">${runs.length} / ${allRuns.length} 条</span>`);
  const content = `${backfillNote}${filterPanel(state, modes, query, backfilled.length)}<section class="panel runs-panel">${runRowsTable(runs)}</section>`;
  return embedded
    ? `<section class="runs-embed" id="runs-panel">${heading}${content}</section>`
    : `<section class="runs-standalone" id="runs-panel">${heading}${content}</section>`;
}

export function renderRuns(state: AppState): string {
  if (state.indexLoading && !state.index) return skeletonPage();
  if (!state.index) return pageHeader('运行记录', '检索每一次投研流水线执行。') + errorState('暂时无法读取运行记录', state.indexError || '索引接口尚未就绪。');
  return pageHeader('运行记录', '从执行阶段到最终报告，保留完整、可检索的研究轨迹。') + runsSection(state);
}
