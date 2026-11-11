import { emptyState, pageHeader } from './components';
import { escapeHtml, formatDateTime, truncate } from './format';
import { icon } from './icons';
import { renderMarkdown } from './markdown';
import { parseReportPath } from './run-history';
import { groupStocks } from './stock-index';
import type { AppState } from './state';
import type { StockNoteEntry, StockNoteMeta } from './types';

export interface AskReportOption {
  key: string;
  path: string;
  ts: string;
  title: string;
  codes: string[];
}

const normPath = (value: string): string => String(value || '').replace(/\\/g, '/').toLowerCase();

/** 标的名称：优先索引名称，其次代码本身 */
function codeLabel(state: AppState, code: string): string {
  const name = state.index?.codes?.[code]?.name;
  return name ? `${name} ${code}` : code;
}

/**
 * 可追问的报告清单（「综合」分组与「个股知识库」不可用时的兜底列表）。
 * 索引里同一次运行会挂两份报告（`.dsh-invest/reports/*.md` 与 `invest-outputs/…/报告.md`），
 * 这里按 run_id / 时间戳去重，优先保留 reports 下的主报告，避免同一份报告出现两次。
 */
export function reportOptions(state: AppState): AskReportOption[] {
  const runsById = new Map((state.index?.runs || []).map((run) => [String(run.id), run]));
  const buckets = new Map<string, AskReportOption & { primary: boolean }>();
  const put = (option: AskReportOption & { primary: boolean }): void => {
    const prev = buckets.get(option.key);
    if (!prev || (option.primary && !prev.primary)) buckets.set(option.key, option);
  };
  (state.index?.reports || []).forEach((report) => {
    const path = String(report.path || '').replace(/\\/g, '/');
    const { ts, title } = parseReportPath(path);
    if (!ts) return;
    const run = report.run_id !== undefined && report.run_id !== null ? runsById.get(String(report.run_id)) : undefined;
    const question = String(run?.question || '').trim();
    const codes = report.codes || run?.codes || [];
    const leadName = codes.length ? codeLabel(state, codes[0]).split(' ')[0] : '';
    const titleParts = [run?.mode || '报告'];
    if (leadName) titleParts.push(leadName);
    titleParts.push(truncate(question || title || '未命名任务', 30));
    put({
      key: report.run_id ? `run:${report.run_id}` : `ts:${ts}`,
      path,
      ts,
      title: titleParts.filter(Boolean).join(' · '),
      codes,
      primary: /\/\.dsh-invest\/reports\//i.test(path),
    });
  });
  (state.jobs || []).forEach((job) => {
    const path = String((job.result?.reports || [])[0] || job.reportPath || '').replace(/\\/g, '/');
    if (!path || job.status !== 'done') return;
    const { ts, title } = parseReportPath(path);
    const leadCode = String(job.code || '').trim();
    const leadName = leadCode ? codeLabel(state, leadCode).split(' ')[0] : '';
    put({
      key: `${job.id}`,
      path,
      ts: ts || formatDateTime(job.createdAt),
      title: [job.mode || job.name || '任务', leadName, truncate(job.question || title || job.templateName || '任务报告', 30)].filter(Boolean).join(' · '),
      codes: leadCode ? [leadCode] : [],
      primary: true,
    });
  });
  const list = Array.from(buckets.values()).map(({ primary, ...option }) => option);
  // 跨来源去重：同一次任务可能同时出现在 index.reports 与当前任务列表里（同一 path）
  const byPath = new Map<string, AskReportOption>();
  list.forEach((option) => {
    const key = normPath(option.path);
    if (!byPath.has(key)) byPath.set(key, option);
  });
  const unique = Array.from(byPath.values());
  // 当前选中的报告若不在清单里（例如历史路径解析不出时间），也要保留，避免出现空白
  if (state.askPath && !unique.some((option) => option.path === state.askPath)) {
    const { ts, title } = parseReportPath(state.askPath);
    unique.push({ key: 'selected', path: state.askPath, ts, title: title || '所选报告', codes: [] });
  }
  return unique.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

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

function threadHtml(state: AppState, path: string, stockName: string): string {
  const thread = state.askThreads[path] || [];
  if (!thread.length) {
    return `<div class="ask-hint">${icon('chat', 20)}<div><strong>${stockName ? `就 ${escapeHtml(stockName)} 的分析提问` : '就这份报告提问'}</strong><p>回答只依据归档报告内容；报告没写的会明确说「报告未涉及」。支持连续追问，历史轮次会一起带上；下次打开页面会话仍在。</p></div></div>
      ${suggestionsHtml(state)}`;
  }
  return thread.map((turn) => `<div class="ask-turn ask-${turn.role}">
      <span class="ask-role">${turn.role === 'user' ? '你' : '助手'}</span>
      <div class="ask-bubble${turn.role === 'assistant' ? ' ask-markdown' : ''}">${turn.role === 'assistant' ? renderMarkdown(turn.text) : escapeHtml(turn.text).replace(/\n/g, '<br/>')}</div>
    </div>`).join('') + suggestionsHtml(state);
}

/** 分析段的类型标签：分段原文 / 整份报告 / 历史节选 */
function kindLabel(kind: string): string {
  if (kind === 'mention') return '节选';
  if (kind === 'report') return '整份';
  return '分段';
}

/** 时间戳只显示 MM-DD HH:MM，列表里更紧凑 */
function entryDate(ts: string): string {
  const m = String(ts || '').match(/^\d{4}-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : (String(ts || '') || '—');
}

/** 摘录预览：去掉标记与 Markdown 符号，只留一句话 */
function entrySnippet(entry: StockNoteEntry): string {
  const plain = String(entry.text || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/[#>*`|~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(plain.replace(/^\d{4}-\d{2}-\d{2}\s*/, ''), 52);
}

function entryRow(state: AppState, stock: StockNoteMeta, entry: StockNoteEntry): string {
  const selected = normPath(state.askPath) === normPath(entry.report);
  return `<button class="ask-entry${selected ? ' selected' : ''}" data-action="ask-select" data-path="${escapeHtml(entry.report)}" data-code="${escapeHtml(stock.code)}">
    <span class="ask-entry-line"><b>${escapeHtml(entryDate(entry.ts))}</b><em>${escapeHtml(entry.mode || '投研')}</em><i>${escapeHtml(kindLabel(entry.kind))}</i></span>
    <span class="ask-entry-title">${escapeHtml(truncate(entry.heading || entry.report_title || '分析', 42))}</span>
    ${entrySnippet(entry) ? `<span class="ask-entry-snippet">${escapeHtml(entrySnippet(entry))}</span>` : ''}
  </button>`;
}

function stockRow(state: AppState, stock: StockNoteMeta): string {
  const open = Boolean(state.askStockOpen[stock.code]);
  const detail = state.askStockData[stock.code];
  const loading = Boolean(state.askStockLoading[stock.code]);
  const entries = open
    ? `<div class="ask-stock-entries">${loading
      ? '<p class="ask-entry-hint">正在读取该股分析…</p>'
      : (detail && detail.entries.length
        ? detail.entries.map((entry) => entryRow(state, stock, entry)).join('')
        : '<p class="ask-entry-hint">该股暂无可展开的分析段。</p>')}</div>`
    : '';
  return `<div class="ask-stock${open ? ' open' : ''}">
    <button class="ask-stock-row" data-action="ask-stock-toggle" data-code="${escapeHtml(stock.code)}" aria-expanded="${open ? 'true' : 'false'}">
      <span class="ask-stock-name">${escapeHtml(stock.name || stock.code)}</span>
      <span class="ask-stock-code">${escapeHtml(stock.code)}</span>
      <span class="ask-stock-count" title="${stock.count} 段分析">${stock.count}</span>
    </button>
    ${entries}
  </div>`;
}

function groupHead(letter: string, count: number, collapsed: boolean): string {
  return `<button class="ask-group-head${collapsed ? ' collapsed' : ''}" data-action="ask-letter-toggle" data-letter="${escapeHtml(letter)}">
    <span class="ask-group-letter">${escapeHtml(letter)}</span>
    <span class="ask-group-count">${count}</span>
    <span class="ask-group-caret">${icon('chevron', 13)}</span>
  </button>`;
}

/** 「综合」分组：没有任何个股归属的报告（大盘/组合/消息类），仍按报告追问 */
function orphansHtml(state: AppState, options: AskReportOption[]): string {
  const wanted = new Set(state.askStocksOrphans.map(normPath));
  const list = options.filter((option) => wanted.has(normPath(option.path)));
  if (!list.length) return '';
  const collapsed = Boolean(state.askLetterCollapsed['综合']);
  const rows = list.map((option) => `<button class="ask-report-item ${normPath(state.askPath) === normPath(option.path) ? 'selected' : ''}" data-action="ask-select" data-path="${escapeHtml(option.path)}">
      <strong>${escapeHtml(truncate(option.title, 30))}</strong>
      <small>${escapeHtml(option.ts || '—')}</small>
    </button>`).join('');
  return `<section class="ask-group" data-letter="综合" id="ask-group-misc">
    ${groupHead('综合', list.length, collapsed)}
    ${collapsed ? '' : `<div class="ask-group-body">${rows}</div>`}
  </section>`;
}

function stockListHtml(state: AppState, options: AskReportOption[]): string {
  const query = state.askQuery.trim().toLowerCase();
  const match = (stock: StockNoteMeta): boolean => (
    !query || `${stock.name} ${stock.code}`.toLowerCase().includes(query)
  );
  const groups = groupStocks(state.askStocks)
    .map((group) => ({ letter: group.letter, items: group.items.filter(match) }))
    .filter((group) => group.items.length);
  const orphans = orphansHtml(state, options);
  const total = state.askStocks.length;
  const segments = state.askStocks.reduce((sum, stock) => sum + stock.count, 0);

  if (!groups.length) {
    return `<div class="ask-report-list"><p class="muted compact">${query ? '没有匹配的标的' : '还没有按个股归集的分析，跑一次任务后再刷新。'}</p></div>
      ${orphans}`;
  }

  const rail = groups.map((group) => `<button class="ask-letter${state.askLetterCollapsed[group.letter] ? ' collapsed' : ''}" data-action="ask-letter-jump" data-letter="${escapeHtml(group.letter)}" title="${group.letter} 组 ${group.items.length} 只">${escapeHtml(group.letter)}</button>`).join('')
    + (orphans ? `<button class="ask-letter ask-letter-misc" data-action="ask-letter-jump" data-letter="综合" title="综合（无个股归属的报告）">综</button>` : '');

  const body = groups.map((group) => {
    const collapsed = Boolean(state.askLetterCollapsed[group.letter]);
    return `<section class="ask-group" data-letter="${escapeHtml(group.letter)}" id="ask-group-${escapeHtml(group.letter)}">
      ${groupHead(group.letter, group.items.length, collapsed)}
      ${collapsed ? '' : `<div class="ask-group-body">${group.items.map((stock) => stockRow(state, stock)).join('')}</div>`}
    </section>`;
  }).join('') + orphans;

  return `<div class="ask-list-body">
    <div class="ask-report-list">${body}</div>
    <nav class="ask-letter-rail" aria-label="按首字母跳转">${rail}</nav>
  </div>
  <p class="ask-list-foot">${total} 只标的 · ${segments} 段分析${state.askStocksBuiltAt ? ` · 归集于 ${escapeHtml(state.askStocksBuiltAt)}` : ''} · <button class="text-button inline" data-action="ask-stocks-rebuild">重建索引</button></p>`;
}

/** 个股知识库不可用（后端未重启/接口 404）时的兜底：按时间的报告列表 */
function fallbackListHtml(state: AppState, options: AskReportOption[]): string {
  const query = state.askQuery.trim().toLowerCase();
  const visible = query
    ? options.filter((option) => {
      const names = (option.codes || []).map((code) => codeLabel(state, code)).join(' ');
      return `${option.title} ${option.path} ${(option.codes || []).join(' ')} ${names}`.toLowerCase().includes(query);
    })
    : options;
  if (!visible.length) return `<p class="muted compact">${options.length ? '没有匹配的报告' : '还没有可追问的报告，先跑一次分析任务。'}</p>`;
  return visible.slice(0, 60).map((option) => {
    const labels = (option.codes || []).slice(0, 2).map((code) => codeLabel(state, code));
    const more = (option.codes || []).length > 2 ? ` 等 ${option.codes.length} 只` : '';
    return `<button class="ask-report-item ${state.askPath === option.path ? 'selected' : ''}" data-action="ask-select" data-path="${escapeHtml(option.path)}">
      <strong>${escapeHtml(truncate(option.title, 30))}</strong>
      <small>${escapeHtml(option.ts || '—')}${labels.length ? ' · ' + escapeHtml(labels.join(' / ')) + escapeHtml(more) : ''}</small>
    </button>`;
  }).join('');
}

export function renderAsk(state: AppState): string {
  const options = reportOptions(state);
  const selected = options.find((option) => option.path === state.askPath) || options[0];
  const stocksReady = state.askStocks.length > 0;
  const listBody = stocksReady
    ? stockListHtml(state, options)
    : `<div class="ask-list-body"><div class="ask-report-list">${fallbackListHtml(state, options)}</div></div>
      ${state.askStocksError ? `<p class="ask-list-foot">个股知识库暂不可用：${escapeHtml(state.askStocksError)}</p>` : ''}`;
  const list = `<aside class="panel ask-list">
    <div class="search-field">${icon('search', 16)}<input data-field="ask-query" value="${escapeHtml(state.askQuery)}" placeholder="搜索股票名称或代码" aria-label="搜索标的" /></div>
    ${listBody}
  </aside>`;

  if (!selected) {
    return pageHeader('报告追问', '按个股归档的投研分析知识库：左侧选股票，右侧就对应报告追问。')
      + `<div class="ask-layout">${list}<section class="panel ask-main">${emptyState('还没有可追问的报告', '先在一键任务里跑一次分析，完成后即可针对报告追问。', 'chat')}</section></div>`;
  }

  const thread = state.askThreads[selected.path] || [];
  const code = state.askCode || (selected.codes || [])[0] || '';
  const stock = code ? state.askStocks.find((item) => item.code === code) : undefined;
  const labels = (selected.codes || []).slice(0, 4).map((item) => codeLabel(state, item));
  const meta = [
    escapeHtml(selected.ts || ''),
    labels.length ? escapeHtml(labels.join(' / ')) : '',
    stock ? `该股共 ${stock.count} 段分析` : '',
    thread.length ? `${thread.length} 轮对话` : '尚无提问',
  ].filter(Boolean).join(' · ');
  const body = `<section class="panel ask-main">
    <header class="ask-head">
      <div><div class="ask-title">${escapeHtml(selected.title)}</div><div class="ask-meta">${meta}</div></div>
      <div class="ask-head-actions">
        ${stock ? `<button class="button button-secondary" data-action="open-stock-kb" data-code="${escapeHtml(stock.code)}">${icon('book', 15)}个股知识库</button>` : ''}
        <button class="button button-secondary" data-action="open-ask-report" data-path="${escapeHtml(selected.path)}">${icon('file', 15)}阅读全文</button>
      </div>
    </header>
    <div class="ask-thread" id="ask-thread">${threadHtml(state, selected.path, stock ? (stock.name || stock.code) : '')}</div>
    ${state.askError ? `<div class="inline-warning">${icon('alert', 15)}${escapeHtml(state.askError)}</div>` : ''}
    <div class="ask-compose">
      <textarea data-field="ask-input" rows="2" placeholder="就这份报告提问，例如：这个结论在什么情况下会失效？（Ctrl/⌘ + Enter 发送）">${escapeHtml(state.askDraft || '')}</textarea>
      <button class="button button-primary" data-action="ask-send" ${state.askLoading ? 'disabled' : ''}>${state.askLoading ? '<span class="spinner"></span>思考中' : `${icon('play', 15)}发送`}</button>
    </div>
  </section>`;

  return pageHeader('报告追问', '按个股归档：左侧按股票名/首字母索引，右侧就该股的报告追问；回答只依据报告内容。') + `<div class="ask-layout">${list}${body}</div>`;
}
