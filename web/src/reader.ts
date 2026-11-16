import { api } from './api';
import { errorState, loadingBlock } from './components';
import { escapeHtml, fileName, formatBytes } from './format';
import { hydrateCharts, renderMarkdown } from './markdown';

let requestSerial = 0;
let previousFocus: HTMLElement | null = null;

function readerElement(): HTMLElement {
  return document.getElementById('reader')!;
}

export function closeReader(): void {
  requestSerial += 1;
  readerElement().hidden = true;
  document.body.classList.remove('reader-open');
  previousFocus?.focus({ preventScroll: true });
  previousFocus = null;
}

/** 图表画廊：报告阅读器与个股知识库放大层共用（v0.53.0） */
function chartGallery(charts: string[], label: string): string {
  if (!charts.length) return '';
  const items = charts.slice(0, 12).map((chart) =>
    `<img class="report-chart" data-chart-path="${escapeHtml(chart)}" alt="${escapeHtml(fileName(chart))}" title="${escapeHtml(fileName(chart))}" loading="lazy" />`,
  ).join('');
  const count = charts.length > 12 ? `最近 12 / 共 ${charts.length} 张` : `${charts.length} 张`;
  return `<section class="reader-chart-gallery"><h3>${escapeHtml(label)} · ${count}</h3><div class="reader-chart-grid">${items}</div></section>`;
}

/** 直接渲染一段 Markdown（不读文件）：用于「放大查看」知识库这类已有内容的场景
 *  charts 为该标的归集到的图表路径，会作为画廊放在知识库正文之前。
 *  v0.58.0 起：两段式知识库（同时有 `## 基本面` 与 `## 技术面`）自动改走页签视图；
 *  存量旧稿（7 段结构与只吐了一半的稿子）照旧原样渲染，不出页签、不报错。 */
export function openMarkdown(title: string, markdown: string, meta = '', charts: string[] = []): void {
  if (isSplitStockNote(markdown)) { openStockNote(title, markdown, meta, charts); return; }
  requestSerial += 1;
  const reader = readerElement();
  const content = document.getElementById('readerContent')!;
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.getElementById('readerTitle')!.textContent = title;
  document.getElementById('readerMeta')!.textContent = meta;
  content.innerHTML = `${chartGallery(charts, '相关图表')}<article class="markdown-body">${renderMarkdown(markdown) || '<p>内容为空。</p>'}</article>`;
  reader.hidden = false;
  document.body.classList.add('reader-open');
  document.getElementById('readerClose')!.focus({ preventScroll: true });
  void hydrateCharts(content);
}

/** 个股知识库的三个页签：基本面 / 技术面 / 时间线（`## 待核实` 等收尾段并入时间线，保证不丢段） */
const NOTE_TABS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'fundamental', label: '基本面' },
  { key: 'technical', label: '技术面' },
  { key: 'timeline', label: '时间线' },
];

export interface StockNoteTab { key: string; label: string; markdown: string }
export interface StockNoteView { scope: string; tabs: StockNoteTab[] }

/** 二级标题归一成哪一段（认不出的返回空串，仍归进时间线页签，保证不丢内容） */
function sectionName(title: string): string {
  const clean = String(title || '').replace(/[【】\[\]（）()「」《》\s]/g, '').replace(/^[0-9一二三四五六七八九十]+[、.．：:)）]/, '');
  if (clean.includes('基本面')) return '基本面';
  if (clean.includes('技术面')) return '技术面';
  if (clean.startsWith('时间线')) return '时间线';
  if (clean.startsWith('待核实')) return '待核实';
  return '';
}

/** 二级标题归到哪个页签：认不出的一律进时间线，宁可多收也不丢内容 */
function tabKeyOf(title: string): string {
  const name = sectionName(title);
  if (name === '基本面') return 'fundamental';
  if (name === '技术面') return 'technical';
  return 'timeline';
}

/** 两段式知识库的判定：必须同时存在 `## 基本面` 与 `## 技术面`。
 *  只有一段（模型吐了半截）或旧版 7 段结构都返回 false —— 页签是渐进增强，不是硬切换。 */
export function isSplitStockNote(markdown: string): boolean {
  const text = String(markdown || '');
  return /^##\s*基本面\s*$/m.test(text) && /^##\s*技术面\s*$/m.test(text);
}

/** 按 `##` 二级标题把知识库切成三页签（纯解析，不碰 DOM，便于单测） */
export function parseStockNote(markdown: string): StockNoteView {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const scope: string[] = [];
  const bodies: Record<string, string[]> = { fundamental: [], technical: [], timeline: [] };
  const seen: Record<string, Set<string>> = { fundamental: new Set(), technical: new Set(), timeline: new Set() };
  let current = '';
  for (const line of lines) {
    const section = line.match(/^##\s+(.+?)\s*$/);
    if (section) {
      const key = tabKeyOf(section[1]);
      const title = section[1].trim();
      if (key === current) {
        // 同一页签里的后续二级标题（典型是「时间线」之后的「待核实」）降一级保留，重复标题只留一份
        if (!seen[key].has(title)) { seen[key].add(title); bodies[key].push('### ' + title); }
      } else {
        const label = (NOTE_TABS.find((tab) => tab.key === key) || { label: '' }).label;
        seen[key].add(title);
        current = key;
        // 页签标签与实际标题不一致时（没有「时间线」段、只有「待核实」，或旧稿的「分歧与变化」）
        // 保留标题，别让内容失去出处；一致时标签已经承担了标题，不再重复
        if (sectionName(title) !== label) bodies[key].push('### ' + title);
      }
      continue;
    }
    if (/^#\s+\S/.test(line)) continue; // 一级标题是文档名，阅读器标题区已经显示
    if (!current) {
      const scopeLine = line.replace(/^>\s?/, '').trim();
      if (scopeLine) scope.push(scopeLine);
      continue;
    }
    bodies[current].push(line);
  }
  return {
    scope: scope.join(' '),
    tabs: NOTE_TABS.map((tab) => ({ key: tab.key, label: tab.label, markdown: bodies[tab.key].join('\n').trim() })),
  };
}

/** 个股知识库的放大层：页签 + 各页签正文；归集的图表放在技术面页签里，和价位/趋势一起看 */
function stockNoteHtml(markdown: string, charts: string[]): string {
  const view = parseStockNote(markdown);
  const tabs = view.tabs.map((tab, index) => `<button type="button" class="stock-note-tab${index === 0 ? ' active' : ''}" role="tab" id="stock-tab-${tab.key}" aria-controls="stock-panel-${tab.key}" aria-selected="${index === 0 ? 'true' : 'false'}" tabindex="${index === 0 ? '0' : '-1'}" data-stock-tab="${tab.key}">${escapeHtml(tab.label)}</button>`).join('');
  const panels = view.tabs.map((tab, index) => {
    const body = renderMarkdown(tab.markdown) || '<p class="muted compact">这一段暂无内容，可在「重新整理」后补上。</p>';
    const gallery = tab.key === 'technical' ? chartGallery(charts, '相关图表') : '';
    return `<section class="stock-note-panel" role="tabpanel" id="stock-panel-${tab.key}" aria-labelledby="stock-tab-${tab.key}" data-stock-panel="${tab.key}"${index === 0 ? '' : ' hidden'}>${gallery}<article class="markdown-body">${body}</article></section>`;
  }).join('');
  const scope = view.scope ? `<p class="stock-note-scope">${escapeHtml(view.scope)}</p>` : '';
  return `<div class="stock-note">${scope}<div class="stock-note-tabs" role="tablist" aria-label="个股知识库分页">${tabs}</div>${panels}</div>`;
}

/** 个股知识库放大层：默认停在基本面，图表随技术面页签展示 */
export function openStockNote(title: string, markdown: string, meta = '', charts: string[] = []): void {
  requestSerial += 1;
  const reader = readerElement();
  const content = document.getElementById('readerContent')!;
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.getElementById('readerTitle')!.textContent = title;
  document.getElementById('readerMeta')!.textContent = meta;
  content.innerHTML = stockNoteHtml(markdown, charts);
  reader.hidden = false;
  document.body.classList.add('reader-open');
  document.getElementById('readerClose')!.focus({ preventScroll: true });
  void hydrateCharts(content);
}

/** 页签切换：只改 hidden / aria 状态，不重绘内容（图表已 hydrate，重绘会重新拉一遍图） */
function activateStockTab(target: HTMLElement): void {
  const key = target.dataset.stockTab || '';
  const root = target.closest('.stock-note');
  if (!root) return;
  root.querySelectorAll<HTMLElement>('[data-stock-tab]').forEach((tab) => {
    const on = tab.dataset.stockTab === key;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
  });
  root.querySelectorAll<HTMLElement>('[data-stock-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.stockPanel !== key;
  });
}

export async function openReport(path: string, charts: string[] = []): Promise<void> {
  const serial = ++requestSerial;
  const reader = readerElement();
  const content = document.getElementById('readerContent')!;
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.getElementById('readerTitle')!.textContent = fileName(path);
  document.getElementById('readerMeta')!.textContent = path;
  content.innerHTML = loadingBlock('正在读取 Markdown 报告与图表');
  reader.hidden = false;
  document.body.classList.add('reader-open');
  document.getElementById('readerClose')!.focus({ preventScroll: true });

  try {
    const report = await api.report(path);
    if (serial !== requestSerial) return;
    const text = String(report.text || '');
    document.getElementById('readerTitle')!.textContent = fileName(report.path || path);
    document.getElementById('readerMeta')!.textContent = `${report.path || path} · ${formatBytes(new Blob([text]).size)}`;
    const normalizedText = text.replace(/\\/g, '/');
    const seenCharts = new Set<string>();
    const extraCharts = charts.filter((chart) => {
      const normalized = chart.replace(/\\/g, '/');
      if (seenCharts.has(normalized) || normalizedText.includes(normalized)) return false;
      seenCharts.add(normalized);
      return true;
    });
    const chartSection = chartGallery(extraCharts, '相关图表');
    content.innerHTML = `${chartSection}<article class="markdown-body">${renderMarkdown(text) || '<p>报告内容为空。</p>'}</article>`;
    void hydrateCharts(content);
  } catch (error) {
    if (serial !== requestSerial) return;
    content.innerHTML = errorState('报告读取失败', error instanceof Error ? error.message : String(error));
  }
}

export function initialiseReader(): void {
  const reader = readerElement();
  reader.addEventListener('click', (event) => {
    if (event.target === reader) { closeReader(); return; }
    const tab = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-stock-tab]') : null;
    if (tab) activateStockTab(tab);
  });
  document.addEventListener('keydown', (event) => {
    if (reader.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeReader(); return; }
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && focused && focused.dataset.stockTab) {
      const group = Array.from(focused.parentElement?.querySelectorAll<HTMLElement>('[data-stock-tab]') || []);
      const index = group.indexOf(focused);
      const next = index < 0 ? null : group[(index + (event.key === 'ArrowRight' ? 1 : group.length - 1)) % group.length];
      if (next) { event.preventDefault(); next.focus(); activateStockTab(next); }
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(reader.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')).filter((element) => !element.hasAttribute('disabled') && !element.closest('[hidden]'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}
