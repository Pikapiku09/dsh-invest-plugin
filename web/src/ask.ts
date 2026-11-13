import { emptyState, pageHeader } from './components';
import { escapeHtml } from './format';
import { icon } from './icons';
import { renderMarkdown } from './markdown';
import { groupStocks } from './stock-index';
import type { AppState } from './state';
import type { StockNoteDetail, StockNoteMeta } from './types';

/** 追问线程按股票代码分组存（localStorage）：换报告不影响，同一只股票的对话始终连续 */
export const stockThreadKey = (code: string): string => 'stock:' + String(code || '').toUpperCase();

/** 预设提问：普通态显示为可点气泡；编辑态可逐条改名/删除/新增/恢复默认（localStorage 持久化） */
function suggestionsHtml(state: AppState): string {
  if (state.askSuggestionsEditing) {
    const rows = state.askSuggestions.map((text, index) => `<div class="ask-suggest-row"><input data-ask-suggestion="${index}" value="${escapeHtml(text)}" aria-label="预设提问 ${index + 1}" /><button class="icon-button small" data-action="ask-suggest-remove" data-index="${index}" title="删除这条" aria-label="删除这条">${icon('close', 13)}</button></div>`).join('');
    return `<div class="ask-suggest-edit">
      <div class="ask-suggest-head"><strong>编辑预设提问</strong><span>改完自动保存 · 最多 12 条 · 留空自动丢弃</span></div>
      ${rows || '<p class="muted compact">当前没有预设提问，可在下方新增。</p>'}
      <div class="ask-suggest-row"><input data-ask-suggestion-new placeholder="新增一条预设提问（回车或点「添加」）" aria-label="新增预设提问" /><button class="button button-secondary" data-action="ask-suggest-add">添加</button></div>
      <div class="ask-suggest-actions"><button class="text-button" data-action="ask-suggest-reset">${icon('refresh', 13)}恢复默认</button><button class="button button-primary" data-action="ask-suggest-edit">完成</button></div>
    </div>`;
  }
  const chips = state.askSuggestions
    .map((text) => `<button class="ask-chip" data-action="ask-ask" data-question="${escapeHtml(text)}">${escapeHtml(text)}</button>`)
    .join('');
  return `<div class="ask-suggestions">${chips}<button class="ask-chip ask-chip-edit" data-action="ask-suggest-edit" title="编辑这些预设提问">${icon('edit', 13)}编辑</button></div>`;
}

function threadHtml(state: AppState, code: string, name: string): string {
  const key = stockThreadKey(code);
  const thread = state.askThreads[key] || [];
  const updated = state.askNote && state.askNote.updated_at ? state.askNote.updated_at : '';
  if (!thread.length) {
    return `<div class="ask-hint">${icon('chat', 20)}<div><strong>就 ${escapeHtml(name || code)} 的知识库提问</strong><p>回答只依据这份知识库${updated ? `（更新于 ${escapeHtml(updated)}）` : ''}；知识库没写的会明确说「未涉及」，涉及更晚的行情会提示你跑任务更新。支持连续追问，历史轮次会一起带上。</p><p class="ask-hint-kb">整理后的知识库已收起，点右上角「知识库」可放大查看。</p></div></div>
      ${suggestionsHtml(state)}`;
  }
  return thread.map((turn) => `<div class="ask-turn ask-${turn.role}">
      <span class="ask-role">${turn.role === 'user' ? '你' : '助手'}</span>
      <div class="ask-bubble${turn.role === 'assistant' ? ' ask-markdown' : ''}">${turn.role === 'assistant' ? renderMarkdown(turn.text) : escapeHtml(turn.text).replace(/\n/g, '<br/>')}</div>
    </div>`).join('') + suggestionsHtml(state);
}

/**
 * 标的档案里的「在管」状态（v0.52.0）
 *
 * 左侧索引按字母排，持仓/观察的票会散落在 192 只里，靠肉眼找很费劲。
 * 这里从 watchlist 读状态，给行加个标记——只认「持有 / 观察」，已清仓/已移除不算在管。
 * watchlist 尚未加载时返回空，页面会在 loadWatchlist 完成后重绘，标记自然出现。
 */
function watchMark(state: AppState, code: string): { cls: string; label: string } {
  const items = state.watchlist?.items || [];
  const hit = items.find((item) => String(item.code || '').toUpperCase() === String(code || '').toUpperCase());
  if (!hit) return { cls: '', label: '' };
  if (hit.state === '持有') return { cls: 'held', label: '持有' };
  if (hit.state === '观察') return { cls: 'watching', label: '观察' };
  return { cls: '', label: '' };
}

/** 距今天数：知识库太久没整理时提示去跑任务 */
function daysSince(stamp: string): number {
  const m = String(stamp || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return 0;
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.floor((Date.now() - then) / 86400000);
}

function stockBadge(stock: StockNoteMeta): string {
  if (stock.kb_status === 'running' || stock.kb_status === 'queued') {
    return '<span class="ask-stock-flag running" title="知识库整理中">整理中</span>';
  }
  if ((stock.new_entries || 0) > 0) {
    return `<span class="ask-stock-flag new" title="${stock.new_entries} 段新分析待并入">${stock.new_entries}</span>`;
  }
  return `<span class="ask-stock-count" title="${stock.count} 段分析">${stock.count}</span>`;
}

function stockRow(state: AppState, stock: StockNoteMeta): string {
  const selected = String(state.askStock || '').toUpperCase() === stock.code;
  const mark = watchMark(state, stock.code);
  const stateText = mark.cls === 'held' ? ' · 持仓中' : mark.cls === 'watching' ? ' · 观察中' : '';
  return `<button class="ask-stock-row${selected ? ' selected' : ''}${mark.cls ? ' ask-stock-row-' + mark.cls : ''}" data-action="ask-stock-select" data-code="${escapeHtml(stock.code)}" title="${escapeHtml(stock.name || stock.code)} · ${stock.count} 段分析${stock.curated_at ? ' · 更新于 ' + escapeHtml(stock.curated_at) : ' · 尚未整理'}${stateText}">
    <span class="ask-stock-name">${escapeHtml(stock.name || stock.code)}</span>
    ${mark.label ? `<span class="ask-watch-tag ${mark.cls}">${mark.label}</span>` : ''}
    <span class="ask-stock-code">${escapeHtml(stock.code)}</span>
    ${stockBadge(stock)}
  </button>`;
}

function groupHead(letter: string, count: number, collapsed: boolean): string {
  return `<button class="ask-group-head${collapsed ? ' collapsed' : ''}" data-action="ask-letter-toggle" data-letter="${escapeHtml(letter)}">
    <span class="ask-group-letter">${escapeHtml(letter)}</span>
    <span class="ask-group-count">${count}</span>
    <span class="ask-group-caret">${icon('chevron', 13)}</span>
  </button>`;
}

function stockListHtml(state: AppState): string {
  const query = state.askQuery.trim().toLowerCase();
  const match = (stock: StockNoteMeta): boolean => (
    !query || `${stock.name} ${stock.code}`.toLowerCase().includes(query)
  );
  const groups = groupStocks(state.askStocks)
    .map((group) => ({ letter: group.letter, items: group.items.filter(match) }))
    .filter((group) => group.items.length);
  const total = state.askStocks.length;
  const segments = state.askStocks.reduce((sum, stock) => sum + stock.count, 0);
  const activeCount = state.askStocks.reduce((n, stock) => n + (watchMark(state, stock.code).cls ? 1 : 0), 0);

  if (!groups.length) {
    return `<div class="ask-report-list"><p class="muted compact">${query ? '没有匹配的标的' : '还没有按个股归集的分析，跑一次任务后再刷新。'}</p></div>`;
  }

  const rail = groups.map((group) => `<button class="ask-letter${state.askLetterCollapsed[group.letter] ? ' collapsed' : ''}" data-action="ask-letter-jump" data-letter="${escapeHtml(group.letter)}" title="${group.letter} 组 ${group.items.length} 只">${escapeHtml(group.letter)}</button>`).join('');

  const body = groups.map((group) => {
    const collapsed = Boolean(state.askLetterCollapsed[group.letter]);
    return `<section class="ask-group" data-letter="${escapeHtml(group.letter)}" id="ask-group-${escapeHtml(group.letter)}">
      ${groupHead(group.letter, group.items.length, collapsed)}
      ${collapsed ? '' : `<div class="ask-group-body">${group.items.map((stock) => stockRow(state, stock)).join('')}</div>`}
    </section>`;
  }).join('');

  return `<div class="ask-list-body">
    <div class="ask-report-list">${body}</div>
    <nav class="ask-letter-rail" aria-label="按首字母跳转">${rail}</nav>
  </div>
  <p class="ask-list-foot">${total} 只标的 · ${segments} 段分析${activeCount ? ` · <span class="ask-foot-active">在管 ${activeCount} 只</span>` : ''}${state.askStocksBuiltAt ? ` · 归集于 ${escapeHtml(state.askStocksBuiltAt)}` : ''} · <button class="text-button inline" data-action="ask-stocks-rebuild">重建索引</button></p>`;
}

function kbStateBanner(note: StockNoteDetail): string {
  const code = note.code;
  if (note.status === 'running') {
    return `<div class="ask-kb-state running"><span class="spinner"></span><span>正在整理知识库…（首次整理约 10-30 秒，完成后自动刷新）</span></div>`;
  }
  if (note.status === 'queued') {
    return `<div class="ask-kb-state running">${icon('clock', 14)}<span>已排队整理，稍后自动刷新</span></div>`;
  }
  if (note.status === 'error') {
    return `<div class="ask-kb-state error">${icon('alert', 14)}<span>整理失败：${escapeHtml(note.error || '未知错误')}（当前展示上一次结果）</span><button class="text-button" data-action="ask-curate" data-code="${escapeHtml(code)}">重试</button></div>`;
  }
  if ((note.new_entries || 0) > 0) {
    return `<div class="ask-kb-state info">${icon('clock', 14)}<span>有 ${note.new_entries} 段新分析待并入知识库。</span><button class="text-button" data-action="ask-curate" data-code="${escapeHtml(code)}">立即整理</button></div>`;
  }
  if (note.updated_at && daysSince(note.updated_at) >= 3) {
    return `<div class="ask-kb-state info">${icon('clock', 14)}<span>知识库更新于 ${escapeHtml(note.updated_at)}，行情可能已变化。</span><button class="text-button" data-action="ask-run" data-code="${escapeHtml(code)}">跑一次个股快检</button></div>`;
  }
  return '';
}

function mainPane(state: AppState): string {
  const code = state.askStock;
  const stock = state.askStocks.find((item) => item.code === String(code).toUpperCase());
  const note = state.askNote;
  if (!code) {
    return `<section class="panel ask-main">${emptyState('选择一只股票', '左侧按名称或首字母索引找到标的，这里就可以直接就它的知识库追问。持仓/观察中的标的在左侧已高亮。', 'chat')}</section>`;
  }
  if (state.askNoteLoading && !note) {
    return `<section class="panel ask-main"><div class="ask-kb-loading"><span class="spinner"></span><span>正在读取 ${escapeHtml(stock?.name || code)} 的知识库…</span></div></section>`;
  }
  if (state.askNoteError && !note) {
    return `<section class="panel ask-main">${emptyState('知识库读取失败', state.askNoteError, 'alert')}</section>`;
  }
  if (!note) {
    return `<section class="panel ask-main">${emptyState('暂无内容', '该标的还没有可展示的知识库。', 'chat')}</section>`;
  }

  const name = note.name || (stock && stock.name) || code;
  const meta = [
    note.updated_at ? `知识库更新于 ${escapeHtml(note.updated_at)}` : '尚未整理',
    `${note.count} 段分析`,
    `整理模型 ${escapeHtml(shortModel(note.model))}`,
    daysSince(note.updated_at) >= 3 ? '可能滞后' : '',
  ].filter(Boolean).join(' · ');

  const body = `<section class="panel ask-main">
    <header class="ask-head">
      <div>
        <div class="ask-title">${escapeHtml(name)}<span class="ask-code">${escapeHtml(code)}</span></div>
        <div class="ask-meta">${meta}</div>
      </div>
      <div class="ask-head-actions">
        <button class="button button-secondary" data-action="ask-kb-expand" title="放大查看整理后的个股知识库">${icon('book', 15)}知识库</button>
        <button class="button button-secondary" data-action="ask-curate" data-code="${escapeHtml(code)}">${icon('refresh', 15)}重新整理</button>
        <button class="button button-secondary" data-action="ask-run" data-code="${escapeHtml(code)}">${icon('sparkles', 15)}更新数据</button>
      </div>
    </header>
    ${kbStateBanner(note)}
    <div class="ask-kb-collapsed">
      ${icon('book', 15)}<span>整理后的知识库已收起。这里是追问工作区，需要看全文时点右上角「知识库」放大查看。</span>
      <button class="text-button" data-action="ask-kb-expand">查看知识库 ${icon('arrow', 13)}</button>
    </div>
    <div class="ask-thread" id="ask-thread">${threadHtml(state, code, name)}</div>
    ${state.askError ? `<div class="inline-warning">${icon('alert', 15)}${escapeHtml(state.askError)}</div>` : ''}
    <div class="ask-compose">
      <textarea data-field="ask-input" rows="2" placeholder="就这只股票的知识库提问，例如：这个结论在什么情况下会失效？（Ctrl/⌘ + Enter 发送）">${escapeHtml(state.askDraft || '')}</textarea>
      <button class="button button-primary" data-action="ask-send" ${state.askLoading ? 'disabled' : ''}>${state.askLoading ? '<span class="spinner"></span>思考中' : `${icon('play', 15)}发送`}</button>
    </div>
  </section>`;
  return body;
}

function shortModel(model: string): string {
  const raw = String(model || '').trim();
  if (!raw || raw === 'inherit') return '继承宿主';
  const at = raw.lastIndexOf('@');
  const base = at > 0 ? raw.slice(0, at) : raw;
  const effort = at > 0 ? raw.slice(at + 1) : '';
  const parts = base.split('/');
  const tail = parts[parts.length - 1] || base;
  return effort ? `${tail}@${effort}` : tail;
}

export function renderAsk(state: AppState): string {
  const list = `<aside class="panel ask-list">
    <div class="search-field">${icon('search', 16)}<input data-field="ask-query" value="${escapeHtml(state.askQuery)}" placeholder="搜索股票名称或代码" aria-label="搜索标的" /></div>
    ${state.askStocks.length
      ? stockListHtml(state)
      : `<div class="ask-list-body"><div class="ask-report-list"><p class="muted compact">${state.askStocksLoading ? '正在读取知识库清单…' : '还没有可展示的个股知识库，先跑一次任务。'}</p></div></div>
        ${state.askStocksError ? `<p class="ask-list-foot">知识库不可用：${escapeHtml(state.askStocksError)}</p>` : ''}`}
  </aside>`;
  const head = pageHeader('个股知识库', '按股票归档：左侧索引里持仓/观察中的标的会高亮；中间是追问工作区，整理后的知识库收在右上角，点开即放大查看。');
  return head + `<div class="ask-layout">${list}${mainPane(state)}</div>`;
}
