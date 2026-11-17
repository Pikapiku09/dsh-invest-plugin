// 影子交易（v0.68.0）
//
// 从「量化策略 → 结论验证」迁到「判断质量」页。
// 原因：方向命中的判定式与判断质量**逐字相同**（bullish ? ret5>0 : ret5<0），
// 同一件事出现在两处，只会出现「同一个指标两个数字」。这里只保留判断质量没有的那块：
// **把结论当成真实买卖执行一遍，算出元计盈亏**。
//
// 排版要点：
// - 口径（复权覆盖几只 / 回落几只）必须露出来：收益口径不同，数字就不可比
// - 样本极少（当前 5 笔），不夸大、不写「胜率」这种需要样本支撑的词
import { emptyState, errorState, loadingBlock, sectionHeading } from './components';
import { escapeHtml } from './format';
import { sparkline } from './chart-utils';
import type { AppState } from './state';

function money(v: number | null | undefined): string {
  return (v === null || v === undefined || !Number.isFinite(v)) ? '—' : v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

function pct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + (v * 100).toFixed(digits) + '%';
}


/**
 * 撮合模拟（v0.69.0）：把资金约束加回来。
 *
 * 单笔影子交易假设「每笔都能按 100 股成交」，不涉及钱够不够、仓位满没满。
 * 真实做的时候现金有限、单票有上限、同时持仓有上限 —— 结论一多就必须排队。
 * 这一节回答「如果当初真按纪律做，账户会长什么样」。
 */
function portfolioSection(t: NonNullable<AppState['strategyTrials']>): string {
  const p = t.portfolio;
  if (!p) return '';
  const skipped = Object.entries(p.skipped || {});
  const skipText = skipped.length
    ? skipped.map(([k, v]) => {
        const label = k === 'no_slot' ? '仓位已满' : k === 'insufficient_cash' ? '买不起一手'
          : k === 'already_held' ? '已持有' : k === 'no_quote' ? '无行情' : k;
        return `${label} ${v}`;
      }).join(' · ')
    : '无';

  const cards: [string, string, string][] = [
    ['期末权益', money(p.final_equity), `初始 ${money(p.initial_capital)}`],
    ['组合收益', pct(p.total_return), ''],
    ['组合最大回撤', pct(p.max_drawdown), '虚拟账户口径'],
    ['成交 / 在持', `${p.n_trades} / ${p.n_open}`, `最多同时 ${p.rules?.max_positions ?? '—'} 只`],
  ];
  const grid = cards.map(([k, v, hint]) => `<div class="metric-cell"><span>${escapeHtml(k)}</span>
      <strong>${escapeHtml(v)}</strong><small>${escapeHtml(hint)}</small></div>`).join('');

  const curve = (p.equity_curve || []).map((x) => ({ d: x.d, v: x.v }));
  const chart = curve.length >= 2 ? sparkline(curve, 640, 140, '撮合模拟权益曲线') : '';

  const tradeRows = (p.trades || []).map((x) => {
    const cls = x.pnl_ratio > 0 ? 'num pos' : x.pnl_ratio < 0 ? 'num neg' : 'num';
    const reason = x.exit_reason === 'target' ? '止盈' : x.exit_reason === 'stop' ? '止损' : '到期';
    return `<tr><td><code>${escapeHtml(x.code)}</code></td>
      <td class="num">${escapeHtml(x.entry_date)}</td><td class="num">${x.entry_price}</td>
      <td class="num">${escapeHtml(x.exit_date)}</td><td class="num">${x.exit_price}</td>
      <td>${reason}</td><td class="${cls}">${pct(x.pnl_ratio)}</td>
      <td class="num">${money(x.pnl)}</td>
      <td class="num">${x.commission === undefined ? '—' : money(x.commission)}</td>
      <td class="num">${x.stamp_tax === undefined ? '—' : money(x.stamp_tax)}</td></tr>`;
  }).join('');
  const tradeTable = (p.trades || []).length
    ? `<div class="swing-table-wrap"><table class="swing-table"><thead><tr>
        <th>代码</th><th class="num">入场日</th><th class="num">入场价</th>
        <th class="num">出场日</th><th class="num">出场价</th><th>原因</th>
        <th class="num">净收益</th><th class="num">净盈亏(元)</th>
        <th class="num">佣金</th><th class="num">印花税</th>
      </tr></thead><tbody>${tradeRows}</tbody></table></div>`
    : '<p class="muted">模拟期内没有触发平仓（都还在持有窗口内）。</p>';

  const cost = p.costs;
  const costLine = cost
    ? `<p class="muted">交易成本已计入：佣金 ${money(cost.total_commission)} 元
        （${(cost.commission_rate * 10000).toFixed(2)} 万，单笔最低 ${money(cost.min_commission)} 元）·
        印花税 ${money(cost.total_stamp_tax)} 元（卖出 ${(cost.stamp_tax_rate * 1000).toFixed(1)}‰）·
        滑点 ${money(cost.total_slippage)} 元（${(cost.slippage * 100).toFixed(2)}%）·
        合计 <b>${money(cost.total_fees)} 元</b></p>`
    : '<p class="muted">本快照未含交易成本（旧版产出），收益为毛额。</p>';

  return `<div class="sub-block">
    <h3 class="sub-heading">撮合模拟（含资金约束与交易成本）</h3>
    <div class="metric-grid">${grid}</div>
    ${chart}
    ${tradeTable}
    ${costLine}
    <p class="muted">跳过原因：${escapeHtml(skipText)}。规则：单票 ≤ 总资产
      ${(p.rules?.max_single_position ?? 0) * 100}%、最多同时 ${p.rules?.max_positions ?? '—'} 只、
      ${p.rules?.lot ?? 100} 股整手、入场 ${escapeHtml(p.rules?.entry || '')}。</p>
  </div>`;
}

export function renderShadowTrades(state: AppState): string {
  const head = sectionHeading('影子交易', '把结论当成真实买卖执行一遍：T+1 收盘入场 100 股，止盈/止损/到期出场');
  const t = state.strategyTrials;
  if (state.strategyTrialsLoading && !t) return `<section class="panel">${head}${loadingBlock('正在读取影子交易')}</section>`;
  if (state.strategyTrialsError && !t) return `<section class="panel">${head}${errorState('读取失败', state.strategyTrialsError)}</section>`;
  if (!t || !t.ok) {
    const desc = t?.reason === 'missing'
      ? '还没有影子交易结果。在 LihuQuantify 跑：python scripts/run_strategy_trials.py'
      : (t?.hint || '影子交易数据不可用');
    return `<section class="panel">${head}<p class="muted">${escapeHtml(desc)}</p></section>`;
  }
  const sum = t.summary;
  if (!sum) return `<section class="panel">${head}${emptyState('暂无汇总', '影子交易结果缺少 summary。')}</section>`;

  const lt = sum.long_trials;
  const adj = t.rules?.adj_covered_codes;
  const miss = t.rules?.adj_missing_codes?.length ?? 0;
  const cards: [string, string, string][] = [
    ['已建仓', String(lt.n), `持有中 ${lt.open} / 已平 ${lt.closed}`],
    ['合计盈亏', money(lt.pnl_total), `${lt.wins} 笔为正`],
    ['收益口径', adj === undefined ? '复权优先' : `复权 ${adj} 只`,
      miss ? `另有 ${miss} 只无复权因子，回落原始价` : '全部可用复权'],
    ['未建仓', String(sum.skipped?.not_long ?? 0), '非买入判断（观察/持有/减仓等）'],
  ];
  const grid = cards.map(([k, v, hint]) => `<div class="metric-cell"><span>${escapeHtml(k)}</span>
      <strong>${escapeHtml(v)}</strong><small>${escapeHtml(hint)}</small></div>`).join('');

  const rows = (t.trials || []).map((r) => {
    const status = r.status === 'closed'
      ? (r.exit_reason === 'target' ? '止盈' : r.exit_reason === 'stop' ? '止损' : '到期')
      : '持有中';
    const ratio = r.pnl_ratio;
    const cls = (ratio ?? 0) > 0 ? 'num pos' : (ratio ?? 0) < 0 ? 'num neg' : 'num';
    const basisTag = r.basis === 'adjusted' ? '' : ' <span class="muted small" title="该标的无复权因子，收益率按原始价计算">未复权</span>';
    return `<tr>
      <td><code>${escapeHtml(r.code)}</code></td>
      <td>${escapeHtml(r.stance)}</td>
      <td class="num">${escapeHtml(r.entry_date || '—')}</td>
      <td class="num">${r.entry_price ?? '—'}</td>
      <td>${escapeHtml(status)}${r.exit_date ? ` · ${escapeHtml(r.exit_date)}` : ''}</td>
      <td class="${cls}">${pct(ratio)}${basisTag}</td>
      <td class="num">${money(r.pnl)}</td>
    </tr>`;
  }).join('');

  const table = (t.trials || []).length
    ? `<div class="swing-table-wrap"><table class="swing-table"><thead><tr>
        <th>代码</th><th>判断</th><th class="num">入场日</th><th class="num">入场价</th>
        <th>状态</th><th class="num">收益</th><th class="num">盈亏(元)</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="muted">当前没有已建仓的影子交易。</p>';

  const rules = t.rules
    ? `<details class="swing-details"><summary>执行规则（可审计）</summary><ul>
        <li>入场：${escapeHtml(t.rules.entry)}</li>
        <li>股数：${escapeHtml(String(t.rules.shares))} 股（名义，不占主账本资金）</li>
        <li>最长持有：${escapeHtml(String(t.rules.max_hold_days))} 个交易日</li>
        <li>出场：${escapeHtml(t.rules.exit)}</li>
        <li>建仓判断：${escapeHtml((t.rules.long_stances || []).join(' / '))}</li>
        <li>口径：${escapeHtml(t.rules.return_basis || '优先复权')}</li>
      </ul></details>`
    : '';

  return `<section class="panel">${head}
    <div class="metric-grid">${grid}</div>
    ${table}
    ${portfolioSection(t)}
    ${rules}
    <p class="muted">本节为<b>毛收益</b>（未计交易成本，用于逐笔对照）；到手收益看下方撮合模拟。
      样本 ${lt.n} 笔，不足以支撑「胜率」这类统计结论，这里只作逐笔记录。
      方向命中（猜对没有）见本页上方的分组表格，不与本节重复。</p>
  </section>`;
}
