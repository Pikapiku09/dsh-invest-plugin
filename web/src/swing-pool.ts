// 波段池页（v0.61.0，2026-11-17，P3）
//
// 这一页存在的意义和别的页不一样：**它是一页「别做」的页面**。
//
// 事实（data/swing_pool/波段池_持仓.md + outputs/swing_backtest.json 2026-10-20）：
//   第一版 +382% 是记账 bug（单笔收益被平方）；修复后 +37.7% → 补齐数据与修正估值分位口径后 -48.8%；
//   扩样本 2021-2026（5.7 年）-52.0%，年化 -12.4%，最大回撤 62.2%。
//   随机对照里「同择时随机选股」「完全随机」都好于策略 → 选股与排序规则为负 alpha。
//   决定：暂停实盘、纸面跟踪；停止历史参数寻优。
//
// 所以本页的排版顺序刻意与「策略看起来不错」相反：
//   ① 顶部红色证伪横幅（含决定与重启前提）
//   ② 随机对照（最能说明问题的一条：比随机还差）
//   ③ 回测数字（负收益、大回撤，原样呈现，不挑好看的）
//   ④ 当前池子（现在只是纸面观察，不是买入建议）
//
// 任何一屏都不该让人产生「这个策略可以上」的错觉。
import { emptyState, errorState, loadingBlock, sectionHeading } from './components';
import { escapeHtml } from './format';
import type { AppState } from './state';
import type { StrategySwing, SwingHolding } from './types';

function pct(v: number | null | undefined, digits = 1): string {
  return (v === null || v === undefined || !Number.isFinite(v)) ? '—' : (v * 100).toFixed(digits) + '%';
}

function signed(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = (v * 100).toFixed(digits) + '%';
  return v > 0 ? '+' + s : s;
}

function falsifiedBanner(swing: StrategySwing): string {
  if (swing.strategy_status !== 'falsified') {
    return `<article class="swing-banner swing-unknown">
      <strong>策略状态未知</strong>
      <p>快照没有给出证伪判定。不要据此操作，先核对 data/swing_pool 与 outputs/swing_backtest.json。</p>
    </article>`;
  }
  const stmts = (swing.pool?.statements || []).filter((s) => /证伪|决定|暂停/.test(s));
  const decide = stmts.find((s) => s.startsWith('决定')) || stmts[0] || '';
  return `<article class="swing-banner swing-falsified">
    <div class="swing-banner-head">
      <span class="swing-flag">已证伪</span>
      <strong>本策略暂停实盘，仅纸面跟踪 — 不要据此建仓</strong>
    </div>
    <p>扩样本 5.7 年总收益 <b>−52.0%</b>、年化 <b>−12.4%</b>、最大回撤 <b>62.2%</b>；
       随机对照组均优于策略 → 选股与排序规则为负 alpha。</p>
    ${decide ? `<p class="swing-decide">${escapeHtml(decide)}</p>` : ''}
  </article>`;
}

function robustnessCard(swing: StrategySwing): string {
  const rb = swing.robustness;
  if (!rb || !rb.windows.length) {
    return `<section class="panel">${sectionHeading('随机对照', '数据缺失')}
      <p class="muted">没有找到与回测同窗口的随机对照结果。</p></section>`;
  }
  const blocks = rb.windows.map((w) => {
    const rows = Object.entries(w.controls).map(([name, c]) => `<tr>
        <td>${escapeHtml(name)}</td>
        <td class="num">${signed(c.mean)}</td>
        <td class="num">${c.baseline_percentile === null ? '—' : pct(c.baseline_percentile, 1)}</td>
      </tr>`).join('');
    return `<div class="swing-win">
      <div class="swing-win-head">窗口 ${escapeHtml((w.window || []).join(' ~ '))}
        ${w.matched_headline ? '<span class="swing-chip">与回测同窗口</span>' : '<span class="swing-chip swing-chip-alt">另一窗口</span>'}
        <span class="muted">策略 ${signed(w.baseline_total_return)}</span></div>
      <table class="swing-table"><thead><tr>
        <th>对照组</th><th class="num">均值收益</th><th class="num">策略所处分位</th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  }).join('');
  return `<section class="panel">${sectionHeading('随机对照', '策略在随机分布里的位置 —— 越低越说明规则没用')}
    ${blocks}
    <p class="muted">分位 = 策略收益在该对照组随机分布中的位置。越小表示策略越差；
      0% 表示随机怎么抽都比它好。</p></section>`;
}

function backtestCard(swing: StrategySwing): string {
  const bt = swing.backtest;
  if (!bt) {
    return `<section class="panel">${sectionHeading('三年回测', '数据缺失')}
      <p class="muted">没有 outputs/swing_backtest.json。</p></section>`;
  }
  const m = bt.metrics || {};
  const cells: [string, string, string][] = [
    ['总收益', signed(m.total_return), `年化 ${signed(m.cagr)}`],
    ['最大回撤', pct(m.max_drawdown), ''],
    ['胜率', pct(m.win_rate), `盈亏比 ${m.win_loss_ratio?.toFixed(2) ?? '—'}`],
    ['盈利因子', m.profit_factor?.toFixed(2) ?? '—', ''],
    ['超额收益', signed(m.excess_return), '对基准'],
    ['交易数', String(m.n_trades ?? '—'), `均持 ${m.avg_hold_days?.toFixed(0) ?? '—'} 天`],
  ];
  const grid = cells.map(([k, v, hint]) => `<div class="metric-cell"><span>${escapeHtml(k)}</span>
      <strong>${escapeHtml(v)}</strong><small>${escapeHtml(hint)}</small></div>`).join('');
  const yearly = bt.yearly ? `<table class="swing-table"><thead><tr><th>年份</th>
      <th class="num">收益</th><th class="num">交易</th></tr></thead><tbody>${
    Object.entries(bt.yearly).map(([y, v]) => `<tr><td>${escapeHtml(y)}</td>
      <td class="num">${signed((v as Record<string, number>).total_return)}</td>
      <td class="num">${(v as Record<string, number>).n_trades ?? '—'}</td></tr>`).join('')
  }</tbody></table>` : '';
  const disclaimers = (bt.disclaimers || []).length
    ? `<ul class="swing-disclaimers">${bt.disclaimers!.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`
    : '';
  return `<section class="panel">${sectionHeading('三年回测', `生成于 ${bt.generated_at ?? '—'} · 训练段口径`)}
    <div class="metric-grid">${grid}</div>${yearly}${disclaimers}</section>`;
}

function poolCard(swing: StrategySwing): string {
  const pool = swing.pool;
  if (!pool) {
    return `<section class="panel">${sectionHeading('当前池子', '数据缺失')}
      <p class="muted">找不到波段池 md（data/swing_pool/波段池_持仓.md 与 DSH 侧副本都不可用）。</p></section>`;
  }
  if (!pool.parse_ok || !pool.holdings.length) {
    return `<section class="panel">${sectionHeading('当前池子', '解析失败，原文如下')}
      <pre class="swing-raw">${escapeHtml(pool.raw_excerpt)}</pre></section>`;
  }
  const rows = pool.holdings.map((h: SwingHolding) => `<tr>
      <td><code>${escapeHtml(h.code || '')}</code></td>
      <td>${escapeHtml(h.name || '')}</td>
      <td>${escapeHtml(h.pool || '—')}</td>
      <td class="num">${escapeHtml(h.price || '—')}</td>
      <td class="num">${escapeHtml(h.target || '—')}</td>
      <td class="num">${escapeHtml(h.stop || '—')}</td>
      <td class="swing-state">${escapeHtml(h.state || '—')}</td>
      <td class="num">${escapeHtml(h.next_check || '—')}</td>
    </tr>`).join('');
  const statements = pool.statements.length
    ? `<details class="swing-details"><summary>纪律与状态声明（${pool.statements.length} 条）</summary>
       <ul>${pool.statements.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul></details>`
    : '';
  return `<section class="panel">${sectionHeading('当前池子', `${pool.as_of ?? ''} · 纸面观察，非买入建议`)}
    <div class="swing-table-wrap"><table class="swing-table"><thead><tr>
      <th>代码</th><th>名称</th><th>所属池</th><th class="num">现价</th>
      <th class="num">目标价</th><th class="num">止损价</th><th>状态</th><th class="num">下次复核</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    ${statements}</section>`;
}

/**
 * 波段池区块（v0.65.0 起并入「量化策略」页，不再单独成页）。
 * 由渲染方负责 loading / error / 空快照，这里只关心 swing 块本身。
 */
export function renderSwingPoolBody(state: AppState): string {
  const res = state.strategyHealth ?? null;
  if (state.strategyHealthLoading && !res) return loadingBlock('正在读取波段池数据');
  if (state.strategyHealthError) return errorState('读取失败', state.strategyHealthError);
  if (!res) return emptyState('尚未读取', '点击「重新读取」加载波段池数据。');
  if (!res.ok || !res.data) {
    const desc = res.reason === 'missing'
      ? '还没有量化策略快照。先在 LihuQuantify 跑 python scripts/export_strategy_health.py。'
      : `快照不可用（${res.reason ?? '未知'}）：${res.hint ?? ''}`;
    return errorState('数据不可用', desc);
  }
  const swing = res.data.swing;
  if (!swing) {
    return emptyState('该快照没有波段池数据',
      '契约版本 v2 及以前不含 swing 块。在 LihuQuantify 重新导出（脚本会升到 v3+）后即可显示。');
  }
  return falsifiedBanner(swing)
    + robustnessCard(swing)
    + backtestCard(swing)
    + poolCard(swing);
}
