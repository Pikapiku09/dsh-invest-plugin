// 实盘绩效（v0.68.0）
//
// 这条数据此前**没有任何页面在展示**：系统能说清模拟盘、AI 判断、策略回测，
// 唯独没地方看「我真实的钱跑成了什么样」。数据来自 Lihu 用真实交割单重建的 monthly_perf.json。
//
// 排版原则：
// 1. **最大回撤必须带「未修复」标记**（recovered_date 为 null）—— 这是最重要的风险事实
// 2. **口径限制与估值跳变必须显示**：初始资金是假设值、有一处 −8,688 元的估值跳变，
//    不写出来就是拿一份带假设的数字当铁证
// 3. 波动倍数与相关性放一起：跑赢大盘 3.5pp 的代价是 3.4 倍波动，单说一头都失真
import { errorState, loadingBlock, sectionHeading } from './components';
import { escapeHtml } from './format';
import { sparkline } from './chart-utils';
import type { AppState } from './state';

function money(v: number | null | undefined): string {
  return (v === null || v === undefined || !Number.isFinite(v)) ? '—' : v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

function pct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(digits) + '%';
}

export function renderRealPerformance(state: AppState): string {
  const head = sectionHeading('实盘绩效', '由真实交割单重建 · 不是回测、不是模拟盘');
  const p = state.realPerformance;
  if (state.realPerformanceLoading && !p) return `<section class="panel">${head}${loadingBlock('正在读取实盘绩效')}</section>`;
  if (state.realPerformanceError && !p) return `<section class="panel">${head}${errorState('读取失败', state.realPerformanceError)}</section>`;
  if (!p || !p.ok || !p.totals) {
    const desc = p?.reason === 'missing'
      ? '还没有实盘绩效数据。在 LihuQuantify 跑：python scripts/monthly_perf.py'
      : (p?.hint || '实盘绩效不可用');
    return `<section class="panel">${head}<p class="muted">${escapeHtml(desc)}</p></section>`;
  }

  const tt = p.totals;
  const md = p.max_drawdown;
  const bm = p.benchmark;
  const unrecovered = md && md.recovered_date === null;
  const volRatio = bm?.account_std_pct && bm?.index_std_pct
    ? (bm.account_std_pct / bm.index_std_pct) : null;

  const cur = p.current;
  // 权威口径优先：券商账本才是「我的钱现在有多少」。
  // monthly_perf 是按交割单重建的模型（初始资金 11 万也是假设值），
  // 两者实测差 1.3 万，不能让它们并列却不解释。
  const reconcile = (cur && cur.total_asset !== null && tt.equity_end)
    ? cur.total_asset - tt.equity_end : null;
  // 折叠摘要常驻两个决策数字：当前总资产（持仓账本口径）与最大回撤（未修复会在展开区标注）
  const keyFigures = `<span class="muted">当前总资产 <b>${escapeHtml(money(cur?.total_asset))}</b> · 最大回撤 <b>${escapeHtml(md ? pct(md.pct) : '—')}</b></span>`;
  const headWithKey = sectionHeading('实盘绩效', '由真实交割单重建 · 不是回测、不是模拟盘', keyFigures);
  const cards: [string, string, string, string][] = cur && cur.total_asset !== null
    ? [
        ['当前总资产', money(cur.total_asset), `持仓账本 · ${String(cur.updated_at || '').slice(0, 10)}`,
          reconcile !== null && reconcile < 0 ? 'neg' : ''],
        ['重建模型累计', pct(tt.total_return_pct),
          `截至 ${(p.equity_curve && p.equity_curve.length) ? p.equity_curve[p.equity_curve.length - 1].date : '—'} · 非当前值`, ''],
        ['最大回撤', md ? pct(md.pct) : '—',
          md ? `${md.peak_date} → ${md.trough_date}${unrecovered ? ' · 未修复' : ''}` : '',
          unrecovered ? 'neg' : ''],
        ['持仓浮亏', cur.holding_pnl === null || cur.holding_pnl === undefined ? '—' : money(cur.holding_pnl),
          `仓位 ${cur.position_pct ?? '—'}% · 现金 ${money(cur.available_cash)}`, (cur.holding_pnl ?? 0) < 0 ? 'neg' : ''],
      ]
    : [
    ['累计收益', pct(tt.total_return_pct), `年化 ${pct(tt.annualized_pct)} · ${tt.years ?? '—'} 年`, ''],
    ['最大回撤', md ? pct(md.pct) : '—',
      md ? `${md.peak_date} → ${md.trough_date} · ${md.calendar_days} 天${unrecovered ? ' · 未修复' : ''}` : '',
      unrecovered ? 'neg' : ''],
    ['月度胜率', tt.monthly_win_rate_pct === null || tt.monthly_win_rate_pct === undefined ? '—' : `${tt.monthly_win_rate_pct.toFixed(1)}%`,
      `${tt.n_months ?? '—'} 个月`, ''],
    ['波动倍数', volRatio === null ? '—' : `${volRatio.toFixed(1)}x`,
      bm ? `账户 ${bm.account_std_pct?.toFixed(1)}% vs 上证 ${bm.index_std_pct?.toFixed(1)}%（月）` : '', ''],
  ];
  const grid = cards.map(([k, v, hint, tone]) => `<div class="metric-cell">
      <span>${escapeHtml(k)}</span>
      <strong class="${tone}">${escapeHtml(v)}</strong>
      <small>${escapeHtml(hint)}</small></div>`).join('');

  const reconcileNote = (reconcile !== null && Math.abs(reconcile) > 1)
    ? `<div class="inline-warning">两个数字对不上：重建模型期末 ${money(tt.equity_end)}（${(p.equity_curve || []).length ? p.equity_curve![p.equity_curve!.length - 1].date : '—'}）
       与持仓账本 ${money(cur!.total_asset)}（${String(cur!.updated_at || '').slice(0, 10)}）相差 <b>${money(reconcile)}</b>。
       该模型初始资金 11 万为假设值、不含天天宝与银证转账、且有 7 笔成交晚于行情末日未计价，
       <b>绝对权益水平不可作为账户事实</b>；以持仓账本为准。曲线与月度分布仅代表重建路径。</div>`
    : '';

  const exJump = md?.pct_ex_valuation_jumps;
  const ddNote = (md && exJump !== null && exJump !== undefined && md.pct !== exJump)
    ? `<p class="muted">剔除估值跳变后的最大回撤为 <b>${pct(exJump)}</b>（原始 ${pct(md.pct)}，差额来自部分标的行情首次出现时的估值切换）。</p>`
    : '';

  const curve = (p.equity_curve || []).map((x) => ({ d: x.date, v: x.equity }));
  const chart = curve.length >= 2 ? sparkline(curve, 640, 160, '实盘权益曲线') : '';
  const truncated = (p.equity_points_total ?? 0) > curve.length
    ? `<p class="muted">曲线显示 ${curve.length} / ${p.equity_points_total} 个交易日（等距抽稀）。</p>` : '';

  const benchLine = bm
    ? `<p class="muted">与 ${escapeHtml(bm.code)} 月度相关 <b>${bm.spearman?.toFixed(3) ?? '—'}</b>
       （Spearman）· 账户月均 ${pct(bm.account_mean_pct)} vs 上证 ${pct(bm.index_mean_pct)}</p>`
    : '';

  const monthly = (p.monthly || []).slice().reverse().slice(0, 12);
  const monthRows = monthly.map((m) => {
    const cls = m.return_pct > 0 ? 'num pos' : m.return_pct < 0 ? 'num neg' : 'num';
    return `<tr><td>${escapeHtml(m.month)}</td>
      <td class="${cls}">${pct(m.return_pct)}</td>
      <td class="num">${m.win_rate_pct === null || m.win_rate_pct === undefined ? '—' : m.win_rate_pct.toFixed(1) + '%'}</td>
      <td class="num">${m.n_trades ?? '—'}</td>
      <td class="num">${money(m.realized_pnl)}</td></tr>`;
  }).join('');
  const monthTable = monthly.length
    ? `<div class="swing-table-wrap"><table class="swing-table"><thead><tr>
        <th>月份</th><th class="num">收益</th><th class="num">胜率</th>
        <th class="num">成交笔数</th><th class="num">已实现盈亏</th></tr></thead>
        <tbody>${monthRows}</tbody></table></div>`
    : '';

  const jumps = (p.valuation_jumps || []).length
    ? `<p class="muted">估值跳变 ${p.valuation_jumps!.length} 处：${
        p.valuation_jumps!.map((j) => `${escapeHtml(j.ts_code)} ${escapeHtml(j.date)} ${money(j.jump_yuan)} 元`).join('、')
      }</p>` : '';

  const limits = (p.limitations || []).length
    ? `<details class="swing-details"><summary>口径限制（${p.limitations!.length} 条，读数字前请先看）</summary>
        <ul>${p.limitations!.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></details>`
    : '';

  // 默认折叠（不写 open）：摘要行常驻标题与两个决策数字，展开后内容与旧版一致
  return `<section class="panel"><details class="swing-details"><summary>${headWithKey}</summary>
    <div class="metric-grid">${grid}</div>
    ${reconcileNote}
    ${ddNote}
    ${chart}${truncated}
    ${benchLine}
    <h3 class="sub-heading">最近 12 个月</h3>
    ${monthTable}
    ${jumps}
    ${limits}
  </details></section>`;
}
