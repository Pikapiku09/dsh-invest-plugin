import { LEDGER_DEFAULT_COLUMNS } from './types';
import type {
  ConclusionRecord, HoldingsDraftResponse, HoldingsResponse, IndexResponse, Job,
  ModelSettingsResponse, TaskTemplate, WorkbenchView, WatchlistResponse, LedgerColKey, BacktestResponse, ConclusionAuditResponse, WatchDailyStatus,
  StockNoteMeta, StockNoteDetail,
} from './types';
import type { WatchDistMode } from './watch-metrics';

const LEDGER_COL_STORE = 'dsh-invest.ledgerColumns';
const LEDGER_SORT_STORE = 'dsh-invest.ledgerSort';
export const TEMPLATE_ORDER_STORE = 'dsh-invest.templateOrder';
const ASK_THREADS_STORE = 'dsh-invest.askThreads';
const ASK_SUGGESTIONS_STORE = 'dsh-invest.askSuggestions';

/** 追问默认预设（用户可在页面上直接改增删，存 localStorage） */
export const DEFAULT_ASK_SUGGESTIONS = [
  '这份报告的核心结论和主要依据是什么？',
  '如果把结论当成操作建议，具体该在什么条件、什么价位执行？',
  '报告里提到的风险和失效条件有哪些？',
  '哪些关键数据是报告没覆盖、需要补充的？',
];

/** 追问会话持久化：按报告路径分组，限制线程数与单条长度，避免 localStorage 撑爆 */
const ASK_THREAD_MAX = 30;
const ASK_TURN_MAX = 40;
const ASK_TEXT_MAX = 20000;

function readAskThreads(): Record<string, AskTurn[]> {
  try {
    const raw = window.localStorage.getItem(ASK_THREADS_STORE);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, AskTurn[]> = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([path, turns]) => {
      if (!Array.isArray(turns)) return;
      const clean = turns
        .filter((turn): turn is AskTurn => Boolean(turn) && typeof turn === 'object'
          && (turn as AskTurn).role !== undefined && typeof (turn as AskTurn).text === 'string')
        .map((turn) => ({ role: turn.role === 'assistant' ? 'assistant' as const : 'user' as const, text: String(turn.text).slice(0, ASK_TEXT_MAX), ts: Number(turn.ts) || Date.now() }))
        .slice(-ASK_TURN_MAX);
      if (clean.length) out[path] = clean;
    });
    const paths = Object.keys(out);
    if (paths.length > ASK_THREAD_MAX) {
      paths
        .sort((a, b) => (out[a][out[a].length - 1]?.ts || 0) - (out[b][out[b].length - 1]?.ts || 0))
        .slice(0, paths.length - ASK_THREAD_MAX)
        .forEach((path) => { delete out[path]; });
    }
    return out;
  } catch { return {}; }
}

/** 追问会话落盘（每次追加消息后调用）；写入前按线程数/轮数/单条长度收敛，写失败不影响使用 */
export function persistAskThreads(threads: Record<string, AskTurn[]>): void {
  try {
    const picked = Object.keys(threads || {})
      .map((path) => ({ path, turns: (threads[path] || []).slice(-ASK_TURN_MAX) }))
      .filter((item) => item.turns.length > 0)
      .sort((a, b) => (a.turns[a.turns.length - 1]?.ts || 0) - (b.turns[b.turns.length - 1]?.ts || 0))
      .slice(-ASK_THREAD_MAX);
    const out: Record<string, AskTurn[]> = {};
    picked.forEach(({ path, turns }) => {
      out[path] = turns.map((turn) => ({
        role: turn.role === 'assistant' ? 'assistant' : 'user',
        text: String(turn.text || '').slice(0, ASK_TEXT_MAX),
        ts: Number(turn.ts) || Date.now(),
      }));
    });
    window.localStorage.setItem(ASK_THREADS_STORE, JSON.stringify(out));
  } catch { /* 配额或隐私模式：忽略 */ }
}

function readAskSuggestions(): string[] {
  try {
    const raw = window.localStorage.getItem(ASK_SUGGESTIONS_STORE);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim()).slice(0, 12);
      }
    }
  } catch { /* 解析失败回落默认 */ }
  return [...DEFAULT_ASK_SUGGESTIONS];
}

/** 追问预设落盘 */
export function persistAskSuggestions(list: string[]): void {
  try { window.localStorage.setItem(ASK_SUGGESTIONS_STORE, JSON.stringify(list)); } catch { /* ignore */ }
}

/** 读取一键任务模板的自定义排序（模板 id 数组；未知 id 由渲染层忽略） */
function readTemplateOrder(): string[] {
  try {
    const raw = window.localStorage.getItem(TEMPLATE_ORDER_STORE);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

/** 读取用户自定义列顺序；与默认列合并，保证后续新增列不会丢失 */
function readLedgerColumns(): LedgerColKey[] {
  try {
    const raw = window.localStorage.getItem(LEDGER_COL_STORE);
    if (!raw) return [...LEDGER_DEFAULT_COLUMNS];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [...LEDGER_DEFAULT_COLUMNS];
    const valid = arr.filter((k): k is LedgerColKey => LEDGER_DEFAULT_COLUMNS.includes(k));
    return Array.from(new Set([...valid, ...LEDGER_DEFAULT_COLUMNS]));
  } catch { return [...LEDGER_DEFAULT_COLUMNS]; }
}

function readLedgerSort(): { key: LedgerColKey; dir: 'asc' | 'desc' } | null {
  try {
    const raw = window.localStorage.getItem(LEDGER_SORT_STORE);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !LEDGER_DEFAULT_COLUMNS.includes(o.key) || (o.dir !== 'asc' && o.dir !== 'desc')) return null;
    return { key: o.key, dir: o.dir };
  } catch { return null; }
}

export interface AskTurn { role: 'user' | 'assistant'; text: string; ts: number }
export interface TaskDraft { code: string; question: string; name?: string; resolvedCode?: string; }
export interface ManualPositionDraft {
  code: string;
  name: string;
  shares: string;
  cost: string;
  available_shares: string;
  current_price: string;
  status: string;
  note: string;
}

export const emptyManualPosition = (): ManualPositionDraft => ({
  code: '', name: '', shares: '', cost: '', available_shares: '', current_price: '', status: '持有', note: '',
});

export interface AppState {
  view: WorkbenchView;
  index: IndexResponse | null;
  holdings: HoldingsResponse | null;
  templates: TaskTemplate[];
  jobs: Job[];
  /** 后端任务并发信息：并发上限 / 运行中 / 排队中 */
  jobsMeta: { concurrency: number; running: number; queued: number };
  indexLoading: boolean;
  holdingsLoading: boolean;
  templatesLoading: boolean;
  jobsLoading: boolean;
  indexError: string;
  holdingsError: string;
  templatesError: string;
  jobsError: string;
  selectedCode: string | null;
  archiveQuery: string;
  archiveRecords: ConclusionRecord[];
  archiveLoading: boolean;
  archiveError: string;
  archiveNotice: string;
  runQuery: string;
  runStatus: 'all' | 'success' | 'failed';
  runMode: string;
  /** 报告追问：报告列表搜索词、每只股票的对话线程 */
  askQuery: string;
  askThreads: Record<string, AskTurn[]>;
  /** 当前输入框草稿（重渲染不丢） */
  askDraft: string;
  askLoading: boolean;
  askError: string;
  /** 追问预设提问（可编辑，localStorage 持久化） */
  askSuggestions: string[];
  /** 预设编辑面板是否展开 */
  askSuggestionsEditing: boolean;
  // ===== 个股知识库：按股票归集 + 二次整理，追问直接对着知识库 =====
  /** 有归集内容的个股清单（含段数、整理状态、未并入段数） */
  askStocks: StockNoteMeta[];
  askStocksBuiltAt: string;
  askStocksLoading: boolean;
  askStocksError: string;
  /** 当前选中的个股代码 */
  askStock: string;
  /** 当前个股的知识库详情（整理稿 + 原始记录摘要） */
  askNote: StockNoteDetail | null;
  askNoteLoading: boolean;
  askNoteError: string;
  /** 折叠的首字母分组（默认全展开） */
  askLetterCollapsed: Record<string, boolean>;
  /** 运行记录页：隐藏「报告归档」回填条目，只看真实运行日志 */
  runHideBackfill: boolean;
  /** 判断质量回测（v0.44.0） */
  backtest: BacktestResponse | null;
  backtestLoading: boolean;
  backtestError: string;
  /** 结论采集审计：数据从哪来、有没有漏 */
  audit: ConclusionAuditResponse | null;
  auditLoading: boolean;
  auditError: string;
  backfillRunning: boolean;
  taskDrafts: Record<string, TaskDraft>;
  /** 一键任务模板的自定义排序（模板 id 数组；localStorage 持久化） */
  templateOrder: string[];
  startingTemplates: Record<string, boolean>;
  sidebarOpen: boolean;
  modelSettings: ModelSettingsResponse | null;
  modelSettingsLoading: boolean;
  modelSettingsSaving: boolean;
  modelSettingsError: string;
  modelRoleRoutes: Record<string, string>;
  modelTemplatePresets: Record<string, string>;
  /** 宿主模型选择器草稿：'inherit' = 跟随会话宿主；其余为 provider/model（保存前） */
  modelHostDraft: string;
  /** 知识库整理模型草稿（保存前） */
  modelStockKbDraft: string;
  /** 知识库「后台自动整理」草稿（null = 未改过） */
  modelStockKbAutoDraft: boolean | null;
  /** 知识库整理并发数草稿（null = 未改过） */
  modelStockKbConcurrencyDraft: number | null;
  holdingsDraft: HoldingsDraftResponse | null;
  holdingsDraftLoading: boolean;
  holdingsImporting: string;
  holdingsConfirming: boolean;
  /** 「一键刷新现价」请求进行中 */
  holdingsQuotesLoading: boolean;
  /** 右上角「刷新数据」进行中：驱动「刷新中」旋转器并禁止重复触发 */
  refreshing: boolean;
  /** 上一次成功刷新数据的时间（ISO，localStorage 持久化） */
  lastRefreshAt: string;
  /** 最近一次刷新的行情时间与来源，用于页面提示 */
  holdingsQuotesInfo: string;
  holdingsActionError: string;
  manualPosition: ManualPositionDraft;
  // ===== 标的档案（观察 + 持仓统一监控）=====
  watchlist: WatchlistResponse | null;
  watchlistLoading: boolean;
  watchlistRefreshing: boolean;
  watchlistSaving: boolean;
  watchlistError: string;
  /** 档案页监控卡片编辑表单是否展开 */
  watchEditOpen: boolean;
  /** 距离口径：target=距止盈(目标价) / stop=距止损，默认止盈 */
  watchDistMode: WatchDistMode;
  // ===== 观察仓日检（每日自动）=====
  watchDaily: WatchDailyStatus | null;
  watchDailyLoading: boolean;
  watchDailySaving: boolean;
  watchDailyRunning: boolean;
  // ===== 持仓工作区「当前账本」表格偏好（localStorage 持久化）=====
  ledgerColumns: LedgerColKey[];
  ledgerSort: { key: LedgerColKey; dir: 'asc' | 'desc' } | null;
}

export const state: AppState = {
  view: 'overview', index: null, holdings: null, templates: [], jobs: [],
  jobsMeta: { concurrency: 0, running: 0, queued: 0 },
  indexLoading: true, holdingsLoading: true, templatesLoading: false, jobsLoading: false,
  indexError: '', holdingsError: '', templatesError: '', jobsError: '',
  selectedCode: null, archiveQuery: '', archiveRecords: [], archiveLoading: false,
  archiveError: '', archiveNotice: '', runQuery: '', runStatus: 'all', runMode: 'all', runHideBackfill: false,
  backtest: null, backtestLoading: false, backtestError: '',
  audit: null, auditLoading: false, auditError: '', backfillRunning: false,
  askQuery: '', askThreads: readAskThreads(), askDraft: '', askLoading: false, askError: '',
  askSuggestions: readAskSuggestions(), askSuggestionsEditing: false,
  askStocks: [], askStocksBuiltAt: '', askStocksLoading: false, askStocksError: '',
  askStock: '', askNote: null, askNoteLoading: false, askNoteError: '', askLetterCollapsed: {},
  taskDrafts: {}, templateOrder: readTemplateOrder(), startingTemplates: {}, sidebarOpen: false,
  modelSettings: null, modelSettingsLoading: false, modelSettingsSaving: false,
  modelSettingsError: '', modelRoleRoutes: {}, modelTemplatePresets: {}, modelHostDraft: '', modelStockKbDraft: '', modelStockKbAutoDraft: null, modelStockKbConcurrencyDraft: null,
  holdingsDraft: null, holdingsDraftLoading: false, holdingsImporting: '',
  holdingsConfirming: false, holdingsQuotesLoading: false, refreshing: false, lastRefreshAt: '', holdingsQuotesInfo: '', holdingsActionError: '',
  manualPosition: emptyManualPosition(),
  watchlist: null, watchlistLoading: false, watchlistRefreshing: false,
  watchlistSaving: false, watchlistError: '', watchEditOpen: false,
  watchDistMode: 'target', ledgerColumns: readLedgerColumns(), ledgerSort: readLedgerSort(),
  watchDaily: null, watchDailyLoading: false, watchDailySaving: false, watchDailyRunning: false,
};
