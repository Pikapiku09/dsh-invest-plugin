// 个股名称的拼音首字母：用于「报告追问」左侧按股票名排序 + A-Z 索引导航。
// 不引入 pinyin 依赖：Intl.Collator('zh-Hans-CN') 中文按拼音排序，
// 用一组「各字母的边界汉字」二分即可得到首字母（V8/ICU 内置能力，零额外包体）。
import type { StockNoteMeta } from './types';

/** 拼音字母表：无 I / U / V（汉语拼音不作声母） */
export const STOCK_LETTERS: string[] = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N',
  'O', 'P', 'Q', 'R', 'S', 'T', 'W', 'X', 'Y', 'Z',
];

/** 每个字母的边界汉字：某字 >= 边界字 且 < 下一个边界字，则首字母为该字母 */
const BOUNDARY: Record<string, string> = {
  A: '阿', B: '八', C: '擦', D: '搭', E: '蛾', F: '发', G: '噶', H: '哈', J: '击', K: '喀',
  L: '垃', M: '妈', N: '拿', O: '哦', P: '啪', Q: '期', R: '然', S: '撒', T: '塌',
  W: '挖', X: '夕', Y: '压', Z: '匝',
};

/**
 * 多音字按「股票名实际读音」纠正：ICU 只给字的标准读音，`长电/长江` 读 cháng（C）不是 zhǎng，
 * `西藏` 读 zàng（X）不是 cáng，`厦门/厦工` 读 xià（X）不是 shà。
 */
const CHAR_OVERRIDE: Record<string, string> = { 长: 'C', 厦: 'X' };
const PREFIX_OVERRIDE: Array<[RegExp, string]> = [
  [/^重庆/, 'C'],
  [/^西藏/, 'X'],
  [/^藏格/, 'Z'],
];

const COLLATOR = (() => {
  try { return new Intl.Collator('zh-Hans-CN', { usage: 'sort' }); } catch { return null; }
})();

const HAN_RE = /[\u4e00-\u9fa5]/;

/** 名称首字母：汉字转拼音首字母；字母开头取该字母；其余归到 # */
export function pinyinInitial(name: string): string {
  // 去掉 *ST / ST / XD / XR / DR 这类前缀，按「正名」首字归组（*ST威领 → W）
  const cleaned = String(name || '').trim()
    .replace(/^[*＊]\s*/, '')
    .replace(/^(?:XD|XR|DR)(?=[\u4e00-\u9fa5])/i, '')
    .replace(/^ST(?=[\u4e00-\u9fa5])/i, '')
    .trim();
  const ch = cleaned.charAt(0);
  if (!ch) return '#';
  if (/[A-Za-z]/.test(ch)) return ch.toUpperCase();
  if (!HAN_RE.test(ch)) return '#';
  for (const [pattern, letter] of PREFIX_OVERRIDE) if (pattern.test(cleaned)) return letter;
  if (CHAR_OVERRIDE[ch]) return CHAR_OVERRIDE[ch];
  if (!COLLATOR) return '#';
  let hit = '#';
  for (const letter of STOCK_LETTERS) {
    if (COLLATOR.compare(ch, BOUNDARY[letter]) >= 0) hit = letter; else break;
  }
  return hit;
}

export function compareStockName(a: string, b: string): number {
  if (COLLATOR) return COLLATOR.compare(String(a || ''), String(b || ''));
  return String(a || '').localeCompare(String(b || ''));
}

export interface StockGroup {
  letter: string;
  items: StockNoteMeta[];
}

/** 按拼音首字母分组；组内按名称排序，组间按 A-Z/# 顺序 */
export function groupStocks(stocks: StockNoteMeta[]): StockGroup[] {
  const buckets = new Map<string, StockNoteMeta[]>();
  const sorted = [...stocks].sort((a, b) => (
    compareStockName(a.name || a.code, b.name || b.code) || String(a.code).localeCompare(String(b.code))
  ));
  sorted.forEach((stock) => {
    const letter = pinyinInitial(stock.name || stock.code);
    const list = buckets.get(letter) || [];
    list.push(stock);
    buckets.set(letter, list);
  });
  const order = [...STOCK_LETTERS, '#'];
  return Array.from(buckets.entries())
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([letter, items]) => ({ letter, items }));
}
