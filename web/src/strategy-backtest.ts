// 策略回测页（v0.63.0，2026-11-17，P2）
//
// 与「判断质量」页的边界（页面顶部必须写清，否则会被当成同一件事）：
//   判断质量：AI **结论**准不准（conclusions.jsonl → 结论日后第 5/20 交易日涨跌）
//   本页    ：**策略代码**在历史数据上的表现（backtest_result.json）
//
// 本页最容易骗人的地方，是把两组不可比的数字并排放：
//   实盘策略回测   IntradayReversal / 主板 50 只 / 2 年 → **−4.06%**
//   网格寻优最好   +46.28% ~ +559.68%（四份摘要，同一训练段）
// 网格是训练段寻优、池子按当前上市股票构建、含幸存者偏差，不能当预期收益。
// 所以排版：先给实盘回测（诚实数字），再给网格（明确标注不可外推），
// 并且幸存者偏差说明常驻顶部，不折叠、不隐藏。
import { emptyState, errorState, loadingBlock, sectionHeading } from './components';
import { escapeHtml } from './format';
import { sparkline } from './chart-utils';
import type { AppState } from './state';
import type { StrategyBacktest, StrategyBacktestMain, StrategyGridRow } from './types';

function signed(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = (v * 100).toFixed(digits) + '%';
  return v > 0 ? '+' + s : s;
}

function money(v: number | null | undefined): string {
  return (v === null || v === undefined || !Number.isFinite(v))
    ? '—' : v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

function biasBanner(bias: string | null): string {
  if (!bias) return '';
  return `<article class="bias-banner">
    <span class="bias-tag">口径提醒</span>
    <div><strong>回测含幸存者偏差，收益系统性偏高</strong>
      <p>${escapeHtml(bias)}。这是回测数字，不是实盘业绩，也不是预期收益。</p></div>
  </article>`;
}

function mainCard(bt: StrategyBacktest): string {
  const m: StrategyBacktestMain | null = bt.main;
  if (!m) {
    return `<section class="panel">${sectionHeading('实盘策略回测', '数据缺失')}
      <p class="muted">没有 outputs/backtest_result.json。先在 LihuQuantify 跑一次 run_full_backtest.py。</p></section>`;
  }
  const pool = m.pool || {};
  const met = m.metrics || {};
  const cells: [string, string, string][] = [
    ['总收益', signed(met.total_return), `年化 ${signed(met.annual_return)}`],
    ['最大回撤', signed(met.max_drawdown), `Calmar ${met.calmar?.toFixed(2) ?? '—'}`],
    ['夏普', met.sharpe?.toFixed(3) ?? '—', ''],
    ['胜率', signed(met.win_rate), `盈亏比 ${met.profit_loss_ratio?.toFixed(2) ?? '—'}`],
    ['交易数', String(met.total_trades ?? '—'), `均持 ${met.avg_holding_days?.toFixed(1) ?? '—'} 天`],
    ['期末权益', money(met.final_equity), `初始 ${money(m.init_capital)}`],
  ];
  const grid = cells.map(([k, v, hint]) => `<div class="metric-cell"><span>${escapeHtml(k)}</span>
      <strong>${escapeHtml(v)}</strong><small>${escapeHtml(hint)}</small></div>`).join('');

  const rules = m.rules_included
    ? `<div class="rule-chips">${Object.entries(m.rules_included).map(([k, v]) =>
        `<span class="rule-chip" title="${escapeHtml(k)}">${escapeHtml(
          typeof v === 'string' ? v : (v ? k : '✗ ' + k))}</span>`).join('')}</div>`
    : '';

  const meta = `策略 ${pool.strategy ?? '—'} · 池 ${pool.type ?? '—'} ${pool.n_with_data ?? '—'} 只 ·`
    + ` ${pool.years ?? '—'} 年 · 截至 ${pool.end_date ?? '—'} · 生成于 ${m.generated_at ?? '—'}`;

  const curve = m.curve && m.curve.length >= 2 ? sparkline(m.curve, 640, 150, '回测权益曲线') : '';
  const truncated = m.curve_points_total > (m.curve?.length ?? 0)
    ? `<p class="muted">曲线显示 ${m.curve.length} / ${m.curve_points_total} 个交易日（等距抽稀）。</p>` : '';

  return `<section class="panel">${sectionHeading('实盘策略回测', meta)}
    <div class="metric-grid">${grid}</div>
    ${curve}${truncated}
    ${rules}</section>`;
}

function gridCard(bt: StrategyBacktest): string {
  const rows: StrategyGridRow[] = bt.grid || [];
  if (!rows.length) {
    return `<section class="panel">${sectionHeading('参数网格寻优', '无结果')}
      <p class="muted">没有 outputs/grid_v2_*_summary.json。</p></section>`;
  }
  const bests = rows.map((r) => r.best?.total_return).filter((v): v is number => Number.isFinite(v as number));
  const spread = bests.length > 1
    ? `<p class="muted">四份摘要的最好结果跨度 ${signed(Math.min(...bests))} ~ ${signed(Math.max(...bests))}。
       同一训练段内差别这么大，本身就说明它不能当预期收益。</p>` : '';
  const body = rows.map((r) => `<tr>
      <td>${escapeHtml(r.pool_label || '—')}</td>
      <td>${escapeHtml((r.data_segment || []).join(' ~ ') || '—')}</td>
      <td class="num">${r.n_robust ?? '—'} / ${r.n_total ?? '—'}</td>
      <td class="num">${signed(r.best?.total_return)}</td>
      <td class="num">${signed(r.orig_total_return)}</td>
      <td class="num">${r.orig_robust === null ? '—' : (r.orig_robust ? '稳健' : '不稳健')}</td>
    </tr>`).join('');
  return `<section class="panel">${sectionHeading('参数网格寻优', '训练段结果 · 不可外推')}
    <details class="swing-details" open><summary>展开 ${rows.length} 行寻优摘要</summary>
      <div class="swing-table-wrap"><table class="swing-table"><thead><tr>
        <th>池</th><th>数据段</th><th class="num">稳健组</th>
        <th class="num">最好收益</th><th class="num">原参数收益</th><th class="num">原参数稳健性</th>
      </tr></thead><tbody>${body}</tbody></table></div>
    </details>
    ${spread}
    <p class="muted">「稳健组」= 参数邻域内仍为正收益的组数。这是寻优过程产物，
      既不代表最优参数能上线，也不代表历史会重演。</p></section>`;
}

/**
 * 策略回测区块（v0.65.0 起并入「量化策略」页，不再单独成页）。
 * 由渲染方负责 loading / error / 空快照，这里只关心 backtest 块本身。
 */
export function renderStrategyBacktestBody(state: AppState): string {
  const res = state.strategyHealth ?? null;
  if (state.strategyHealthLoading && !res) return loadingBlock('正在读取回测结果');
  if (state.strategyHealthError) return errorState('读取失败', state.strategyHealthError);
  if (!res) return emptyState('尚未读取', '点击「重新读取」加载回测结果。');
  if (!res.ok || !res.data) {
    const desc = res.reason === 'missing'
      ? '还没有量化策略快照。先在 LihuQuantify 跑 python scripts/export_strategy_health.py。'
      : `快照不可用（${res.reason ?? '未知'}）：${res.hint ?? ''}`;
    return errorState('数据不可用', desc);
  }
  const bt = res.data.backtest;
  if (!bt) {
    return emptyState('该快照没有回测数据',
      '契约版本 v4 及以前不含 backtest 块。在 LihuQuantify 重新导出（脚本会升到 v5+）后即可显示。');
  }
  return biasBanner(bt.survivorship_bias) + mainCard(bt) + gridCard(bt);
}
