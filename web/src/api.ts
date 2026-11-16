import type {
  ConclusionRecord, HoldingsConfirmResponse, HoldingsDraftResponse, HoldingsImportInput,
  HoldingsQuotesResponse, HoldingsRefreshQuotesResponse, HoldingsResponse, IndexResponse, Job, ModelSettingsResponse, ModelSettingsSaveInput,
  HoldingPosition, HoldingsAccount, StockResolveResponse, TaskTemplate,
  WatchlistResponse, WatchlistUpdateInput, WatchlistRefreshResponse, WatchDailyStatus, WatchlistUpdateResponse,
  StockNotesResponse, StockNoteDetail, StockAskResponse, StockChartsResponse, BacktestResponse, ConclusionAuditResponse, BackfillResponse, ImportResponse, UpdateCheckResponse, WhatsNewResponse,
} from './types';

const BASE = '/dsh-invest/api';
const CHART_BASE = '/api/dsh-invest/chart';

/**
 * 请求超时（v0.55.1）
 *
 * 之前所有请求都不带超时：一旦服务端没回（重启中、连接半开、代理吞包），
 * fetch 就会一直挂着，调用方的 loading 标志永远停在 true，界面卡在骨架屏且按钮是灰的，
 * 用户除了刷新页面没有任何出路。现在默认 30 秒兜底，慢接口按需放宽。
 */
const DEFAULT_TIMEOUT_MS = 30_000;

async function request<T>(url: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init?.signal ?? controller.signal,
      headers: { Accept: 'application/json', ...init?.headers },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒未响应）：${url.replace(location.origin, '')}`);
    }
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
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

/** 慢接口用：把超时放宽到指定毫秒（0 = 不设超时） */
function postSlow<T>(url: string, body?: unknown, timeoutMs = 180_000): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, timeoutMs);
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
  /** 截图 OCR 识别可能要 1–2 分钟，超时放宽到 3 分钟 */
  importHoldings: (input: HoldingsImportInput) => postSlow<HoldingsDraftResponse>(`${BASE}/holdings/import`, input, 180_000),
  holdingsDraft: (id: string) => request<HoldingsDraftResponse>(`${BASE}/holdings/draft?id=${encodeURIComponent(id)}`),
  confirmHoldings: (input: { draftId: string; positions: HoldingPosition[]; account?: HoldingsAccount }) =>
    post<HoldingsConfirmResponse>(`${BASE}/holdings/confirm`, input),
  /** 按代码批量取腾讯实时现价；返回 prices 以完整代码（如 603606.SH）为键 */
  holdingsQuotes: (codes: string[]) => postSlow<HoldingsQuotesResponse>(`${BASE}/holdings/quotes`, { codes }, 60_000),
  /** 直接按行情刷新账本现价（不生成草稿、无需人工确认） */
  holdingsRefreshQuotes: () => postSlow<HoldingsRefreshQuotesResponse>(`${BASE}/holdings/quotes/refresh`, {}, 60_000),
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
  // ===== 个股分析知识库（报告按个股切段归集 + 二次整理）=====
  stockNotes: () => request<StockNotesResponse>(`${BASE}/stock-notes`),
  stockNote: (code: string) => request<StockNoteDetail>(`${BASE}/stock-note?code=${encodeURIComponent(code)}`),
  stockNotesRebuild: () => postSlow<StockNotesResponse & { ok: true }>(`${BASE}/stock-notes/rebuild`, {}, 180_000),
  /** 触发某只股票的二次整理（异步，完成后轮询 stockNote 取结果） */
  stockCurate: (input: { code: string; full?: boolean }) =>
    post<{ ok: boolean; queued: boolean; code: string }>(`${BASE}/stock-note/curate`, input),
  /** 针对个股知识库追问 */
  stockAsk: (input: { code: string; question: string; history?: Array<{ role: 'user' | 'assistant'; text: string }> }) =>
    post<StockAskResponse>(`${BASE}/stock-ask`, input),
  /** 图表内容：SVG 返回 svg 文本，PNG 返回 base64（v0.53.0 起支持 PNG） */
  chart: (path: string) => request<{ path: string; svg?: string; png?: string }>(
    `${CHART_BASE}?path=${encodeURIComponent(path)}`,
  ),
  /** 按 6 位代码归集 charts 目录里的图表（个股知识库「相关图表」区） */
  stockCharts: (code: string) => request<StockChartsResponse>(
    `${BASE}/stock-charts?code=${encodeURIComponent(code)}`,
  ),
  // ===== 判断质量回测（v0.44.0）：结构化结论 × 日线 → 5/20 日命中率 =====
  backtest: () => request<BacktestResponse>(`${BASE}/backtest`, undefined, 120_000),
  /** 结论采集审计（v0.45.0）：哪些运行进库、哪些没进、为什么 */
  conclusionsAudit: () => request<ConclusionAuditResponse>(`${BASE}/conclusions-audit`),
  /** 历史报告回溯补录（默认 dry-run，apply=true 才写盘） */
  conclusionsBackfill: (apply: boolean) => postSlow<BackfillResponse>(`${BASE}/conclusions-backfill`, { apply }, 180_000),
  /** 结论导出（v0.48.0）：下载单文件 jsonl（首行 _manifest），转发即共享 */
  conclusionsExport: async (): Promise<void> => {
    const res = await fetch(`${BASE}/conclusions-export`);
    if (!res.ok) {
      let msg = `导出失败（${res.status}）`;
      try { msg = (await res.json() as { error?: string }).error || msg; } catch { /* keep */ }
      throw new Error(msg);
    }
    const disposition = res.headers.get('content-disposition') || '';
    const m = /filename="([^"]+)"/.exec(disposition);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = m ? m[1] : 'conclusions.jsonl';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  /** 结论导入（v0.48.0）：他机导出的 jsonl 文本，后端按（callId+标的）去重、只追加 */
  conclusionsImport: (text: string) => post<ImportResponse>(`${BASE}/conclusions-import`, { text }),
  /** 本机实例改名（v0.48.0）：多人共享数据时给分组表一个可读名字 */
  setInstanceName: (name: string) => post<{ ok: true; instance: { id: string; name: string } }>(`${BASE}/instance-name`, { name }),
  /** 更新检查（v0.50.0）：只读，返回是否有新版 + 对应更新命令；force 绕过 30 分钟缓存（v0.51.0） */
  updateCheck: (force = false) => request<UpdateCheckResponse>(`${BASE}/update-check${force ? '?force=1' : ''}`),
  /** 「本次更新」说明（v0.50.0）：由 CHANGELOG.md 生成 */
  whatsNew: () => request<WhatsNewResponse>(`${BASE}/whats-new`),
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
