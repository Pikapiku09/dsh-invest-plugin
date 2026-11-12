import './style.css';
import './page-updates.css';
import { api } from './api';
import { renderArchive } from './archive';
import { renderAsk, stockThreadKey } from './ask';
import { escapeHtml, formatBytes, formatDateTime } from './format';
import { hydrateStaticIcons, icon } from './icons';
import { renderOverview } from './overview';
import { closeReader, initialiseReader, openMarkdown, openReport } from './reader';
import { hydrateCharts } from './markdown';
import { recordsForCode, reportForRun } from './selectors';
import { allRunRows } from './run-history';
import { emptyManualPosition, DEFAULT_ASK_SUGGESTIONS, persistAskSuggestions, persistAskThreads, state, TEMPLATE_ORDER_STORE } from './state';
import type { TaskDraft } from './state';
import { NAME_INPUT_TEMPLATES, orderedTemplates, primaryJobReport, renderTasks } from './tasks';
import { renderRuns } from './runs';
import { renderModelSettings, modelRouteFor, modelPresetFor, isValidModelRoute, serverHostValue, modelStockKb, modelStockKbAuto, modelStockKbConcurrency, splitStockKbRoute } from './model-settings';
import { ensureNotifyPermission, notifyEnabled, notifyPermission, pushAlertsToSystem, setNotifyEnabled } from './notify';
import type { SystemNotice } from './notify';
import { fileToBase64, positionsForConfirm, prepareScreenshotForUpload, renderHoldings, validateHoldingsDraft } from './holdings';
import type { PreparedScreenshot } from './holdings';
import { LEDGER_DEFAULT_COLUMNS } from './types';
import { APP_VERSION } from './version';
import { compareStockName } from './stock-index';
import type { ConclusionRecord, HoldingPosition, HoldingsImportInput, Job, ModelSettingsSaveInput, TaskTemplate, WatchAlert, WorkbenchView, WatchlistUpdateInput, LedgerColKey } from './types';

const viewElement = document.getElementById('view')!;
const pollingJobs = new Set<string>();
const localJobMetadata = new Map<string, Partial<Job>>();
let archiveRequestSerial = 0;
/** 全量重绘时需要保持滚动位置的滚动容器（标的档案左侧栏、标的索引列表、账本列设置、追问会话与报告列表） */
const SCROLL_KEEP_SELECTOR = '.archive-browser, .code-list, .ledger-col-list, .ask-thread, .ask-report-list';
/** 上一次渲染的视图：同视图重绘保持滚动位置，切换视图回到顶部 */
let lastRenderedView: WorkbenchView | null = null;
/** 页面暂时变矮（如档案详情先显示加载态）没恢复成功的窗口滚动位置，留到下一次渲染再试 */
let pendingWindowScroll: number | null = null;
/** 显式跳转意图：有效期内 render() 一律回到该锚点，而不是恢复旧滚动位置 */
let scrollIntent: { targetId: string; block: ScrollLogicalPosition; until: number } | null = null;
/** 用户最近一次主动滚动的时间：期间的重绘不再「恢复旧位置」，否则会与任务轮询的重绘来回拉扯 */
let lastUserScrollAt = 0;
/** 程序化滚动标记：避免自己触发的 scroll 事件被当成用户滚动 */
let programmaticScroll = false;

function setWindowScroll(top: number): void {
  const scroller = document.scrollingElement;
  if (!scroller) return;
  programmaticScroll = true;
  scroller.scrollTop = top;
  window.requestAnimationFrame(() => { programmaticScroll = false; });
}

function scrollToIntentTarget(): void {
  const intent = scrollIntent;
  if (!intent) return;
  const element = document.getElementById(intent.targetId);
  if (element) element.scrollIntoView({ behavior: 'auto', block: intent.block });
}

/** 跳到页面锚点：用跳转意图压住重绘的滚动恢复，保证落点稳定（1.6s 内有效） */
function jumpToSection(targetId: string, block: ScrollLogicalPosition = 'start'): void {
  scrollIntent = { targetId, block, until: Date.now() + 1600 };
  window.requestAnimationFrame(() => { scrollToIntentTarget(); });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toast(message: string, tone: 'success' | 'error' | 'info' = 'info'): void {
  const region = document.getElementById('toastRegion')!;
  const element = document.createElement('div');
  element.className = `toast toast-${tone}`;
  element.innerHTML = `<span>${icon(tone === 'success' ? 'check' : tone === 'error' ? 'alert' : 'sparkles', 17)}</span><p>${escapeHtml(message)}</p>`;
  region.appendChild(element);
  window.setTimeout(() => { element.classList.add('leaving'); window.setTimeout(() => element.remove(), 180); }, 4200);
}

const THEME_KEY = 'workbench-theme';
type ThemeMode = 'light' | 'dark';

function storedTheme(): ThemeMode | null {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch { return null; }
}

function systemTheme(): ThemeMode {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function activeTheme(): ThemeMode {
  return document.documentElement.classList.contains('theme-light') ? 'light' : 'dark';
}

function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  root.classList.toggle('theme-light', mode === 'light');
  root.classList.toggle('theme-dark', mode === 'dark');
  const button = document.getElementById('themeToggle');
  if (button) {
    button.innerHTML = icon(mode === 'light' ? 'moon' : 'sun', 16);
    const label = mode === 'light' ? '切换到深色主题' : '切换到浅色主题';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  }
}

function toggleTheme(): void {
  const next: ThemeMode = activeTheme() === 'light' ? 'dark' : 'light';
  try { window.localStorage.setItem(THEME_KEY, next); } catch { /* 无法持久化时仅本次生效 */ }
  applyTheme(next);
  toast(next === 'light' ? '已切换到浅色主题。' : '已切换到深色主题。', 'info');
}

function initialiseTheme(): void {
  applyTheme(storedTheme() ?? systemTheme());
  if (typeof window.matchMedia === 'function') {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', () => { if (!storedTheme()) applyTheme(systemTheme()); });
  }
}

function hasActiveAnalysisJobs(): boolean {
  return state.jobs.some((job) => job.status === 'queued' || job.status === 'running');
}

interface WatchEditSnapshot { fields: Array<[string, string]>; notify: boolean | null }

/** 抓取标的档案「编辑规则」表单中未保存的输入值，供重绘后回填，后台刷新不再吞掉正在编辑的内容 */
function captureWatchEditSnapshot(): WatchEditSnapshot | null {
  if (state.view !== 'archive' || !state.watchEditOpen) return null;
  const fields = Array.from(viewElement.querySelectorAll<HTMLInputElement>('[data-watch-field]'))
    .map((el) => [el.dataset.watchField || '', el.value] as [string, string]);
  const notifyEl = viewElement.querySelector<HTMLInputElement>('[data-watch-notify]');
  return { fields, notify: notifyEl ? notifyEl.checked : null };
}

function applyWatchEditSnapshot(snapshot: WatchEditSnapshot | null): void {
  if (!snapshot) return;
  snapshot.fields.forEach(([field, value]) => {
    const el = viewElement.querySelector<HTMLInputElement>(`[data-watch-field="${field}"]`);
    if (el) el.value = value;
  });
  if (snapshot.notify !== null) {
    const el = viewElement.querySelector<HTMLInputElement>('[data-watch-notify]');
    if (el) el.checked = snapshot.notify;
  }
}

function render(): void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // 输入法组合输入期间不重绘：重绘会替换正在输入的节点、打断候选窗并丢失未上屏内容；
  // compositionend 处理器会立即补一次重绘（与持仓草稿输入的处理策略一致）
  if (active?.dataset.imeComposing === 'true') return;
  const focusField = active?.dataset.field;
  const selectionStart = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionStart : null;
  const selectionEnd = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionEnd : null;

  const openDetails = Array.from(viewElement.querySelectorAll<HTMLDetailsElement>('details[data-field]')).filter((d) => d.open).map((d) => d.dataset.field!);
  const watchEditSnapshot = captureWatchEditSnapshot();
  // 同视图重绘保持滚动位置；切换视图回到顶部
  const sameView = lastRenderedView === state.view;
  const savedWindowScroll = sameView ? window.scrollY : 0;
  const savedContainerScrolls: number[] = [];
  if (sameView) {
    viewElement.querySelectorAll<HTMLElement>(SCROLL_KEEP_SELECTOR).forEach((el) => { savedContainerScrolls.push(el.scrollTop); });
  }
  viewElement.innerHTML = state.view === 'overview' ? renderOverview(state)
    : state.view === 'archive' ? renderArchive(state)
      : state.view === 'runs' ? renderRuns(state)
: state.view === 'ask' ? renderAsk(state)
        : state.view === 'tasks' ? renderTasks(state)
          : state.view === 'model-settings' ? renderModelSettings(state) : renderHoldings(state);
  // 追问回答以 Markdown 渲染，若回答里引用了 .svg 图表路径，需要按需加载成 data URL
  if (state.view === 'ask') void hydrateCharts(viewElement);
  const labels: Record<WorkbenchView, string> = {
    overview: '投研概览', archive: '标的档案', runs: '运行记录', tasks: '一键任务',
    ask: '个股知识库', 'model-settings': '模型设置', holdings: '持仓工作区',
  };
  document.getElementById('topbarContext')!.textContent = labels[state.view];
  // 左上角品牌区的插件版本号（构建期由 packages/dsh-invest/package.json 注入，前端不硬编码）
  const versionEl = document.getElementById('appVersion');
  if (versionEl) {
    versionEl.textContent = 'v' + APP_VERSION;
    versionEl.title = '插件版本 v' + APP_VERSION + '（来源 packages/dsh-invest/package.json）';
  }
  document.querySelectorAll<HTMLElement>('.nav-item').forEach((item) => {
    const selected = item.dataset.view === state.view;
    item.classList.toggle('active', selected);
    if (selected) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
  const builtAt = document.getElementById('indexBuiltAt')!;
  builtAt.textContent = state.index?.built_at ? formatDateTime(state.index.built_at)
    : state.indexLoading ? '读取中' : state.indexError ? '连接失败' : '尚未构建';
  const indexMeta = document.querySelector<HTMLElement>('.index-meta');
  const storage = state.index?.storage;
  if (indexMeta) indexMeta.title = storage?.sqlite ? `SQLite：${storage.sqlite}\n投影：${storage.projection || '—'}\n索引构建时间` : '主库索引构建时间';
  // 左下角：累计运行环形进度 + 分类统计（已取代原「SQLite 主库」控件）
  renderSidebarRuns();
  const refreshMeta = document.getElementById('refreshMeta');
  if (refreshMeta) refreshMeta.textContent = state.lastRefreshAt ? `上次刷新 ${formatDateTime(state.lastRefreshAt, true)}` : '尚未刷新';
  syncRefreshButton();
  document.getElementById('navBackdrop')!.hidden = !state.sidebarOpen;
  document.body.classList.toggle('sidebar-open', state.sidebarOpen);
  const runBadge = document.getElementById('topbarRunBadge');
  const runBadgeCount = document.getElementById('topbarRunBadgeCount');
  const activeJobs = state.jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  if (runBadge && runBadgeCount) {
    runBadge.hidden = activeJobs === 0;
    runBadgeCount.textContent = String(activeJobs);
    runBadge.classList.toggle('active', activeJobs > 0);
  }

  // 先回填编辑表单未保存的值，再恢复焦点与光标（focus 恢复会把光标放回原处）
  applyWatchEditSnapshot(watchEditSnapshot);
  if (focusField) {
    const replacement = Array.from(viewElement.querySelectorAll<HTMLElement>('[data-field]')).find((element) => element.dataset.field === focusField);
    if (replacement) {
      replacement.focus({ preventScroll: true });
      if ((replacement instanceof HTMLInputElement || replacement instanceof HTMLTextAreaElement) && selectionStart !== null) {
        replacement.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }
  openDetails.forEach((field) => {
    const el = Array.from(viewElement.querySelectorAll<HTMLDetailsElement>('details[data-field]')).find((d) => d.dataset.field === field);
    if (el) el.open = true;
  });
  // 滚动位置保持：点击观察仓/标的索引选择标的后无需重新下滑，可直接继续点击下一只
  // 但显式跳转（顶栏运行徽标 / 最近任务 / 运行记录）优先——否则任务轮询每 1.2s 一次的重绘
  // 会把平滑滚动打断，落点被拉回页面顶部（表现为「跳到模板卡片上」）
  const intentActive = scrollIntent !== null && Date.now() < scrollIntent.until;
  // 用户刚滚动过（600ms 内）：宁可不动，也不要把人拽回旧位置。
  // 追加：pendingWindowScroll 只该在「内容暂时变矮」的当下生效，用户一滚动就必须作废，
  // 否则任务轮询每 1.2s 一次重绘会反复把它应用回来（表现为下拉被弹回）。
  const userScrolling = Date.now() - lastUserScrollAt < 600;
  if (intentActive) {
    pendingWindowScroll = null;
    scrollToIntentTarget();
  } else if (sameView) {
    if (userScrolling) {
      pendingWindowScroll = null;
    } else {
      const scroller = document.scrollingElement;
      const target = pendingWindowScroll ?? savedWindowScroll;
      if (scroller) {
        programmaticScroll = true;
        scroller.scrollTop = target;
        window.requestAnimationFrame(() => { programmaticScroll = false; });
        // 页面暂短被夹住时记录目标位置，下一次渲染（详情回填后）再恢复
        pendingWindowScroll = Math.abs(scroller.scrollTop - target) > 1 ? target : null;
      }
      const containers = viewElement.querySelectorAll<HTMLElement>(SCROLL_KEEP_SELECTOR);
      savedContainerScrolls.forEach((top, index) => {
        const el = containers[index];
        if (el && top > 0) el.scrollTop = top;
      });
    }
  } else {
    pendingWindowScroll = null;
    setWindowScroll(0);
  }
  lastRenderedView = state.view;
}

async function loadIndex(): Promise<void> {
  state.indexLoading = true; state.indexError = ''; render();
  try { state.index = await api.index(); }
  catch (error) { state.indexError = errorMessage(error); }
  finally { state.indexLoading = false; render(); }
}

async function loadHoldings(): Promise<void> {
  state.holdingsLoading = true; state.holdingsError = '';
  try { state.holdings = await api.holdings(); }
  catch (error) { state.holdingsError = errorMessage(error); }
  finally { state.holdingsLoading = false; render(); }
}

// ===== 标的档案（观察 + 持仓统一监控）=====
const ALERT_KIND_LABEL: Record<string, string> = {
  buy: '买入提醒', invalidate: '观察失效', stop: '止损提醒', target: '止盈提醒', add: '加仓提醒', trim: '减仓提醒',
};

/** 未读提醒 → Windows 系统通知（同一 key 只弹一次；页面内 toast 由事件兜底） */
function dispatchAlertNotifications(alerts: WatchAlert[]): void {
  const pending = alerts
    .filter((alert) => !alert.read)
    .map((alert) => ({
      key: alert.key,
      title: `${ALERT_KIND_LABEL[alert.kind] || '提醒'} · ${alert.name || alert.code}`,
      body: alert.message,
    }));
  if (!pending.length) return;
  void pushAlertsToSystem(pending);
}

async function loadWatchlist(): Promise<void> {
  state.watchlistLoading = true; state.watchlistError = '';
  try {
    state.watchlist = await api.watchlist();
    lastAlertSignature = (state.watchlist?.alerts || []).map((alert) => alert.key).join('|');
    dispatchAlertNotifications(state.watchlist?.alerts || []);
  }
  catch (error) { state.watchlist = null; state.watchlistError = errorMessage(error); }
  finally { state.watchlistLoading = false; render(); }
}

// 主动推送：页面打开期间每 60 秒轻量轮询提醒（每日脚本/后台任务产生的提醒无需手动刷新即可弹出）
let lastAlertSignature = '';
async function pollWatchAlerts(): Promise<void> {
  if (document.hidden) return;
  try {
    const doc = await api.watchlist();
    const signature = (doc.alerts || []).map((alert) => alert.key).join('|');
    if (signature === lastAlertSignature) return;
    lastAlertSignature = signature;
    state.watchlist = doc;
    dispatchAlertNotifications(doc.alerts || []);
    render();
  } catch { /* 轮询失败静默：不打断当前操作 */ }
}

/** 开关系统通知：权限申请必须发生在用户手势里（浏览器要求） */
async function toggleSystemNotify(): Promise<void> {
  const enabled = notifyEnabled();
  // 已开启但尚未授权：这一次点击只申请权限，不把开关关掉（否则「点一下反而关闭」很反直觉）
  if (enabled && notifyPermission() !== 'granted') {
    const permission = await ensureNotifyPermission();
    if (permission === 'granted') {
      toast('系统通知已授权：触发止盈/止损/买入提醒时会弹出 Windows 通知。', 'success');
      dispatchAlertNotifications(state.watchlist?.alerts || []);
    } else if (permission === 'denied') {
      toast('浏览器已拒绝通知权限：请在地址栏站点设置里允许通知；页面内提醒仍然生效。', 'error');
    } else {
      toast('尚未授权：请在浏览器弹出的提示中允许通知。', 'info');
    }
    render();
    return;
  }
  if (enabled) {
    setNotifyEnabled(false);
    toast('系统通知已关闭，仅保留页面内提醒。', 'info');
    render();
    return;
  }
  setNotifyEnabled(true);
  const permission = await ensureNotifyPermission();
  if (permission === 'granted') {
    toast('系统通知已开启：触发止盈/止损/买入提醒时会弹出 Windows 通知。', 'success');
    dispatchAlertNotifications(state.watchlist?.alerts || []);
  } else if (permission === 'denied') {
    toast('浏览器已拒绝通知权限：请在地址栏站点设置里允许通知；页面内提醒仍然生效。', 'error');
  } else {
    toast('已开启系统通知，但浏览器尚未授权，请在弹出的提示中允许。', 'info');
  }
  render();
}

async function refreshWatchlist(): Promise<void> {
  if (state.watchlistRefreshing) return;
  state.watchlistRefreshing = true; render();
  try {
    const r = await api.watchlistRefresh();
    const synced = (r.watchSync || []).length ? `；同时对账 ${r.watchSync!.length} 项（${r.watchSync!.slice(0, 3).join('、')}）` : '';
    toast(`已刷新 ${r.refreshed} 只标的现价，触发 ${r.alerts.length} 条提醒${synced}。`, 'success');
    await Promise.all([loadWatchlist(), loadHoldings()]);
  } catch (error) { toast(`刷新失败：${errorMessage(error)}`, 'error'); }
  finally { state.watchlistRefreshing = false; render(); }
}

// ===== 观察仓日检（每日自动）=====
async function loadWatchDaily(): Promise<void> {
  state.watchDailyLoading = true;
  try { state.watchDaily = await api.watchDaily(); }
  catch { /* 后端未重载时静默：不打断页面其它区域 */ }
  finally { state.watchDailyLoading = false; render(); }
}

async function toggleWatchDaily(): Promise<void> {
  const current = state.watchDaily;
  if (!current || state.watchDailySaving) return;
  state.watchDailySaving = true; render();
  try {
    const next = await api.watchDailySettings({ enabled: !current.enabled });
    state.watchDaily = next;
    toast(next.enabled
      ? `观察仓日检已开启：开机补跑 + 每天 ${next.at} 收盘后各跑一次。`
      : '观察仓日检已关闭（仍可随时手动运行）。', 'success');
  } catch (error) { toast(`保存失败：${errorMessage(error)}`, 'error'); }
  finally { state.watchDailySaving = false; render(); }
}

async function saveWatchDailyAt(value: string): Promise<void> {
  if (state.watchDailySaving) return;
  state.watchDailySaving = true; render();
  try {
    const next = await api.watchDailySettings({ at: value });
    state.watchDaily = next;
    toast(`收盘后定时已改为 ${next.at}。`, 'success');
  } catch (error) { toast(`保存失败：${errorMessage(error)}`, 'error'); }
  finally { state.watchDailySaving = false; render(); }
}

async function runWatchDaily(): Promise<void> {
  if (state.watchDailyRunning) return;
  state.watchDailyRunning = true; render();
  try {
    const result = await api.watchDailyRun();
    if (result.status === 'fired') {
      toast(`日检触发 ${result.triggered?.length || 0} 只（${(result.triggered || []).join('、')}），已排队深度判断。`, 'success');
      await loadJobs();
    } else if (result.status === 'no-trigger') {
      toast(`日检完成：观察 ${result.watchCount || 0} 只，本次无触发。`, 'info');
      await loadWatchlist();
    } else {
      toast(result.message || '已有日检任务在跑，本次跳过。', 'info');
    }
    await loadWatchDaily();
  } catch (error) { toast(`日检失败：${errorMessage(error)}`, 'error'); }
  finally { state.watchDailyRunning = false; render(); }
}

/** 保存监控规则：一次性从 DOM 读取编辑表单，避免输入过程中重绘丢焦点 */
async function saveWatchItem(code: string): Promise<void> {
  if (state.watchlistSaving) return;
  const body: Record<string, unknown> = { code };
  const watchPatch: Record<string, unknown> = {};
  const posPatch: Record<string, unknown> = {};
  const notifyEl = document.querySelector<HTMLInputElement>('[data-watch-notify]');
  if (notifyEl) body.notify = notifyEl.checked;
  document.querySelectorAll<HTMLInputElement>('[data-watch-field]').forEach((el) => {
    const f = el.dataset.watchField || '';
    const raw = el.value.trim();
    if (f === 'name') { if (raw) body.name = raw; return; }
    if (f === 'invalidate_if') { watchPatch.invalidate_if = el.value; return; }
    const n = raw === '' ? null : Number(raw);
    const num = (n !== null && Number.isFinite(n)) ? n : null;
    if (f.startsWith('pos.')) posPatch[f.slice(4)] = num;
    else if (f) watchPatch[f] = num;
  });
  body.watch = watchPatch;
  body.position = posPatch;
  state.watchlistSaving = true;
  try {
    const result = await api.watchlistUpdate(body as unknown as WatchlistUpdateInput);
    state.watchEditOpen = false;
    const sync = result.holdingSync;
    if (result.holdingSyncError) toast(`规则已保存，但持仓账本同步失败：${result.holdingSyncError}`, 'error');
    else if (sync?.changed) toast(`监控规则已保存，持仓账本已同步（${sync.action}）。`, 'success');
    else toast('监控规则已保存。', 'success');
    const warning = sync?.warnings?.[0];
    if (warning) toast(warning, 'info');
    await Promise.all([loadWatchlist(), loadHoldings()]);
  } catch (error) { toast(`保存失败：${errorMessage(error)}`, 'error'); }
  finally { state.watchlistSaving = false; render(); }
}

async function createWatch(code: string): Promise<void> {
  try {
    await api.watchlistUpdate({ code });
    state.watchEditOpen = true;
    toast('已建立观察档案，请补录买入区间。', 'success');
    await loadWatchlist();
  } catch (error) { toast(`建档失败：${errorMessage(error)}`, 'error'); }
}

async function markAlertsRead(): Promise<void> {
  try {
    await api.watchlistAlertsRead();
    await loadWatchlist();
    toast('提醒已全部标记为已读。', 'success');
  } catch (error) { toast(`标记失败：${errorMessage(error)}`, 'error'); }
}

async function changeWatchState(code: string, next: string): Promise<void> {
  const valid = ['观察', '持有', '已清仓', '已移除'];
  if (!valid.includes(next)) return;
  try {
    const result = await api.watchlistUpdate({ code, state: next as WatchlistUpdateInput['state'] });
    const sync = result.holdingSync;
    if (result.holdingSyncError) toast(`档案已更新，但持仓账本同步失败：${result.holdingSyncError}`, 'error');
    else if (sync?.changed) toast(`档案状态「${next}」，持仓账本已同步（${sync.action}）。`, 'success');
    else toast('档案状态已更新为「' + next + '」。', 'success');
    const warning = sync?.warnings?.[0];
    if (warning) toast(warning, 'info');
    // 档案与账本是同一份事实：一边改了，另一边立即跟上
    await Promise.all([loadWatchlist(), loadHoldings()]);
  } catch (error) {
    toast(`状态更新失败：${errorMessage(error)}`, 'error');
    await loadWatchlist();
  }
}

async function loadTemplates(): Promise<void> {
  if (state.templatesLoading) return;
  state.templatesLoading = true; state.templatesError = ''; render();
  try { state.templates = (await api.templates()).templates || []; }
  catch (error) { state.templatesError = errorMessage(error); }
  finally { state.templatesLoading = false; render(); }
}


async function loadModelSettings(): Promise<void> {
  if (state.modelSettingsLoading) return;
  state.modelSettingsLoading = true;
  state.modelSettingsError = '';
  render();
  const previous = state.modelSettings;
  try {
    const response = await api.modelSettings();
    state.modelSettings = response;
    // 宿主模型草稿：服务器值变了（或首次加载）才覆盖，避免刷新吞掉未保存的选择
    const previousHost = previous ? serverHostValue(previous) : undefined;
    const nextHost = serverHostValue(response);
    if (!previous || !state.modelHostDraft || state.modelHostDraft === previousHost) {
      state.modelHostDraft = nextHost;
    }
    // 知识库整理模型草稿：同理，服务器值变化或首次加载才覆盖
    const previousKb = previous?.stockKb?.model;
    const nextKb = response.stockKb?.model || '';
    if (!previous || !state.modelStockKbDraft || state.modelStockKbDraft === previousKb) {
      state.modelStockKbDraft = nextKb;
    }
    const previousAuto = previous?.stockKb?.auto !== false;
    const nextAuto = response.stockKb?.auto !== false;
    if (!previous || state.modelStockKbAutoDraft === null || state.modelStockKbAutoDraft === previousAuto) {
      state.modelStockKbAutoDraft = nextAuto;
    }
    const previousConcurrency = previous?.stockKb?.concurrency || 3;
    const nextConcurrency = response.stockKb?.concurrency || 3;
    if (!previous || state.modelStockKbConcurrencyDraft === null || state.modelStockKbConcurrencyDraft === previousConcurrency) {
      state.modelStockKbConcurrencyDraft = nextConcurrency;
    }
    (response.roles || []).forEach((role) => {
      const old = previous?.roles.find((item) => item.code === role.code);
      const draft = state.modelRoleRoutes[role.code];
      if (!old || draft === undefined || draft.trim() === (old.route || 'inherit')) {
        state.modelRoleRoutes[role.code] = role.route || 'inherit';
      }
    });
    (response.templates || []).forEach((template) => {
      const old = previous?.templates.find((item) => item.id === template.id);
      const draft = state.modelTemplatePresets[template.id];
      if (!old || draft === undefined || draft === (old.preset || 'inherit')) {
        state.modelTemplatePresets[template.id] = template.preset || 'inherit';
      }
    });
  } catch (error) {
    state.modelSettingsError = errorMessage(error);
  } finally {
    state.modelSettingsLoading = false;
    render();
  }
}

async function saveModelSettings(): Promise<void> {
  const settings = state.modelSettings;
  if (!settings || state.modelSettingsSaving) return;
  const invalidRole = settings.roles.find((role) => !isValidModelRoute(modelRouteFor(role, state)));
  if (invalidRole) {
    toast(`「${invalidRole.name}」的路由格式不正确，请修正后再保存。`, 'error');
    document.querySelector<HTMLInputElement>(`[data-role-route="${invalidRole.code}"]`)?.focus();
    return;
  }
  const updates: ModelSettingsSaveInput[] = [];
  settings.roles.forEach((role) => {
    const route = modelRouteFor(role, state).trim();
    if (route !== (role.route || 'inherit')) updates.push({ scope: 'role', role: role.code, route });
  });
  settings.templates.forEach((template) => {
    const preset = modelPresetFor(template, state);
    if (preset !== (template.preset || 'inherit')) updates.push({ scope: 'template', templateId: template.id, preset });
  });
  // 宿主模型：草稿与服务器值不同才提交
  const hostValue = state.modelHostDraft || 'inherit';
  if (hostValue !== serverHostValue(settings)) updates.push({ scope: 'host', value: hostValue });
  // 知识库整理：模型/推理强度 + 并发数 + 后台自动整理开关
  const kbModel = modelStockKb(state);
  const kbAuto = modelStockKbAuto(state);
  const kbConcurrency = modelStockKbConcurrency(state);
  if (kbModel !== (settings.stockKb?.model || '')
    || kbAuto !== (settings.stockKb?.auto !== false)
    || kbConcurrency !== (settings.stockKb?.concurrency || 3)) {
    if (kbModel !== 'inherit' && !isValidModelRoute(kbModel)) {
      toast('知识库整理模型的格式不正确（应为 provider/model，可选 @effort）。', 'error');
      return;
    }
    updates.push({ scope: 'stockKb', model: kbModel, auto: kbAuto, concurrency: kbConcurrency });
  }
  if (!updates.length) { toast('当前没有需要保存的修改。', 'info'); return; }

  state.modelSettingsSaving = true;
  render();
  let completed = 0;
  try {
    for (const input of updates) {
      const response = await api.saveModelSettings(input);
      completed += 1;
      if (input.scope === 'role') {
        const role = settings.roles.find((item) => item.code === input.role);
        if (role) role.route = input.route;
        state.modelRoleRoutes[input.role] = input.route;
      } else if (input.scope === 'host') {
        state.modelHostDraft = input.value;
        // 后端回传整份最新设置：直接用服务器值刷新（预设描述内嵌宿主模型名，避免本地拼装失同步）
        if (response.settings) state.modelSettings = response.settings;
      } else if (input.scope === 'stockKb') {
        state.modelStockKbDraft = input.model;
        if (typeof input.auto === 'boolean') state.modelStockKbAutoDraft = input.auto;
        if (typeof input.concurrency === 'number') state.modelStockKbConcurrencyDraft = input.concurrency;
        if (response.settings) state.modelSettings = response.settings;
      } else {
        const template = settings.templates.find((item) => item.id === input.templateId);
        if (template) template.preset = input.preset;
        state.modelTemplatePresets[input.templateId] = input.preset;
      }
      render();
    }
    toast(`模型设置已保存，共更新 ${completed} 项。`, 'success');
  } catch (error) {
    toast(`保存中断：${errorMessage(error)}。已提交 ${completed}/${updates.length} 项，其余修改仍保留，请重试。`, 'error');
  } finally {
    state.modelSettingsSaving = false;
    render();
  }
}

function mergeJob(incoming: Job): Job {
  const metadata = localJobMetadata.get(incoming.id) || {};
  const merged = { ...metadata, ...incoming };
  localJobMetadata.set(incoming.id, merged);
  state.jobs = [merged, ...state.jobs.filter((job) => job.id !== incoming.id)];
  return merged;
}

/** 最近任务本地缓存：即使后端重启/换浏览器，也能保留最近 5 个任务入口 */
const RECENT_JOBS_CACHE = 'dsh-invest.recentJobs';

function readRecentJobsCache(): Job[] {
  try {
    const raw = window.localStorage.getItem(RECENT_JOBS_CACHE);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((item): item is Job => Boolean(item && item.id)) : [];
  } catch { return []; }
}

function cacheRecentJobs(jobs: Job[]): void {
  try {
    const snapshot = jobs
      .filter((job) => job.status === 'done' || job.status === 'failed')
      .slice(0, 5)
      .map((job) => ({
        id: job.id, templateId: job.templateId, name: job.name, mode: job.mode,
        question: job.question, status: job.status, createdAt: job.createdAt,
        elapsedMs: job.elapsedMs, error: job.error,
        reportPath: job.result?.reports?.[0] || job.reportPath || '',
      }));
    window.localStorage.setItem(RECENT_JOBS_CACHE, JSON.stringify(snapshot));
  } catch { /* 无法持久化时忽略 */ }
}

async function loadJobs(): Promise<void> {
  if (state.jobsLoading) return;
  state.jobsLoading = true; state.jobsError = ''; render();
  try {
    const response = await api.jobs();
    const serverJobs = response.jobs || [];
    state.jobsMeta = {
      concurrency: response.concurrency ?? 0,
      running: response.running ?? 0,
      queued: response.queued ?? 0,
    };
    const serverIds = new Set(serverJobs.map((job) => job.id));
    const localActive = state.jobs.filter((job) => !serverIds.has(job.id) && (job.status === 'queued' || job.status === 'running'));
    state.jobs = [];
    serverJobs.forEach(mergeJob);
    state.jobs.push(...localActive);
    // 持久化的最近任务（后端 recent + 本地缓存，跨 web 关闭/DSH 重启保留 5 个）
    const known = new Set(state.jobs.map((job) => job.id));
    const persistedSource = [...(response.recent || []), ...readRecentJobsCache()];
    const historical = persistedSource
      .filter((item) => item && item.id && !known.has(item.id))
      .filter((item, index, list) => list.findIndex((other) => other.id === item.id) === index)
      .slice(0, 5)
      .map((item) => ({
        ...item,
        persisted: true,
        createdAt: Number(item.createdAt) || Date.now(),
        result: item.reportPath ? { reports: [item.reportPath] } : undefined,
      } as Job));
    state.jobs.push(...historical);
    state.jobs.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    cacheRecentJobs(state.jobs);
    serverJobs.filter((job) => job.status === 'queued' || job.status === 'running').forEach((job) => { void pollJob(job.id); });
  } catch (error) { state.jobsError = errorMessage(error); }
  finally { state.jobsLoading = false; render(); }
}

/** 只重读当前标的的结论链（任务完成后的静默同步用）：不改选中、不关编辑表单 */
async function reloadArchiveConclusions(code: string): Promise<void> {
  const serial = ++archiveRequestSerial;
  state.archiveRecords = []; state.archiveError = ''; state.archiveNotice = ''; state.archiveLoading = true;
  render();
  const fallback = state.index ? recordsForCode(state.index, code) : [];
  try {
    const response = await api.conclusions(code);
    if (serial !== archiveRequestSerial) return;
    const unique = new Map<string, ConclusionRecord>();
    [...(response.records || []), ...fallback].forEach((record) => {
      const key = record.id !== undefined ? String(record.id) : `${record.asof}-${record.stance}-${record.run_id}`;
      if (!unique.has(key)) unique.set(key, record);
    });
    state.archiveRecords = Array.from(unique.values());
  } catch (error) {
    if (serial !== archiveRequestSerial) return;
    state.archiveRecords = fallback;
    state.archiveError = errorMessage(error);
    state.archiveNotice = fallback.length
      ? `结论链接口暂不可用，当前展示 ${fallback.length} 条历史索引回填记录。`
      : `结论链接口暂不可用：${state.archiveError}`;
  } finally {
    if (serial === archiveRequestSerial) { state.archiveLoading = false; render(); }
  }
}

async function selectCode(code: string, navigateToArchive = true): Promise<void> {
  state.selectedCode = code;
  if (navigateToArchive) state.view = 'archive';
  state.sidebarOpen = false;
  state.watchEditOpen = false;
  await reloadArchiveConclusions(code);
}

function openRun(id: string): void {
  const run = state.index?.runs.find((item) => String(item.id) === id);
  if (!run) { toast('未找到该运行记录，请刷新索引后重试。', 'error'); return; }
  const report = reportForRun(state.index, run);
  if (!report) { toast(run.ok === false ? `运行失败：${run.error || '未归档报告'}` : '该运行暂无归档报告。', 'info'); return; }
  void openReport(report.path, report.charts);
}

function openReportById(id: string): void {
  const report = state.index?.reports.find((item) => String(item.id) === id);
  if (!report) { toast('未在索引中找到对应报告。', 'error'); return; }
  void openReport(report.path, report.charts || []);
}

function openJobReport(id: string): void {
  const job = state.jobs.find((item) => item.id === id);
  const report = job ? primaryJobReport(job) : null;
  if (report) void openReport(report.path, report.charts);
  else toast('该任务尚未返回可阅读的报告。', 'info');
}

function navigate(view: WorkbenchView): void {
  state.view = view; state.sidebarOpen = false; render();
  if (view === 'tasks') {
    if (!state.templates.length && !state.templatesLoading) void loadTemplates();
    void loadJobs();
  }
  if (view === 'model-settings' && !state.modelSettings && !state.modelSettingsLoading) void loadModelSettings();
  if (view === 'ask' && !state.index && !state.indexLoading) void loadIndex();
  if (view === 'ask') void loadAskStocks();
  if (view === 'holdings') {
    if (!state.holdings && !state.holdingsLoading) void loadHoldings();
    void loadJobs();
    void restoreRememberedHoldingsDraft();
  }
}

/** 任务类型配色：环形分段与下方图例共用（颜色即类型，避免只凭文字辨认） */
const RUN_CATEGORY_COLORS: Record<string, string> = {
  个股: '#6f9ff8',
  选股: '#42c8a0',
  组合: '#b78cf8',
  消息: '#f0b447',
  其他: '#8b93a7',
};
const RUN_CATEGORY_ORDER = ['个股', '选股', '组合', '消息', '其他'];

/** 左下角「累计运行」环形进度：按任务类型分段着色 + 图例显示次数与占比 */
function renderSidebarRuns(): void {
  const totalEl = document.getElementById('sidebarRunTotal');
  const segLayer = document.getElementById('runsRingSegments');
  const breakdown = document.getElementById('sidebarRunBreakdown');
  if (!totalEl || !segLayer || !breakdown) return;
  const rows = allRunRows(state.index);
  const total = rows.length;
  const groups: Array<[string, RegExp]> = [
    ['个股', /个股|体检|快诊|诊断/],
    ['选股', /选股|海选/],
    ['组合', /组合|复盘|持仓|总判断|调仓/],
    ['消息', /消息|异动|盘中/],
  ];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const mode = String(row.mode || '');
    // 「报告归档」回填行没有原始 mode，用问题标题推断分类
    const text = mode === '报告归档' ? String(row.question || '') : mode;
    const hit = groups.find(([, pattern]) => pattern.test(text));
    const key = hit ? hit[0] : '其他';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const categories = RUN_CATEGORY_ORDER.map((label) => ({
    label,
    count: counts.get(label) || 0,
    color: RUN_CATEGORY_COLORS[label] || '#8b93a7',
    percent: total ? ((counts.get(label) || 0) / total) * 100 : 0,
  }));
  totalEl.textContent = String(total);

  // 多色分段环：每类任务一段，长度按占比，段间留小空隙便于区分
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const gap = total > 0 ? Math.min(2.5, (circumference / total) * 0.18) : 0;
  let cursor = 0;
  segLayer.innerHTML = categories.filter((item) => item.count > 0).map((item) => {
    const sweep = circumference * (item.count / total);
    const length = Math.max(sweep - gap, 0.8);
    const markup = `<circle class="runs-ring-seg" cx="32" cy="32" r="${radius}" stroke="${item.color}" stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-cursor).toFixed(2)}"><title>${item.label} ${item.count} 次 · ${item.percent.toFixed(1)}%</title></circle>`;
    cursor += sweep;
    return markup;
  }).join('');

  breakdown.innerHTML = total
    ? categories.map((item) => `<span class="runs-legend-item" title="${item.label} ${item.count} 次 · 占 ${item.percent.toFixed(1)}%"><i style="background:${item.color}"></i><b>${item.label}</b><em>${item.count}</em><small>${item.percent.toFixed(0)}%</small></span>`).join('')
    : '<span class="muted">暂无运行</span>';

  const nextMilestone = total > 0 ? (Math.floor(total / 50) + 1) * 50 : 50;
  const wrapper = document.getElementById('sidebarRuns');
  if (wrapper) wrapper.title = total ? `累计运行 ${total} 次 · 距第 ${nextMilestone} 次还差 ${nextMilestone - total} 次` : '还没有运行记录';
}

/** 刷新按钮旁的「上次刷新数据时间」：本地持久化，重开页面仍显示 */
const LAST_REFRESH_KEY = 'dsh-invest.lastRefreshAt';

function readLastRefreshAt(): string {
  try { return window.localStorage.getItem(LAST_REFRESH_KEY) || ''; } catch { return ''; }
}

function markRefreshed(): void {
  const stamp = new Date().toISOString();
  state.lastRefreshAt = stamp;
  try { window.localStorage.setItem(LAST_REFRESH_KEY, stamp); } catch { /* 无法持久化时忽略 */ }
}

/** 「刷新数据」按钮状态：刷新中 → 旋转器 + 「刷新中」文案 + 禁用（防重复触发） */
function syncRefreshButton(): void {
  const button = document.getElementById('refreshButton') as HTMLButtonElement | null;
  if (!button) return;
  button.disabled = state.refreshing;
  button.classList.toggle('is-loading', state.refreshing);
  button.setAttribute('aria-busy', state.refreshing ? 'true' : 'false');
  const label = document.getElementById('refreshLabel');
  if (label) label.textContent = state.refreshing ? '刷新中' : '刷新数据';
}

async function refreshAll(): Promise<void> {
  // 防重入：刷新进行中直接忽略，避免并发刷新互相覆盖导致冲突/失败
  if (state.refreshing) return;
  state.refreshing = true;
  render();
  const jobs: Promise<void>[] = [loadIndex(), loadHoldings(), loadWatchlist(), loadWatchDaily()];
  if (state.view === 'tasks') { jobs.push(loadTemplates(), loadJobs()); }
  if (state.view === 'model-settings') jobs.push(loadModelSettings());
  // 只重读结论链，不重置选中与编辑表单：刷新期间用户正在填的监控规则不被打断
  if (state.selectedCode) jobs.push(reloadArchiveConclusions(state.selectedCode));
  try {
    await Promise.all(jobs);
    const failure = state.indexError || state.holdingsError || state.watchlistError || state.jobsError || state.templatesError;
    if (failure) toast(`刷新完成，但部分数据异常：${failure}`, 'error');
    else { markRefreshed(); toast(`数据刷新成功（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）。`, 'success'); }
  } catch (error) {
    toast(`刷新失败：${errorMessage(error)}`, 'error');
  } finally {
    state.refreshing = false;
    render();
  }
}

// ===== 每日自动刷新：每天首次打开/跨天时自动执行一次「刷新数据」+ 现价刷新 =====
const AUTO_REFRESH_DAY_KEY = 'dsh-invest.lastAutoRefreshDay';

function localDayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 每日一次的自动数据刷新：与右上角「刷新数据」同源，另加现价刷新与信号比对（当天只执行一次） */
async function autoDailyRefresh(): Promise<void> {
  let last = '';
  try { last = window.localStorage.getItem(AUTO_REFRESH_DAY_KEY) || ''; }
  catch { return; }   // 本地存储不可用时跳过，避免同一天反复刷新
  const today = localDayKey();
  if (last === today) return;
  try { window.localStorage.setItem(AUTO_REFRESH_DAY_KEY, today); } catch { /* 忽略 */ }
  try {
    await refreshAll();
    try { await api.watchlistRefresh(); } catch { /* 行情拉取失败不影响本地数据刷新 */ }
    await loadWatchlist();
    toast('已自动刷新当日数据与现价。', 'info');
  } catch (error) { toast(`每日自动刷新失败：${errorMessage(error)}`, 'error'); }
}

function startDraft(template: TaskTemplate): TaskDraft {
  return state.taskDrafts[template.id] || { code: '', question: '' };
}

const STOCK_CODE_PATTERN = /^\d{6}(\.(SH|SZ|BJ))?$/i;

async function resolveTemplateCode(template: TaskTemplate, draft: TaskDraft): Promise<string | null> {
  const text = draft.code.trim();
  if (STOCK_CODE_PATTERN.test(text)) return text;
  if (!NAME_INPUT_TEMPLATES.has(template.id)) return text;
  if (draft.resolvedCode && text === (draft.name || '')) return draft.resolvedCode;
  const focusInput = () => document.querySelector<HTMLInputElement>(`[data-field="template-code-${template.id}"]`)?.focus();
  try {
    const resolved = await api.resolveStock(text);
    if (!resolved || resolved.found === false || !resolved.code) {
      toast('未找到该股票名，请改用代码', 'error');
      focusInput();
      return null;
    }
    const name = (resolved.name || '').trim() || text;
    draft.name = name;
    draft.resolvedCode = resolved.code;
    draft.code = name;
    render();
    return resolved.code;
  } catch (error) {
    toast(`股票名解析失败：${errorMessage(error)}，请改用代码输入`, 'error');
    focusInput();
    return null;
  }
}

/** 一键任务模板排序：↑↓ 调整并存到本机；后端新增的模板自动排在末尾 */
function moveTemplate(id: string, dir: number): void {
  if (!dir) return;
  const ordered = orderedTemplates(state.templates, state.templateOrder).map((template) => template.id);
  const from = ordered.indexOf(id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= ordered.length) return;
  [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
  state.templateOrder = ordered;
  try { window.localStorage.setItem(TEMPLATE_ORDER_STORE, JSON.stringify(ordered)); }
  catch { /* 无法持久化时仅本次生效 */ }
  render();
}

/** 个股知识库追问：把本轮问题追加进线程，带上最近几轮历史请求后端（只依据整理稿回答） */
async function askAboutStock(code: string, presetQuestion?: string): Promise<void> {
  const target = String(code || state.askStock || '').toUpperCase();
  const question = String(presetQuestion ?? state.askDraft ?? '').trim();
  if (!target || !question || state.askLoading) return;
  const key = stockThreadKey(target);
  const history = (state.askThreads[key] || []).slice(-6).map((turn) => ({ role: turn.role, text: turn.text }));
  state.askThreads[key] = [...(state.askThreads[key] || []), { role: 'user', text: question, ts: Date.now() }];
  persistAskThreads(state.askThreads);
  state.askDraft = '';
  state.askLoading = true;
  state.askError = '';
  render();
  try {
    const response = await api.stockAsk({ code: target, question, history });
    const answer = String(response.answer || '').trim() || '（模型没有返回内容，请重试）';
    state.askThreads[key] = [...(state.askThreads[key] || []), { role: 'assistant', text: answer, ts: Date.now() }];
    persistAskThreads(state.askThreads);
  } catch (error) {
    state.askError = `追问失败：${errorMessage(error)}`;
  } finally {
    state.askLoading = false;
    render();
    scrollAskThreadToBottom();
  }
}

/** 追问会话滚到最新一轮（切换标的 / 刚收到回答时用；普通重绘不调用，避免打断阅读位置） */
function scrollAskThreadToBottom(): void {
  window.requestAnimationFrame(() => {
    const thread = document.getElementById('ask-thread');
    if (thread) thread.scrollTop = thread.scrollHeight;
  });
}

// ===== 个股知识库（按股票归集 + 二次整理，追问直接对着知识库）=====
let askStocksAt = 0;
let askNotePolling = 0;
let askNotePollTimer = 0;

/** 从索引里找某份报告的个股归属：运行记录/概览的「追问」按钮只带报告路径 */
function codeForReportPath(reportPath: string): string {
  const key = String(reportPath || '').replace(/\\/g, '/').toLowerCase();
  const report = (state.index?.reports || []).find((item) => String(item.path || '').replace(/\\/g, '/').toLowerCase() === key);
  return String((report && report.codes && report.codes[0]) || '');
}

async function loadAskStocks(force = false): Promise<void> {
  if (state.askStocksLoading) return;
  if (!force && state.askStocks.length && Date.now() - askStocksAt < 60_000) return;
  state.askStocksLoading = true; state.askStocksError = ''; render();
  try {
    const data = await api.stockNotes();
    state.askStocks = data.stocks || [];
    state.askStocksBuiltAt = data.built_at || '';
    askStocksAt = Date.now();
    // 首次进入且没有选中标的：按名称排序取第一只，右侧不留空白
    if (!state.askStock && state.askStocks.length) {
      const first = [...state.askStocks].sort((a, b) => compareStockName(a.name || a.code, b.name || b.code))[0];
      if (first) void selectAskStock(first.code);
    }
  } catch (error) {
    state.askStocksError = errorMessage(error);
  } finally {
    state.askStocksLoading = false; render();
  }
}

async function rebuildAskStocks(): Promise<void> {
  if (state.askStocksLoading) return;
  state.askStocksLoading = true; render();
  try {
    const data = await api.stockNotesRebuild();
    state.askStocks = data.stocks || [];
    state.askStocksBuiltAt = data.built_at || '';
    askStocksAt = Date.now();
    const stats = data.stats || {};
    toast(`个股知识库已重建：${stats.stocks ?? state.askStocks.length} 只标的 / ${stats.entries ?? '—'} 段分析`, 'info');
    if (state.askStock) await loadAskNote(state.askStock, true);
  } catch (error) {
    toast(`重建个股知识库失败：${errorMessage(error)}`, 'error');
  } finally {
    state.askStocksLoading = false; render();
  }
}

/** 读取某只股票的知识库；整理中/排队时自动轮询，完成后刷新 */
async function loadAskNote(code: string, silent = false): Promise<void> {
  if (!code) return;
  if (!silent) { state.askNoteLoading = true; state.askNoteError = ''; render(); }
  try {
    const note = await api.stockNote(code);
    if (String(state.askStock || '').toUpperCase() !== String(code).toUpperCase()) return;
    state.askNote = note;
    state.askNoteError = '';
    if (note.status === 'running' || note.status === 'queued') scheduleAskNotePoll(code);
    else askNotePolling = 0;
  } catch (error) {
    if (!silent) state.askNoteError = errorMessage(error);
  } finally {
    state.askNoteLoading = false; render();
  }
}

/** 整理是异步的：每 2.5 秒轮询一次，最多 80 次（200 秒）；同一时刻只留一个定时器 */
function scheduleAskNotePoll(code: string): void {
  if (askNotePollTimer || askNotePolling >= 80) return;
  askNotePolling += 1;
  askNotePollTimer = window.setTimeout(() => {
    askNotePollTimer = 0;
    if (state.view !== 'ask' || String(state.askStock || '').toUpperCase() !== String(code).toUpperCase()) return;
    void loadAskNote(code, true).then(() => {
      if (state.askNote && (state.askNote.status === 'running' || state.askNote.status === 'queued')) scheduleAskNotePoll(code);
      else if (state.askNote) void refreshAskStocksQuietly();
    });
  }, 2500);
}

/** 列表里的整理状态要跟着更新，但不打断右侧阅读（静默刷新） */
async function refreshAskStocksQuietly(): Promise<void> {
  try {
    const data = await api.stockNotes();
    state.askStocks = data.stocks || [];
    state.askStocksBuiltAt = data.built_at || '';
    askStocksAt = Date.now();
    render();
  } catch { /* 静默失败 */ }
}

async function selectAskStock(code: string): Promise<void> {
  const target = String(code || '').toUpperCase();
  if (!target) return;
  askNotePolling = 0;
  if (askNotePollTimer) { window.clearTimeout(askNotePollTimer); askNotePollTimer = 0; }
  state.askStock = target;
  state.askNote = null;
  state.askNoteError = '';
  state.askDraft = '';
  state.askError = '';
  state.askSuggestionsEditing = false;
  if (state.view !== 'ask') navigate('ask');
  else render();
  await loadAskNote(target);
  scrollAskThreadToBottom();
}

/** 手动触发二次整理（后端异步跑，前端轮询状态） */
async function curateAskStock(code: string): Promise<void> {
  const target = String(code || state.askStock || '').toUpperCase();
  if (!target) return;
  try {
    await api.stockCurate({ code: target });
    if (state.askNote) state.askNote = { ...state.askNote, status: 'queued', error: '' };
    render();
    toast('已提交知识库整理，完成后自动刷新。', 'info');
    window.setTimeout(() => { void loadAskNote(target, true); }, 1200);
  } catch (error) {
    toast(`提交整理失败：${errorMessage(error)}`, 'error');
  }
}

/** 知识库需要更新：直接发起个股快诊任务（完成后后端会自动二次整理） */
async function updateAskStock(code: string): Promise<void> {
  const target = String(code || state.askStock || '').toUpperCase();
  if (!target) return;
  await runQuickCheck(target);
  navigate('tasks');
  void loadJobs();
}

function toggleAskLetter(letter: string): void {
  if (!letter) return;
  state.askLetterCollapsed = { ...state.askLetterCollapsed, [letter]: !state.askLetterCollapsed[letter] };
  render();
}

/** 首字母索引导航：把对应分组滚到列表顶部（分组被折叠时先展开） */
function jumpToAskLetter(letter: string): void {
  if (!letter) return;
  if (state.askLetterCollapsed[letter]) {
    state.askLetterCollapsed = { ...state.askLetterCollapsed, [letter]: false };
    render();
  }
  window.requestAnimationFrame(() => {
    const list = document.querySelector<HTMLElement>('.ask-report-list');
    const target = document.getElementById(`ask-group-${letter}`);
    if (!list || !target) return;
    const top = target.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTop = Math.max(0, top - 2);
  });
}

/** 一键任务页内跳转：先保证在任务页，再滚动到锚点 */
function gotoTaskSection(targetId: string): void {
  if (state.view !== 'tasks') navigate('tasks');
  jumpToSection(targetId);
}

// ===== 追问预设提问：可增删改（localStorage 持久化）=====
const ASK_SUGGESTION_LIMIT = 12;

function persistAskSuggestionList(): void {
  persistAskSuggestions(state.askSuggestions.map((item) => item.trim()).filter(Boolean).slice(0, ASK_SUGGESTION_LIMIT));
}

function addAskSuggestion(): void {
  const input = document.querySelector<HTMLInputElement>('[data-ask-suggestion-new]');
  const text = (input?.value || '').trim();
  if (!text) { input?.focus(); return; }
  if (state.askSuggestions.filter((item) => item.trim()).length >= ASK_SUGGESTION_LIMIT) {
    toast(`预设提问最多 ${ASK_SUGGESTION_LIMIT} 条，先删掉一条再添加。`, 'error');
    return;
  }
  state.askSuggestions = [...state.askSuggestions, text];
  persistAskSuggestionList();
  render();
  window.requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-ask-suggestion-new]')?.focus());
}

/** 退出编辑态时收敛：去空、去重、截断上限 */
function finishAskSuggestionEdit(): void {
  const clean: string[] = [];
  state.askSuggestions.forEach((item) => {
    const text = String(item || '').trim();
    if (text && !clean.includes(text) && clean.length < ASK_SUGGESTION_LIMIT) clean.push(text);
  });
  state.askSuggestions = clean;
  persistAskSuggestions(clean);
  state.askSuggestionsEditing = false;
  render();
}

/** 全局「回到顶部」按钮显隐 */
function syncBackToTop(): void {
  const button = document.getElementById('backToTop');
  if (button) button.hidden = window.scrollY < 320;
}

async function startTemplate(id: string): Promise<void> {
  const template = state.templates.find((item) => item.id === id);
  if (!template || state.startingTemplates[id]) return;
  const draft = startDraft(template);
  const question = draft.question.trim();
  const rawCode = draft.code.trim();
  if (template.needsCode && !rawCode) {
    toast(NAME_INPUT_TEMPLATES.has(template.id) ? '请先填写代码或股票名，再开始分析。' : '请先填写标的代码，再开始分析。', 'error');
    document.querySelector<HTMLInputElement>(`[data-field="template-code-${id}"]`)?.focus();
    return;
  }
  state.startingTemplates[id] = true; render();
  try {
    let code = '';
    if (template.needsCode) {
      const resolvedCode = await resolveTemplateCode(template, draft);
      if (resolvedCode === null) return;
      code = resolvedCode;
    }
    const response = await api.run({ templateId: id, ...(code ? { code } : {}), ...(question ? { question } : {}) });
    if (!response.jobId) throw new Error('任务接口未返回 jobId');
    localJobMetadata.set(response.jobId, { name: template.name, templateId: id, templateName: template.name, code, question });
    mergeJob({ id: response.jobId, status: 'queued', createdAt: new Date().toISOString(), elapsedMs: 0, templateId: id, templateName: template.name, code, question });
    toast(`「${template.name}」已提交，正在跟踪执行进度。`, 'success');
    render();
    void pollJob(response.jobId);
  } catch (error) { toast(`任务提交失败：${errorMessage(error)}`, 'error'); }
  finally { state.startingTemplates[id] = false; render(); }
}


const HOLDINGS_DRAFT_KEY = 'dsh-invest.holdingsDraftId';

function storedHoldingsDraftId(): string {
  try { return window.sessionStorage.getItem(HOLDINGS_DRAFT_KEY) || ''; }
  catch { return ''; }
}

function rememberHoldingsDraft(id: string): void {
  try { window.sessionStorage.setItem(HOLDINGS_DRAFT_KEY, id); }
  catch { /* Draft recovery is optional when browser storage is unavailable. */ }
}

function clearRememberedHoldingsDraft(): void {
  try { window.sessionStorage.removeItem(HOLDINGS_DRAFT_KEY); }
  catch { /* No persistent state to clear. */ }
}

function acceptHoldingsDraft(draft: Awaited<ReturnType<typeof api.importHoldings>>): void {
  if (!draft || !draft.draftId || !Array.isArray(draft.positions)) {
    throw new Error('草稿接口返回不完整：缺少 draftId 或 positions。');
  }
  state.holdingsDraft = draft;
  state.holdingsActionError = '';
  rememberHoldingsDraft(draft.draftId);
}

async function loadHoldingsDraft(draftId: string, force = false): Promise<void> {
  if (!draftId || state.holdingsDraftLoading || (!force && state.holdingsDraft)) return;
  state.holdingsDraftLoading = true;
  state.holdingsActionError = '';
  render();
  try {
    acceptHoldingsDraft(await api.holdingsDraft(draftId));
    toast('已恢复服务器草稿，请继续核对；账本尚未修改。', 'info');
  } catch (error) {
    state.holdingsActionError = `草稿恢复失败：${errorMessage(error)}`;
    toast(state.holdingsActionError, 'error');
  } finally {
    state.holdingsDraftLoading = false;
    render();
  }
}

async function restoreRememberedHoldingsDraft(): Promise<void> {
  const id = storedHoldingsDraftId();
  if (id && !state.holdingsDraft) await loadHoldingsDraft(id);
}

async function beginHoldingsImport(
  source: string,
  loadInput: () => HoldingsImportInput | Promise<HoldingsImportInput>,
  focusCode = '',
): Promise<boolean> {
  if (state.holdingsImporting || state.holdingsConfirming) return false;
  state.holdingsImporting = source;
  state.holdingsActionError = '';
  render();
  let accepted = false;
  try {
    const input = await loadInput();
    acceptHoldingsDraft(await api.importHoldings(input));
    accepted = true;
    toast('草稿已生成，请核对差异并人工确认；当前账本尚未修改。', 'success');
  } catch (error) {
    state.holdingsActionError = `草稿生成失败：${errorMessage(error)}`;
    toast(state.holdingsActionError, 'error');
  } finally {
    state.holdingsImporting = '';
    render();
  }
  if (accepted && focusCode) {
    const input = Array.from(viewElement.querySelectorAll<HTMLInputElement>('[data-position-field="code"]'))
      .find((element) => element.value.trim().toUpperCase() === focusCode.toUpperCase());
    input?.focus({ preventScroll: false });
  }
  return accepted;
}

async function handleHoldingsFile(kind: 'csv' | 'screenshot', file: File): Promise<void> {
  if (kind === 'screenshot' && hasActiveAnalysisJobs()) {
    toast('分析任务进行中，模型暂不可用，请稍后再导入截图', 'info');
    return;
  }
  if (!file.size) { toast('所选文件为空，请重新选择。', 'error'); return; }
  if (kind === 'screenshot' && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type.toLowerCase())) {
    toast('截图仅支持 PNG、JPEG 或 WebP 格式。', 'error');
    return;
  }
  let prepared: PreparedScreenshot | null = null;
  if (kind === 'screenshot') {
    try { prepared = await prepareScreenshotForUpload(file); }
    catch (error) { toast('截图预处理失败：' + errorMessage(error), 'error'); return; }
    if (prepared.compressed) toast('截图较大（' + formatBytes(prepared.originalBytes) + '），已压缩为 ' + formatBytes(prepared.finalBytes) + ' 后识别', 'info');
  }
  await beginHoldingsImport(kind, async () => {
    if (kind === 'csv') return { source: 'csv', contentBase64: await fileToBase64(file) };
    return { source: 'screenshot', imageBase64: prepared!.base64, mimeType: prepared!.mimeType };
  });
}

async function editCurrentHoldings(focusCode = ''): Promise<void> {
  if (!state.holdings) { toast('请先成功读取当前账本，再手动编辑。', 'error'); return; }
  await beginHoldingsImport('manual', () => ({ source: 'manual' }), focusCode);
}

async function addManualPosition(): Promise<void> {
  if (!state.holdings) { toast('请先成功读取当前账本，避免新增时遗漏已有持仓。', 'error'); return; }
  const draft = state.manualPosition;
  const code = draft.code.trim();
  if (!code) {
    toast('请填写证券代码。', 'error');
    document.querySelector<HTMLInputElement>('[data-manual-field="code"]')?.focus();
    return;
  }
  if ((state.holdings.positions || []).some((position) => position.code.trim().toUpperCase() === code.toUpperCase())) {
    toast('该代码已在账本中，请使用“编辑现有表格”修改，避免产生重复行。', 'error');
    return;
  }
  for (const [field, label] of [
    ['shares', '股数'], ['cost', '成本'], ['available_shares', '可用数量'], ['current_price', '现价'],
  ] as const) {
    const raw = draft[field].trim();
    if (raw && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
      toast(`${label}需为不小于 0 的数字。`, 'error');
      document.querySelector<HTMLInputElement>(`[data-manual-field="${field}"]`)?.focus();
      return;
    }
  }
  const position: HoldingPosition = {
    code,
    name: draft.name.trim(),
    shares: draft.shares.trim(),
    available_shares: draft.available_shares.trim(),
    cost: draft.cost.trim(),
    current_price: draft.current_price.trim(),
    status: draft.status.trim(),
    note: draft.note.trim(),
  };
  const positions = [...(state.holdings.positions || []).map((item) => ({ ...item })), position];
  const accepted = await beginHoldingsImport('manual', () => ({ source: 'manual', positions }), code);
  if (accepted) {
    state.manualPosition = emptyManualPosition();
    render();
  }
}

function discardHoldingsDraft(): void {
  if (state.holdingsConfirming) return;
  state.holdingsDraft = null;
  state.holdingsActionError = '';
  clearRememberedHoldingsDraft();
  render();
  toast('已放弃整单草稿，账本未发生任何修改。', 'info');
}

function deleteDraftPosition(index: number): void {
  const draft = state.holdingsDraft;
  if (!draft || state.holdingsConfirming || !Number.isInteger(index)) return;
  if (index < 0 || index >= draft.positions.length) return;
  draft.positions.splice(index, 1);
  state.holdingsActionError = '';
  render();
}

function restoreDraftPosition(code: string): void {
  const draft = state.holdingsDraft;
  if (!draft || state.holdingsConfirming) return;
  if (draft.positions.some((position) => position.code.trim().toUpperCase() === code.trim().toUpperCase())) return;
  const current = (state.holdings?.positions || []).find((position) => position.code.trim().toUpperCase() === code.trim().toUpperCase());
  const original = current || (draft.diff?.removed || []).find((position) => position.code.trim().toUpperCase() === code.trim().toUpperCase());
  if (!original) { toast('未找到可恢复的原始持仓，请刷新账本后重试。', 'error'); return; }
  draft.positions.push({ ...original });
  render();
}

function addDraftRow(): void {
  const draft = state.holdingsDraft;
  if (!draft || state.holdingsConfirming) return;
  draft.positions.push({ code: '', name: '', shares: '', available_shares: '', cost: '', current_price: '', status: '持有', note: '' });
  render();
  const index = draft.positions.length - 1;
  document.querySelector<HTMLInputElement>(`[data-field="draft-${index}-code"]`)?.focus();
}

async function confirmHoldingsDraft(): Promise<void> {
  const draft = state.holdingsDraft;
  if (!draft || state.holdingsConfirming) return;
  const errors = validateHoldingsDraft(draft);
  if (errors.length) { toast(`请先修正草稿中的 ${errors.length} 项问题。`, 'error'); return; }
  state.holdingsConfirming = true;
  state.holdingsActionError = '';
  render();
  try {
    const response = await api.confirmHoldings({
      draftId: draft.draftId,
      positions: positionsForConfirm(draft.positions, draft.account),
      account: draft.account ? { ...draft.account } : undefined,
    });
    if (!response.ok) throw new Error('确认接口未返回成功状态。');
    state.holdingsDraft = null;
    state.holdingsQuotesInfo = '';
    clearRememberedHoldingsDraft();
    // 账本 → 标的档案同步结果提示（股数/成本已随账本回写，状态机变化在此说明）
    const synced = Array.isArray(response.watchSync) ? response.watchSync : [];
    const syncNote = synced.length
      ? ` 标的档案已同步 ${synced.length} 项（${synced.slice(0, 3).join('、')}${synced.length > 3 ? ' 等' : ''}）。`
      : '';
    const syncError = response.watchSyncError ? ` 标的档案同步失败：${response.watchSyncError}` : '';
    toast(`账本已确认写入。${response.backup ? ` 原账本备份：${response.backup}` : ''}${syncNote}${syncError}`, syncError ? 'error' : 'success');
    // 同步重载：持仓工作区数据 + 标的档案（股数/成本/状态机立即一致）
    await Promise.all([loadHoldings(), loadWatchlist()]);
  } catch (error) {
    state.holdingsActionError = `确认写入失败：${errorMessage(error)}。草稿与您的修改仍保留，可修正后重试。`;
    toast(state.holdingsActionError, 'error');
  } finally {
    state.holdingsConfirming = false;
    render();
  }
}

/** 一键刷新现价：账本态直接写账本（无需草稿确认）；编辑草稿时只更新草稿，避免覆盖正在改的内容 */
async function refreshHoldingsQuotes(): Promise<void> {
  if (state.holdingsQuotesLoading || state.holdingsConfirming || state.holdingsImporting) return;
  // 没有草稿 = 账本态：直接刷新并落账本，不再要求人工确认账本信息
  if (!state.holdingsDraft) {
    state.holdingsQuotesLoading = true;
    state.holdingsActionError = '';
    render();
    try {
      const result = await api.holdingsRefreshQuotes();
      const stamp = String(result.fetched_at || '').replace('T', ' ').slice(0, 16);
      const missing = result.missing?.length ? `（未取到：${result.missing.join('、')}）` : '';
      state.holdingsQuotesInfo = `账本现价已刷新 ${result.updated}/${result.total} 只 · ${stamp}${missing}`;
      await Promise.all([loadHoldings(), loadWatchlist()]);
      toast(`已直接刷新 ${result.updated}/${result.total} 只现价并写入账本${missing}`, 'success');
    } catch (error) {
      state.holdingsActionError = `刷新现价失败：${errorMessage(error)}`;
      toast(state.holdingsActionError, 'error');
    } finally {
      state.holdingsQuotesLoading = false;
      render();
    }
    return;
  }
  const source = state.holdingsDraft.positions || [];
  const codes = Array.from(new Set(source
    .map((p) => String(p.code || '').trim().toUpperCase())
    .filter((code) => /^\d{6}\.(SH|SZ|BJ)$/.test(code))));
  if (!codes.length) { toast('当前没有可刷新的有效证券代码。', 'error'); return; }
  state.holdingsQuotesLoading = true;
  state.holdingsActionError = '';
  render();
  try {
    const result = await api.holdingsQuotes(codes);
    const prices = result.prices || {};
    const hit = codes.filter((code) => typeof prices[code] === 'number' && Number.isFinite(prices[code]));
    if (!hit.length) {
      toast('行情接口未返回任何有效现价，请稍后重试或手工录入。', 'error');
      return;
    }
    const stamp = String(result.fetched_at || '').replace('T', ' ').slice(0, 16);
    const missing = result.missing?.length ? `（未取到：${result.missing.join('、')}）` : '';
    const info = `现价已更新 ${hit.length}/${codes.length} 只 · ${result.source || '腾讯'} ${stamp}${missing}`;
    const applyPrices = (p: HoldingPosition): HoldingPosition => {
      const code = String(p.code || '').trim().toUpperCase();
      return typeof prices[code] === 'number' ? { ...p, current_price: prices[code] } : { ...p };
    };
    if (state.holdingsDraft) {
      state.holdingsDraft.positions = (state.holdingsDraft.positions || []).map(applyPrices);
      state.holdingsQuotesInfo = info;
      toast('已按实时行情更新草稿现价，市值／盈亏／权重已自动重算；请核对后确认写入。', 'success');
    }
  } catch (error) {
    state.holdingsActionError = `现价刷新失败：${errorMessage(error)}`;
    toast(state.holdingsActionError, 'error');
  } finally {
    state.holdingsQuotesLoading = false;
    render();
  }
}

/** 当前账本的列顺序 / 排序偏好持久化到本机浏览器 */
function persistLedgerPrefs(): void {
  try {
    window.localStorage.setItem('dsh-invest.ledgerColumns', JSON.stringify(state.ledgerColumns));
    window.localStorage.setItem('dsh-invest.ledgerSort', JSON.stringify(state.ledgerSort));
  } catch { /* 无法持久化时仅本次生效 */ }
}

/** 个股快检：从「实时持仓」/「观察」栏一键发起 stock-quick 任务，无需切到一键任务页 */
async function runQuickCheck(code: string): Promise<void> {
  const templateId = 'stock-quick';
  const templateName = '个股快诊';
  try {
    const response = await api.run({ templateId, code });
    if (!response.jobId) throw new Error('任务接口未返回 jobId');
    localJobMetadata.set(response.jobId, { name: '个股快检 · ' + code, templateId, templateName, code });
    mergeJob({ id: response.jobId, status: 'queued', createdAt: new Date().toISOString(), elapsedMs: 0, templateId, templateName, code });
    toast(`已对 ${code} 发起个股快检，可在「一键任务」查看进度。`, 'success');
    void pollJob(response.jobId);
  } catch (error) { toast(`快检发起失败：${errorMessage(error)}`, 'error'); }
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, ms)); }

let postJobSyncChain: Promise<void> = Promise.resolve();

/** 任务完成后的数据同步（串行链：多任务同时完成时排队执行，避免并发重建索引/写档案）：
 *  重建标的索引 + 刷新标的档案现价与监控规则（含信号比对）+ 重读当前档案的结论链 */
function syncAfterJobDone(): Promise<void> {
  postJobSyncChain = postJobSyncChain.then(async () => {
    try {
      try { await api.reindex(); }
      catch (error) { toast(`任务已完成，但索引重建失败：${errorMessage(error)}`, 'error'); }
      const syncs: Promise<void>[] = [
        loadIndex(),
        (async () => {
          try { await api.watchlistRefresh(); } catch { /* 行情拉取失败静默处理，档案仍照常重载 */ }
          await loadWatchlist();
        })(),
      ];
      // 个股知识库：报告更新后清单会变；若用户正开着某只股票，重读它的整理状态
      if (state.view === 'ask') {
        syncs.push(loadAskStocks(true));
        if (state.askStock) syncs.push(loadAskNote(state.askStock, true));
      }
      if (state.selectedCode) syncs.push(reloadArchiveConclusions(state.selectedCode));
      await Promise.all(syncs);
    } catch (error) { toast(`任务完成后的数据同步失败：${errorMessage(error)}`, 'error'); }
  });
  return postJobSyncChain;
}

async function pollJob(id: string): Promise<void> {
  if (pollingJobs.has(id)) return;
  pollingJobs.add(id);
  let failures = 0;
  try {
    while (true) {
      await delay(1200);
      try {
        const job = await api.job(id);
        failures = 0;
        mergeJob(job); render();
        if (job.status === 'done') {
          toast('分析已完成，正在重建索引并归档报告。', 'success');
          cacheRecentJobs(state.jobs);
          // 同步监控规则现价、结论链与标的索引，档案页数据随之更新
          void syncAfterJobDone();
          void loadJobs();
          break;
        }
        if (job.status === 'failed') { toast(`任务执行失败：${job.error || '请查看任务详情'}`, 'error'); cacheRecentJobs(state.jobs); void loadJobs(); break; }
      } catch (error) {
        failures += 1;
        if (failures >= 3) { toast(`任务进度连接中断：${errorMessage(error)}`, 'error'); break; }
      }
    }
  } finally { pollingJobs.delete(id); }
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action]') : null;
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'navigate' && target.dataset.view) navigate(target.dataset.view as WorkbenchView);
  else if (action === 'back-to-top') window.scrollTo({ top: 0, behavior: 'smooth' });
  else if (action === 'ask-latest-report' && target.dataset.code) {
    // 标的档案的「追问」入口：直接进这只股票的知识库
    void selectAskStock(target.dataset.code);
  }
  else if (action === 'ask-report' && target.dataset.path) {
    // 运行记录/概览/任务卡的「追问」只带报告路径：解析出个股后进知识库
    const code = codeForReportPath(target.dataset.path) || String(target.dataset.code || '');
    if (!code) { toast('该报告没有个股归属，无法进入个股知识库。', 'info'); return; }
    void selectAskStock(code);
  }
  else if (action === 'ask-stock-select' && target.dataset.code) void selectAskStock(target.dataset.code);
  else if (action === 'ask-letter-toggle' && target.dataset.letter) toggleAskLetter(target.dataset.letter);
  else if (action === 'ask-letter-jump' && target.dataset.letter) jumpToAskLetter(target.dataset.letter);
  else if (action === 'ask-stocks-rebuild') void rebuildAskStocks();
  else if (action === 'ask-curate' && target.dataset.code) void curateAskStock(target.dataset.code);
  else if (action === 'ask-run' && target.dataset.code) void updateAskStock(target.dataset.code);
  else if (action === 'ask-kb-expand') {
    const note = state.askNote;
    if (!note) return;
    openMarkdown(`${note.name || note.code} · 知识库`, note.markdown,
      `更新于 ${note.updated_at || '尚未整理'} ｜ ${note.count} 段分析 ｜ 整理模型 ${note.model || '继承宿主'}`);
  }
  else if (action === 'ask-ask' && target.dataset.question) void askAboutStock(state.askStock, target.dataset.question);
  else if (action === 'ask-send') void askAboutStock(state.askStock);
  else if (action === 'ask-suggest-edit') {
    if (state.askSuggestionsEditing) finishAskSuggestionEdit();
    else { state.askSuggestionsEditing = true; render(); }
  }
  else if (action === 'ask-suggest-remove' && target.dataset.index !== undefined) {
    const index = Number(target.dataset.index);
    if (Number.isInteger(index) && index >= 0) {
      state.askSuggestions = state.askSuggestions.filter((_, i) => i !== index);
      persistAskSuggestionList();
      render();
    }
  }
  else if (action === 'ask-suggest-add') addAskSuggestion();
  else if (action === 'ask-suggest-reset') {
    state.askSuggestions = [...DEFAULT_ASK_SUGGESTIONS];
    persistAskSuggestionList();
    toast('预设提问已恢复默认。', 'info');
    render();
  }
  else if (action === 'toggle-theme') toggleTheme();
  else if (action === 'toggle-sidebar') { state.sidebarOpen = !state.sidebarOpen; render(); }
  else if (action === 'close-sidebar') { state.sidebarOpen = false; render(); }
  else if (action === 'open-active-tasks') { gotoTaskSection('jobs-panel'); }
  else if (action === 'scroll-to' && target.dataset.target) {
    jumpToSection(target.dataset.target);
  }
  else if (action === 'goto-runs') gotoTaskSection('runs-panel');
  else if (action === 'goto-jobs') gotoTaskSection('jobs-panel');
  else if (action === 'refresh') void refreshAll();
  else if (action === 'select-code' && target.dataset.code) void selectCode(target.dataset.code);
  else if (action === 'open-run' && target.dataset.id !== undefined) openRun(target.dataset.id);
  else if (action === 'open-report-id' && target.dataset.id !== undefined) openReportById(target.dataset.id);
  else if (action === 'open-job-report' && target.dataset.id) openJobReport(target.dataset.id);
  else if (action === 'start-template' && target.dataset.id) void startTemplate(target.dataset.id);
  else if (action === 'template-move' && target.dataset.id) moveTemplate(target.dataset.id, Number(target.dataset.dir || 0));
  else if (action === 'refresh-jobs') void loadJobs();
  else if (action === 'clear-run-filters') { state.runQuery = ''; state.runMode = 'all'; state.runStatus = 'all'; state.runHideBackfill = false; render(); }
  else if (action === 'save-model-settings') void saveModelSettings();
  else if (action === 'refresh-holdings') void loadHoldings();
  else if (action === 'edit-holdings') void editCurrentHoldings(target.dataset.code || '');
  else if (action === 'add-manual-position') void addManualPosition();
  else if (action === 'discard-holdings-draft') discardHoldingsDraft();
  else if (action === 'reload-holdings-draft' && state.holdingsDraft) {
    if (window.confirm('将丢弃确认页中尚未提交的修改，并恢复服务器草稿。是否继续？')) {
      void loadHoldingsDraft(state.holdingsDraft.draftId, true);
    }
  }
  else if (action === 'delete-draft-position') deleteDraftPosition(Number(target.dataset.index));
  else if (action === 'restore-draft-position' && target.dataset.code) restoreDraftPosition(target.dataset.code);
  else if (action === 'add-draft-row') addDraftRow();
  else if (action === 'confirm-holdings') void confirmHoldingsDraft();
  else if (action === 'refresh-holdings-quotes') void refreshHoldingsQuotes();
  else if (action === 'refresh-watchlist') void refreshWatchlist();
  else if (action === 'watch-daily-toggle') void toggleWatchDaily();
  else if (action === 'watch-daily-run') void runWatchDaily();
  else if (action === 'toggle-notify') void toggleSystemNotify();
  else if (action === 'watch-alerts-read') void markAlertsRead();
  else if (action === 'watch-toggle-edit') { state.watchEditOpen = !state.watchEditOpen; render(); }
  else if (action === 'watch-save' && target.dataset.code) void saveWatchItem(target.dataset.code);
  else if (action === 'watch-create' && target.dataset.code) void createWatch(target.dataset.code);
  else if (action === 'quick-check' && target.dataset.code) void runQuickCheck(target.dataset.code);
  else if (action === 'watch-dist-mode' && target.dataset.mode) {
    state.watchDistMode = target.dataset.mode === 'stop' ? 'stop' : 'target';
    render();
  }
  else if (action === 'ledger-sort' && target.dataset.key) {
    const key = target.dataset.key as LedgerColKey;
    const cur = state.ledgerSort;
    if (!cur || cur.key !== key) state.ledgerSort = { key, dir: 'asc' };
    else if (cur.dir === 'asc') state.ledgerSort = { key, dir: 'desc' };
    else state.ledgerSort = null;
    persistLedgerPrefs();
    render();
  }
  else if (action === 'ledger-col-move' && target.dataset.key) {
    const key = target.dataset.key as LedgerColKey;
    const dir = Number(target.dataset.dir || 0);
    const arr = [...state.ledgerColumns];
    const i = arr.indexOf(key), j = i + dir;
    if (i >= 0 && j >= 0 && j < arr.length) {
      [arr[i], arr[j]] = [arr[j], arr[i]];
      state.ledgerColumns = arr;
      persistLedgerPrefs();
      render();
    }
  }
  else if (action === 'ledger-col-reset') {
    state.ledgerColumns = [...LEDGER_DEFAULT_COLUMNS];
    persistLedgerPrefs();
    render();
  }
  else if (action === 'close-reader') closeReader();
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
  if (target.dataset.roleRoute) {
    state.modelRoleRoutes[target.dataset.roleRoute] = target.value;
    render();
  }
  else if (target.dataset.manualField) {
    const field = target.dataset.manualField as keyof typeof state.manualPosition;
    if (['code', 'name', 'shares', 'available_shares', 'cost', 'current_price', 'status', 'note'].includes(field)) {
      state.manualPosition[field] = target.value;
    }
  }
  else if (target.dataset.positionIndex !== undefined && target.dataset.positionField) {
    const draft = state.holdingsDraft;
    const index = Number(target.dataset.positionIndex);
    const allowed = ['code', 'name', 'shares', 'available_shares', 'cost', 'current_price', 'status', 'note'];
    const field = target.dataset.positionField as 'code' | 'name' | 'shares' | 'available_shares' | 'cost' | 'current_price' | 'status' | 'note';
    if (draft && Number.isInteger(index) && draft.positions[index] && allowed.includes(field)) {
      draft.positions[index][field] = target.value;
      state.holdingsActionError = '';
      const composing = (event as InputEvent).isComposing || target.dataset.imeComposing === 'true';
      if (!composing) render();
    }
  }
  else if (target.dataset.accountField && state.holdingsDraft) {
    const field = target.dataset.accountField;
    if (field === 'total_asset' || field === 'available_cash') {
      state.holdingsDraft.account = { ...state.holdingsDraft.account, [field]: target.value };
      state.holdingsActionError = '';
      const composing = (event as InputEvent).isComposing || target.dataset.imeComposing === 'true';
      if (!composing) render();
    }
  }
  else if (target.dataset.field === 'archive-query') { state.archiveQuery = target.value; render(); }
  else if (target.dataset.field === 'run-query') { state.runQuery = target.value; render(); }
  else if (target.dataset.field === 'ask-query') { state.askQuery = target.value; render(); }
  else if (target.dataset.field === 'ask-input') { state.askDraft = target.value; }
  if (target.dataset.templateId && target.dataset.draft) {
    const id = target.dataset.templateId;
    const draft = state.taskDrafts[id] || { code: '', question: '' };
    draft[target.dataset.draft === 'code' ? 'code' : 'question'] = target.value;
    state.taskDrafts[id] = draft;
  }
});

document.addEventListener('compositionstart', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) event.target.dataset.imeComposing = 'true';
});
document.addEventListener('compositionend', (event) => {
  if (!(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) return;
  delete event.target.dataset.imeComposing;
  // 组合输入期间仅更新 state，结束后一次性重绘，避免中文候选被替换节点打断
  render();
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.dataset.holdingsFile) {
    const kind = target.dataset.holdingsFile;
    const file = target.files?.[0];
    target.value = '';
    if (file && (kind === 'csv' || kind === 'screenshot')) void handleHoldingsFile(kind, file);
    return;
  }
  // 运行记录：隐藏「报告归档」回填条目
  if (target instanceof HTMLInputElement && target.dataset.field === 'run-hide-backfill') {
    state.runHideBackfill = target.checked;
    render();
    return;
  }
  // 知识库：后台自动整理开关（只改草稿，保存后生效）
  if (target instanceof HTMLInputElement && target.dataset.stockkbAuto !== undefined) {
    state.modelStockKbAutoDraft = target.checked;
    render();
    return;
  }
  if (target instanceof HTMLInputElement && target.dataset.watchDailyAt !== undefined) {
    void saveWatchDailyAt(target.value);
    return;
  }
  // 追问预设：改文字即时落盘（不重绘，避免输入框失焦；空行在「完成」时收敛掉）
  if (target instanceof HTMLInputElement && target.dataset.askSuggestion !== undefined) {
    const index = Number(target.dataset.askSuggestion);
    if (Number.isInteger(index) && index >= 0 && index < state.askSuggestions.length) {
      const next = [...state.askSuggestions];
      next[index] = target.value;
      state.askSuggestions = next;
      persistAskSuggestionList();
    }
    return;
  }
  if (!(target instanceof HTMLSelectElement)) return;
  if (target.dataset.stockkbConcurrency !== undefined) {
    state.modelStockKbConcurrencyDraft = Number(target.value) || 3;
    render();
    return;
  }
  if (target.hasAttribute('data-watch-state') && target.dataset.code) {
    void changeWatchState(target.dataset.code, target.value);
    return;
  }
  // 宿主模型选择：只改草稿，点「保存设置」才提交
  if (target.hasAttribute('data-host-model')) {
    state.modelHostDraft = target.value;
    render();
    return;
  }
  if (target.dataset.roleModel === 'stockKb' || target.dataset.roleEffort === 'stockKb') {
    const current = splitStockKbRoute(state.modelStockKbDraft || state.modelSettings?.stockKb?.model || '');
    const model = target.dataset.roleModel ? target.value : current.model;
    const effort = target.dataset.roleEffort ? target.value : current.effort;
    state.modelStockKbDraft = model === 'inherit' ? 'inherit' : model + (effort === 'default' ? '' : '@' + effort);
    render();
    return;
  }
  if (target.dataset.roleModel || target.dataset.roleEffort) {
    const code = target.dataset.roleModel || target.dataset.roleEffort || '';
    const previous = state.modelRoleRoutes[code] || 'inherit';
    const first = previous.split('|')[0];
    const at = first.lastIndexOf('@');
    let model = target.dataset.roleModel ? target.value : (first === 'inherit' ? 'inherit' : (at > 0 ? first.slice(0, at) : first));
    // 未显式指定推理强度时默认 default：不下发 reasoningEffort，由模型自身决定
    let effort = target.dataset.roleEffort ? target.value : (at > 0 ? first.slice(at + 1) : 'default');
    if (model === 'inherit') effort = 'default';
    const fallbackSuffix = model !== 'inherit' && previous.includes('|') ? previous.slice(previous.indexOf('|')) : '';
    state.modelRoleRoutes[code] = model === 'inherit' ? 'inherit'
      : model + (effort === 'default' ? '' : '@' + effort) + fallbackSuffix;
    render();
    return;
  }
  if (target.dataset.templatePreset) {
    state.modelTemplatePresets[target.dataset.templatePreset] = target.value;
    render();
  }
  else if (target.dataset.field === 'run-mode') { state.runMode = target.value; render(); }
  else if (target.dataset.field === 'run-status') { state.runStatus = target.value as typeof state.runStatus; render(); }
});

document.addEventListener('keydown', (event) => {
  // 报告追问：Ctrl/⌘ + Enter 发送
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    const askInput = event.target instanceof HTMLElement ? event.target.closest<HTMLTextAreaElement>('[data-field="ask-input"]') : null;
    if (askInput) {
      event.preventDefault();
      state.askDraft = askInput.value;
      void askAboutStock(state.askStock);
      return;
    }
  }
  // 追问预设：在新增输入框里回车 = 添加
  if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
    const newSuggestion = event.target instanceof HTMLElement ? event.target.closest<HTMLInputElement>('[data-ask-suggestion-new]') : null;
    if (newSuggestion) { event.preventDefault(); addAskSuggestion(); return; }
  }
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target instanceof Element ? event.target.closest<HTMLTableRowElement>('tr[data-action="open-run"]') : null;
  if (!target || event.target !== target || !target.dataset.id) return;
  event.preventDefault(); openRun(target.dataset.id);
});

// 系统通知的页面内兜底：无论浏览器是否授权，都弹一条 toast，保证提醒「更明显」
window.addEventListener('dsh-invest:system-notify', (event) => {
  const detail = (event as CustomEvent<SystemNotice>).detail;
  if (detail && detail.body) toast(detail.body, 'info');
});
// 提醒主动推送轮询：60 秒一次（标签页可见时）
window.setInterval(() => { void pollWatchAlerts(); }, 60 * 1000);
// 全局「回到顶部」按钮 + 用户滚动感知：手动滚过就作废待恢复的滚动目标
window.addEventListener('scroll', (event) => {
  if (!programmaticScroll && (event.target === document || event.target === document.scrollingElement)) {
    lastUserScrollAt = Date.now();
    pendingWindowScroll = null;
  }
  syncBackToTop();
}, { passive: true });
syncBackToTop();

hydrateStaticIcons();
initialiseTheme();
initialiseReader();
state.lastRefreshAt = readLastRefreshAt();
render();
const bootLoaded = Promise.all([loadIndex(), loadHoldings(), loadJobs(), loadWatchlist(), loadWatchDaily(), loadAskStocks()]);
// 每天首次打开自动刷新（含现价与信号比对）
void bootLoaded.then(() => autoDailyRefresh());
// 页面跨天整晚开着由定时器触发；睡眠唤醒/切回标签页由可见性变化触发
window.setInterval(() => { void autoDailyRefresh(); }, 30 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void autoDailyRefresh(); });