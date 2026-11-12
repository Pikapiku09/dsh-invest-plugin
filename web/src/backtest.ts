// 判断质量回测 + 数据溯源（v0.45.0）
//
// 这个页面要回答两个问题：
//   ① 这套流水线的判断准不准？（命中率 / 盈亏比 / 期望值 / 置信度校准）
//   ② 这些数据从哪来、有没有因为我漏了什么而缺失？（采集审计）
//
// 数据链路（页面「数据从哪来」面板会原样展示）：
//   每次流水线结束时，各阶段报告末尾的【结论结构化】行 → .dsh-invest/store/conclusions.jsonl（只追加，不改写）
//   → 回测用结论日后第 5/20 个交易日收盘价计算涨跌 → 超过窗口才算样本（窗口没走完时显示「—」而不是 0）
//
// 设计原则：小样本必须看起来就像小样本。命中率旁边永远带样本数与 95% 置信区间，
// 避免「1 条里对 1 条 = 100%」被误读成「这个角色很准」。
import { emptyState, errorState, pageHeader, sectionHeading, skeletonPage, stanceBadge, statCard } from './components';
import { escapeHtml, formatDateTime, truncate } from './format';
import { icon } from './icons';
import type { AppState } from './state';
import type { BacktestGroup, BacktestRow, BacktestSummary, ConclusionAuditResponse } from './types';

const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const rate = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);

function toneClass(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'muted';
  return v > 0 ? 'value-up' : v < 0 ? 'value-down' : '';
}

/** 置信区间文本：样本少时区间会非常宽，这正是要传达的信息 */
function ciText(ci: { low: number; high: number } | null | undefined): string {
  if (!ci) return '';
  return `95% 区间 ${ci.low.toFixed(0)}–${ci.high.toFixed(0)}%`;
}

function sampleNote(summary: BacktestSummary | null): string {
  if (!summary) return '';
  const n = summary.hits5;
  if (!n) return '还没有走完 5 个交易日的样本';
  if (n < 10) return `${n} 条样本 · ${ciText(summary.rate5CI)}（样本太少，不能据此评判）`;
  return `${n} 条样本 · ${ciText(summary.rate5CI)}`;
}

// ===== 数据来源与完整性 =====
function auditPanel(audit: ConclusionAuditResponse | null, loading: boolean, error: string, backfilling: boolean): string {
  const head = sectionHeading(
    '数据从哪来 · 有没有漏',
    '回测的每条记录都能追溯到具体某次运行与报告；这里列出采集口径与未进库的运行',
    `<button class="button button-secondary" data-action="conclusions-backfill" ${backfilling ? 'disabled' : ''}>${icon('upload', 15)}${backfilling ? '补录中' : '扫描历史报告'}</button>`,
  );
  if (loading && !audit) return `<section class="panel">${head}<div class="loading-block"><span class="spinner"></span><span>正在审计采集链路</span></div></section>`;
  if (error && !audit) return `<section class="panel">${head}${errorState('审计失败', error)}</section>`;
  if (!audit) return `<section class="panel">${head}</section>`;

  const r = audit.runs;
  const cov = r.recentCoverage;
  const covTone = cov === null ? '' : cov >= 95 ? 'accent-mint' : cov >= 70 ? 'accent-amber' : '';
  const modeRows = audit.byMode.map((m) => `<tr>
    <td>${escapeHtml(m.mode)}</td>
    <td class="numeric">${m.runs}</td>
    <td class="numeric">${m.withConclusions}</td>
    <td class="numeric">${m.conclusions}</td>
    <td class="numeric">${m.failed}</td>
  </tr>`).join('');

  const missingRows = audit.missing.slice(-10).reverse().map((m) => `<tr>
    <td class="table-date">${formatDateTime(m.ts, true)}</td>
    <td><span class="mode-tag">${escapeHtml(m.mode)}</span></td>
    <td class="question-cell">${escapeHtml(truncate(m.question || '—', 40))}</td>
    <td class="muted small">${escapeHtml(m.reason)}</td>
  </tr>`).join('');

  return `<section class="panel">
    ${head}
    <div class="stats-grid">
      ${statCard(`近 ${r.recentWindowDays} 天覆盖率`, rate(cov), `${r.recentWith} / ${r.recentReal} 次真实运行产出了结论`, 'check', covTone)}
      ${statCard('累计覆盖率', rate(r.realCoverage), `${r.realWith} / ${r.realTotal} 次真实运行`, 'database', '')}
      ${statCard('结论总数', audit.conclusions.total, `覆盖 ${audit.conclusions.distinctCodes} 只标的`, 'archive', '')}
      ${statCard('可解析报告', audit.reports.parseable, `共 ${audit.reports.total} 份归档报告含结构化行`, 'file', '')}
    </div>
    <div class="inline-note">${icon('file', 15)}<span><strong>采集口径</strong>：${escapeHtml(audit.lineage.source)}。<br>
      <strong>回测口径</strong>：${escapeHtml(audit.lineage.window)}。<br>
      <strong>边界</strong>：${escapeHtml(audit.lineage.note)}</span></div>
    ${r.recovered ? `<div class="inline-warning">${icon('alert', 15)}另有 ${r.recovered} 条「报告回填」记录（早期版本未写运行日志时按报告补的），它们当时没有结构化结论，已从覆盖率分母中剔除，不算遗漏。</div>` : ''}
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>模式</th><th>运行次数</th><th>有结论</th><th>结论条数</th><th>失败运行</th></tr></thead>
      <tbody>${modeRows}</tbody>
    </table></div>
    ${missingRows ? `<details class="ask-raw"><summary>最近未进库的运行（${audit.missing.length} 条，点开查看原因）</summary>
      <div class="table-scroll"><table class="data-table"><thead><tr><th>时间</th><th>模式</th><th>问题</th><th>原因</th></tr></thead><tbody>${missingRows}</tbody></table></div>
    </details>` : ''}
  </section>`;
}

/** 执行率对账：建议与持仓是否一致（只提示，不判断对错） */
function executionPanel(audit: ConclusionAuditResponse | null): string {
  const ex = audit && audit.execution;
  if (!ex || !ex.available) return '';
  const rows = (ex.notExecuted || []).map((x) => `<tr>
    <td>${escapeHtml(x.code)}</td>
    <td>${stanceBadge(x.stance)}</td>
    <td class="muted small">${escapeHtml(x.kind)}</td>
    <td class="table-date">${formatDateTime(x.ts, true)}</td>
  </tr>`).join('');
  return `<section class="panel">
    ${sectionHeading('执行率对账', ex.note, `<span class="record-count">账本 ${ex.positions} 只 · 与建议匹配 ${ex.matched} 只</span>`)}
    ${rows ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>标的</th><th>最新结论</th><th>差异</th><th>结论时间</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="inline-note">${icon('check', 15)}每只标的最新结论与当前持仓一致，没有发现未执行项。</div>`}
  </section>`;
}

function summaryCards(overall: BacktestSummary | null, matched: number): string {
  const rate5 = overall ? (overall.rate5 ?? null) : null;
  const pl = overall ? (overall.plRatio ?? null) : null;
  const exp = overall ? (overall.expectancy ?? null) : null;
  return `<section class="stats-grid">
    ${statCard('5 日命中率', rate(rate5), sampleNote(overall), 'chart', rate5 === null ? '' : rate5 >= 50 ? 'accent-mint' : 'accent-amber')}
    ${statCard('盈亏比', pl === null ? '—' : pl.toFixed(2), overall && overall.avgWin !== null ? `平均盈利 ${pct(overall.avgWin)} / 平均亏损 ${pct(overall.avgLoss)}` : '样本不足', 'runs', pl === null ? '' : pl > 1 ? 'accent-mint' : 'accent-amber')}
    ${statCard('单笔期望', pct(exp), '胜率×平均盈利 − 败率×平均亏损；>0 才有正向期望', 'arrow', exp === null ? '' : exp > 0 ? 'accent-mint' : 'accent-amber')}
    ${statCard('可回测结论', matched, `共 ${overall ? overall.samples : 0} 条结论有日线覆盖`, 'database', '')}
  </section>`;
}

function groupTable(title: string, meta: string, groups: BacktestGroup[], firstCol: string): string {
  if (!groups.length) return '';
  const rows = groups.map((g) => {
    const thin = g.hits5 > 0 && g.hits5 < 10;
    return `<tr>
      <td>${g.name === '—' ? '<span class="muted">—</span>' : escapeHtml(g.name)}</td>
      <td class="numeric">${g.samples}</td>
      <td class="numeric">${rate(g.rate5)}<span class="muted small"> / ${g.hits5}${thin ? ' ⚠' : ''}</span></td>
      <td class="numeric">${rate(g.rate20)}<span class="muted small"> / ${g.hits20}</span></td>
      <td class="numeric">${g.plRatio === null || g.plRatio === undefined ? '—' : g.plRatio.toFixed(2)}</td>
      <td class="numeric ${toneClass(g.avgEx5)}">${pct(g.avgEx5)}</td>
    </tr>`
  }).join('');
  return `<section class="panel">
    ${sectionHeading(title, meta)}
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>${firstCol}</th><th>结论数</th><th>5 日命中率 / 样本</th><th>20 日命中率 / 样本</th><th>盈亏比</th><th>平均超额</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="inline-note">${icon('alert', 15)}标注 ⚠ 的行样本不足 10 条，命中率没有统计意义；命中率长期高于 50% 但盈亏比小于 1，仍然会亏钱。</div>
  </section>`;
}

function detailTable(rows: BacktestRow[]): string {
  if (!rows.length) return '';
  const sorted = rows.slice().reverse().slice(0, 60);
  const body = sorted.map((row) => {
    const hit = row.hit5 === null ? '<span class="muted">未到期</span>'
      : row.hit5 ? '<span class="hit-yes">命中</span>' : '<span class="hit-no">未中</span>';
    // 复权修正量（v0.46.0）：差异 >= 0.05pp 才提示，否则满屏噪声
    const d5 = row.ret5 !== null && row.ret5 !== undefined && row.ret5Raw !== null && row.ret5Raw !== undefined
      ? Math.abs(row.ret5 - row.ret5Raw) : 0;
    const adjHint = d5 >= 0.05 ? `<span class="muted small" title="未复权 ${pct(row.ret5Raw)}，差额来自除权除息"> ⚖</span>` : '';
    return `<tr>
      <td class="table-date">${formatDateTime(row.ts, true)}</td>
      <td>${escapeHtml(row.code)}</td>
      <td>${stanceBadge(row.stance)}</td>
      <td class="muted small">${escapeHtml(row.stage || '—')}</td>
      <td class="numeric">${row.confidence === null || row.confidence === undefined ? '<span class="muted">—</span>' : row.confidence.toFixed(2)}</td>
      <td class="numeric">${row.base === null ? '—' : row.base.toFixed(2)}</td>
      <td class="numeric ${toneClass(row.ret5)}">${pct(row.ret5)}${adjHint}</td>
      <td class="numeric ${toneClass(row.ex5)}">${pct(row.ex5)}</td>
      <td>${hit}</td>
      <td class="muted small" title="${escapeHtml(row.report || '')}">${escapeHtml(row.source === 'backfill' ? '回溯补录' : (row.runId || '—'))}</td>
    </tr>`
  }).join('');
  return `<section class="panel">
    ${sectionHeading('逐条明细', '最近 60 条；收益按前复权计算，⚖ 标记表示该条若用未复权价会差 0.05pp 以上（hover 看原值）', `<span class="record-count">${rows.length} 条可回测</span>`)}
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>时间</th><th>标的</th><th>结论</th><th>角色</th><th>置信度</th><th>基准价</th><th>5 日</th><th>超额</th><th>5日命中</th><th>溯源</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </section>`;
}

export function renderBacktest(state: AppState): string {
  const header = pageHeader(
    '判断质量',
    '用历史结论验证这套流水线到底准不准：每条结论都对照真实走势。同时列出采集口径与未进库的运行，避免数据被悄悄漏掉。',
    `<button class="button button-secondary" data-action="backtest-refresh" ${state.backtestLoading ? 'disabled' : ''}>${icon('refresh', 15)}${state.backtestLoading ? '回测中' : '重新回测'}</button>`,
  );
  const audit = auditPanel(state.audit, state.auditLoading, state.auditError, state.backfillRunning);

  if (state.backtestLoading && !state.backtest) return header + skeletonPage();
  if (state.backtestError && !state.backtest) return header + audit + errorState('回测失败', state.backtestError);
  const data = state.backtest;
  if (!data) return header + audit + emptyState('尚无回测数据', '点右上「重新回测」读取结论库并计算。', 'chart');
  if (!data.total) {
    return header + audit + `<div class="inline-warning">${icon('alert', 15)}结论库还是空的：跑一次带结构化的任务（个股/深度分析模式）后再回来。</div>`;
  }
  const warnings = data.warnings.length
    ? `<div class="inline-warning">${icon('alert', 15)}${escapeHtml(data.warnings.slice(0, 4).join('；'))}${data.warnings.length > 4 ? `（共 ${data.warnings.length} 条）` : ''}</div>`
    : '';
  const adjNote = (data.adjUniverse || 0) > 0
    ? `复权因子覆盖 ${data.adjCoverage ?? 0} / ${data.adjUniverse} 只标的${(data.adjCoverage ?? 0) < (data.adjUniverse ?? 0) ? '（其余为 ETF 等无因子标的，按未复权计算）' : ''}。`
    : '';
  const method = `<div class="inline-note">${icon('file', 15)}<span><strong>命中</strong>：看多/持有/加仓 → 上涨；拒绝/回避/减仓/离场 → 下跌；观察不计命中率。<br>
    <strong>收益按前复权</strong>（close × adj_factor）计算——未复权价在除权除息日会自然下跳，直接算会被误判成下跌。${adjNote}<br>
    <strong>超额</strong>＝个股区间收益 − 上证指数同区间收益。<strong>盈亏比</strong>＝平均盈利 ÷ 平均亏损（>1 才有正向赔率）。<br>
    20 日窗口需要更长时间积累，样本少时显示「—」。</span></div>`;
  const confGroups = data.byConfidence || [];
  const confMeta = (data.confidenceCoverage || 0) > 0
    ? `其中 ${data.confidenceCoverage} 条带置信度（v0.45.0 起才有）；回答「它说很有把握时是不是真的更准」`
    : '暂无置信度数据：历史结论没有该字段，从 v0.45.0 起的新结论才会带上';

  return header
    + audit
    + executionPanel(state.audit)
    + summaryCards(data.overall, data.matched)
    + method + warnings
    + groupTable('按角色', '谁给的结论更靠谱；样本量小的别急着下判断', data.byStage, '角色')
    + groupTable('按置信度', confMeta, confGroups, '置信度')
    + groupTable('按立场', '观察类样本最多但不计命中率，可看它们的后续走势', data.byStance, '立场')
    + groupTable('按月份', '同一个月内市场环境相近，命中率会同步漂移', data.byMonth, '月份')
    + detailTable(data.rows);
}
