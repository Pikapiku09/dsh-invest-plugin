import { escapeHtml, formatNumber } from './format';
import { icon } from './icons';
import type { JobStatus, RunRecord } from './types';

export function pageHeader(title: string, description: string, actions = ''): string {
  return `<div class="page-header"><div><div class="eyebrow">RESEARCH WORKSPACE</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</div>`;
}

export function statCard(label: string, value: unknown, hint: string, iconName: string, tone = ''): string {
  return `<article class="stat-card ${tone}"><div class="stat-top"><span>${escapeHtml(label)}</span><span class="stat-icon">${icon(iconName, 19)}</span></div><strong class="stat-value">${formatNumber(value)}</strong><div class="stat-hint">${escapeHtml(hint)}</div></article>`;
}

export function stanceBadge(stance: unknown): string {
  const text = String(stance || '未明');
  const type = /看多|买入|增持/.test(text) ? 'bullish'
    : /拒绝|看空|卖出|风险/.test(text) ? 'bearish'
      : /观察|中性|等待/.test(text) ? 'watch'
        : /持有/.test(text) ? 'hold'
          : /离场|减仓/.test(text) ? 'reduce' : 'neutral';
  return `<span class="stance-badge stance-${type}"><i></i>${escapeHtml(text)}</span>`;
}

export function runStatusBadge(run: RunRecord): string {
  const failed = run.ok === false || run.status === 'failed';
  return `<span class="status-badge ${failed ? 'status-failed' : 'status-done'}"><i></i>${failed ? '失败' : '成功'}</span>`;
}

export function jobStatusBadge(status: JobStatus): string {
  const labels: Record<JobStatus, string> = { queued: '排队中', running: '运行中', done: '已完成', failed: '失败' };
  return `<span class="status-badge status-${status}"><i></i>${labels[status]}</span>`;
}

export function codeTags(codes: string[] = [], clickable = true): string {
  if (!codes.length) return '<span class="muted">—</span>';
  const visible = codes.slice(0, 4).map((code) => clickable
    ? `<button class="code-tag" data-action="select-code" data-code="${escapeHtml(code)}">${escapeHtml(code)}</button>`
    : `<span class="code-tag">${escapeHtml(code)}</span>`).join('');
  return `<span class="code-tags">${visible}${codes.length > 4 ? `<span class="code-more">+${codes.length - 4}</span>` : ''}</span>`;
}

export function emptyState(title: string, description: string, iconName = 'empty'): string {
  return `<div class="empty-state"><span class="empty-icon">${icon(iconName, 25)}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div>`;
}

export function errorState(title: string, description: string): string {
  return `<div class="error-state"><span>${icon('alert', 24)}</span><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div><button class="button button-secondary" data-action="refresh">${icon('refresh', 15)}重试</button></div>`;
}

export function loadingBlock(label = '正在读取数据'): string {
  return `<div class="loading-block" role="status"><span class="spinner"></span><span>${escapeHtml(label)}</span></div>`;
}

export function skeletonPage(): string {
  return `<div class="page-skeleton" aria-label="页面加载中"><div class="skeleton skeleton-title"></div><div class="skeleton-grid">${Array.from({ length: 4 }, () => '<div class="skeleton skeleton-stat"></div>').join('')}</div><div class="skeleton-columns"><div class="skeleton skeleton-panel"></div><div class="skeleton skeleton-panel"></div></div></div>`;
}

export function sectionHeading(title: string, meta = '', action = ''): string {
  return `<div class="section-heading"><div><h2>${escapeHtml(title)}</h2>${meta ? `<p>${escapeHtml(meta)}</p>` : ''}</div>${action}</div>`;
}
