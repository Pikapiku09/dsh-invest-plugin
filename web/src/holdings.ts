import { emptyState, errorState, pageHeader, sectionHeading, skeletonPage } from './components';
import { escapeHtml, formatDateTime, formatNumber } from './format';
import { icon } from './icons';
import type { AppState } from './state';
import { LEDGER_DEFAULT_COLUMNS } from './types';
import type { HoldingPosition, HoldingsAccount, HoldingsDiff, HoldingsDraftResponse, LedgerColKey } from './types';

/** 差异比对只看「输入字段」；市值/盈亏/权重是派生值，不参与是否修改的判断 */
const POSITION_COMPARE_FIELDS = [
  'name', 'pool', 'shares', 'available_shares', 'cost', 'current_price', 'status', 'stop', 'target', 'note',
] as const;
const SOURCE_NAMES: Record<string, string> = { csv: '东财 CSV', screenshot: '持仓截图', manual: '手动维护' };
const EMPTY_DIFF: HoldingsDiff = { added: [], modified: [], removed: [], unchanged: [] };

/* ===== 当前账本列定义：顺序可自定义、每列可排序 ===== */
interface LedgerCol {
  key: LedgerColKey;
  label: string;
  numeric: boolean;
  html: (p: HoldingPosition, m: PositionMetrics) => string;
  sortValue: (p: HoldingPosition, m: PositionMetrics) => number | string | null;
}
const ledgerNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const ledgerStr = (v: unknown): string => (v === null || v === undefined || v === '') ? '' : String(v);

const LEDGER_COLS: Record<LedgerColKey, LedgerCol> = {
  code: { key: 'code', label: '代码', numeric: false, html: (p) => `<span class="holding-code">${escapeHtml(p.code)}</span>`, sortValue: (p) => ledgerStr(p.code) },
  name: { key: 'name', label: '名称', numeric: false, html: (p) => escapeHtml(p.name || '—'), sortValue: (p) => ledgerStr(p.name) },
  pool: { key: 'pool', label: '池', numeric: false, html: (p) => escapeHtml(p.pool || '—'), sortValue: (p) => ledgerStr(p.pool) },
  shares: { key: 'shares', label: '股数', numeric: true, html: (p) => cellNumber(p.shares), sortValue: (p) => ledgerNum(p.shares) },
  available_shares: { key: 'available_shares', label: '可用', numeric: true, html: (p) => cellNumber(p.available_shares), sortValue: (p) => ledgerNum(p.available_shares) },
  cost: { key: 'cost', label: '成本', numeric: true, html: (p) => cellNumber(p.cost), sortValue: (p) => ledgerNum(p.cost) },
  current_price: { key: 'current_price', label: '现价', numeric: true, html: (p) => cellNumber(p.current_price), sortValue: (p) => ledgerNum(p.current_price) },
  market_value: { key: 'market_value', label: '市值', numeric: true, html: (_p, m) => moneyCell(m.market_value), sortValue: (_p, m) => m.market_value },
  pnl: { key: 'pnl', label: '持仓盈亏', numeric: true, html: (_p, m) => signedCell(m.pnl), sortValue: (_p, m) => m.pnl },
  pnl_pct: { key: 'pnl_pct', label: '盈亏率', numeric: true, html: (_p, m) => signedCell(m.pnl_pct, 3, '%'), sortValue: (_p, m) => m.pnl_pct },
  weight_pct: { key: 'weight_pct', label: '权重', numeric: true, html: (_p, m) => weightCell(m.weight_pct), sortValue: (_p, m) => m.weight_pct },
  status: { key: 'status', label: '状态', numeric: false, html: (p) => `<span class="holding-status">${escapeHtml(p.status || '未标记')}</span>`, sortValue: (p) => ledgerStr(p.status) },
  note: { key: 'note', label: '备注', numeric: false, html: (p) => `<span class="holding-note" title="${escapeHtml(p.note || '')}">${escapeHtml(p.note || '—')}</span>`, sortValue: (p) => ledgerStr(p.note) },
};

/* ------------------------------------------------------------------ *
 * 持仓计算口径（必须与后端 lib/index.js 的 recalcPositions 完全一致）
 *   市值   = 股数 × 现价
 *   盈亏   = 股数 × (现价 − 成本)
 *   盈亏率 = (现价 − 成本) / 成本 × 100
 *   权重   = 市值 / 账户总资产 × 100
 * 任一项缺失 → 对应计算值为 null，界面显示「—」
 * ------------------------------------------------------------------ */
export interface PositionMetrics {
  market_value: number | null;
  pnl: number | null;
  pnl_pct: number | null;
  weight_pct: number | null;
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function computeMetrics(position: HoldingPosition, totalAsset: number | null): PositionMetrics {
  const shares = numeric(position.shares);
  const cost = numeric(position.cost);
  const price = numeric(position.current_price);
  const marketValue = shares !== null && price !== null ? roundTo(shares * price, 2) : null;
  const pnl = shares !== null && price !== null && cost !== null ? roundTo(shares * (price - cost), 2) : null;
  const pnlPct = price !== null && cost !== null && cost > 0 ? roundTo(((price - cost) / cost) * 100, 3) : null;
  const weightPct = marketValue !== null && totalAsset !== null && totalAsset > 0
    ? roundTo((marketValue / totalAsset) * 100, 2) : null;
  return { market_value: marketValue, pnl, pnl_pct: pnlPct, weight_pct: weightPct };
}

/** 账户总资产：优先账本显式字段，缺失时按 可用资金 + Σ市值 估算 */
export function holdingsTotalAsset(positions: HoldingPosition[], account?: HoldingsAccount | null): number | null {
  const explicit = numeric(account?.total_asset ?? account?.totalAsset);
  if (explicit !== null && explicit > 0) return explicit;
  const cash = numeric(account?.cash ?? account?.available_cash ?? account?.availableCash);
  if (cash === null) return null;
  const marketSum = positions.reduce((sum, p) => sum + (computeMetrics(p, null).market_value ?? 0), 0);
  const total = cash + marketSum;
  return total > 0 ? total : null;
}

const MONEY_FMT = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PCT_FMT = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

function moneyCell(value: number | null): string {
  return value === null ? '<span class="metric-empty">—</span>' : escapeHtml(MONEY_FMT.format(value));
}
function cellNumber(value: unknown): string {
  return numeric(value) === null ? '<span class="metric-empty">—</span>' : escapeHtml(String(value).trim());
}
function signedCell(value: number | null, digits = 2, suffix = ''): string {
  if (value === null) return '<span class="metric-empty">—</span>';
  const tone = value > 0 ? 'pnl-up' : value < 0 ? 'pnl-down' : 'pnl-flat';
  const formatted = digits === 3 ? PCT_FMT.format(value) : MONEY_FMT.format(value);
  return `<span class="${tone}">${escapeHtml(`${value > 0 ? '+' : ''}${formatted}${suffix}`)}</span>`;
}
function weightCell(value: number | null): string {
  if (value === null) return '<span class="metric-empty">—</span>';
  const width = Math.max(0, Math.min(100, value));
  return `<div class="weight-cell"><strong>${escapeHtml(value.toFixed(2))}%</strong><span class="weight-bar"><i style="width:${width}%"></i></span></div>`;
}
function quotesButton(state: AppState, hasPositions: boolean): string {
  const disabled = state.holdingsQuotesLoading || Boolean(state.holdingsImporting) || state.holdingsConfirming || !hasPositions;
  return `<button class="button button-secondary" data-action="refresh-holdings-quotes" ${disabled ? 'disabled' : ''}>${state.holdingsQuotesLoading ? '<span class="spinner"></span>正在取价' : `${icon('refresh', 14)}一键刷新现价`}</button>`;
}
function quotesNotice(state: AppState): string {
  return state.holdingsQuotesInfo ? `<p class="quotes-notice">${icon('check', 12)}${escapeHtml(state.holdingsQuotesInfo)}</p>` : '';
}

function codeKey(code: unknown): string {
  return String(code ?? '').trim().toUpperCase();
}

function comparable(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string' && value.trim() === '') return '';
  const number = Number(value);
  if (Number.isFinite(number) && String(value).trim() !== '') return `number:${number}`;
  return `text:${String(value).trim()}`;
}

function samePosition(a: HoldingPosition, b: HoldingPosition): boolean {
  return POSITION_COMPARE_FIELDS.every((field) => comparable(a[field]) === comparable(b[field]));
}

export function calculateHoldingsDiff(current: HoldingPosition[], positions: HoldingPosition[]): HoldingsDiff {
  const before = new Map(current.map((position) => [codeKey(position.code), position]));
  const after = new Map(positions.map((position) => [codeKey(position.code), position]));
  const diff: HoldingsDiff = { added: [], modified: [], removed: [], unchanged: [] };
  positions.forEach((position) => {
    const previous = before.get(codeKey(position.code));
    if (!previous) diff.added.push(position);
    else if (samePosition(previous, position)) diff.unchanged.push(position);
    else diff.modified.push(position);
  });
  current.forEach((position) => {
    if (!after.has(codeKey(position.code))) diff.removed.push(position);
  });
  return diff;
}

function draftDiff(state: AppState): HoldingsDiff {
  if (!state.holdingsDraft) return EMPTY_DIFF;
  if (state.holdings && Array.isArray(state.holdings.positions)) {
    return calculateHoldingsDiff(state.holdings.positions, state.holdingsDraft.positions || []);
  }
  return state.holdingsDraft.diff || EMPTY_DIFF;
}

export function validateHoldingsDraft(draft: HoldingsDraftResponse): string[] {
  const errors: string[] = [];
  const seen = new Map<string, number>();
  (draft.positions || []).forEach((position, index) => {
    const row = index + 1;
    const code = codeKey(position.code);
    if (!code) errors.push(`第 ${row} 行缺少证券代码`);
    else if (seen.has(code)) errors.push(`第 ${seen.get(code)} 行与第 ${row} 行代码重复：${code}`);
    else seen.set(code, row);
    for (const [field, label] of [
      ['shares', '股数'], ['cost', '成本'], ['available_shares', '可用数量'], ['current_price', '现价'],
    ] as const) {
      const value = position[field];
      if (value === undefined || value === null || String(value).trim() === '') continue;
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) errors.push(`第 ${row} 行${label}需为不小于 0 的数字`);
    }
  });
  return Array.from(new Set(errors));
}

/** 确认写入前：规范化输入字段，并按统一口径重算市值/盈亏/权重 */
export function positionsForConfirm(positions: HoldingPosition[], account?: HoldingsAccount | null): HoldingPosition[] {
  const totalAsset = holdingsTotalAsset(positions, account);
  return positions.map((source) => {
    const metrics = computeMetrics(source, totalAsset);
    const position: HoldingPosition = {
      ...source,
      code: String(source.code ?? '').trim(),
      name: String(source.name ?? '').trim(),
      pool: String(source.pool ?? '').trim(),
      status: String(source.status ?? '').trim(),
      note: String(source.note ?? '').trim(),
    };
    for (const field of ['shares', 'cost', 'available_shares', 'current_price'] as const) {
      const value = source[field];
      if (value === undefined || value === null || String(value).trim() === '') delete position[field];
      else position[field] = Number(value);
    }
    for (const field of ['market_value', 'pnl', 'pnl_pct', 'weight_pct'] as const) {
      const value = metrics[field];
      if (value === null) delete position[field];
      else position[field] = value;
    }
    return position;
  });
}

/** Read raw bytes only. In particular, never use TextDecoder for GB18030 CSV files. */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

// 模型对单张图片的输入体积有实际上限：约 0.5MB 以上的手机截图会识别失败。
// 上传前在浏览器内缩放到长边不超过 1600px，并压缩为 JPEG，文字足以识别持仓表格。
const SCREENSHOT_TARGET_BYTES = 350 * 1024;
const SCREENSHOT_MAX_SIDE = 1600;

export interface PreparedScreenshot {
  base64: string;
  mimeType: string;
  compressed: boolean;
  originalBytes: number;
  finalBytes: number;
}

export async function prepareScreenshotForUpload(file: File): Promise<PreparedScreenshot> {
  if (file.size <= SCREENSHOT_TARGET_BYTES) {
    return { base64: await fileToBase64(file), mimeType: file.type, compressed: false, originalBytes: file.size, finalBytes: file.size };
  }
  const bitmap = await createImageBitmap(file);
  try {
    let scale = Math.min(1, SCREENSHOT_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    let best: Blob | null = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) break;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
      if (blob && (!best || blob.size < best.size)) best = blob;
      if (blob && blob.size <= SCREENSHOT_TARGET_BYTES) break;
      scale *= 0.8;
    }
    if (!best) return { base64: await fileToBase64(file), mimeType: file.type, compressed: false, originalBytes: file.size, finalBytes: file.size };
    return { base64: await fileToBase64(best), mimeType: 'image/jpeg', compressed: true, originalBytes: file.size, finalBytes: best.size };
  } finally {
    bitmap.close();
  }
}

function sourceName(source: string): string {
  return SOURCE_NAMES[source] || source || '未知来源';
}

function accountValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  const number = Number(value);
  return Number.isFinite(number) ? formatNumber(number) : String(value);
}

function estimatedTotal(state: AppState): number | null {
  const account = state.holdings?.account || {};
  const cash = Number(account.available_cash ?? account.cash ?? account.availableCash);
  if (!Number.isFinite(cash)) return null;
  const cost = (state.holdings?.positions || []).reduce((sum, position) => {
    const shares = Number(position.shares), price = Number(position.cost);
    return Number.isFinite(shares) && Number.isFinite(price) ? sum + shares * price : sum;
  }, 0);
  return cash + cost;
}

function currentSummary(state: AppState): string {
  const positions = state.holdings?.positions || [];
  const account = state.holdings?.account || {};
  const totalAsset = holdingsTotalAsset(positions, account);
  const hasMetrics = positions.some((p) => computeMetrics(p, totalAsset).market_value !== null);
  const marketSum = positions.reduce((sum, p) => sum + (computeMetrics(p, totalAsset).market_value ?? 0), 0);
  const pnlSum = positions.reduce((sum, p) => sum + (computeMetrics(p, totalAsset).pnl ?? 0), 0);
  return `<section class="holdings-summary">
    <article><span>账户总资产</span><strong>${escapeHtml(accountValue(account.total_asset ?? account.totalAsset ?? estimatedTotal(state)))}</strong><small>权重分母；未记录时按现金+持仓市值估算</small></article>
    <article><span>可用资金</span><strong>${escapeHtml(accountValue(account.available_cash ?? account.cash ?? account.availableCash))}</strong><small>确认草稿后随账户更新</small></article>
    <article><span>当前持仓</span><strong>${formatNumber(positions.length)}<em>只</em></strong><small>更新于 ${formatDateTime(state.holdings?.updated_at, true)}</small></article>
    <article><span>持仓市值</span><strong>${hasMetrics ? escapeHtml(MONEY_FMT.format(marketSum)) : '—'}</strong><small>Σ 股数 × 现价</small></article>
    <article><span>累计持仓盈亏</span><strong>${hasMetrics ? signedCell(pnlSum) : '—'}</strong><small>Σ 股数 × (现价 − 成本)</small></article>
  </section>`;
}

function currentLedger(state: AppState): string {
  if (state.holdingsLoading && !state.holdings) return '<section class="panel"><div class="skeleton holdings-ledger-skeleton"></div></section>';
  if (!state.holdings) return errorState('持仓账本读取失败', state.holdingsError || '请检查持仓接口后重试。');
  const positions = state.holdings.positions || [];
  const totalAsset = holdingsTotalAsset(positions, state.holdings.account);
  const cols = (state.ledgerColumns || LEDGER_DEFAULT_COLUMNS)
    .map((key) => LEDGER_COLS[key])
    .filter((col): col is LedgerCol => Boolean(col));
  const sort = state.ledgerSort;

  // 排序：空值沉底；数值列按数值、文本列按本地化字符串；三态（升 → 降 → 原顺序）
  const indexed = positions.map((p, i) => ({ p, m: computeMetrics(p, totalAsset), i }));
  if (sort && LEDGER_COLS[sort.key]) {
    const valueOf = LEDGER_COLS[sort.key].sortValue;
    indexed.sort((a, b) => {
      const av = valueOf(a.p, a.m), bv = valueOf(b.p, b.m);
      if (av === null && bv === null) return a.i - b.i;
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = (typeof av === 'number' && typeof bv === 'number')
        ? av - bv : String(av).localeCompare(String(bv), 'zh-CN');
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }
  const rows = indexed.map(({ p, m }) => `<tr>${cols.map((c) => `<td class="${c.numeric ? 'numeric' : ''}">${c.html(p, m)}</td>`).join('')}<td class="table-action"><button class="icon-button small" data-action="edit-holdings" data-code="${escapeHtml(p.code)}" aria-label="编辑 ${escapeHtml(p.name || p.code)}">${icon('edit', 14)}</button></td></tr>`).join('');
  const head = cols.map((c) => {
    const active = sort?.key === c.key;
    const mark = active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕';
    return `<th class="sortable-th${active ? ' sorted' : ''}"><button class="th-sort" data-action="ledger-sort" data-key="${c.key}" title="点击按「${escapeHtml(c.label)}」排序：从小到大 → 从大到小 → 恢复原顺序">${escapeHtml(c.label)}<span class="sort-mark">${mark}</span></button></th>`;
  }).join('');

  // 列顺序设置：← → 调整先后，偏好存 localStorage
  const colSettings = `<details class="ledger-col-settings" data-field="ledger-cols"><summary>${icon('layers', 14)} 列顺序</summary>
    <div class="ledger-col-panel"><p class="field-help">用 ← → 调整列的先后展示顺序；顺序与排序偏好保存在本机浏览器。</p>
      <div class="ledger-col-list">${cols.map((c, idx) => `<div class="ledger-col-item"><span>${escapeHtml(c.label)}</span><span class="ledger-col-btns"><button class="icon-button small" data-action="ledger-col-move" data-key="${c.key}" data-dir="-1" ${idx === 0 ? 'disabled' : ''} aria-label="上移${escapeHtml(c.label)}">←</button><button class="icon-button small" data-action="ledger-col-move" data-key="${c.key}" data-dir="1" ${idx === cols.length - 1 ? 'disabled' : ''} aria-label="下移${escapeHtml(c.label)}">→</button></span></div>`).join('')}</div>
      <button class="text-button" data-action="ledger-col-reset">${icon('refresh', 13)}恢复默认顺序</button></div></details>`;
  const headingActions = `<div class="ledger-actions">${colSettings}${quotesButton(state, positions.length > 0)}<button class="button button-secondary" data-action="edit-holdings" ${state.holdingsImporting ? 'disabled' : ''}>${icon('edit', 14)}编辑现有表格</button></div>`;
  const sortHint = sort ? `<div class="ledger-sort-hint">当前排序：${escapeHtml(LEDGER_COLS[sort.key]?.label || sort.key)} ${sort.dir === 'asc' ? '从小到大 ↑' : '从大到小 ↓'} · 再点一次表头切换方向，第三次恢复账本原顺序</div>` : '';
  return `<section class="panel current-ledger">${sectionHeading('当前账本', '已生效数据；列顺序与排序可自定义，市值／盈亏／权重按 成本·股数·现价 自动重算', headingActions)}
     ${state.holdingsError ? `<div class="inline-warning">${icon('alert', 15)}刷新失败，当前为上次读取的数据：${escapeHtml(state.holdingsError)}</div>` : ''}
     ${quotesNotice(state)}
     ${positions.length ? `${sortHint}<div class="table-scroll"><table class="data-table holdings-table"><thead><tr>${head}<th></th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('账本暂无持仓', '可从下方四种来源生成第一份草稿，确认后写入账本。', 'wallet')}
   </section>`;
}

function manualPositionCard(state: AppState): string {
  const draft = state.manualPosition;
  const disabled = Boolean(state.holdingsImporting) || !state.holdings;
  const field = (key: keyof typeof draft, label: string, placeholder: string, inputmode = '') => `<label><span>${label}</span><input data-field="manual-${key}" data-manual-field="${key}" value="${escapeHtml(draft[key])}" placeholder="${escapeHtml(placeholder)}" ${inputmode ? `inputmode="${inputmode}"` : ''} ${disabled ? 'disabled' : ''} data-ime-input="true" lang="zh-CN" autocomplete="off" /></label>`;
  return `<article class="source-card manual-add-card"><div class="source-card-head"><span class="source-icon">${icon('plus', 19)}</span><div><h3>手动新增单条</h3><p>追加到当前账本后生成草稿，不会直接写入。</p></div></div>
     <div class="manual-position-form">
       ${field('code', '代码 *', '如 600519.SH')}
       ${field('name', '名称', '如 贵州茅台')}
       ${field('shares', '股数', '如 100', 'decimal')}
       ${field('available_shares', '可用数量', '如 100', 'decimal')}
       ${field('cost', '成本', '如 1680.50', 'decimal')}
       ${field('current_price', '现价', '如 1700.00', 'decimal')}
       ${field('status', '状态', '如 持有')}
       ${field('note', '备注', '选填，如 场内基金')}
     </div>
     <button class="button button-secondary" data-action="add-manual-position" ${disabled ? 'disabled' : ''}>${state.holdingsImporting === 'manual' ? '<span class="spinner"></span>正在生成草稿' : `${icon('arrow', 14)}生成差异草稿`}</button>
     ${!state.holdings ? '<p class="field-help">需先读取当前账本，避免误删已有持仓。</p>' : ''}
   </article>`;
}

function analysisJobsActive(state: AppState): boolean {
  return state.jobs.some((job) => job.status === 'queued' || job.status === 'running');
}

function importSources(state: AppState): string {
  const busy = Boolean(state.holdingsImporting) || state.holdingsDraftLoading;
  const analysisBusy = analysisJobsActive(state);
  return `<section class="settings-section holdings-sources">${sectionHeading('生成持仓草稿', '四种来源统一经过差异预览与人工确认；没有“直接导入并覆盖”入口')}
     ${state.holdingsActionError ? `<div class="inline-error">${icon('alert', 16)}<div><strong>草稿操作失败</strong><p>${escapeHtml(state.holdingsActionError)}</p></div></div>` : ''}
     <div class="source-grid">
       <article class="source-card"><div class="source-card-head"><span class="source-icon">${icon('image', 19)}</span><div><h3>截图上传</h3><p>支持 PNG / JPEG / WebP，提交后由后端识别。</p></div></div>
         ${analysisBusy ? `<div class="inline-warning">${icon('alert', 15)}分析任务进行中，模型暂不可用，请稍后再导入截图</div>` : ''}
         <label class="button button-secondary source-upload ${busy || analysisBusy ? 'is-disabled' : ''}">${state.holdingsImporting === 'screenshot' ? '<span class="spinner"></span>正在识别' : `${icon('upload', 14)}选择持仓截图`}<input type="file" data-holdings-file="screenshot" accept="image/png,image/jpeg,image/webp" ${busy || analysisBusy ? 'disabled' : ''} hidden /></label>
         <p class="field-help">识别可能需要 1–2 分钟，请勿重复提交；原图不留档，失败会显示后端具体原因。</p></article>
       <article class="source-card"><div class="source-card-head"><span class="source-icon">${icon('file', 19)}</span><div><h3>东财 CSV 上传</h3><p>上传交割单，后端按 GB18030 字节内容解析。</p></div></div>
         <label class="button button-secondary source-upload ${busy ? 'is-disabled' : ''}">${state.holdingsImporting === 'csv' ? '<span class="spinner"></span>正在解析' : `${icon('upload', 14)}选择东财 CSV`}<input type="file" data-holdings-file="csv" accept=".csv,text/csv" ${busy ? 'disabled' : ''} hidden /></label>
         <p class="field-help">浏览器只执行 arrayBuffer → base64，不做默认文本解码；成本价为估算，确认页可修改。</p></article>
       <article class="source-card"><div class="source-card-head"><span class="source-icon">${icon('edit', 19)}</span><div><h3>手动编辑现有表格</h3><p>复制当前账本为草稿，再逐行调整或删除。</p></div></div>
         <button class="button button-secondary" data-action="edit-holdings" ${busy || !state.holdings ? 'disabled' : ''}>${state.holdingsImporting === 'manual' ? '<span class="spinner"></span>正在生成草稿' : `${icon('edit', 14)}从当前账本新建草稿`}</button>
         <p class="field-help">编辑过程不影响已生效账本，可整单放弃。</p></article>
       ${manualPositionCard(state)}
     </div></section>`;
}

function draftStatus(position: HoldingPosition, diff: HoldingsDiff): { label: string; tone: string } {
  const code = codeKey(position.code);
  if (diff.added.some((item) => codeKey(item.code) === code)) return { label: '新增', tone: 'added' };
  if (diff.modified.some((item) => codeKey(item.code) === code)) return { label: '修改', tone: 'modified' };
  return { label: '不变', tone: 'unchanged' };
}

type DraftInputKey = 'code' | 'name' | 'shares' | 'available_shares' | 'cost' | 'current_price' | 'status' | 'note';

function editablePositionRow(position: HoldingPosition, index: number, diff: HoldingsDiff, totalAsset: number | null): string {
  const status = draftStatus(position, diff);
  const m = computeMetrics(position, totalAsset);
  const field = (key: DraftInputKey, label: string, numericInput = false) => `<label class="draft-cell"><span class="mobile-cell-label">${label}</span><input data-field="draft-${index}-${key}" data-position-index="${index}" data-position-field="${key}" value="${escapeHtml(position[key] ?? '')}" aria-label="第 ${index + 1} 行${label}" ${numericInput ? 'inputmode="decimal"' : ''} data-ime-input="true" lang="zh-CN" autocomplete="off" /></label>`;
  const computed = (content: string) => `<td class="draft-computed">${content}</td>`;
  return `<tr class="draft-${status.tone}">
     <td><span class="diff-tag ${status.tone}">${status.label}</span></td>
     <td>${field('code', '代码')}</td><td>${field('name', '名称')}</td>
     <td>${field('shares', '股数', true)}</td><td>${field('available_shares', '可用', true)}</td>
     <td>${field('cost', '成本', true)}</td><td>${field('current_price', '现价', true)}</td>
     ${computed(moneyCell(m.market_value))}
     ${computed(signedCell(m.pnl))}
     ${computed(signedCell(m.pnl_pct, 3, '%'))}
     ${computed(weightCell(m.weight_pct))}
     <td>${field('status', '状态')}</td><td>${field('note', '备注')}</td>
     <td class="table-action"><button class="icon-button small danger-icon" data-action="delete-draft-position" data-index="${index}" aria-label="删除第 ${index + 1} 行" title="从草稿删除，可在下方恢复">${icon('trash', 14)}</button></td>
   </tr>`;
}

function accountEditor(account: HoldingsAccount | undefined, disabled: boolean): string {
  const value = (key: 'total_asset' | 'available_cash') => account?.[key] === undefined ? '' : String(account[key]);
  return `<section class="draft-account"><div><h3>账户信息</h3><p>总资产是权重的分母；账户字段只随本次确认一并写入。</p></div>
     <label><span>总资产</span><input data-field="draft-account-total" data-account-field="total_asset" value="${escapeHtml(value('total_asset'))}" inputmode="decimal" ${disabled ? 'disabled' : ''} /></label>
     <label><span>可用资金</span><input data-field="draft-account-cash" data-account-field="available_cash" value="${escapeHtml(value('available_cash'))}" inputmode="decimal" ${disabled ? 'disabled' : ''} /></label>
   </section>`;
}

function removedPositions(diff: HoldingsDiff): string {
  if (!diff.removed.length) return '';
  return `<section class="removed-positions"><div><h3>确认后将删除 ${diff.removed.length} 条</h3><p>如属误删，可恢复回草稿继续编辑。</p></div>
     <div class="removed-list">${diff.removed.map((position) => `<div><span><strong>${escapeHtml(position.name || position.code)}</strong><small>${escapeHtml(position.code)} · ${position.shares === undefined ? '股数未填' : `${formatNumber(position.shares)} 股`}</small></span><button class="text-button" data-action="restore-draft-position" data-code="${escapeHtml(position.code)}">${icon('refresh', 13)}恢复</button></div>`).join('')}</div>
   </section>`;
}

function draftReview(state: AppState): string {
  const draft = state.holdingsDraft!;
  const diff = draftDiff(state);
  const errors = validateHoldingsDraft(draft);
  const totalAsset = holdingsTotalAsset(draft.positions || [], draft.account);
  const warnings = Array.from(new Set([
    ...(draft.warnings || []),
    ...(draft.source === 'csv' ? ['CSV 成本价为估算值，请逐条核对；可在下方直接修改。'] : []),
    ...(draft.source === 'screenshot' ? ['截图识别可能存在误差，请重点核对代码、股数与成本。'] : []),
  ]));
  const hasRows = (draft.positions || []).length > 0;
  const rows = (draft.positions || []).map((position, index) => editablePositionRow(position, index, diff, totalAsset)).join('');
  return `<section class="panel draft-panel">
     <div class="draft-topline"><div><span class="eyebrow">DRAFT REVIEW</span><h2>差异预览与人工确认</h2><p>来源：${escapeHtml(sourceName(draft.source))}${draft.engine === 'local-ocr' ? '<span class="engine-tag">本地 OCR</span>' : draft.engine === 'vision' ? '<span class="engine-tag vision">视觉模型</span>' : ''} · 草稿 <span class="mono">${escapeHtml(draft.draftId)}</span></p></div>
       <div class="draft-actions"><button class="text-button" data-action="reload-holdings-draft" ${state.holdingsDraftLoading || state.holdingsConfirming ? 'disabled' : ''}>${icon('refresh', 13)}恢复服务器草稿</button><button class="button button-secondary" data-action="discard-holdings-draft" ${state.holdingsConfirming ? 'disabled' : ''}>${icon('close', 14)}放弃整单</button></div></div>
     <ol class="holdings-steps"><li class="done"><i>${icon('check', 12)}</i><span>生成草稿</span></li><li class="active"><i>2</i><span>差异预览与编辑</span></li><li><i>3</i><span>人工确认</span></li><li><i>4</i><span>写入账本</span></li></ol>
     <div class="diff-summary"><article class="added"><span>新增</span><strong>${diff.added.length}</strong><small>确认后写入</small></article><article class="modified"><span>修改</span><strong>${diff.modified.length}</strong><small>以草稿内容替换</small></article><article class="removed"><span>删除</span><strong>${diff.removed.length}</strong><small>从账本中移除</small></article><article><span>不变</span><strong>${diff.unchanged.length}</strong><small>保持现有记录</small></article></div>
     ${warnings.length ? `<div class="draft-warnings"><strong>${icon('alert', 15)}核对提醒</strong><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></div>` : ''}
     ${errors.length ? `<div class="draft-errors"><strong>${icon('alert', 15)}请先修正 ${errors.length} 项问题</strong><ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul></div>` : ''}
     ${state.holdingsActionError ? `<div class="inline-error">${icon('alert', 16)}<div><strong>账本写入失败</strong><p>${escapeHtml(state.holdingsActionError)}</p></div></div>` : ''}
     ${accountEditor(draft.account, state.holdingsConfirming)}
     <div class="draft-table-heading"><div><h3>确认后的持仓明细</h3><p>成本／股数／现价可编辑；市值、盈亏、权重随之自动重算。</p>${quotesNotice(state)}</div>
       <div class="draft-heading-actions">${quotesButton(state, hasRows)}<button class="button button-secondary" data-action="add-draft-row" ${state.holdingsConfirming ? 'disabled' : ''}>${icon('plus', 14)}新增一行</button></div></div>
     ${rows ? `<div class="table-scroll draft-table-scroll"><table class="data-table draft-table"><thead><tr><th>差异</th><th>代码 *</th><th>名称</th><th>股数</th><th>可用</th><th>成本</th><th>现价</th><th>市值</th><th>持仓盈亏</th><th>盈亏率</th><th>权重</th><th>状态</th><th>备注</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('草稿中没有持仓', '可新增一行，或确认空草稿以删除当前账本中的全部持仓。', 'empty')}
     ${removedPositions(diff)}
     <div class="confirm-bar"><div><strong>${errors.length ? '修正错误后才能确认' : '请再次核对代码、股数与成本'}</strong><span>仅在点击“确认并写入账本”后提交；原账本仍保持不变。</span></div>
       <button class="button button-primary" data-action="confirm-holdings" ${errors.length || state.holdingsConfirming ? 'disabled' : ''}>${state.holdingsConfirming ? '<span class="spinner"></span>正在写入' : `${icon('check', 15)}确认并写入账本`}</button></div>
   </section>`;
}

export function renderHoldings(state: AppState): string {
  const header = pageHeader('持仓工作区', '集中维护账户与持仓；市值／盈亏／权重按 成本·股数·现价 自动重算，权重＝市值÷账户总资产。所有来源都经过草稿、差异预览、人工确认后才写入。', `<button class="button button-secondary" data-action="refresh-holdings" ${state.holdingsLoading || state.holdingsConfirming ? 'disabled' : ''}>${icon('refresh', 14)}刷新账本</button>`);
  if (state.holdingsDraftLoading && !state.holdingsDraft) return header + skeletonPage();
  if (state.holdingsDraft) return header + draftReview(state);
  return header + currentSummary(state) + currentLedger(state) + importSources(state);
}
