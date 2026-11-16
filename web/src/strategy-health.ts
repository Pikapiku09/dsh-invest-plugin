// 策略健康页（v0.59.0，2026-11-16）
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
import { icon } from './icons';
import type { AppState } from './state';
import type { StrategyHealthResponse, StrategyHealthRisk, StrategyHealthSnapshot } from './types';

const STATUS_TONE: Record<string, { label: string; cls: string }> = {
  ok: { label: '正常', cls: 'ok' },
  warn: { label: '需关注', cls: 'warn' },
  breach: { label: '已触线', cls: 'breach' },
  unknown: { label: '未知', cls: 'unknown' },
};

const REASON_TEXT: Record<string, { title: string; desc: string }> = {
  missing: {
    title: '还没有策略健康快照',
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

export function renderStrategyHealth(state: AppState): string {
  const res: StrategyHealthResponse | null = state.strategyHealth ?? null;
  const header = pageHeader(
    '策略健康',
    '只读展示 LihuQuantify 的模拟盘验证结果：风控集中度、行为体检、研究纪律判决。与实盘账本严格分开。',
    '<button class="button button-secondary" data-action="refresh">' + icon('refresh', 15) + '重新读取</button>',
  );

  if (state.strategyHealthLoading && !res) return header + loadingBlock('正在读取策略健康快照');
  if (state.strategyHealthError) return header + errorState('读取失败', state.strategyHealthError);
  if (!res) return header + emptyState('尚未读取', '点击右上角「重新读取」加载策略健康快照。');

  if (!res.ok || !res.data) {
    const info = REASON_TEXT[res.reason ?? ''] ?? {
      title: '快照不可用',
      desc: res.reason ? `原因：${res.reason}` : '服务端未返回数据。',
    };
    const extra = [res.hint, `读取路径：${res.path}`].filter(Boolean).join(' · ');
    return header + errorState(info.title, `${info.desc}${extra ? '（' + extra + '）' : ''}`);
  }

  const snap = res.data;
  const stale = res.stale_hours !== null && res.stale_hours !== undefined && res.stale_hours > 48;
  const staleNote = stale
    ? `<div class="stale-note">快照已 ${Math.round(res.stale_hours as number)} 小时未更新，可能不代表当前状态。在 LihuQuantify 重跑 export_strategy_health.py。</div>`
    : '';
  const missing = (snap.missing || []).length
    ? `<p class="muted">缺失数据块：${escapeHtml((snap.missing || []).join('、'))}</p>` : '';

  return header + staleNote + statusBanner(snap)
    + findingsCard(snap)
    + `<div class="health-columns">${riskCard(snap.risk)}${snap.research ? researchCard(snap.research) : ''}</div>`
    + behaviorCard(snap)
    + missing;
}
