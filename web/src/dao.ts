import { emptyState, sectionHeading } from './components';
import { escapeHtml } from './format';
import { icon } from './icons';
import { renderMarkdown } from './markdown';
import { DAO_KINDS, DAO_PERSONAS, DAO_ROLES } from './state';
import type { AppState } from './state';
import type { DaoEntry, DaoKind, DaoRole } from './types';
import spaceBg from './assets/dao-space.webp';

/** 时间只显示到分钟：条目时间用于排序与追溯，不需要秒 */
function stamp(value: string): string {
  return String(value || '').replace('T', ' ').slice(0, 16);
}

function kindBadge(kind: DaoKind): string {
  return `<span class="dao-kind dao-kind-${kind}">${kind}</span>`;
}

function tagsHtml(tags: DaoRole[]): string {
  if (!tags.length) return '<span class="dao-tag dao-tag-general">通用</span>';
  return tags.map((tag) => `<span class="dao-tag">${escapeHtml(tag)}</span>`).join('');
}

/** 条目筛选：类型 + 注入角色 + 关键词（标题/正文/标签），全在前端做——条数上限 200，不值得再开接口 */
function entryMatches(state: AppState, item: DaoEntry): boolean {
  if (state.daoKindFilter !== '全部' && item.kind !== state.daoKindFilter) return false;
  if (state.daoRoleFilter !== '全部') {
    const roles: string[] = item.tags.length ? item.tags : ['通用'];
    if (!roles.includes(state.daoRoleFilter)) return false;
  }
  const query = state.daoQuery.trim().toLowerCase();
  if (!query) return true;
  return `${item.title} ${item.body} ${item.tags.join(' ')}`.toLowerCase().includes(query);
}

function entryCard(state: AppState, item: DaoEntry): string {
  const selected = state.daoDraft.id === item.id;
  const preview = item.body.replace(/\s+/g, ' ').slice(0, 140);
  return `<article class="dao-card${selected ? ' selected' : ''}${item.pinned ? ' pinned' : ''}">
    <button class="dao-card-main" data-action="dao-edit" data-id="${escapeHtml(item.id)}" title="点击编辑这条">
      <span class="dao-card-head">${kindBadge(item.kind)}<strong>${escapeHtml(item.title)}</strong>${item.pinned ? `<span class="dao-pin" title="置顶：注入时排最前">${icon('top', 12)}置顶</span>` : ''}</span>
      <span class="dao-card-tags">${tagsHtml(item.tags)}<span class="dao-card-time">${escapeHtml(stamp(item.updated_at))}</span></span>
      <span class="dao-card-body">${escapeHtml(preview)}</span>
    </button>
    <div class="dao-card-actions">
      <button class="text-button" data-action="dao-edit" data-id="${escapeHtml(item.id)}">${icon('edit', 13)}编辑</button>
      <button class="text-button danger" data-action="dao-delete" data-id="${escapeHtml(item.id)}">${icon('trash', 13)}删除</button>
    </div>
  </article>`;
}

function filterRow(label: string, all: string, values: string[], current: string, action: string, dataKey: string): string {
  const chips = values.map((value) => `<button class="dao-chip${current === value ? ' active' : ''}" data-action="${action}" data-${dataKey}="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join('');
  return `<div class="dao-filter-row"><span class="dao-filter-label">${escapeHtml(label)}</span>
    <button class="dao-chip${current === all ? ' active' : ''}" data-action="${action}" data-${dataKey}="${escapeHtml(all)}">全部</button>${chips}</div>`;
}

// ── 抽屉里的条目库 ──────────────────────────────────────────────

function listPanel(state: AppState): string {
  const items = state.daoEntries.filter((item) => entryMatches(state, item));
  const body = items.length
    ? items.map((item) => entryCard(state, item)).join('')
    : state.daoEntries.length
      ? `<p class="dao-list-empty muted">没有符合筛选条件的条目。</p>`
      : emptyState('还没有条目', '先和教练聊，聊出有用的东西再打成标签入库；也可以直接新建一条。', 'book');
  return `<div class="dao-list">
    <div class="dao-list-head">
      <div class="search-field">${icon('search', 16)}<input data-field="dao-query" value="${escapeHtml(state.daoQuery)}" placeholder="搜索标题 / 正文 / 标签" aria-label="搜索悟道条目" /></div>
      <div class="dao-list-actions">
        <button class="button button-primary" data-action="dao-new">${icon('plus', 14)}新建条目</button>
        <span class="muted compact">${items.length} / ${state.daoEntries.length} 条</span>
      </div>
      ${filterRow('类型', '全部', DAO_KINDS, state.daoKindFilter, 'dao-filter-kind', 'kind')}
      ${filterRow('注入', '全部', DAO_ROLES, state.daoRoleFilter, 'dao-filter-role', 'role')}
    </div>
    <div class="dao-list-body">${body}</div>
    ${state.daoError ? `<p class="dao-error">${escapeHtml(state.daoError)}</p>` : ''}
    <p class="dao-list-foot">注入预算：每个角色最多 8 条 / 1200 字，按置顶→最近更新排序；进提示词的只有前 160 字摘要。</p>
  </div>`;
}

/** 编辑已有条目用的完整表单（新建走对话区的标签卡，不在这里） */
function editorPanel(state: AppState): string {
  const draft = state.daoDraft;
  return `<div class="dao-editor">
    ${sectionHeading('编辑条目', '保存后，下一次跑流水线就会按新内容注入')}
    <div class="dao-field">
      <span>标题 <em>留空自动取正文前 20 字</em></span>
      <input data-field="dao-title" value="${escapeHtml(draft.title)}" maxlength="60" placeholder="一句话说清这条纪律，例如：跌破 20 日线先减半" />
    </div>
    <div class="dao-field">
      <span>类型</span>
      <div class="dao-chip-row">${DAO_KINDS.map((kind) => `<button class="dao-chip${draft.kind === kind ? ' active' : ''}" data-action="dao-kind" data-kind="${kind}">${kind}</button>`).join('')}</div>
    </div>
    <div class="dao-field">
      <span>注入给谁 <em>不选 = 通用，每个角色都会带上</em></span>
      <div class="dao-chip-row">${DAO_ROLES.map((role) => `<button class="dao-chip${draft.tags.includes(role) ? ' active' : ''}" data-action="dao-tag" data-tag="${role}">${role}</button>`).join('')}</div>
    </div>
    <div class="dao-field">
      <span>正文 <em data-dao-body-count>${draft.body.length} / 4000 字</em></span>
      <textarea data-field="dao-body" rows="7" maxlength="4000" placeholder="把当时的判断、依据、错在哪、下次怎么改写清楚。">${escapeHtml(draft.body)}</textarea>
    </div>
    <label class="dao-check"><input type="checkbox" data-action="dao-pin"${draft.pinned ? ' checked' : ''} /> 置顶（注入排序最前，适合铁律）</label>
    ${state.daoNotice ? `<p class="dao-notice">${escapeHtml(state.daoNotice)}</p>` : ''}
    <div class="dao-editor-actions">
      <button class="button button-secondary" data-action="dao-cancel">取消编辑</button>
      <button class="button button-primary" data-action="dao-save"${state.daoSaving ? ' disabled' : ''}>${state.daoSaving ? '保存中…' : '保存修改'}</button>
    </div>
  </div>`;
}

function statsRow(state: AppState): string {
  const stats = state.daoStats;
  if (!stats) return '';
  const cell = (label: string, value: number): string => `<span class="dao-stat${value ? '' : ' is-zero'}">${escapeHtml(label)} <strong>${value}</strong></span>`;
  return `<div class="dao-stats">
    ${cell('沉淀', stats.total)}
    ${cell('置顶', stats.pinned)}
    ${cell('通用', stats.byRole['通用'] || 0)}
    ${DAO_ROLES.map((role) => cell(role, stats.byRole[role] || 0)).join('')}
  </div>`;
}

/** 底部抽屉：默认收起，只留一条细带。展开后左列表、右编辑。 */
function dock(state: AppState): string {
  const open = state.daoDockOpen;
  const total = state.daoEntries.length;
  const head = `<button class="dao-dock-handle" data-action="dao-dock-toggle" aria-expanded="${open ? 'true' : 'false'}" title="${open ? '收起条目库' : '展开条目库'}">
    <span class="dao-dock-grip" aria-hidden="true"></span>
    <span class="dao-dock-label">${icon('book', 13)}条目库 <strong>${total}</strong></span>
    <span class="dao-dock-hint">${open ? '收起' : '展开'}</span>
  </button>`;
  if (!open) return `<footer class="dao-dock is-collapsed">${head}</footer>`;
  const editing = Boolean(state.daoDraft.id);
  return `<footer class="dao-dock is-open">${head}
    ${statsRow(state)}
    <div class="dao-dock-body">
      ${listPanel(state)}
      ${editing ? editorPanel(state) : `<div class="dao-dock-empty"><p>点左边任意条目可以在这里编辑。</p><p class="muted">新建条目不用填表：直接在下面的对话框里说，聊完点「沉淀为条目」，打好标签入库即可。</p></div>`}
    </div>
  </footer>`;
}

// ── 中间：对话 ────────────────────────────────────────────────

function threadHtml(state: AppState): string {
  const turns = state.daoThread.map((turn) => `<div class="dao-turn dao-turn-${turn.role}">
      <div class="dao-bubble${turn.role === 'assistant' ? ' dao-markdown' : ''}">${turn.role === 'assistant' ? renderMarkdown(turn.text) : escapeHtml(turn.text).replace(/\n/g, '<br/>')}</div>
    </div>`).join('');
  return `<div class="dao-thread-inner">${turns}</div>`;
}

/** 从对话里提炼出来的草稿：在对话框上方以「可打标签的卡片」出现，确认才入库 */
function draftCard(state: AppState): string {
  const draft = state.daoDraft;
  if (draft.id || !draft.body) return '';
  return `<div class="dao-draft">
    <div class="dao-draft-head">${icon('sparkles', 14)}<span>这段可以留下来</span>
      <button class="text-button" data-action="dao-cancel">不要</button>
    </div>
    <input class="dao-draft-title" data-field="dao-title" value="${escapeHtml(draft.title)}" maxlength="60" placeholder="给它起个名字，例如：跌破 20 日线先减半" />
    <p class="dao-draft-body">${escapeHtml(draft.body.slice(0, 240))}${draft.body.length > 240 ? '…' : ''}</p>
    <div class="dao-draft-tags">
      <span class="dao-filter-label">类型</span>
      ${DAO_KINDS.map((kind) => `<button class="dao-chip${draft.kind === kind ? ' active' : ''}" data-action="dao-kind" data-kind="${kind}">${kind}</button>`).join('')}
    </div>
    <div class="dao-draft-tags">
      <span class="dao-filter-label">给谁</span>
      ${DAO_ROLES.map((role) => `<button class="dao-chip${draft.tags.includes(role) ? ' active' : ''}" data-action="dao-tag" data-tag="${role}">${role}</button>`).join('')}
    </div>
    ${state.daoNotice ? `<p class="dao-notice">${escapeHtml(state.daoNotice)}</p>` : ''}
    <div class="dao-draft-actions">
      <button class="button button-primary" data-action="dao-save"${state.daoSaving ? ' disabled' : ''}>${state.daoSaving ? '入库中…' : '入库'}</button>
    </div>
  </div>`;
}

function composer(state: AppState): string {
  const persona = DAO_PERSONAS.find((item) => item.value === state.daoPersona)?.label || '悟道教练';
  return `<div class="dao-composer-wrap">
    ${draftCard(state)}
    <div class="dao-bar">
      <textarea class="dao-bar-input" data-field="dao-chat" rows="1" placeholder="和${escapeHtml(persona)}说说你的判断、犹豫或者复盘…" title="Enter 发送，Shift+Enter 换行" aria-label="悟道对话输入">${escapeHtml(state.daoChatDraft)}</textarea>
      <button class="dao-send" data-action="dao-send"${state.daoChatLoading ? ' disabled' : ''} title="发送（Enter）">
        ${state.daoChatLoading ? '<span class="dao-send-wait">…</span>' : icon('send', 17)}
      </button>
    </div>
    <div class="dao-under">
      <label class="dao-persona" title="换个人格跟你说话">
        ${icon('chat', 13)}
        <select data-field="dao-persona">${DAO_PERSONAS.map((item) => `<option value="${escapeHtml(item.value)}"${item.value === state.daoPersona ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select>
      </label>
      <span class="dao-under-spacer"></span>
      <button class="text-button" data-action="dao-distill"${state.daoThread.length < 2 || state.daoDistilling ? ' disabled' : ''}>${state.daoDistilling ? '提炼中…' : '沉淀为条目'}</button>
      <button class="text-button" data-action="dao-clear-thread"${state.daoThread.length ? '' : ' disabled'}>${icon('trash', 12)}清空</button>
    </div>
    ${state.daoChatError ? `<p class="dao-error">${escapeHtml(state.daoChatError)}</p>` : ''}
  </div>`;
}

/**
 * 悟道页（v0.79.0 重构）
 *
 * 一屏三件事：背景是深空，中间一条对话框，其余全部收进底部抽屉。
 * 对话优先——条目不是填表填出来的，是聊出来、打上标签才留下的。
 * 页面只负责把话说清楚并真的存进本机，不做二次加工。
 */
export function renderDao(state: AppState): string {
  const empty = state.daoThread.length === 0 && !state.daoDraft.body;
  return `<div class="dao-stage${empty ? ' is-empty' : ''}${state.daoDockOpen ? ' dock-open' : ''}">
    <div class="dao-stage-bg" style="background-image:url(${spaceBg})" aria-hidden="true"></div>
    <div class="dao-stage-veil" aria-hidden="true"></div>
    <main class="dao-stage-main">
      ${state.daoThread.length ? `<div class="dao-thread" role="log" aria-live="polite">${threadHtml(state)}</div>` : ''}
      ${composer(state)}
      <footer class="dao-stage-foot">
        <h1>悟道</h1>
        <p>把判断、纪律和复盘留下来，按角色自动注进流水线。只存本机，不上传。</p>
      </footer>
    </main>
    ${dock(state)}
  </div>`;
}
