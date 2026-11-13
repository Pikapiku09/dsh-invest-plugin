// 「本次更新」弹层（v0.50.0）
//
// 目标：升级后第一次进入工作台，主动告诉用户这个版本变了什么，并道一声谢。
//
// 三条设计约束：
//  ① 只在版本变化时出现——版本号记在 localStorage，同一版本永远只弹一次，不打扰日常使用；
//  ② 跨版本合并展示——用户可能一次跨过好几个版本（比如 v0.48 → v0.50），
//     就把中间所有没看过的版本一并列出，而不是只报最新那个；
//  ③ 内容来自 CHANGELOG.md（经 lib/whats-new.json 分发），不在前端手抄第二份文案。
import { escapeHtml } from './format';
import { icon } from './icons';
import type { WhatsNewRelease } from './types';

const SEEN_KEY = 'dsh-invest.seenVersion';

export function lastSeenVersion(): string {
  try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; }
}

export function markVersionSeen(version: string): void {
  try { localStorage.setItem(SEEN_KEY, version); } catch { /* 隐私模式下忽略 */ }
}

/** 取出「用户没看过的」版本段落（含跨版本），最新在前 */
export function unseenReleases(releases: WhatsNewRelease[], current: string, seen: string): WhatsNewRelease[] {
  if (!current) return [];
  if (seen === current) return [];
  const cmp = (v: string): number[] => v.replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const newer = (a: string, b: string): boolean => {
    const x = cmp(a), y = cmp(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const p = x[i] || 0, q = y[i] || 0;
      if (p !== q) return p > q;
    }
    return false;
  };
  // 只看当前版本及以下（更新更的版本不属于本次更新的内容），且要比「已见版本」新
  const picked = releases.filter((r) => !newer(r.version, current) && (!seen || newer(r.version, seen)));
  // 没有任何命中（例如 seen 比当前还新，或 releases 里没有当前版本）时，至少展示当前版本
  if (!picked.length) {
    const self = releases.find((r) => r.version === current);
    if (self) return [self];
    return [];
  }
  return picked;
}

/** 渲染弹层；调用方负责挂载与关闭 */
export function renderWhatsNew(releases: WhatsNewRelease[], current: string): string {
  if (!releases.length) return '';
  const blocks = releases.map((r) => `<section class="whatsnew-block">
    <div class="whatsnew-ver"><span class="whatsnew-tag">v${escapeHtml(r.version)}</span>
      <span class="whatsnew-date">${escapeHtml(r.date || '')}</span></div>
    ${r.title ? `<div class="whatsnew-title">${escapeHtml(r.title)}</div>` : ''}
    <ul class="whatsnew-list">${r.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
  </section>`).join('');
  const span = releases.length > 1 ? `跨了 ${releases.length} 个版本` : '本次更新';
  return `<div class="whatsnew-mask" data-action="whatsnew-close">
    <div class="whatsnew-card" role="dialog" aria-modal="true" aria-label="本次更新说明">
      <div class="whatsnew-head">
        <span class="whatsnew-h">${icon('sparkles', 16)} ${escapeHtml(span)} · v${escapeHtml(current)}</span>
        <button class="whatsnew-x" type="button" data-action="whatsnew-close" aria-label="关闭">${icon('close', 16)}</button>
      </div>
      <div class="whatsnew-body">${blocks}</div>
      <div class="whatsnew-foot">
        <div class="whatsnew-thanks">谢谢你在用这套投研工作台。数据都在你自己机器上，判断也在你自己手上。</div>
        <button class="button button-primary" type="button" data-action="whatsnew-close">开始使用</button>
      </div>
    </div>
  </div>`;
}
