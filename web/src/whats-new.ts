// 两个弹层：「本次更新」（升级后）与「发现新版本」（检测到远端有新版）
//
// 目标：① 升级后第一次进入工作台，主动告诉用户这个版本变了什么，并道一声谢；
//       ② 检测到新版本时，把「改了什么 + 怎么更新」一次说清，不让用户猜。
//
// 四条设计约束：
//  ① 「本次更新」只在版本变化时出现——版本号记在 localStorage，同一版本只弹一次，不打扰日常使用；
//  ② 跨版本合并展示——用户可能一次跨过好几个版本（比如 v0.48 → v0.50），
//     就把中间所有没看过的版本一并列出，而不是只报最新那个；
//  ③ 内容来自 CHANGELOG.md（经 lib/whats-new.json 分发），不在前端手抄第二份文案；
//  ④ **弹层永不自动关闭**（v0.51.0 起）——点遮罩不关、无定时器，只有用户显式点关闭才关。
//     这一条是修 bug：v0.50.0 把关闭动作挂在整个遮罩上，用户想看清内容时随手一点就关掉，
//     而关闭同时写入了「已读」，内容就此永久消失。信息型弹层不该有这种代价。
import { escapeHtml } from './format';
import { icon } from './icons';
import type { UpdateCheckResponse, WhatsNewRelease } from './types';

const SEEN_KEY = 'dsh-invest.seenVersion';
/** v0.51.0：已经主动提示过更新的版本（同一新版只在启动时问一次，之后只留红点） */
const PROMPTED_KEY = 'dsh-invest.promptedVersion';

export function lastSeenVersion(): string {
  try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; }
}

export function markVersionSeen(version: string): void {
  try { localStorage.setItem(SEEN_KEY, version); } catch { /* 隐私模式下忽略 */ }
}

export function lastPromptedVersion(): string {
  try { return localStorage.getItem(PROMPTED_KEY) || ''; } catch { return ''; }
}

export function markVersionPrompted(version: string): void {
  try { localStorage.setItem(PROMPTED_KEY, version); } catch { /* 隐私模式下忽略 */ }
}

const cmp = (v: string): number[] => v.replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);

/** a 是否比 b 新 */
export function isNewer(a: string, b: string): boolean {
  const x = cmp(a), y = cmp(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] || 0, q = y[i] || 0;
    if (p !== q) return p > q;
  }
  return false;
}

/** 取出「用户没看过的」版本段落（含跨版本），最新在前 */
export function unseenReleases(releases: WhatsNewRelease[], current: string, seen: string): WhatsNewRelease[] {
  if (!current) return [];
  if (seen === current) return [];
  // 只看当前版本及以下（更新更的版本不属于本次更新的内容），且要比「已见版本」新
  const picked = releases.filter((r) => !isNewer(r.version, current) && (!seen || isNewer(r.version, seen)));
  // 没有任何命中（例如 seen 比当前还新，或 releases 里没有当前版本）时，至少展示当前版本
  if (!picked.length) {
    const self = releases.find((r) => r.version === current);
    if (self) return [self];
    return [];
  }
  return picked;
}

/** 启动时该不该主动弹「发现新版本」：有新版，且这个新版还没问过 */
export function shouldPromptUpdate(current: string, latest: string | undefined, prompted: string): boolean {
  if (!current || !latest) return false;
  if (!isNewer(latest, current)) return false;
  return prompted !== latest;
}

/** 版本变更块（两个弹层共用同一套排版） */
function releaseBlocks(releases: WhatsNewRelease[]): string {
  return releases.map((r) => `<section class="whatsnew-block">
    <div class="whatsnew-ver"><span class="whatsnew-tag">v${escapeHtml(r.version)}</span>
      <span class="whatsnew-date">${escapeHtml(r.date || '')}</span></div>
    ${r.title ? `<div class="whatsnew-title">${escapeHtml(r.title)}</div>` : ''}
    <ul class="whatsnew-list">${r.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
  </section>`).join('');
}

/**
 * 「本次更新」：说明**已安装版本**改了什么。
 * 关闭方式只有底部按钮与右上角 ×；遮罩点击与 ESC 都不关闭（v0.51.0）。
 */
export function renderWhatsNew(releases: WhatsNewRelease[], current: string): string {
  if (!releases.length) return '';
  const span = releases.length > 1 ? `跨了 ${releases.length} 个版本` : '本次更新';
  return `<div class="whatsnew-mask" data-modal="whatsnew">
    <div class="whatsnew-card" role="dialog" aria-modal="true" aria-label="本次更新说明">
      <div class="whatsnew-head">
        <span class="whatsnew-h">${icon('sparkles', 16)} ${escapeHtml(span)} · v${escapeHtml(current)}</span>
        <button class="whatsnew-x" type="button" data-action="whatsnew-close" aria-label="关闭">${icon('close', 16)}</button>
      </div>
      <div class="whatsnew-body">${releaseBlocks(releases)}</div>
      <div class="whatsnew-foot">
        <div class="whatsnew-thanks">谢谢你在用这套投研工作台。数据都在你自己机器上，判断也在你自己手上。</div>
        <button class="button button-primary" type="button" data-action="whatsnew-close">开始使用</button>
      </div>
    </div>
  </div>`;
}

/**
 * 「发现新版本」：说明**远端的更新版本**改了什么，并给出可直接复制的更新命令。
 * DSH 插件无法热更新（宿主半部进程内加载），所以按钮只做「复制命令」，不假装能一键升级。
 */
export function renderUpdateDialog(info: UpdateCheckResponse): string {
  const latest = info.latest || '';
  if (!latest) return '';
  const highlights = Array.isArray(info.highlights) ? info.highlights : [];
  const command = info.command || '';
  const body = highlights.length
    ? releaseBlocks(highlights)
    : `<div class="update-nohl">这个版本的更新说明没取到（可能是网络问题），可以到 <a href="${escapeHtml(info.repo || '#')}" target="_blank" rel="noopener">仓库的 CHANGELOG</a> 查看。这不影响你按下面的命令更新。</div>`;
  const cmd = command
    ? `<div class="update-cmd"><code>${escapeHtml(command)}</code></div>`
    : `<div class="update-nohl">没有识别出你的安装方式，请手动更新后重启 DSH。</div>`;
  return `<div class="whatsnew-mask" data-modal="update">
    <div class="whatsnew-card update-card" role="dialog" aria-modal="true" aria-label="发现新版本">
      <div class="whatsnew-head">
        <span class="whatsnew-h">${icon('download', 16)} 发现新版本 · v${escapeHtml(latest)}</span>
        <button class="whatsnew-x" type="button" data-action="update-close" aria-label="关闭">${icon('close', 16)}</button>
      </div>
      <div class="whatsnew-body">
        <div class="update-lead">当前 <b>v${escapeHtml(info.current)}</b> → 最新 <b>v${escapeHtml(latest)}</b>。${
          info.installKind === 'link' ? '你是从本地克隆安装的，需要先 git pull。'
            : info.installKind === 'github' ? '你是从 GitHub 源安装的，一条命令即可。'
              : ''
        }</div>
        ${body}
        ${command ? `<div class="update-how"><div class="update-how-h">在终端执行（复制下面这一行）</div>${cmd}</div>` : cmd}
      </div>
      <div class="whatsnew-foot">
        <div class="whatsnew-thanks">${escapeHtml(info.hint || '更新完成后需要重启 DSH 才会生效——插件不能在运行中替换自己。')}</div>
        <button class="button" type="button" data-action="update-later">稍后再说</button>
        ${command ? `<button class="button button-primary" type="button" data-action="update-copy">复制更新命令</button>` : ''}
      </div>
    </div>
  </div>`;
}
