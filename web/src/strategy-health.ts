// 量化策略页（v0.59.0，2026-11-16；2026-11-17 由「策略健康」改名）
//
// 定位：dsh-invest 是主体入口，LihuQuantify 是**模拟盘验证层**。
// 本页只读展示 Lihu 导出的契约快照（outputs/strategy_health.json，schema_version=1），
// 让「策略有没有问题」在工作台里一眼可见，不必再切到 Lihu 的看板。
//
// 三条设计取舍：
// 1. **模拟盘标签必须显眼**：这份数据与 .dsh-invest/持仓.json（实盘）是两套账，
//    混看会做出错误判断，所以顶部常驻「模拟盘」徽标，服务端也会拒非 paper 快照。
// 2. **失败态要能指导动作**：缺文件 / JSON 损坏 / schema 不符 / 非模拟盘，
//    每种都给具体下一步，而不是一句「加载失败」。
// 3. **陈旧度必须露出来**：快照是离线导出的，可能几天没更新；不标出来就会被当成实时数据。
import { emptyState, errorState, loadingBlock, pageHeader, sectionHeading } from './components';
import { escapeHtml } from './format';
import { sparkline } from './chart-utils';
import { renderSwingPoolBody } from './swing-pool';
import { renderStrategyBacktestBody } from './strategy-backtest';
import { icon } from './icons';
import type { AppState } from './state';
import type { StrategyHealthResponse, StrategyHealthRisk, StrategyHealthSnapshot, StrategyOverview } from './types';

const STATUS_TONE: Record<string, { label: string; cls: string }> = {
  ok: { label: '正常', cls: 'ok' },
  warn: { label: '需关注', cls: 'warn' },
  breach: { label: '已触线', cls: 'breach' },
  unknown: { label: '未知', cls: 'unknown' },
};

const REASON_TEXT: Record<string, { title: string; desc: string }> = {
  missing: {
    title: '还没有量化策略快照',
    desc: '在 LihuQuantify 目录下执行：python scripts/export_strategy_health.py，然后回到本页刷新。',
  },
  invalid_json: {
    title: '快照文件不是合法 JSON',
    desc: '可能是导出中断或文件被截断。重新跑一次 python scripts/export_strategy_health.py 即可。',
  },
  schema_mismatch: {
    title: '快照版本与工作台不匹配',
    desc: '工作台当前只认 schema_version=1。请升级 LihuQuantify 的导出脚本或本插件，不要手动改版本号。',
  },
  not_paper_account: {
    title: '拒绝展示：这份快照不是模拟盘',
    desc: 'Lihu 的账本是模拟盘，.dsh-invest/持仓.json 是实盘，两者严禁混账。请检查导出目标是否指错了账本。',
  },
};

function pct(v: number | null | undefined): string {
  return (v === null || v === undefined || !Number.isFinite(v)) ? '—' : (v * 100).toFixed(1) + '%';
}

function statusBanner(snap: StrategyHealthSnapshot): string {
  const tone = STATUS_TONE[snap.risk?.status ?? 'unknown'] ?? STATUS_TONE.unknown;
  const findings = snap.findings || [];
  const errors = findings.filter((f) => f.level === 'error').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  return `<article class="health-banner health-${tone.cls}">
    <div class="health-banner-main">
      <span class="health-dot"></span>
      <div>
        <strong>风控状态：${escapeHtml(tone.label)}</strong>
        <p>${errors} 项触线 · ${warns} 项待关注 · 来源 ${escapeHtml(snap.source)} · 快照 ${escapeHtml(snap.generated_at)}</p>
      </div>
    </div>
    <span class="paper-badge" title="LihuQuantify 跑的是模拟盘，与 .dsh-invest/持仓.json 实盘是两套账">模拟盘</span>
  </article>`;
}

function findingsCard(snap: StrategyHealthSnapshot): string {
  const items = snap.findings || [];
  if (!items.length) {
    return `<section class="panel">${sectionHeading('待关注事项', '没有需要处理的问题')}
      <p class="muted">当前快照没有产生任何告警。</p></section>`;
  }
  const rows = items.map((f) => {
    const tone = f.level === 'error' ? 'breach' : f.level === 'warn' ? 'warn' : 'info';
    return `<li class="finding finding-${tone}"><span class="finding-tag">${
      f.level === 'error' ? '触线' : f.level === 'warn' ? '关注' : '提示'
    }</span><span>${escapeHtml(f.text)}</span></li>`;
  }).join('');
  return `<section class="panel">${sectionHeading('待关注事项', `${items.length} 条`)}<ul class="finding-list">${rows}</ul></section>`;
}

function riskCard(risk: StrategyHealthRisk | null): string {
  if (!risk) return '';
  const tone = STATUS_TONE[risk.status] ?? STATUS_TONE.unknown;
  const cells: [string, string, string][] = [
    ['持仓数', String(risk.n_positions ?? '—'), `下限 ${risk.min_concurrent_positions} 只`],
    ['最大单票权重', pct(risk.max_single_weight), `上限 ${pct(risk.max_single_position)}`],
    ['当前回撤', risk.current_drawdown === null ? '未采集' : pct(risk.current_drawdown), `硬上限 ${pct(risk.mdd_limit)}`],
    ['状态', tone.label, risk.largest_position ? `最大仓位 ${risk.largest_position}` : ''],
  ];
  const grid = cells.map(([label, value, hint]) => `<div class="metric-cell">
      <span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small></div>`).join('');
  const note = risk.current_drawdown === null && risk.drawdown_note
    ? `<p class="muted">${escapeHtml(risk.drawdown_note)}</p>` : '';
  return `<section class="panel">${sectionHeading('风控与集中度', '决定回撤的是持仓数，不是单票上限')}
    <div class="metric-grid">${grid}</div>${note}</section>`;
}

function researchCard(snap: StrategySnapshotResearch): string {
  const r = snap;
  const bar = (label: string, n: number, cls: string) => `<div class="research-bar ${cls}">
      <span>${escapeHtml(label)}</span><strong>${n}</strong></div>`;
  const recent = (r.decisions || []).filter((d) => d.status !== 'pending').slice(0, 6)
    .map((d) => `<li><code>${escapeHtml(d.id)}</code><span class="research-status research-${escapeHtml(d.status)}">${
      d.status === 'passed' ? '通过' : d.status === 'failed' ? '否掉' : d.status === 'rejected' ? '驳回' : '无检验力'
    }</span><span class="research-title">${escapeHtml(d.title)}</span></li>`).join('');
  return `<section class="panel">${sectionHeading('研究纪律', `${r.total} 条预注册假设`)}
    <div class="research-bars">${bar('通过', r.passed, 'pass')}${bar('否掉', r.failed, 'fail')}${
      bar('驳回', r.rejected, 'reject')}${bar('无检验力', r.inconclusive, 'neutral')}${
      bar('待判定', r.pending, 'pending')}</div>
    ${recent ? `<ul class="research-list">${recent}</ul>` : '<p class="muted">暂无已判定假设。</p>'}</section>`;
}

type StrategySnapshotResearch = NonNullable<StrategyHealthSnapshot['research']>;

function behaviorCard(snap: StrategyHealthSnapshot): string {
  const b = snap.behavior;
  if (!b) return '';
  const rows: [string, string][] = [];
  const rounds = b.rounds as Record<string, number> | undefined;
  const lossAdd = b.loss_add_ratio as Record<string, number> | undefined;
  const turnover = b.turnover as Record<string, number> | undefined;
  const peak = b.peak_capture as Record<string, number> | undefined;
  const sizing = b.position_sizing as Record<string, number> | undefined;
  if (rounds) rows.push(['轮次 / 胜率', `${rounds.n_rounds ?? '—'} 轮 · ${pct(rounds.win_rate)}`]);
  if (lossAdd) rows.push(['浮亏加仓占买入额', pct(lossAdd.ratio)]);
  if (turnover) rows.push(['年化换手', turnover.turnover_annual === undefined ? '—' : Number(turnover.turnover_annual).toFixed(1) + ' 倍']);
  if (peak) rows.push(['峰值捕获率（中位）', pct(peak.median)]);
  if (sizing) rows.push(['亏损单/盈利单规模比', sizing.loss_to_win_ratio === undefined ? '—' : Number(sizing.loss_to_win_ratio).toFixed(2) + 'x']);
  if (!rows.length) return '';
  const grid = rows.map(([k, v]) => `<div class="metric-cell"><span>${escapeHtml(k)}</span><strong>${escapeHtml(v)}</strong></div>`).join('');
  return `<section class="panel">${sectionHeading('行为体检', '来自真实交割单（907 笔）')}
    <div class="metric-grid">${grid}</div></section>`;
}

function money(v: number | null | undefined): string {
  return (v === null || v === undefined || !Number.isFinite(v))
    ? '—' : v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

/** 首屏总览（v4）：今日巡检结果 + 账户 + 持仓。数据来自 last_scan，不在这里重算。 */
function overviewSection(snap: StrategyHealthSnapshot): string {
  const o = snap.overview;
  if (!o) {
    return `<section class="panel">${sectionHeading('今日巡检', '数据不可用')}
      <p class="muted">该快照是契约 v4 之前的版本，没有总览块。在 LihuQuantify 重新导出后即可显示。</p></section>`;
  }
  const c = o.counts || ({} as StrategyOverview['counts']);
  const a = o.account || ({} as StrategyOverview['account']);
  const gate = o.market_gate;
  const gateText = gate
    ? (gate.gate_open ? '开（允许开仓）' : '关（停止开新仓）')
    : '—';
  const tp = a.today_pnl;

  const patrol: [string, string][] = [
    ['巡检日期', o.trade_date ?? '—'],
    ['市场状态', o.market_state ?? '—'],
    // 必须写明作用范围：这行容易被误读成「波段池也被闸门卡着」。
    // 波段池从来没有市场闸门（三年回测的 params 里连市场相关键都没有），
    // 它的闸只有两道：高价股硬闸 P_max 与赔率 ≥3:1。
    ['短线策略闸门', gateText],
    ['信号 / 成交', `${c.signals ?? '—'} / ${c.executed ?? '—'}`],
    ['拦截 / 卖出', `${c.rejected ?? '—'} / ${c.sells_today ?? '—'}`],
    ['过期丢弃', c.stale_dropped === null || c.stale_dropped === undefined ? '—' : String(c.stale_dropped)],
  ];
  const patrolRow = patrol.map(([k, v]) => `<span class="patrol-cell">
      <small>${escapeHtml(k)}</small><b>${escapeHtml(v)}</b></span>`).join('');

  const acct: [string, string, string][] = [
    ['总资产', money(a.total_asset), `初始 ${money(a.init_capital)}`],
    ['累计收益', pct(a.total_return), ''],
    ['今日盈亏', tp ? (tp.amount >= 0 ? '+' : '') + tp.amount.toFixed(0) : '—',
      tp ? pct(tp.ratio) + (tp.basis === 'equity_history' ? '（按权益历史）' : '') : ''],
    ['持仓 / 现金', `${(o.positions || []).length} 只`, `${money(a.cash)} 现金`],
  ];
  const acctGrid = acct.map(([k, v, hint]) => `<div class="metric-cell"><span>${escapeHtml(k)}</span>
      <strong>${escapeHtml(v)}</strong><small>${escapeHtml(hint)}</small></div>`).join('');

  const pos = o.positions || [];
  const posTable = pos.length ? `<div class="swing-table-wrap"><table class="swing-table"><thead><tr>
      <th>代码</th><th>名称</th><th class="num">数量</th><th class="num">成本</th>
      <th class="num">现价</th><th class="num">市值</th><th class="num">浮盈亏</th><th class="num">止损价</th>
    </tr></thead><tbody>${pos.map((p) => `<tr>
      <td><code>${escapeHtml(p.code || '')}</code></td>
      <td>${escapeHtml(p.name || '—')}</td>
      <td class="num">${p.volume ?? '—'}</td>
      <td class="num">${p.cost ?? '—'}</td>
      <td class="num">${p.price ?? '—'}</td>
      <td class="num">${money(p.market_value)}</td>
      <td class="num">${p.pnl_ratio === null ? '—' : pct(p.pnl_ratio)}</td>
      <td class="num">${p.stop_price === null ? '—' : p.stop_price.toFixed(2)}</td>
    </tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">当前空仓。</p>';

  const review = o.review;
  const reviewLine = review
    ? `<p class="muted">评审进度：已平仓 <b>${review.closed_rounds ?? '—'}</b> / ${review.target ?? '—'} 轮
       （还差 ${review.remaining ?? '—'}）· 胜率 ${pct(review.win_rate as number)} · 盈亏比 ${
      (review.pl_ratio as number)?.toFixed?.(2) ?? '—'} · 已实现 ${money(review.realized_pnl as number)}</p>`
    : '';

  const brief = o.brief
    ? `<div class="brief-box">${escapeHtml(o.brief)}</div>`
    : '<p class="muted">本日没有简报。</p>';
  const alerts = (o.alerts || []).length
    ? `<ul class="finding-list">${o.alerts.map((t) => `<li class="finding finding-warn">
        <span class="finding-tag">提示</span><span>${escapeHtml(t)}</span></li>`).join('')}</ul>`
    : '';

  return `<section class="panel">${sectionHeading('今日巡检', `${o.finished_at ?? ''}${o.brief_is_ai ? ' · AI 简报' : ''}`)}
    <div class="patrol-row">${patrolRow}</div>
    <div class="metric-grid">${acctGrid}</div>
    ${reviewLine}
    <h3 class="sub-heading">持仓</h3>${posTable}
    <h3 class="sub-heading">简报</h3>${brief}
    ${alerts}</section>`;
}

function equityCard(snap: StrategyHealthSnapshot): string {
  const eq = snap.equity;
  // v1 快照没有 equity 块 —— 降级成一句说明，而不是整块消失或报错
  if (!eq) {
    return `<section class="panel">${sectionHeading('权益与回撤', '数据不可用')}
      <p class="muted">该快照是契约 v1，没有权益序列。在 LihuQuantify 重新导出后即可显示真实回撤曲线。</p></section>`;
  }
  const pts = eq.points || [];
  const cells: [string, string, string][] = [
    ['当前回撤', eq.current_drawdown === null ? '—' : pct(eq.current_drawdown), '距历史峰值'],
    ['历史最大回撤', eq.max_drawdown === null ? '—' : pct(eq.max_drawdown),
      `${eq.max_drawdown_peak_date ?? '—'} → ${eq.max_drawdown_trough_date ?? '—'}`],
    ['最新权益', eq.latest_equity === null ? '—' : eq.latest_equity.toFixed(0), '元'],
    ['覆盖交易日', String(eq.n_points), `${eq.first_date ?? '—'} 起`],
  ];
  const grid = cells.map(([k, v, hint]) => `<div class="metric-cell"><span>${escapeHtml(k)}</span>
      <strong>${escapeHtml(v)}</strong><small>${escapeHtml(hint)}</small></div>`).join('');

  // 来源必须写出来：重建段与实时段混在一起而不标注，会被当成全期真实记账
  const srcNote = eq.reconstructed_days > 0
    ? `<p class="muted">其中 <b>${eq.reconstructed_days}</b> 个交易日由模拟盘自有日报重建，
        <b>${eq.live_days}</b> 个为巡检实时记账。${eq.truncated_days ? `曲线只显示最近 ${pts.length} 天（前 ${eq.truncated_days} 天已截断）。` : ''}</p>`
    : `<p class="muted">全部 ${eq.live_days} 个交易日均为巡检实时记账。</p>`;

  return `<section class="panel">${sectionHeading('权益与回撤', '模拟盘真实记账，非回测曲线')}
    <div class="metric-grid">${grid}</div>
    ${sparkline(pts)}
    ${srcNote}</section>`;
}

/** 巡检日报（v6）：默认折叠 —— 它是备查资料，不该抢首屏。 */
function reportsSection(snap: StrategyHealthSnapshot): string {
  const rep = snap.reports;
  if (!rep || !rep.recent?.length) {
    return `<section class="panel">${sectionHeading('巡检日报', '数据不可用')}
      <p class="muted">该快照没有日报块（契约 v5 及以前）。在 LihuQuantify 重新导出后即可显示。</p></section>`;
  }
  const rows = rep.recent.map((r) => {
    const bad = r.checks_failed?.length ? ` <span class="report-flag">自检 ${r.checks_failed.length} 项未过</span>` : '';
    const dateCell = r.date_mismatch
      ? `${escapeHtml(r.date)} <span class="report-flag" title="文件名与标题日期不一致（${escapeHtml(r.title_date || '')}）">日期不一致</span>`
      : escapeHtml(r.date);
    return `<tr>
      <td>${dateCell}</td>
      <td>${escapeHtml(r.market_state || '—')}</td>
      <td class="num">${money(r.total_asset)}</td>
      <td class="num">${r.pnl_ratio === null ? '—' : pct(r.pnl_ratio)}</td>
      <td class="num">${r.positions ?? '—'}</td>
      <td class="report-ops">${escapeHtml(r.ops || '—')}${bad}</td>
    </tr>`;
  }).join('');
  const failed = rep.recent.flatMap((r) => (r.checks_failed || []).map((t) => ({ date: r.date, t })));
  const failedBlock = failed.length
    ? `<ul class="finding-list" style="margin-top:10px">${failed.map((f) => `<li class="finding finding-error">
        <span class="finding-tag">未通过</span><span>${escapeHtml(f.date)} · ${escapeHtml(f.t)}</span></li>`).join('')}</ul>`
    : '<p class="muted">最近这些天的铁律自检全部通过。</p>';

  return `<section class="panel">
    <details class="swing-details">
      <summary>巡检日报 · 总 ${rep.total} 份，显示最近 ${rep.recent.length} 天</summary>
      <div class="swing-table-wrap"><table class="swing-table"><thead><tr>
        <th>日期</th><th>市场</th><th class="num">总资产</th>
        <th class="num">累计收益</th><th class="num">持仓</th><th>今日操作</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <h3 class="sub-heading">铁律自检</h3>
      ${failedBlock}
      <p class="muted">完整日报留在 LihuQuantify 的 outputs/reports/ 下，本页只抽关键字段。</p>
    </details>
  </section>`;
}


/** 页内分组（v0.65.0）：波段池与策略回测并入本页，不再各占一个导航项。 */
type QuantTab = 'overview' | 'swing' | 'backtest';
const QUANT_TABS: { id: QuantTab; label: string; hint: string }[] = [
  { id: 'overview', label: '总览', hint: '今日巡检 · 权益 · 风控 · 研究纪律' },
  { id: 'swing', label: '波段池', hint: '已证伪 · 纸面跟踪' },
  { id: 'backtest', label: '回测', hint: '回测绩效 · 网格寻优' },
];

function quantTabBar(active: QuantTab): string {
  const items = QUANT_TABS.map((t) => `<button class="quant-tab${t.id === active ? ' active' : ''}"
      data-action="quant-tab" data-tab="${t.id}" title="${escapeHtml(t.hint)}">
      ${escapeHtml(t.label)}</button>`).join('');
  return `<div class="quant-tabs" role="tablist">${items}</div>`;
}

export function renderStrategyHealth(state: AppState): string {
  const res: StrategyHealthResponse | null = state.strategyHealth ?? null;
  const header = pageHeader(
    '量化策略',
    'LihuQuantify 的模拟盘验证层：今日巡检、权益与回撤、风控集中度、行为体检、研究纪律、波段池、策略回测。与实盘账本严格分开。',
    '<button class="button button-secondary" data-action="refresh">' + icon('refresh', 15) + '重新读取</button>',
  );

  if (state.strategyHealthLoading && !res) return header + loadingBlock('正在读取量化策略快照');
  if (state.strategyHealthError) return header + errorState('读取失败', state.strategyHealthError);
  if (!res) return header + emptyState('尚未读取', '点击右上角「重新读取」加载量化策略快照。');

  if (!res.ok || !res.data) {
    const info = REASON_TEXT[res.reason ?? ''] ?? {
      title: '快照不可用',
      desc: res.reason ? `原因：${res.reason}` : '服务端未返回数据。',
    };
    const extra = [res.hint, `读取路径：${res.path}`].filter(Boolean).join(' · ');
    return header + errorState(info.title, `${info.desc}${extra ? '（' + extra + '）' : ''}`);
  }

  const snap = res.data;
  const tab = state.quantTab || 'overview';
  const stale = res.stale_hours !== null && res.stale_hours !== undefined && res.stale_hours > 48;
  const staleNote = stale
    ? `<div class="stale-note">快照已 ${Math.round(res.stale_hours as number)} 小时未更新，可能不代表当前状态。在 LihuQuantify 重跑 export_strategy_health.py。</div>`
    : '';

  if (tab === 'swing') return header + quantTabBar(tab) + staleNote + renderSwingPoolBody(state);
  if (tab === 'backtest') return header + quantTabBar(tab) + staleNote + renderStrategyBacktestBody(state);

  const missing = (snap.missing || []).length
    ? `<p class="muted">缺失数据块：${escapeHtml((snap.missing || []).join('、'))}</p>` : '';

  return header + quantTabBar(tab) + staleNote + statusBanner(snap)
    + overviewSection(snap)
    + findingsCard(snap)
    + equityCard(snap)
    + `<div class="health-columns">${riskCard(snap.risk)}${snap.research ? researchCard(snap.research) : ''}</div>`
    + behaviorCard(snap)
    + reportsSection(snap)
    + missing;
}
