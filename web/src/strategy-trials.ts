// 结论验证（v0.66.0，2026-11-17，Step 1）
//
// 这一页回答的是用户最初的疑问：**「dsh-invest 的判断，交给 Lihu 验证之后到底怎样」**。
//
// 它不是回测、也不是策略绩效，而是「AI 说 → 之后行情怎么走 → 算不算说对」的对账。
// 排版必须把样本量顶在最前面：现在看多类只有 4 条可判、10 日窗口 0 条，
// 这种数字脱离 n 去读就是自欺。所以每个比率旁边都跟 n，并且小样本直接标黄提醒。
//
// 两套产出分开呈现：
//   ① 方向命中 —— 覆盖全部有行情的结论（观察/持有记中性，不判对错）
//   ② 影子交易 —— 仅买入类，按 T+1 收盘入场，跟踪止盈止损
// 跳过原因必须露出来（76 条不是买入）—— 否则会以为「只验证了 5 条是系统缺陷」，
// 其实是 AI 很少给出买入信号。
import { emptyState, errorState, loadingBlock, sectionHeading } from './components';
import { escapeHtml } from './format';
import type { AppState } from './state';
import type { StrategyHitStat, StrategyTrials, StrategyTrialRecord } from './types';

const SKIP_LABEL: Record<string, string> = {
  not_long: '非买入判断（观察/持有/减仓等）',
  no_forward_quote: '结论后还没有行情（窗口未走完）',
  no_quote: '该标的没有行情数据',
};

function pct(v: number | null | undefined, digits = 1): string {
  return (v === null || v === undefined || !Number.isFinite(v)) ? '—' : (v * 100).toFixed(digits) + '%';
}

function money(v: number | null | undefined): string {
  return (v === null || v === undefined || !Number.isFinite(v)) ? '—' : v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

/** 样本量提示：n 太小时把话说死，别让 1/1 看起来像 100% 的能力。 */
function sampleNote(n: number): string {
  if (n === 0) return '无样本';
  if (n < 30) return `仅 ${n} 条，统计上不足以下结论`;
  return `${n} 条`;
}

function hitCard(label: string, stat: StrategyHitStat, hint: string): string {
  const weak = stat.n < 30;
  return `<div class="metric-cell${weak ? ' metric-weak' : ''}">
    <span>${escapeHtml(label)}</span>
    <strong>${stat.rate === null ? '—' : pct(stat.rate)}</strong>
    <small>${escapeHtml(stat.hits)} / ${escapeHtml(String(stat.n))} · ${escapeHtml(sampleNote(stat.n))}${hint ? ' · ' + escapeHtml(hint) : ''}</small>
  </div>`;
}

function trialRow(r: StrategyTrialRecord): string {
  const statusText = r.status === 'closed'
    ? (r.exit_reason === 'target' ? '止盈平仓' : r.exit_reason === 'stop' ? '止损平仓' : '到期平仓')
    : '持有中';
  const pnl = r.pnl_ratio === null ? '—' : (r.pnl_ratio > 0 ? '+' : '') + (r.pnl_ratio * 100).toFixed(2) + '%';
  const cls = (r.pnl_ratio ?? 0) > 0 ? 'num pos' : (r.pnl_ratio ?? 0) < 0 ? 'num neg' : 'num';
  return `<tr>
    <td><code>${escapeHtml(r.code)}</code></td>
    <td>${escapeHtml(r.stance)}</td>
    <td class="num">${escapeHtml(r.entry_date || '—')}</td>
    <td class="num">${r.entry_price ?? '—'}</td>
    <td>${escapeHtml(statusText)}${r.exit_date ? ` · ${escapeHtml(r.exit_date)}` : ''}</td>
    <td class="${cls}">${pnl}</td>
    <td class="num">${r.pnl === null ? '—' : money(r.pnl)}</td>
  </tr>`;
}

function skippedList(tr: StrategyTrials): string {
  const entries = Object.entries(tr.summary.skipped || {});
  if (!entries.length) return '';
  const items = entries.map(([k, v]) =>
    `<span class="skip-chip">${escapeHtml(SKIP_LABEL[k] || k)}：<b>${v}</b></span>`).join('');
  return `<p class="skip-row">未进入影子交易的 ${entries.reduce((a, [, v]) => a + v, 0)} 条：${items}</p>`;
}

export function renderStrategyTrialsBody(state: AppState): string {
  const res = state.strategyHealth ?? null;
  if (state.strategyHealthLoading && !res) return loadingBlock('正在读取结论验证结果');
  if (state.strategyHealthError) return errorState('读取失败', state.strategyHealthError);
  if (!res) return emptyState('尚未读取', '点击「重新读取」加载结论验证结果。');
  if (!res.ok || !res.data) {
    const desc = res.reason === 'missing'
      ? '还没有量化策略快照。先在 LihuQuantify 跑 python scripts/export_strategy_health.py。'
      : `快照不可用（${res.reason ?? '未知'}）：${res.hint ?? ''}`;
    return errorState('数据不可用', desc);
  }
  const tr = res.data.strategy_trials;
  if (!tr) {
    return emptyState('该快照没有结论验证数据',
      '契约版本 v6 及以前不含 strategy_trials 块，或 Lihu 侧还没跑过 scripts/run_strategy_trials.py。');
  }

  const s = tr.summary;
  const lt = s.long_trials;
  const head: [string, string, string][] = [
    ['结论总数', String(s.total), tr.generated_at ? `生成于 ${tr.generated_at}` : ''],
    ['可执行影子交易', String(lt.n), `持有中 ${lt.open} / 已平 ${lt.closed}`],
    ['影子交易盈亏', money(lt.pnl_total), `盈利 ${lt.wins} 笔`],
    ['5 日方向命中', pct(s.direction_hit_5d.expected_up.rate),
      `看多 ${s.direction_hit_5d.expected_up.hits}/${s.direction_hit_5d.expected_up.n} · 看空 ${s.direction_hit_5d.expected_down.hits}/${s.direction_hit_5d.expected_down.n}`],
  ];
  const headGrid = head.map(([k, v, hint]) => `<div class="metric-cell"><span>${escapeHtml(k)}</span>
      <strong>${escapeHtml(v)}</strong><small>${escapeHtml(hint)}</small></div>`).join('');

  const hitGrid = `<div class="metric-grid">
    ${hitCard('5 日 · 看多类命中', s.direction_hit_5d.expected_up, '判断为涨，实际涨')}
    ${hitCard('5 日 · 看空类命中', s.direction_hit_5d.expected_down, '判断为跌，实际跌')}
    ${hitCard('10 日 · 看多类命中', s.direction_hit_10d.expected_up, '')}
    ${hitCard('10 日 · 看空类命中', s.direction_hit_10d.expected_down, '')}
  </div>`;

  const longRows = tr.records.filter((r) => r.status === 'open' || r.status === 'closed');
  const longTable = longRows.length
    ? `<div class="swing-table-wrap"><table class="swing-table"><thead><tr>
        <th>代码</th><th>判断</th><th class="num">入场日</th><th class="num">入场价</th>
        <th>状态</th><th class="num">浮动/已实现</th><th class="num">盈亏(元)</th>
      </tr></thead><tbody>${longRows.map(trialRow).join('')}</tbody></table></div>`
    : '<p class="muted">当前没有可执行的买入类结论。</p>';

  const stanceDist = Object.entries(s.by_stance || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="skip-chip">${escapeHtml(k)}：<b>${v}</b></span>`).join('');

  return `<section class="panel">${sectionHeading('结论验证', 'AI 判断 → 之后行情怎么走 → 算不算说对')}
    <div class="metric-grid">${headGrid}</div>
    <p class="muted">数据源：dsh-invest 的 conclusions.jsonl（只读）。Lihu 不写这份文件，
      两侧账本互不影响。</p>
  </section>
  <section class="panel">${sectionHeading('方向命中', '基准=结论日后第一个交易日收盘，避免用结论日当天收盘产生前视偏差')}
    ${hitGrid}
    <p class="muted">只统计有前向行情的结论；观察/持有属中性，不判对错。样本少于 30 条已标黄，
      不要把 1/4 读成 25% 的能力。</p>
  </section>
  <section class="panel">${sectionHeading('影子交易', '仅买入类 · T+1 收盘入场 100 股 · 止盈/止损/到期出场')}
    ${longTable}
    ${skippedList(tr)}
    <p class="muted">判断分布：${stanceDist}</p>
  </section>
  <section class="panel">
    <details class="swing-details"><summary>执行规则（可审计）</summary>
      <ul>
        <li>入场：${escapeHtml(tr.rules.entry)}</li>
        <li>股数：${escapeHtml(String(tr.rules.shares))} 股（名义，不占主账本资金）</li>
        <li>最长持有：${escapeHtml(String(tr.rules.max_hold_days))} 个交易日</li>
        <li>出场：${escapeHtml(tr.rules.exit)}</li>
        <li>建仓判断：${escapeHtml((tr.rules.long_stances || []).join(' / '))}</li>
      </ul>
    </details>
  </section>`;
}
