import { emptyState, pageHeader } from './components';
import { escapeHtml } from './format';
import { icon } from './icons';
import { renderMarkdown } from './markdown';
import { groupStocks } from './stock-index';
import { COMPARE_PAIR_STORE } from './state';
import type { AppState } from './state';
import type { CompareDim, CompareGate, CompareResponse, CompareStock, StockNoteDetail, StockNoteMeta } from './types';

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
    return `<div class="ask-hint">${icon('chat', 20)}<div><strong>就 ${escapeHtml(name || code)} 的知识库提问</strong><p>回答只依据这份知识库${updated ? `（更新于 ${escapeHtml(updated)}）` : ''}；知识库没写的会明确说「未涉及」，涉及更晚的行情会提示你跑任务更新。支持连续追问，历史轮次会一起带上。</p><p class="ask-hint-kb">整理后的知识库${(state.askCharts || []).length ? ` 与 ${(state.askCharts || []).length} 张相关图表` : ''}已收起，点右上角「知识库」可放大查看。</p></div></div>
      ${suggestionsHtml(state)}`;
  }
  return thread.map((turn, index) => `<div class="ask-turn ask-${turn.role}">
      <span class="ask-role">${turn.role === 'user' ? '你' : '助手'}</span>
      <div class="ask-bubble${turn.role === 'assistant' ? ' ask-markdown' : ''}">${turn.role === 'assistant' ? renderMarkdown(turn.text) : escapeHtml(turn.text).replace(/\n/g, '<br/>')}${
        turn.role === 'user'
          ? `<span class="ask-turn-actions"><button class="ask-mini" type="button" data-action="ask-copy" data-turn="${index}" title="复制这条提问">${icon('file', 12)}复制</button><button class="ask-mini" type="button" data-action="ask-edit" data-turn="${index}" title="把这条提问放回输入框改写后重发">${icon('edit', 12)}修改</button></span>`
          : ''}</div>
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

/** 对比模式下左栏行：点一下填 A 槽，再点一只填 B 槽；已入槽的显示 A/B 角标 */
function compareBadge(state: AppState, code: string): string {
  if (state.compareA === code) return '<span class="compare-pick-tag is-a">A</span>';
  if (state.compareB === code) return '<span class="compare-pick-tag is-b">B</span>';
  return '';
}

function stockRow(state: AppState, stock: StockNoteMeta): string {
  const compareMode = state.askMode === 'compare';
  const selected = compareMode
    ? state.compareA === stock.code || state.compareB === stock.code
    : String(state.askStock || '').toUpperCase() === stock.code;
  const mark = watchMark(state, stock.code);
  const stateText = mark.cls === 'held' ? ' · 持仓中' : mark.cls === 'watching' ? ' · 观察中' : '';
  const action = compareMode ? 'compare-pick' : 'ask-stock-select';
  const hint = compareMode ? ' · 点一下放入对比槽' : '';
  return `<button class="ask-stock-row${selected ? ' selected' : ''}${mark.cls ? ' ask-stock-row-' + mark.cls : ''}" data-action="${action}" data-code="${escapeHtml(stock.code)}" title="${escapeHtml(stock.name || stock.code)} · ${stock.count} 段分析${stock.curated_at ? ' · 更新于 ' + escapeHtml(stock.curated_at) : ' · 尚未整理'}${stateText}${hint}">
    <span class="ask-stock-name">${escapeHtml(stock.name || stock.code)}</span>
    ${mark.label ? `<span class="ask-watch-tag ${mark.cls}">${mark.label}</span>` : ''}
    <span class="ask-stock-code">${escapeHtml(stock.code)}</span>
    ${compareMode ? compareBadge(state, stock.code) : ''}
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

  const charts = state.askCharts || [];
  const chartsHint = charts.length ? ` 与 ${charts.length} 张相关图表` : '';
  const body = `<section class="panel ask-main">
    <header class="ask-head">
      <div>
        <div class="ask-title">${escapeHtml(name)}<span class="ask-code">${escapeHtml(code)}</span></div>
        <div class="ask-meta">${meta}</div>
      </div>
      <div class="ask-head-actions">
        <button class="button button-secondary" data-action="ask-kb-expand" title="放大查看整理后的个股知识库（基本面 / 技术面 / 时间线分页）与图表">${icon('book', 15)}知识库${charts.length ? ` · ${charts.length} 图` : ''}</button>
        <button class="button button-secondary" data-action="ask-curate" data-code="${escapeHtml(code)}">${icon('refresh', 15)}重新整理</button>
        <button class="button button-secondary" data-action="ask-run" data-code="${escapeHtml(code)}">${icon('sparkles', 15)}更新数据</button>
      </div>
    </header>
    ${kbStateBanner(note)}
    <div class="ask-kb-collapsed">
      ${icon('book', 15)}<span>整理后的知识库${chartsHint}已收起。这里是追问工作区；要读全文（放大后按「基本面 / 技术面 / 时间线」分页）或看图，点右上角「知识库」。</span>
      <button class="text-button" data-action="ask-kb-expand">查看知识库${chartsHint ? '与图表' : ''} ${icon('arrow', 13)}</button>
    </div>
    <div class="ask-thread" id="ask-thread">${threadHtml(state, code, name)}</div>
    ${state.askError ? `<div class="inline-warning">${icon('alert', 15)}${escapeHtml(state.askError)}</div>` : ''}
    <div class="ask-compose">
      <textarea data-field="ask-input" rows="2" placeholder="就这只股票的知识库提问，例如：这个结论在什么情况下会失效？（Enter 发送，Shift + Enter 换行）">${escapeHtml(state.askDraft || '')}</textarea>
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

// ===== 同口径对比（v0.77.0）=====
// 只排版、不计算：数字全部来自服务端 compare_pack.js（同一 as-of、不复权 daily），
// 胜负由服务端规则判定。前端唯一做的取舍是"缺数据显示 —"，绝不补 0、不估算。

const cmpNum = (v: number | null | undefined, digits = 2): string =>
  (v === null || v === undefined || !Number.isFinite(v)) ? '—' : v.toFixed(digits);

/** 资金用万元，过亿折成亿——读数字是为了抓量级，不是为了精确到个位 */
const cmpWan = (v: number | null | undefined): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 10000) return (v / 10000).toFixed(2) + ' 亿';
  return v.toFixed(0) + ' 万';
};

const DIM_UNIT: Record<string, string> = {
  position: '回撤%', momentum: '超额%', flow: '20日净流入', valuation: 'PE_TTM', quality: 'ROE%', plan: '赔率',
};

const GATE_LABEL: Record<string, string> = {
  H1: '权重上限', H2: '失效条件', H3: '赔率/止损', H4: '目标价', STOP: '口径冲突',
};

/** 胜者代码 → 名称；查不到就退回代码，避免出现 "undefined 领先" */
function cmpName(stocks: CompareStock[], code: string | null): string {
  if (!code) return '不判';
  const hit = stocks.find((s) => s.code === code);
  return hit ? hit.name : code;
}

function dimText(dim: CompareDim, v: number | undefined): string {  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  if (dim.key === 'flow') return cmpWan(v);
  if (dim.key === 'plan') return v.toFixed(2) + ':1';
  if (dim.key === 'valuation') return v.toFixed(1);
  return v.toFixed(2) + '%';
}

function compareSlot(state: AppState, slot: 'a' | 'b'): string {
  const code = slot === 'a' ? state.compareA : state.compareB;
  const stock = state.askStocks.find((item) => item.code === code);
  const name = stock?.name || (state.compareResult?.stocks || []).find((item) => item.code === code)?.name || '';
  if (!code) {
    return `<div class="compare-slot empty">
      <span class="compare-slot-tag">${slot.toUpperCase()}</span>
      <span class="compare-slot-hint">点左侧标的选择</span>
    </div>`;
  }
  return `<div class="compare-slot filled">
    <span class="compare-slot-tag">${slot.toUpperCase()}</span>
    <span class="compare-slot-name">${escapeHtml(name || code)}<span class="ask-code">${escapeHtml(code)}</span></span>
    <button class="icon-button small" data-action="compare-clear" data-slot="${slot}" title="移出这个槽位" aria-label="移出这个槽位">${icon('close', 13)}</button>
  </div>`;
}

function comparePlanCell(stock: CompareStock): string {
  const p = stock.plan;
  const rows = [
    ['现价', cmpNum(stock.close, 3) + (stock.chg_pct === null ? '' : `（${stock.chg_pct > 0 ? '+' : ''}${cmpNum(stock.chg_pct, 2)}%）`)],
    ['生效止损', p.eff_stop === null ? '未设' : `${cmpNum(p.eff_stop, 3)} · ${p.eff_stop_src}`],
    ['目标价', p.target === null ? '未设（赔率不可算）' : cmpNum(p.target, 3)],
    ['赔率', p.odds === null ? '—' : `${cmpNum(p.odds, 2)}:1`],
    ['权重/可加', p.held ? `${cmpNum(p.weight_pct, 2)}% / 还能加 ${cmpNum(p.room_pct, 2)}%` : `空仓 / 最多可建 ${cmpNum(p.room_pct, 2)}%`],
    ['买区', p.buy_low === null && p.buy_high === null ? '—' : `${cmpNum(p.buy_low, 2)}–${cmpNum(p.buy_high, 2)}`],
  ];
  return `<div class="compare-plan">
    <div class="compare-plan-head">${escapeHtml(stock.name)}<span class="ask-code">${escapeHtml(stock.code)}</span></div>
    <dl>${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>
    <p class="compare-plan-note">${p.stance ? `立场：${escapeHtml(p.stance)}` : '立场：—'}${p.concl_ts ? ` · 结论 ${escapeHtml(p.concl_ts.slice(0, 16).replace('T', ' '))}` : ''}</p>
  </div>`;
}

function compareResultHtml(state: AppState, result: CompareResponse): string {
  const stocks = result.stocks || [];
  const verdict = result.verdict;
  const leader = stocks
    .slice()
    .sort((a, b) => (verdict.score[b.code] || 0) - (verdict.score[a.code] || 0))[0];
  const winCounts = stocks.map((s) => verdict.score[s.code] || 0);
  const tied = new Set(winCounts).size === 1 && winCounts.length > 1;

  const verdictCard = `<div class="compare-verdict">
    <div class="compare-verdict-main">
      <span class="compare-verdict-label">${tied ? '打平' : '规则判定'}</span>
      <strong>${tied ? '六维打平，看硬约束' : escapeHtml(cmpName(stocks, leader ? leader.code : null)) + ' 领先'}</strong>
      <span class="compare-verdict-score">${stocks.map((s) => `${escapeHtml(s.name)} ${verdict.score[s.code] || 0} 胜`).join(' · ')}</span>
    </div>
    <p class="compare-verdict-hint">${escapeHtml(verdict.summary_hint || '')}</p>
  </div>`;

  const head = `<tr><th>维度</th>${stocks.map((s) => `<th>${escapeHtml(s.name)}</th>`).join('')}<th>判定</th></tr>`;
  const rows = (verdict.dims || []).map((dim) => {
    const cells = stocks.map((s) => {
      const win = dim.winner === s.code;
      return `<td class="compare-cell${win ? ' win' : ''}">${escapeHtml(dimText(dim, dim.values[s.code]))}${win ? ' <span class="compare-win-tag">胜</span>' : ''}</td>`;
    }).join('');
    const winnerName = dim.winner ? cmpName(stocks, dim.winner) : (dim.note || '不判');
    return `<tr><th>${escapeHtml(dim.label)}<span class="compare-dim-unit">${escapeHtml(DIM_UNIT[dim.key] || '')}</span></th>${cells}<td class="compare-dim-note">${escapeHtml(winnerName)}</td></tr>`;
  }).join('');

  const gates = (verdict.gates || []) as CompareGate[];
  const gateHtml = gates.length
    ? `<div class="compare-gates">
        <div class="compare-section-title">先过硬约束<span class="muted compact">（规则判定，模型无权豁免）</span></div>
        ${gates.map((g) => `<div class="compare-gate is-${g.level}">
          <span class="compare-gate-rule">${escapeHtml(GATE_LABEL[g.rule] || g.rule)}</span>
          <span class="compare-gate-name">${escapeHtml(g.name)}</span>
          <span class="compare-gate-text">${escapeHtml(g.text)}</span>
        </div>`).join('')}
      </div>`
    : '<p class="compare-no-gate">没有触发硬约束；剩下的就是估值与节奏的取舍。</p>';

  const answer = result.answer
    ? `<div class="compare-answer ask-markdown">${renderMarkdown(result.answer)}</div>`
    : `<div class="compare-answer-missing">${icon('alert', 15)}<div><strong>解释没出来</strong><p>${escapeHtml(result.answerError || '模型不可用')}。上面的事实表与规则判定仍然有效，可以先用它们做判断，或稍后重试。</p></div></div>`;

  const thread = state.compareThread.length
    ? `<div class="compare-thread">${state.compareThread.map((turn) => `<div class="ask-turn ask-${turn.role}">
        <span class="ask-role">${turn.role === 'user' ? '你' : '助手'}</span>
        <div class="ask-bubble${turn.role === 'assistant' ? ' ask-markdown' : ''}">${turn.role === 'assistant' ? renderMarkdown(turn.text) : escapeHtml(turn.text).replace(/\n/g, '<br/>')}</div>
      </div>`).join('')}</div>`
    : '';

  const follow = `<div class="compare-follow">
    ${thread}
    <div class="ask-compose">
      <textarea data-field="compare-follow" rows="2" placeholder="继续问这一对：例如「如果我必须今天动手，先做哪一步？」（会带上上一轮结论，数字仍只来自同口径事实）">${escapeHtml(state.compareFollowDraft || '')}</textarea>
      <button class="button button-primary" data-action="compare-send" ${state.compareSending ? 'disabled' : ''}>${state.compareSending ? '<span class="spinner"></span>追问中' : `${icon('play', 15)}追问`}</button>
    </div>
  </div>`;

  const footer = `<p class="compare-foot">as-of ${escapeHtml(result.asof)} · 价格口径 ${result.price_basis === 'unadj' ? '不复权' : escapeHtml(result.price_basis)} · 数据源 Tushare ${escapeHtml(result.stocks[0]?.fina_end_date ? `（财务截止 ${result.stocks[0].fina_end_date}）` : '')}${result.warnings?.length ? ` · 注意：${escapeHtml(result.warnings.join('；'))}` : ''}</p>`;

  return `${verdictCard}
    <div class="compare-plans">${stocks.map((s) => comparePlanCell(s)).join('')}</div>
    <div class="table-scroll compare-table-wrap"><table class="data-table compare-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
    ${gateHtml}
    <div class="compare-section-title">让模型读一遍</div>
    ${answer}
    ${follow}
    ${footer}`;
}

function compareHint(state: AppState): string {
  if (state.compareA && state.compareB && state.compareA === state.compareB) {
    return `<div class="inline-warning">${icon('alert', 15)}两侧是同一只标的，换一只再比。</div>`;
  }
  return `<div class="compare-hint">${icon('layers', 20)}<div><strong>怎么比</strong><p>左侧点一只放进 A，再点一只放进 B。对比会先把两只票拉齐到<b>同一个交易日</b>，用同一口径算价格位置、动量、资金、估值、质量、计划与赔率；胜负按规则判，模型只负责把差异讲成人话，不允许改数字。</p><p class="muted compact">常用入口：持仓工作区和标的档案的「加入对比」会把标的直接填进 A 槽。</p></div></div>`;
}

function comparePane(state: AppState): string {
  const ready = Boolean(state.compareA && state.compareB && state.compareA !== state.compareB);
  const result = state.compareResult;
  return `<section class="panel ask-main compare-main">
    <div class="compare-slots">
      ${compareSlot(state, 'a')}
      <button class="icon-button compare-swap" data-action="compare-swap" title="交换 A / B" aria-label="交换 A / B" ${ready ? '' : 'disabled'}>${icon('refresh', 14)}</button>
      ${compareSlot(state, 'b')}
    </div>
    <div class="compare-ask">
      <textarea data-field="compare-question" rows="2" placeholder="默认：结合我当前的持仓、现金与纪律，如果只能选一只买，选谁？先做什么？">${escapeHtml(state.compareQuestion || '')}</textarea>
      <div class="compare-actions">
        <button class="button button-primary" data-action="compare-run" ${ready && !state.compareLoading ? '' : 'disabled'}>${state.compareLoading ? '<span class="spinner"></span>对比中' : `${icon('sparkles', 15)}开始对比`}</button>
        <button class="button button-secondary" data-action="compare-facts" ${ready && !state.compareLoading ? '' : 'disabled'}>${icon('database', 15)}只看数据</button>
        <span class="muted compact">「只看数据」不调模型、0 token；「开始对比」会调一次模型（约 30–90 秒）。</span>
      </div>
      ${result ? `<div class="compare-actions">
        <button class="button button-secondary" data-action="compare-deep" ${state.compareLoading ? 'disabled' : ''}>${icon('layers', 15)}升级为深度对比</button>
        <span class="muted compact">走完整流水线（消息 → 深度 → 总判断），出正式报告并落档；耗时几分钟、消耗额度，适合真要下单前。</span>
      </div>` : ''}
    </div>
    ${state.compareError ? `<div class="inline-warning">${icon('alert', 15)}${escapeHtml(state.compareError)}</div>` : ''}
    ${result ? compareResultHtml(state, result) : compareHint(state)}
  </section>`;
}

/** 页内模式切换：知识库（默认）/ 对比。不新增导航页——两个模式共用左栏标的索引。 */
function modeTabs(state: AppState): string {
  const tab = (mode: 'kb' | 'compare', label: string, hint: string): string => `<button class="ask-mode-tab${state.askMode === mode ? ' active' : ''}" data-action="ask-mode" data-mode="${mode}" title="${escapeHtml(hint)}">${label}</button>`;
  const hint = state.askMode === 'compare'
    ? '点左侧标的填 A 槽，再点一只填 B 槽'
    : '左侧选标的，就它的知识库追问';
  return `<div class="ask-modes"><div class="ask-mode-group">${tab('kb', '知识库', '按股票归档的知识库答疑')}${tab('compare', '对比', '两只票同口径对比')}</div><span class="ask-mode-hint">${escapeHtml(hint)}</span></div>`;
}

export function renderAsk(state: AppState): string {
  const list = `<aside class="panel ask-list">
    <div class="search-field">${icon('search', 16)}<input data-field="ask-query" value="${escapeHtml(state.askQuery)}" placeholder="搜索股票名称或代码" aria-label="搜索标的" /></div>
    ${state.askStocks.length
      ? stockListHtml(state)
      : `<div class="ask-list-body"><div class="ask-report-list"><p class="muted compact">${state.askStocksLoading ? '正在读取知识库清单…' : '还没有可展示的个股知识库，先跑一次任务。'}</p></div></div>
        ${state.askStocksError ? `<p class="ask-list-foot">知识库不可用：${escapeHtml(state.askStocksError)}</p>` : ''}`}
  </aside>`;
  const head = state.askMode === 'compare'
    ? pageHeader('同口径对比', '两只票拉齐到同一交易日、同一价格口径再比：价格位置、趋势动量、资金、估值、质量、计划与赔率。数字来自 Tushare，胜负按规则判——模型只解读，不许改数。')
    : pageHeader('个股知识库', '按股票归档：左侧索引里持仓/观察中的标的会高亮；中间是追问工作区，整理后的知识库与该股图表一起收在右上角，点开即放大查看。');
  const main = state.askMode === 'compare' ? comparePane(state) : mainPane(state);
  return head + modeTabs(state) + `<div class="ask-layout">${list}${main}</div>`;
}

/** 配对写入 localStorage（main.ts 填槽/清槽后调用） */
export function saveComparePair(a: string, b: string): void {
  try { window.localStorage.setItem(COMPARE_PAIR_STORE, JSON.stringify({ a, b })); } catch { /* 隐私模式忽略 */ }
}
