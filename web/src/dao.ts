import { emptyState, pageHeader, sectionHeading } from './components';
import { escapeHtml } from './format';
import { icon } from './icons';
import { renderMarkdown } from './markdown';
import { DAO_KINDS, DAO_PERSONAS, DAO_ROLES } from './state';
import type { AppState } from './state';
import type { DaoEntry, DaoKind, DaoRole } from './types';

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

function filterRow(state: AppState, label: string, all: string, values: string[], current: string, action: string, dataKey: string): string {
  const chips = values.map((value) => `<button class="dao-chip${current === value ? ' active' : ''}" data-action="${action}" data-${dataKey}="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join('');
  return `<div class="dao-filter-row"><span class="dao-filter-label">${escapeHtml(label)}</span>
    <button class="dao-chip${current === all ? ' active' : ''}" data-action="${action}" data-${dataKey}="${escapeHtml(all)}">全部</button>${chips}</div>`;
}

function listPanel(state: AppState): string {
  const items = state.daoEntries.filter((item) => entryMatches(state, item));
  const body = items.length
    ? items.map((item) => entryCard(state, item)).join('')
    : state.daoEntries.length
      ? `<p class="dao-list-empty muted">没有符合筛选条件的条目。</p>`
      : emptyState('还没有条目', '把交易铁律、复盘结论、自我反思写下来；也可以先跟教练聊，再把聊出来的东西沉淀成条目。', 'book');
  return `<aside class="panel dao-list">
    <div class="dao-list-head">
      <div class="search-field">${icon('search', 16)}<input data-field="dao-query" value="${escapeHtml(state.daoQuery)}" placeholder="搜索标题 / 正文 / 标签" aria-label="搜索悟道条目" /></div>
      <div class="dao-list-actions">
        <button class="button button-primary" data-action="dao-new">${icon('plus', 14)}新建条目</button>
        <span class="muted compact">${items.length} / ${state.daoEntries.length} 条</span>
      </div>
      ${filterRow(state, '类型', '全部', DAO_KINDS, state.daoKindFilter, 'dao-filter-kind', 'kind')}
      ${filterRow(state, '注入', '全部', DAO_ROLES, state.daoRoleFilter, 'dao-filter-role', 'role')}
    </div>
    <div class="dao-list-body">${body}</div>
    ${state.daoError ? `<p class="dao-error">${escapeHtml(state.daoError)}</p>` : ''}
    <p class="dao-list-foot">注入预算：每个角色最多 8 条 / 1200 字，按置顶→最近更新排序；进提示词的只有前 160 字摘要。</p>
  </aside>`;
}

function editorPanel(state: AppState): string {
  const draft = state.daoDraft;
  const editing = Boolean(draft.id);
  return `<section class="panel dao-editor">
    ${sectionHeading(editing ? '编辑条目' : '新建条目', editing ? '保存后，下一次跑流水线就会按新内容注入' : '写下来，才算数')}
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
      <span>正文 <em data-dao-body-count>${draft.body.length} / 4000 字；进提示词只取前 160 字摘要</em></span>
      <textarea data-field="dao-body" rows="9" maxlength="4000" placeholder="把当时的判断、依据、错在哪、下次怎么改写清楚。越具体，注入后越有用。">${escapeHtml(draft.body)}</textarea>
    </div>
    <label class="dao-check"><input type="checkbox" data-action="dao-pin"${draft.pinned ? ' checked' : ''} /> 置顶（注入排序最前，适合铁律）</label>
    ${state.daoNotice ? `<p class="dao-notice">${escapeHtml(state.daoNotice)}</p>` : ''}
    <div class="dao-editor-actions">
      ${editing ? `<button class="button button-secondary" data-action="dao-cancel">取消编辑</button>` : ''}
      <button class="button button-primary" data-action="dao-save"${state.daoSaving ? ' disabled' : ''}>${state.daoSaving ? '保存中…' : editing ? '保存修改' : '入库'}</button>
    </div>
  </section>`;
}

function threadHtml(state: AppState): string {
  if (!state.daoThread.length) {
    const persona = DAO_PERSONAS.find((item) => item.value === state.daoPersona)?.label || '悟道教练';
    return `<div class="ask-hint">${icon('chat', 20)}<div><strong>和${escapeHtml(persona)}聊聊</strong><p>聊你的判断、犹豫和复盘。教练会追问依据、指出逻辑冲突；切到分析师人格，就按那个角色的视角跟你说话。聊出有用的东西，点「沉淀为条目」，确认后入库。</p></div></div>`;
  }
  return state.daoThread.map((turn) => `<div class="ask-turn ask-${turn.role}">
      <span class="ask-role">${turn.role === 'user' ? '你' : '悟道'}</span>
      <div class="ask-bubble${turn.role === 'assistant' ? ' ask-markdown' : ''}">${turn.role === 'assistant' ? renderMarkdown(turn.text) : escapeHtml(turn.text).replace(/\n/g, '<br/>')}</div>
    </div>`).join('');
}

function chatPanel(state: AppState): string {
  return `<section class="panel dao-chat">
    ${sectionHeading('悟道对话', '教练帮你拆逻辑；也可以切到某个分析师人格，按它的视角聊')}
    <div class="dao-chat-bar">
      <label class="dao-persona">人格
        <select data-field="dao-persona">${DAO_PERSONAS.map((item) => `<option value="${escapeHtml(item.value)}"${item.value === state.daoPersona ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select>
      </label>
      <button class="text-button" data-action="dao-clear-thread"${state.daoThread.length ? '' : ' disabled'}>${icon('trash', 13)}清空对话</button>
    </div>
    <div class="dao-thread ask-thread">${threadHtml(state)}</div>
    ${state.daoChatError ? `<p class="dao-error">${escapeHtml(state.daoChatError)}</p>` : ''}
    <div class="dao-composer">
      <textarea data-field="dao-chat" rows="3" placeholder="说点什么…（Enter 发送，Shift+Enter 换行）">${escapeHtml(state.daoChatDraft)}</textarea>
      <div class="dao-composer-actions">
        <button class="button button-secondary" data-action="dao-distill"${state.daoThread.length < 2 || state.daoDistilling ? ' disabled' : ''}>${state.daoDistilling ? '提炼中…' : '沉淀为条目'}</button>
        <button class="button button-primary" data-action="dao-send"${state.daoChatLoading ? ' disabled' : ''}>${state.daoChatLoading ? '等回复…' : '发送'}</button>
      </div>
    </div>
  </section>`;
}

function statsRow(state: AppState): string {
  const stats = state.daoStats;
  if (!stats) return '';
  const cell = (label: string, value: number, extra = ''): string => `<span class="dao-stat${value ? '' : ' is-zero'}${extra}">${escapeHtml(label)} <strong>${value}</strong></span>`;
  return `<div class="dao-stats">
    ${cell('沉淀', stats.total)}
    ${cell('置顶', stats.pinned)}
    ${cell('通用', stats.byRole['通用'] || 0)}
    ${DAO_ROLES.map((role) => cell(role, stats.byRole[role] || 0)).join('')}
    <span class="dao-stat muted">更新于 ${escapeHtml(stamp(state.daoUpdatedAt)) || '—'}</span>
  </div>`;
}

/**
 * 悟道页（v0.78.0）
 *
 * 左侧是条目库（筛选 + 选中编辑），右侧上方是编辑区、下方是对话区。
 * 条目本身只是文本：页面不解释、不做二次加工，怎么写就怎么进提示词——
 * 这一页的价值在「让人愿意写、写了能改、改完真的会被带进流水线」，不在花哨。
 */
export function renderDao(state: AppState): string {
  const head = pageHeader(
    '悟道',
    '把你的交易纪律、复盘与自我反思写下来，按角色标签自动注入投研流水线；也可以先和教练聊聊，再把聊出来的东西沉淀成条目。条目只在你本机，不上传。',
  );
  return head + statsRow(state) + `<div class="dao-layout">${listPanel(state)}<div class="dao-main">${editorPanel(state)}${chatPanel(state)}</div></div>`;
}
