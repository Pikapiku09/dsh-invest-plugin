import { api } from './api';
import { escapeHtml } from './format';

const chartCache = new Map<string, Promise<string>>();
const TICK = String.fromCharCode(96);

function inlineMarkup(raw: string): string {
  let value = escapeHtml(raw);
  const codeSpans: string[] = [];
  const codePattern = new RegExp(TICK + '([^' + TICK + ']+)' + TICK, 'g');
  value = value.replace(codePattern, (_, code: string) => {
    codeSpans.push(code);
    return '@@CODE' + (codeSpans.length - 1) + '@@';
  });
  value = value
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/@@DSHCHART(\d+)@@/g, '<img class="report-chart" data-chart-index="$1" alt="研报图表" loading="lazy" />')
    .replace(/@@CODE(\d+)@@/g, (_, index: string) => '<code>' + codeSpans[Number(index)] + '</code>');
  return value;
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

export function renderMarkdown(text: string): string {
  const charts: string[] = [];
  const chartIndexes = new Map<string, number>();
  const chartToken = (rawPath: string): string => {
    const path = rawPath.trim();
    const key = path.replace(/\\/g, '/');
    const existing = chartIndexes.get(key);
    if (existing !== undefined) return '';
    chartIndexes.set(key, charts.length);
    charts.push(path);
    return '@@DSHCHART' + (charts.length - 1) + '@@';
  };
  const cleaned = String(text || '')
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/^###\s+(?:推理过程|思考过程|思考内容)\s*$[\s\S]*?(?=^#{1,3}\s|^---$|(?![\s\S]))/gim, '')
    // 个股分段标记只给归档系统看，正文里隐藏（否则会被转义成可见的 <!--stock:...--> 文本）
    .replace(/^[ \t]*<!--\s*\/?\s*stock\s*[:：][^\n]*-->[ \t]*$/gim, '')
    .replace(/^[ \t]*<!--\s*\/\s*stock\s*-->[ \t]*$/gim, '');
  const source = cleaned
    .replace(new RegExp(TICK + '([^' + TICK + ']+?\\.svg)' + TICK, 'gi'), (match: string, path: string) => (/^(?:[A-Za-z]:[\\/]|\/)/.test(path.trim()) ? chartToken(path) : match))
    .replace(/!\[[^\]]*\]\(([^)\s]+\.svg)\)/gi, (_, path: string) => chartToken(path))
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'<>|)\]]+?\.svg\b/gi, (path) => chartToken(path));

  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let index = 0;
  let inCode = false;
  let codeLanguage = '';
  let codeLines: string[] = [];

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith(TICK.repeat(3))) {
      if (inCode) {
        output.push('<pre class="code-block"><code' + (codeLanguage ? ' data-language="' + escapeHtml(codeLanguage) + '"' : '') + '>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
        inCode = false; codeLines = []; codeLanguage = '';
      } else {
        inCode = true; codeLanguage = trimmed.slice(3).trim();
      }
      index += 1; continue;
    }
    if (inCode) { codeLines.push(line); index += 1; continue; }

    if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) { output.push('<hr />'); index += 1; continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 5);
      output.push('<h' + level + '>' + inlineMarkup(heading[2]) + '</h' + level + '>');
      index += 1; continue;
    }
    if (/^\s*\|/.test(line) && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1])) {
      const headers = tableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|/.test(lines[index])) {
        rows.push(tableCells(lines[index])); index += 1;
      }
      output.push('<div class="table-scroll"><table class="markdown-table"><thead><tr>' + headers.map((cell) => '<th>' + inlineMarkup(cell) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((row) => '<tr>' + headers.map((_, cellIndex) => '<td>' + inlineMarkup(row[cellIndex] || '') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, '')); index += 1;
      }
      output.push('<ul>' + items.map((item) => '<li>' + inlineMarkup(item) + '</li>').join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, '')); index += 1;
      }
      output.push('<ol>' + items.map((item) => '<li>' + inlineMarkup(item) + '</li>').join('') + '</ol>');
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quotes: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quotes.push(lines[index].replace(/^\s*>\s?/, '')); index += 1;
      }
      output.push('<blockquote>' + quotes.map((quote) => '<p>' + inlineMarkup(quote) + '</p>').join('') + '</blockquote>');
      continue;
    }
    if (!line.trim()) { index += 1; continue; }
    output.push('<p>' + inlineMarkup(line) + '</p>');
    index += 1;
  }
  if (inCode) output.push('<pre class="code-block"><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');

  return output.join('\n').replace(/data-chart-index="(\d+)"/g, (_, chartIndex: string) =>
    'data-chart-path="' + escapeHtml(charts[Number(chartIndex)] || '') + '"',
  ).replace(/<li>\s*<\/li>/g, '');
}

function chartDataUrl(path: string): Promise<string> {
  if (!chartCache.has(path)) {
    const request = api.chart(path).then((result) => {
      if (!result || typeof result.svg !== 'string') throw new Error('图表接口未返回 SVG 内容');
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(result.svg);
    });
    // 失败不能永久缓存：报告/图表归档存在毫秒级时序差，下一次打开必须允许重试
    request.catch(() => chartCache.delete(path));
    chartCache.set(path, request);
  }
  return chartCache.get(path)!;
}

export async function hydrateCharts(root: ParentNode): Promise<void> {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-chart-path]'));
  await Promise.all(images.map(async (image) => {
    const path = image.dataset.chartPath || '';
    if (!path) return;
    try {
      image.src = await chartDataUrl(path);
      image.classList.add('chart-loaded');
    } catch (error) {
      const failure = document.createElement('div');
      failure.className = 'chart-error';
      failure.textContent = '图表加载失败：' + path.split(/[\\/]/).pop() + '（' + (error instanceof Error ? error.message : String(error)) + '）';
      image.replaceWith(failure);
    }
  }));
}
