import { emptyState } from './components';
import { escapeHtml, formatDateTime } from './format';
import { icon } from './icons';
import type { AppState } from './state';
import type { FundamentalDimension, FundamentalFlag, FundamentalsResponse } from './types';

/**
 * 基本面评级卡片（v0.58.0）
 *
 * 定位是「排雷 + 让人看懂公司质地」，不是买卖信号：
 * - `caveat`（实证免责：基本面不区分盈亏）必须常驻可见，不折叠、不省略——这是产品红线；
 * - 维度 `score === null` 表示数据不足，只能显示「数据不足」，绝不能折算成 0 分（会凭空制造差评）。
 */

/** 无数据（加载 / 出错 / 空态）时也要常驻的通用免责，避免卡片在没有评级时看起来像一张推荐 */
const CAVEAT_FALLBACK = '基本面评级用于排雷与理解质地，不构成买卖信号；实证上基本面不区分盈亏，'
  + '「基本面差」也不构成回避理由。';

/** 等级 → 语义色：A/B 绿、C 中性、D/E 红；无等级（数据不足）灰 */
function gradeTone(grade: string): 'good' | 'neutral' | 'bad' | 'unknown' {
  const letter = String(grade || '').trim().toUpperCase().slice(0, 1);
  if (letter === 'A' || letter === 'B') return 'good';
  if (letter === 'C') return 'neutral';
  if (letter === 'D' || letter === 'E') return 'bad';
  return 'unknown';
}

/** 分数展示：整数不带小数点，非整数保留一位；null 只能显示「数据不足」 */
function scoreText(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return '数据不足';
  const rounded = Math.round(score * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} 分`;
}

/** 条形填充宽度：夹在 0–100，脏数据不许把条撑破 */
function barWidth(score: number | null): number {
  if (score === null || !Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** 条形配色：≥70 绿、45–69 中性蓝、<45 红；null 走灰条（空态） */
function barTone(score: number | null): 'is-good' | 'is-mid' | 'is-bad' | 'is-empty' {
  if (score === null || !Number.isFinite(score)) return 'is-empty';
  if (score >= 70) return 'is-good';
  if (score >= 45) return 'is-mid';
  return 'is-bad';
}

/** 指标明细塞进 title：不占版面，但鼠标停一下就能看到每个数字的分位口径 */
function metricTitle(dim: FundamentalDimension): string {
  const metrics = Array.isArray(dim.metrics) ? dim.metrics : [];
  return metrics.map((metric) => {
    const hint = typeof metric.pct === 'number' && Number.isFinite(metric.pct)
      ? `（同业 ${metric.pct} 分位）` : '';
    return `${metric.label} ${metric.value}${hint}`;
  }).join('；');
}

/** 报告期原始值（Tushare 多为 YYYYMMDD）转可读日期；空值给「—」 */
function dateLabel(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '—';
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return raw;
}

function metaItem(label: string, value: unknown): string {
  const raw = value === null || value === undefined || value === '' ? '—' : String(value);
  return `<span><em>${escapeHtml(label)}</em>${escapeHtml(raw)}</span>`;
}

function sectionHead(note: string): string {
  return `<div class="archive-section-title"><h3>${icon('chart', 16)}基本面评级</h3><span>${escapeHtml(note)}</span></div>`;
}

/** 免责一行：任何状态都必须出现在卡片里 */
function caveatLine(text: string): string {
  return `<p class="fund-caveat">${icon('alert', 14)}<span>${escapeHtml(text || CAVEAT_FALLBACK)}</span></p>`;
}

function dimensionRow(dim: FundamentalDimension): string {
  const empty = dim.score === null || !Number.isFinite(dim.score);
  const tone = barTone(dim.score);
  const title = metricTitle(dim);
  const bar = empty
    ? `<div class="fund-bar is-empty" title="该维度数据不足，不参与总分"></div>`
    : `<div class="fund-bar ${tone}"${title ? ` title="${escapeHtml(title)}"` : ''}><i style="width:${barWidth(dim.score)}%"></i></div>`;
  return `<div class="fund-dim" data-dim="${escapeHtml(dim.key)}">
    <div class="fund-dim-head">
      <span class="fund-dim-label">${escapeHtml(dim.label)}</span>
      ${bar}
      <span class="fund-dim-score ${tone}">${empty ? '数据不足' : escapeHtml(scoreText(dim.score))}</span>
    </div>
    ${dim.detail ? `<p class="fund-dim-detail">${escapeHtml(dim.detail)}</p>` : ''}
  </div>`;
}

const FLAG_TAG: Record<FundamentalFlag['level'], string> = { bad: '风险', warn: '注意', info: '待核实' };

function flagRow(flag: FundamentalFlag): string {
  const level = flag.level === 'bad' || flag.level === 'warn' ? flag.level : 'info';
  return `<li class="fund-flag fund-flag-${level}">
    <span class="fund-flag-tag">${FLAG_TAG[level]}</span>
    <span class="fund-flag-label">${escapeHtml(flag.label)}</span>
    <small>${escapeHtml(flag.note)}</small>
  </li>`;
}

/** 升降对比：只有 change 是真数字才展示，绝不把「没有上期」画成 0 */
function deltaRow(data: FundamentalsResponse): string {
  const delta = data.delta;
  if (!delta || typeof delta.change !== 'number' || !Number.isFinite(delta.change)) return '';
  const change = Math.round(delta.change * 10) / 10;
  const tone = change > 0 ? 'is-up' : change < 0 ? 'is-down' : 'is-flat';
  const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';
  const prev = typeof delta.total === 'number' && Number.isFinite(delta.total) ? scoreText(delta.total) : '—';
  return `<div class="fund-delta ${tone}">${icon('arrow', 13)}<span>较上期（${escapeHtml(delta.periodLabel || '上一期')}）：${escapeHtml(prev)} → <b>${arrow} ${Math.abs(change)} 分</b></span></div>`;
}

function renderLoading(code: string): string {
  return `<section class="panel fund-card is-loading" aria-busy="true">${sectionHead('读取中')}
    <div class="fund-skeleton">
      <div class="fund-skeleton-grade"></div>
      <div class="fund-skeleton-lines"><span></span><span></span></div>
    </div>
    <div class="fund-skeleton-bars">${Array.from({ length: 5 }, () => '<div class="fund-skeleton-bar"></div>').join('')}</div>
    <div class="fund-loading-hint">${icon('refresh', 14)}<span>正在按行业横截面计算评级（首次拉取全市场快照可能需要十几秒）</span><button class="text-button" data-action="fundamentals-refresh" data-code="${escapeHtml(code)}">立即重试</button></div>
    ${caveatLine(CAVEAT_FALLBACK)}
  </section>`;
}

function renderError(code: string, message: string): string {
  return `<section class="panel fund-card">${sectionHead('读取失败')}
    <div class="fund-error">${icon('alert', 15)}<span>${escapeHtml(message)}</span></div>
    <div class="fund-actions">
      <button class="button button-secondary" data-action="fundamentals-refresh" data-code="${escapeHtml(code)}">${icon('refresh', 14)}重试</button>
      <small>基本面取数依赖 Tushare，可能限流或超时；重试不影响已有的结论链。</small>
    </div>
    ${caveatLine(CAVEAT_FALLBACK)}
  </section>`;
}

function renderEmpty(code: string): string {
  return `<section class="panel fund-card">${sectionHead('评分与风险')}
    ${emptyState('暂无基本面评级', '选中标的后会自动读取；若长时间为空，可点下方按钮手动加载。', 'chart')}
    <div class="fund-actions"><button class="button button-secondary" data-action="fundamentals-refresh" data-code="${escapeHtml(code)}">${icon('refresh', 14)}加载基本面评级</button></div>
    ${caveatLine(CAVEAT_FALLBACK)}
  </section>`;
}

function renderData(data: FundamentalsResponse, code: string, loading: boolean): string {
  const dims = Array.isArray(data.dims) ? data.dims : [];
  const flags = Array.isArray(data.flags) ? data.flags : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  const scored = dims.filter((dim) => dim && Number.isFinite(dim.score)).length;
  const total = typeof data.total === 'number' && Number.isFinite(data.total) ? data.total : null;
  const grade = String(data.grade || '').trim() || '—';
  const gradeLabel = String(data.gradeLabel || '').trim() || (total === null ? '数据不足' : '—');
  const tone = gradeTone(grade);
  const peerCount = Number.isFinite(data.peerCount) ? data.peerCount : 0;
  const name = String(data.name || code || '');
  const industry = String(data.industry || '').trim() || '行业未分类';
  const coverage = dims.length ? `${scored}/${dims.length} 维有数据` : (data.coverage ? `${String(data.coverage)} 有数据` : '维度数据缺失');

  const headNote = `${name} · ${industry} · 同业 ${peerCount} 只`;
  const meta = [
    metaItem('覆盖', coverage),
    metaItem('报告期', data.periodLabel || data.period || '—'),
    metaItem('公告日', dateLabel(data.announceDate)),
    metaItem('估值日', dateLabel(data.priceDate)),
    metaItem('快照', formatDateTime(data.cachedAt, true)),
  ].join('');

  const dimsHtml = dims.length
    ? `<div class="fund-dims">${dims.map(dimensionRow).join('')}</div>`
    : `<p class="fund-flags-empty">该报告期没有可算分的维度，评级为空不代表公司没有问题。</p>`;

  const flagsHtml = flags.length
    ? `<ul class="fund-flags">${flags.map(flagRow).join('')}</ul>`
    : `<p class="fund-flags-empty">${icon('check', 14)}未发现明显风险（仅就接口可得指标而言；商誉、质押、审计意见未覆盖）</p>`;

  const warningsHtml = warnings.length
    ? `<div class="fund-warnings">${warnings.map((warning) => `<small>${icon('alert', 12)}<span>${escapeHtml(warning)}</span></small>`).join('')}</div>`
    : '';

  return `<section class="panel fund-card${loading ? ' is-loading' : ''}">
    ${sectionHead(headNote)}
    <div class="fund-head">
      <div class="fund-grade fund-grade-${tone}" data-grade="${escapeHtml(grade)}" title="等级 ${escapeHtml(grade)}：${escapeHtml(gradeLabel)}">
        <b>${escapeHtml(grade)}</b><small>${escapeHtml(gradeLabel)}</small>
      </div>
      <div class="fund-head-main">
        <div class="fund-head-title"><strong>${total === null ? '综合分 —' : `综合 ${escapeHtml(scoreText(total))}`}</strong><span>五维分位加权，缺失维度不计分</span></div>
        <p class="fund-head-meta">${meta}</p>
      </div>
      <button class="button button-secondary fund-refresh" data-action="fundamentals-refresh" data-code="${escapeHtml(code)}" title="${loading ? '正在刷新：点击可立即重试' : '强制重拉全市场快照后重算（首次可能较慢）'}">${icon('refresh', 14)}${loading ? '刷新中…' : '刷新'}</button>
    </div>
    ${deltaRow(data)}
    ${warningsHtml}
    <div class="fund-subhead">${icon('chart', 13)}分位评分（同业横截面，越大越好）</div>
    ${dimsHtml}
    <div class="fund-subhead">${icon('alert', 13)}风险标记（不计分，排雷优先）</div>
    ${flagsHtml}
    ${caveatLine(data.caveat || CAVEAT_FALLBACK)}
  </section>`;
}

/**
 * 渲染基本面评级卡片。
 * 只渲染与当前选中标的一致的数据：切换标的后旧响应短暂残留不得显示成别人的评级。
 */
export function renderFundamentalsCard(state: AppState): string {
  const raw = state.fundamentals ?? null;
  const code = String(state.selectedCode || raw?.code || '');
  const data = raw && (!code || String(raw.code) === code) ? raw : null;
  const loading = Boolean(state.fundamentalsLoading);
  const error = String(state.fundamentalsError || '');
  if (data) return renderData(data, code, loading);
  if (loading) return renderLoading(code);
  if (error) return renderError(code, error);
  return renderEmpty(code);
}
