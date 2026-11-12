// 判断质量回测（v0.44.0）
//
// 回答一个此前无法回答的问题：这套流水线的判断，历史上到底准不准？
// 数据源：每次流水线末尾的【结论结构化】行（store/conclusions.jsonl），
// 服务端用日线算出结论日后第 5/20 个交易日的实际涨跌，再按角色/立场/月份汇总命中率。
//
// 口径（必须让用户看见，否则命中率会被误读）：
//  - 基准 = 结论日后第一个交易日收盘；看第 5 / 20 个交易日收盘。
//  - 命中：看多/持有/加仓 → 上涨；拒绝/回避/减仓/离场 → 下跌；观察不计入命中率（单独看后续走势）。
//  - 超额 = 个股区间收益 − 上证指数同区间收益；正值表示跑赢大盘。
import { emptyState, errorState, pageHeader, sectionHeading, skeletonPage, stanceBadge, statCard } from './components';
import { escapeHtml, formatDateTime, truncate } from './format';
import { icon } from './icons';
import type { AppState } from './state';
import type { BacktestGroup, BacktestRow, BacktestSummary } from './types';

const pct = (value: number | null): string => (value === null || value === undefined ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`);
const rate = (value: number | null): string => (value === null || value === undefined ? '—' : `${value.toFixed(1)}%`);

function toneClass(value: number | null): string {
  if (value === null || value === undefined) return 'muted';
  return value > 0 ? 'value-up' : value < 0 ? 'value-down' : '';
}

/** 样本量过小提示：命中率没有统计意义时必须说出来，不能让它看起来比实际可信 */
function sampleNote(summary: BacktestSummary | null): string {
  if (!summary) return '';
  if (summary.hits5 < 10) return '样本仅 ' + summary.hits5 + ' 条（有方向且满 5 日窗口），命中率尚无统计意义';
  return '有方向样本 ' + summary.hits5 + ' 条';
}

function summaryCards(overall: BacktestSummary | null, matched: number): string {
  const rate5 = overall ? overall.rate5 : null;
  const rate20 = overall ? overall.rate20 : null;
  const ex5 = overall ? overall.avgEx5 : null;
  return `<section class="stats-grid">
    ${statCard('5 日命中率', rate(rate5), sampleNote(overall), 'chart', rate5 === null ? '' : rate5 >= 50 ? 'accent-mint' : 'accent-amber')}
    ${statCard('20 日命中率', rate(rate20), overall && overall.hits20 > 0 ? '有方向样本 ' + overall.hits20 + ' 条' : '样本仍在积累', 'runs', '')}
    ${statCard('平均超额（5 日）', pct(ex5), '相对上证指数；正值=跑赢大盘', 'arrow', 'accent-violet')}
    ${statCard('可回测结论', matched, '共 ' + (overall ? overall.samples : 0) + ' 条结论有日线覆盖', 'database', '')}
  </section>`;
}

function groupTable(title: string, meta: string, groups: BacktestGroup[]): string {
  if (!groups.length) return '';
  const rows = groups.map((group) => `<tr>
    <td>${group.name === '—' ? '<span class="muted">—</span>' : escapeHtml(group.name)}</td>
    <td class="numeric">${group.samples}</td>
    <td class="numeric">${rate(group.rate5)}<span class="muted small"> / ${group.hits5}</span></td>
    <td class="numeric">${rate(group.rate20)}<span class="muted small"> / ${group.hits20}</span></td>
    <td class="numeric ${toneClass(group.avgRet5)}">${pct(group.avgRet5)}</td>
    <td class="numeric ${toneClass(group.avgEx5)}">${pct(group.avgEx5)}</td>
  </tr>`).join('');
  return `<section class="panel">
    ${sectionHeading(title, meta)}
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>${title.includes('角色') ? '角色' : '类别'}</th><th>结论数</th><th>5 日命中率 / 样本</th><th>20 日命中率 / 样本</th><th>平均 5 日收益</th><th>平均超额</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

function detailTable(rows: BacktestRow[]): string {
  if (!rows.length) return '';
  const sorted = rows.slice().reverse().slice(0, 60);
  const body = sorted.map((row) => {
    const hit = row.hit5 === null ? '<span class="muted">不计</span>'
      : row.hit5 ? '<span class="hit-yes">命中</span>' : '<span class="hit-no">未中</span>';
    return `<tr>
      <td class="table-date">${formatDateTime(row.ts, true)}</td>
      <td>${escapeHtml(row.code)}</td>
      <td>${stanceBadge(row.stance)}</td>
      <td class="muted small">${escapeHtml(row.stage || '—')}</td>
      <td class="numeric">${row.base === null ? '—' : row.base.toFixed(2)}</td>
      <td class="numeric ${toneClass(row.ret5)}">${pct(row.ret5)}</td>
      <td class="numeric ${toneClass(row.ex5)}">${pct(row.ex5)}</td>
      <td class="numeric ${toneClass(row.ret20)}">${pct(row.ret20)}</td>
      <td>${hit}</td>
      <td class="question-cell" title="${escapeHtml(row.thesis || '')}">${escapeHtml(truncate(row.thesis || '—', 40))}</td>
    </tr>`;
  }).join('');
  return `<section class="panel">
    ${sectionHeading('逐条明细', '最近 60 条结论的实际走势；点代码可跳转标的档案', `<span class="record-count">${rows.length} 条可回测</span>`)}
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>时间</th><th>标的</th><th>结论</th><th>角色</th><th>基准价</th><th>5 日</th><th>超额</th><th>20 日</th><th>5日命中</th><th>论据</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </section>`;
}

export function renderBacktest(state: AppState): string {
  const header = pageHeader(
    '判断质量',
    '用历史结论验证这套流水线到底准不准：每条结论都对照真实走势，按角色与立场统计命中率。观察类结论不计命中率。',
    `<button class="button button-secondary" data-action="backtest-refresh" ${state.backtestLoading ? 'disabled' : ''}>${icon('refresh', 15)}${state.backtestLoading ? '回测中' : '重新回测'}</button>`,
  );
  if (state.backtestLoading && !state.backtest) return header + skeletonPage();
  if (state.backtestError && !state.backtest) return header + errorState('回测失败', state.backtestError);
  const data = state.backtest;
  if (!data) return header + emptyState('尚无回测数据', '点右上「重新回测」读取结论库并计算。', 'target');
  if (!data.total) {
    return header + `<div class="inline-warning">${icon('alert', 15)}结论库还是空的：跑一次带「结论结构化」输出的任务（个股/深度分析模式）后再回来。</div>`;
  }
  const warnings = data.warnings.length
    ? `<div class="inline-warning">${icon('alert', 15)}${escapeHtml(data.warnings.slice(0, 4).join('；'))}${data.warnings.length > 4 ? `（共 ${data.warnings.length} 条）` : ''}</div>`
    : '';
  const method = `<div class="inline-note">${icon('file', 15)}口径：基准为结论日后第一个交易日收盘，查看第 5 / 20 个交易日收盘涨跌；命中＝看多/持有/加仓后上涨、拒绝/回避/减仓/离场后下跌；观察不计命中率。超额＝个股区间收益 − 上证指数同区间收益。20 日窗口需要更长的时间积累，样本少时以「—」显示。</div>`;
  return header
    + summaryCards(data.overall, data.matched)
    + method + warnings
    + groupTable('按角色', '谁给的结论更靠谱；样本量小的别急着下判断', data.byStage)
    + groupTable('按立场', '观察类样本最多但不计命中率，可看它们的后续走势', data.byStance)
    + groupTable('按月份', '同一个月内市场环境相近，命中率会同步漂移', data.byMonth)
    + detailTable(data.rows);
}
