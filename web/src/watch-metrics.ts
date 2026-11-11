// 标的档案距离口径（概览面板 / 档案监控卡片 / 实时持仓栏共用）
// 语义：正值 = 尚有空间。持有标的按「相对现价的百分点」计算；观察标的按买区下沿计算。
import type { WatchAlert, WatchlistItem } from './types';

export type WatchDistMode = 'target' | 'stop';

/** 买入类提醒（用计划买入股数）；其余为持有类提醒（用持仓股数） */
const BUY_KINDS = new Set(['buy', 'invalidate']);

/**
 * 提醒的购买仓位数。
 * v0.27.0 之后触发的提醒自带 qty；更早的历史提醒没有该字段，
 * 这里按「当前档案」的持仓 / 计划仓位补一个展示值（调用方需标注「当前」以免误读为触发时仓位）。
 */
export function alertQty(alert: WatchAlert, items: WatchlistItem[]): number | null {
  if (typeof alert.qty === 'number' && Number.isFinite(alert.qty)) return alert.qty;
  const item = items.find((candidate) => candidate.code === alert.code);
  if (!item) return null;
  const raw = BUY_KINDS.has(alert.kind) ? item.watch?.buy_qty : item.position?.shares;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** 该提醒是否为「历史提醒 + 当前仓位」的补全值（需在界面上标注「当前」） */
export function alertQtyIsCurrent(alert: WatchAlert): boolean {
  return !(typeof alert.qty === 'number' && Number.isFinite(alert.qty));
}

/** 提醒正文：历史提醒缺仓位数时追加「当前持仓 N 股」；新提醒原文已含则不重复 */
export function alertMessageWithQty(alert: WatchAlert, items: WatchlistItem[]): string {
  const message = String(alert.message || '');
  if (/仓位数/.test(message)) return message;
  const qty = alertQty(alert, items);
  if (qty === null) return message;
  return message + (BUY_KINDS.has(alert.kind) ? `（计划买入 ${qty} 股 · 当前档案）` : `（当前持仓 ${qty} 股）`);
}

export const WATCH_DIST_MODES: { id: WatchDistMode; label: string }[] = [
  { id: 'target', label: '距止盈' },
  { id: 'stop', label: '距止损' },
];

const r2 = (n: number): number => Math.round(n * 100) / 100;
const positive = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** 返回距离百分点；缺现价 / 缺阈值 / 非观察持有状态 → null */
export function watchDistance(it: WatchlistItem, mode: WatchDistMode): number | null {
  const price = positive(it.monitor?.current_price);
  if (price === null) return null;
  if (it.state === '观察') {
    const w = it.watch || {};
    const anchor = positive(w.buy_low) ?? positive(w.buy_high);
    return anchor === null ? null : r2(((price - anchor) / anchor) * 100);
  }
  if (it.state === '持有') {
    const level = positive(mode === 'target' ? it.position?.target : it.position?.stop);
    if (level === null) return null;
    return mode === 'target'
      ? r2(((level - price) / price) * 100)   // 还需上涨多少到止盈
      : r2(((price - level) / price) * 100); // 还有多少缓冲到止损
  }
  return null;
}

export function watchDistLabel(it: WatchlistItem, mode: WatchDistMode): string {
  return it.state === '观察' ? '距买点' : (mode === 'target' ? '距止盈' : '距止损');
}

/** 距离口径切换控件（概览面板与档案监控卡片共用同一 state，联动） */
export function watchDistSwitch(mode: WatchDistMode, extraClass = ''): string {
  return '<div class="watch-mode-switch ' + extraClass + '"><span>距离口径</span>'
    + WATCH_DIST_MODES.map((m) => '<button class="watch-mode-btn' + (mode === m.id ? ' active' : '')
      + '" data-action="watch-dist-mode" data-mode="' + m.id + '">' + m.label + '</button>').join('')
    + '</div>';
}
