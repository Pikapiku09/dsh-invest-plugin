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
    const chartSection = extraCharts.length ? `<section class="reader-chart-gallery"><h3>相关图表</h3>${extraCharts.slice(0, 12).map((chart) => `<img class="report-chart" data-chart-path="${escapeHtml(chart)}" alt="运行图表" loading="lazy" />`).join('')}</section>` : '';
    content.innerHTML = `${chartSection}<article class="markdown-body">${renderMarkdown(text) || '<p>报告内容为空。</p>'}</article>`;
    void hydrateCharts(content);
  } catch (error) {
    if (serial !== requestSerial) return;
    content.innerHTML = errorState('报告读取失败', error instanceof Error ? error.message : String(error));
  }
}

export function initialiseReader(): void {
  const reader = readerElement();
  reader.addEventListener('click', (event) => { if (event.target === reader) closeReader(); });
  document.addEventListener('keydown', (event) => {
    if (reader.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeReader(); return; }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(reader.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')).filter((element) => !element.hasAttribute('disabled'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}
