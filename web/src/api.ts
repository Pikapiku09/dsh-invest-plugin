import type {
  ConclusionRecord, HoldingsConfirmResponse, HoldingsDraftResponse, HoldingsImportInput,
  HoldingsQuotesResponse, HoldingsRefreshQuotesResponse, HoldingsResponse, IndexResponse, Job, ModelSettingsResponse, ModelSettingsSaveInput,
  HoldingPosition, HoldingsAccount, StockResolveResponse, TaskTemplate,
  WatchlistResponse, WatchlistUpdateInput, WatchlistRefreshResponse, WatchDailyStatus, WatchlistUpdateResponse,
  StockNotesResponse, StockNoteDetail,
} from './types';

const BASE = '/dsh-invest/api';
const CHART_BASE = '/api/dsh-invest/chart';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`服务返回了非 JSON 响应（HTTP ${response.status}）`);
  }
  const error = payload && typeof payload === 'object' && 'error' in payload
    ? String((payload as { error: unknown }).error) : '';
  if (!response.ok || error) throw new Error(error || `请求失败（HTTP ${response.status}）`);
  return payload as T;
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const api = {
  index: () => request<IndexResponse>(`${BASE}/index`),
  holdings: () => request<HoldingsResponse>(`${BASE}/holdings`),
  importHoldings: (input: HoldingsImportInput) => post<HoldingsDraftResponse>(`${BASE}/holdings/import`, input),
  holdingsDraft: (id: string) => request<HoldingsDraftResponse>(`${BASE}/holdings/draft?id=${encodeURIComponent(id)}`),
  confirmHoldings: (input: { draftId: string; positions: HoldingPosition[]; account?: HoldingsAccount }) =>
    post<HoldingsConfirmResponse>(`${BASE}/holdings/confirm`, input),
  /** 按代码批量取腾讯实时现价；返回 prices 以完整代码（如 603606.SH）为键 */
  holdingsQuotes: (codes: string[]) => post<HoldingsQuotesResponse>(`${BASE}/holdings/quotes`, { codes }),
  /** 直接按行情刷新账本现价（不生成草稿、无需人工确认） */
  holdingsRefreshQuotes: () => post<HoldingsRefreshQuotesResponse>(`${BASE}/holdings/quotes/refresh`, {}),
  modelSettings: () => request<ModelSettingsResponse>(`${BASE}/model-settings`),
  saveModelSettings: (input: ModelSettingsSaveInput) =>
    post<{ ok: true; settings?: ModelSettingsResponse } & ModelSettingsSaveInput>(`${BASE}/model-settings`, input),
  templates: () => request<{ templates: TaskTemplate[] }>(`${BASE}/templates`),
  jobs: () => request<{ jobs: Job[]; recent?: Job[]; concurrency?: number; running?: number; queued?: number }>(`${BASE}/jobs`),
  conclusions: (code: string) => request<{ records: ConclusionRecord[] }>(
    `${BASE}/conclusions?code=${encodeURIComponent(code)}`,
  ),
  run: (input: { templateId: string; code?: string; question?: string }) =>
    post<{ jobId: string }>(`${BASE}/run`, input),
  resolveStock: (query: string) => request<StockResolveResponse>(`${BASE}/stock/resolve?query=${encodeURIComponent(query)}`),
  job: (id: string) => request<Job>(`${BASE}/job?id=${encodeURIComponent(id)}`),
  reindex: () => post<{ ok: boolean; stats?: unknown }>(`${BASE}/reindex`),
  /** 针对已归档报告追问（多轮：history 传最近几轮） */
  askReport: (input: { path: string; question: string; history?: Array<{ role: 'user' | 'assistant'; text: string }> }) =>
    post<{ ok: true; answer: string; elapsedMs: number }>(`${BASE}/report-ask`, input),
  report: (path: string) => request<{ path: string; text: string }>(
    `${BASE}/report?path=${encodeURIComponent(path)}`,
  ),
  // ===== 个股分析知识库（报告按个股切段归集）=====
  stockNotes: () => request<StockNotesResponse>(`${BASE}/stock-notes`),
  stockNote: (code: string) => request<StockNoteDetail>(`${BASE}/stock-note?code=${encodeURIComponent(code)}`),
  stockNotesRebuild: () => post<StockNotesResponse & { ok: true }>(`${BASE}/stock-notes/rebuild`, {}),
  chart: (path: string) => request<{ path: string; svg: string }>(
    `${CHART_BASE}?path=${encodeURIComponent(path)}`,
  ),
  // ===== 标的档案（观察 + 持仓统一监控）=====
  watchlist: () => request<WatchlistResponse>(`${BASE}/watchlist`),
  watchlistRefresh: () => post<WatchlistRefreshResponse>(`${BASE}/watchlist/refresh`, {}),
  watchlistUpdate: (input: WatchlistUpdateInput) =>
    post<WatchlistUpdateResponse>(`${BASE}/watchlist/update`, input),
  watchlistAlertsRead: (key?: string) =>
    post<{ ok: boolean; marked: number }>(`${BASE}/watchlist/alerts/read`, key ? { key } : {}),
  // ===== 观察仓日检（每日自动）=====
  watchDaily: () => request<WatchDailyStatus>(`${BASE}/watch-daily`),
  watchDailySettings: (input: { enabled?: boolean; at?: string }) =>
    post<WatchDailyStatus & { ok: true }>(`${BASE}/watch-daily/settings`, input),
  watchDailyRun: () => post<{
    ok: boolean; status?: string; skipped?: string; message?: string;
    jobId?: string; triggered?: string[]; watchCount?: number;
  }>(`${BASE}/watch-daily/run`, {}),
};
