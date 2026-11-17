export type Id = string | number;

export interface RunStage {
  stage: string;
  ok?: boolean;
  ms?: number;
  /** 失败原因摘要（v0.44.0 起写入 runs.jsonl，用于运行记录里直接定位失败原因） */
  error?: string;
}

export interface RunRecord {
  id: Id;
  ts_local?: string;
  created_at?: string;
  mode?: string;
  question?: string;
  codes?: string[];
  ok?: boolean;
  status?: string;
  elapsed_ms?: number;
  stages?: RunStage[];
  reports?: string[];
  charts?: string[];
  error?: string;
}

export interface ReportRecord {
  id: Id;
  path: string;
  /** 报告里出现的标的代码（索引构建时抽取，孤儿报告回填运行记录时使用） */
  codes?: string[];
  run_id?: Id;
  title?: string;
  charts?: string[];
  created_at?: string;
}

export interface ConclusionRecord {
  id: Id;
  run_id?: Id | null;
  report_id?: Id | null;
  callId?: string;
  code: string;
  name?: string;
  asof?: string;
  ts?: string;
  stance?: string;
  target?: string | number | null;
  stop?: string | number | null;
  thesis?: string;
  invalidate_if?: string;
  invalidation?: string;
  invalid_condition?: string;
  diff_from_previous?: unknown;
  diff?: unknown;
  changes?: unknown;
  source?: string;
}

export interface CodeIndexEntry {
  name?: string;
  records?: Id[];
  runs?: Id[];
  reports?: Id[];
}

export interface IndexStats {
  runs?: number;
  records?: number;
  structured_records?: number;
  codes?: number;
  reports?: number;
  runs_matched_report?: number;
  charts_on_disk?: number;
  db_path?: string;
  database?: string;
  [key: string]: unknown;
}

export interface IndexResponse {
  built_at: string | null;
  stats: IndexStats;
  runs: RunRecord[];
  reports: ReportRecord[];
  records: ConclusionRecord[];
  codes: Record<string, CodeIndexEntry>;
  storage?: { primary?: string; sqlite?: string; projection?: string };
}

export interface HoldingPosition {
  code: string;
  name?: string;
  pool?: string;
  cost?: string | number;
  shares?: string | number;
  /** 可用数量（可卖股数）——从券商备注拆出的独立字段 */
  available_shares?: string | number;
  /** 现价：手工录入为主，可由「一键刷新现价」批量更新 */
  current_price?: string | number;
  /** 市值 = 股数 × 现价（计算列，随成本/股数/现价联动） */
  market_value?: string | number;
  /** 持仓盈亏金额 = 股数 × (现价 − 成本)（计算列） */
  pnl?: string | number;
  /** 持仓盈亏比例 % = (现价 − 成本) / 成本 × 100（计算列） */
  pnl_pct?: string | number;
  /** 权重 % = 市值 / 账户总资产 × 100（计算列） */
  weight_pct?: string | number;
  status?: string;
  stop?: string | number | null;
  target?: string | number | null;
  /** 仅自由文本标签（如「场内基金」）；结构化数据已拆为独立字段 */
  note?: string;
}

export interface HoldingsAccount {
  total_asset?: string | number;
  available_cash?: string | number;
  [key: string]: unknown;
}

export interface HoldingsResponse {
  positions?: HoldingPosition[];
  account?: HoldingsAccount;
  updated_at?: string;
  none?: boolean;
}

export interface HoldingsDiff {
  added: HoldingPosition[];
  modified: HoldingPosition[];
  removed: HoldingPosition[];
  unchanged: HoldingPosition[];
}

export type HoldingsImportSource = 'csv' | 'screenshot' | 'manual';

export interface HoldingsDraftResponse {
  draftId: string;
  /** 截图导入的识别引擎：local-ocr（离线 OCR）/ vision（多模态兜底） */
  engine?: 'local-ocr' | 'vision';
  source: HoldingsImportSource | string;
  positions: HoldingPosition[];
  account?: HoldingsAccount;
  diff: HoldingsDiff;
  warnings?: string[];
}

export type HoldingsImportInput =
  | { source: 'csv'; contentBase64: string }
  | { source: 'screenshot'; imageBase64: string; mimeType: string }
  | { source: 'manual'; positions?: HoldingPosition[] };

export interface HoldingsConfirmResponse {
  ok: true;
  updated_at?: string;
  backup?: string;
  diff?: HoldingsDiff;
  /** 账本 → 标的档案同步结果（如「600519.SH 股数 200」「000001.SZ 持有→已清仓」） */
  watchSync?: string[];
  watchSyncError?: string;
}

/** POST /holdings/quotes 的响应：腾讯实时行情，按完整代码回传现价 */
export interface HoldingsQuotesResponse {
  ok: true;
  source: string;
  fetched_at: string;
  prices: Record<string, number>;
  missing: string[];
}

export interface ModelRoleSetting {
  code: string;
  name: string;
  route: string;
}

export interface ModelTemplateSetting {
  id: string;
  name: string;
  preset: string;
}

export interface ModelPresetDefinition {
  id: string;
  name: string;
  description: string;
}

export interface ModelOption {
  value: string;
  label: string;
  provider?: string;
  model?: string;
}

/** 当前宿主模型（「继承宿主」实际落到哪个模型） */
export interface HostModelInfo {
  provider?: string;
  model: string;
  /** 推理强度（仅覆盖值带 @effort 时存在） */
  reasoningEffort?: string;
  label: string;
  source?: 'session' | 'override';
}

/** 任务模板中某个角色的生效模型 */
export interface EffectiveModel {
  role: string;
  /** 路由备选链展示串；空链为「继承宿主」 */
  route: string;
  /** 实际首选模型；空链时为宿主模型 label */
  resolved: string;
}

export interface ModelSettingsResponse {
  /** 当前生效宿主模型（模型设置里的覆盖优先，缺省为会话模型） */
  hostModel?: HostModelInfo | null;
  /** 当前会话根 Agent 的模型（只读对照） */
  sessionModel?: HostModelInfo | null;
  /** 个股知识库二次整理使用的模型 */
  stockKb?: { model: string; default: string; auto?: boolean; concurrency?: number; description: string };
  roles: ModelRoleSetting[];
  templates: ModelTemplateSetting[];
  presets: ModelPresetDefinition[];
  modelOptions?: ModelOption[];
}

export type ModelSettingsSaveInput =
  | { scope: 'role'; role: string; route: string }
  | { scope: 'template'; templateId: string; preset: string }
  | { scope: 'host'; value: string }
  | { scope: 'stockKb'; model: string; auto?: boolean; concurrency?: number };

export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  mode: string;
  roles: string[];
  /** 显式串行顺序：非空时各角色按此顺序逐段串行（如 选股→消息→深度→总判断） */
  sequence?: string[] | null;
  needsCode: boolean;
  placeholder?: string;
  /** 模板生效预设档 */
  preset?: string;
  /** 各角色生效模型（一键任务回显实际使用模型） */
  effectiveModels?: EffectiveModel[];
  /** 该模板实际使用的宿主模型 label */
  hostModel?: string;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type JobProgress = string | number | {
  stage?: string;
  index?: number;
  total?: number;
  status?: string;
  done?: Array<{ stage: string; ms: number; route?: string }>;
  elapsedMs?: number;
  updatedAt?: string;
  message?: string;
  label?: string;
};

export interface JobOutput {
  stage: string;
  ok: boolean;
  elapsedMs?: number;
  route?: string;
  error?: string;
  text?: string;
}
export interface JobResult {
  reports?: string[];
  charts?: string[];
  outputs?: JobOutput[];
}

export interface Job {
  /** 任务模式（个股/选股/总判断…）；历史任务也有 */
  mode?: string;
  /** true = 来自持久化的历史任务（跨 web 关闭保留） */
  persisted?: boolean;
  /** 历史任务保存的报告路径（persisted 时使用） */
  reportPath?: string;
  id: string;
  status: JobStatus;
  createdAt: string | number;
  elapsedMs?: number;
  progress?: JobProgress;
  result?: JobResult;
  error?: string;
  name?: string;
  templateId?: string;
  templateName?: string;
  code?: string;
  question?: string;
}

/** 结论影子跟踪（v7 契约）：把 AI 判断放进行情里走一遍的结果。 */
export interface StrategyTrialRecord {
  id: string;
  code: string;
  stance: string;
  expected_direction: number;
  proposed_at: string | null;
  proposed_date: string;
  source_call_id: string | null;
  mode: string | null;
  target: number | null;
  stop: number | null;
  status: 'skipped' | 'open' | 'closed';
  skip_reason: string | null;
  entry_date: string | null;
  entry_price: number | null;
  exit_date: string | null;
  exit_price: number | null;
  exit_reason: string | null;
  pnl: number | null;
  pnl_ratio: number | null;
  ret5: number | null;
  ret10: number | null;
  hit5: boolean | null;
  hit10: boolean | null;
  mark_date?: string | null;
  mark_price?: number | null;
}

export interface StrategyHitStat {
  n: number;
  hits: number;
  rate: number | null;
}

export interface StrategyTrials {
  generated_at: string | null;
  source: string;
  rules: {
    entry: string;
    shares: number;
    max_hold_days: number;
    exit: string;
    long_stances: string[];
  };
  summary: {
    total: number;
    by_stance: Record<string, number>;
    direction_hit_5d: { expected_up: StrategyHitStat; expected_down: StrategyHitStat };
    direction_hit_10d: { expected_up: StrategyHitStat; expected_down: StrategyHitStat };
    long_trials: { n: number; open: number; closed: number; pnl_total: number; wins: number };
    skipped: Record<string, number>;
  };
  records: StrategyTrialRecord[];
}

export type WorkbenchView = 'overview' | 'archive' | 'runs' | 'tasks' | 'ask' | 'model-settings' | 'holdings' | 'backtest' | 'strategy-health';

// ===== 策略健康（v0.59.0）=====
// 只读消费 LihuQuantify 导出的模拟盘契约（outputs/strategy_health.json，schema_version=1）。
// 账本边界：account_type 恒为 "paper"。Lihu 跑的是模拟盘验证，与 .dsh-invest/持仓.json 实盘严格分开，
// 服务端遇到非 paper 会直接拒（reason="not_paper_account"）。
export interface StrategyHealthRisk {
  max_single_position: number;
  min_concurrent_positions: number;
  mdd_limit: number;
  n_positions: number | null;
  max_single_weight: number | null;
  current_drawdown: number | null;
  drawdown_note?: string;
  status: 'ok' | 'warn' | 'breach' | 'unknown';
  largest_position?: string;
}

export interface StrategyHealthFinding {
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** 波段池（v3 契约）：策略已证伪，页面主调是「别做」，不是「策略不错」。 */
export interface SwingHolding {
  code?: string | null;
  name?: string | null;
  pool?: string | null;
  price?: string | null;
  target?: string | null;
  stop?: string | null;
  state?: string | null;
  next_check?: string | null;
}

export interface SwingControl {
  mean: number | null;
  baseline_percentile: number | null;
  q5: number | null;
  q95: number | null;
}

export interface StrategySwing {
  strategy_status: 'falsified' | 'unknown';
  pool: {
    exists: boolean;
    statements: string[];
    holdings: SwingHolding[];
    parse_ok: boolean;
    as_of: string | null;
    raw_excerpt: string;
  } | null;
  backtest: {
    generated_at?: string;
    params?: Record<string, unknown>;
    metrics: Record<string, number>;
    yearly?: Record<string, Record<string, number>>;
    funnel?: Record<string, number>;
    exit_reasons?: Record<string, number>;
    disclaimers?: string[];
  } | null;
  robustness: {
    windows: {
      window: string[];
      baseline_total_return: number | null;
      controls: Record<string, SwingControl>;
      matched_headline: boolean;
    }[];
  } | null;
}

/** 模拟盘总览（v4 契约）：今日巡检的权威结果是 last_scan 的 summary，客户端不重算。 */
export interface StrategyOverview {
  trade_date: string | null;
  finished_at: string | null;
  market_state: string | null;
  entry_scale: number | null;
  market_gate: { state: string | null; mode: string | null; gate_open: boolean | null } | null;
  counts: {
    signals: number | null;
    executed: number | null;
    rejected: number | null;
    sells_today: number | null;
    pending_stops: number | null;
    halted: number | null;
    stale_dropped: number | null;
  };
  account: {
    cash: number | null;
    total_asset: number | null;
    market_value: number | null;
    init_capital: number | null;
    total_return: number | null;
    today_pnl: { amount: number; ratio: number; basis: string } | null;
  };
  positions: {
    code: string | null; name: string | null; volume: number | null;
    cost: number | null; price: number | null; market_value: number | null;
    pnl_ratio: number | null; stop_price: number | null;
  }[];
  review: Record<string, number | string> | null;
  capital: Record<string, number> | null;
  alerts: string[];
  brief: string | null;
  brief_is_ai: boolean;
  ai_summary: string | null;
  report_name: string | null;
}

/** 策略回测（v5 契约）：回测绩效与网格寻优是两套不可比的数，页面必须分开。 */
export interface StrategyBacktestMain {
  generated_at: string | null;
  config_hash: string | null;
  init_capital: number | null;
  market_filter_mode: string | null;
  pool: {
    type?: string; strategy?: string; n_requested?: number; n_with_data?: number;
    years?: number; end_date?: string; survivorship_bias?: string;
  } | null;
  metrics: Record<string, number>;
  rules_included: Record<string, boolean | string> | null;
  curve: { d: string; v: number }[];
  curve_points_total: number;
}

export interface StrategyGridRow {
  file: string;
  pool_label: string | null;
  pool_built_date: string | null;
  data_segment: string[] | null;
  n_robust: number | null;
  n_total: number | null;
  best: Record<string, number> | null;
  orig_params: number[] | null;
  orig_total_return: number | null;
  orig_robust: boolean | null;
  survivorship_bias: string | null;
}

export interface StrategyBacktest {
  main: StrategyBacktestMain | null;
  grid: StrategyGridRow[];
  /** 幸存者偏差说明抬成一级字段：页面必须显著展示，不能埋进 pool */
  survivorship_bias: string | null;
}

/** 巡检日报（v6 契约）：只抽字段，不下发全文。铁律自检未通过项单列。 */
export interface StrategyReportEntry {
  date: string;
  title_date: string | null;
  /** 文件名与标题日期不一致 → 日报可能被复制或改名，页面要标出来 */
  date_mismatch: boolean;
  report_name: string;
  market_state: string | null;
  total_asset: number | null;
  pnl_ratio: number | null;
  review: string | null;
  positions: number | null;
  ops: string | null;
  checks: { ok: boolean; text: string }[];
  checks_failed: string[];
}

export interface StrategyReports {
  total: number;
  recent: StrategyReportEntry[];
}

export interface StrategyHealthSnapshot {
  schema_version: number;
  source: string;
  account_type: string;
  generated_at: string;
  /** v2 起有；v1 快照没有这个字段，渲染时必须降级而不是报错 */
  equity?: StrategyEquity | null;
  /** v3 起有 */
  swing?: StrategySwing | null;
  /** v4 起有：今日巡检总览 */
  overview?: StrategyOverview | null;
  /** v5 起有：策略回测 + 网格寻优 */
  backtest?: StrategyBacktest | null;
  /** v6 起有：巡检日报（最近若干天） */
  reports?: StrategyReports | null;
  /** v7 起有：AI 结论影子跟踪 */
  strategy_trials?: StrategyTrials | null;
  strategy: {
    main: string | null;
    market_filter?: boolean;
    market_filter_mode?: string;
    shadow_declared: number;
    shadow_found: number;
    shadow_drift: number;
  };
  risk: StrategyHealthRisk | null;
  behavior: Record<string, Record<string, number | string | null>> | null;
  research: {
    total: number;
    passed: number;
    failed: number;
    rejected: number;
    inconclusive: number;
    pending: number;
    decisions: { id: string; title: string; status: string; decided_at: string | null }[];
  } | null;
  findings: StrategyHealthFinding[];
  missing: string[];
}

export interface StrategyEquity {
  n_points: number;
  first_date: string | null;
  last_date: string | null;
  current_drawdown: number | null;
  max_drawdown: number | null;
  max_drawdown_peak_date: string | null;
  max_drawdown_trough_date: string | null;
  peak_equity: number | null;
  latest_equity: number | null;
  live_days: number;
  reconstructed_days: number;
  truncated_days?: number;
  points: { d: string; v: number }[];
}

export interface StrategyHealthResponse {
  ok: boolean;
  path: string;
  supported_schema: number;
  stale_hours: number | null;
  data: StrategyHealthSnapshot | null;
  /** 失败原因：missing / invalid_json / schema_mismatch / not_paper_account */
  reason?: string;
  hint?: string;
  found_schema?: number | null;
  found_account_type?: string | null;
}


// ===== 判断质量回测（v0.44.0）=====
// 口径：结论日后第一个交易日收盘为基准，看第 5/20 个交易日涨跌；超额 = 个股区间收益 − 上证同区间收益
export interface BacktestRow {
  ts: string;
  code: string;
  stance: string;
  stage: string;
  mode: string;
  base: number | null;
  target: number | null;
  ret5: number | null;
  ret20: number | null;
  ex5: number | null;
  ex20: number | null;
  /** 未复权原值（v0.46.0）：仅供审计对照，除权日会失真，不要拿它判断准不准 */
  ret5Raw?: number | null;
  ret20Raw?: number | null;
  /** 本条是否真的取到了复权因子（ETF 等无因子标的为 false，等于用未复权价） */
  adjApplied?: boolean;
  /** 市场状态（v0.47.0）：结论基准日的上证 上行/下行/震荡；指数历史不足为 null */
  regime?: string | null;
  /** 来源实例（v0.48.0）：空 = 本机旧数据（v0.48.0 之前落库） */
  instance?: string;
  /** null = 该结论无方向（观察）或前向窗口尚不足，不计入命中率 */
  hit5: boolean | null;
  hit20: boolean | null;
  thesis: string;
  /** 溯源（v0.45.0）：这条结论来自哪次运行 / 哪份报告 */
  runId?: string;
  report?: string;
  source?: string;
  /** 模型自评置信度 0-1；历史记录为 null */
  confidence?: number | null;
  counterCase?: string;
}

export interface BacktestGroup extends BacktestSummary {
  name: string;
}

export interface BacktestSummary {
  samples: number;
  /** 有方向且已有 5 日窗口的样本数（命中率分母） */
  hits5: number;
  rate5: number | null;
  hits20: number;
  rate20: number | null;
  avgRet5: number | null;
  avgRet20: number | null;
  avgEx5: number | null;
  avgEx20: number | null;
  /** Wilson 95% 置信区间（小样本时区间极宽，用来识破「1/1=100%」） */
  rate5CI?: { low: number; high: number } | null;
  rate20CI?: { low: number; high: number } | null;
  /** 交易质量指标（v0.45.0）：只看胜率会被「高胜率亏大钱」骗 */
  dirSamples?: number;
  winRate?: number | null;
  avgWin?: number | null;
  avgLoss?: number | null;
  plRatio?: number | null;
  expectancy?: number | null;
}

export interface BacktestResponse {
  generatedAt: string;
  total: number;
  matched: number;
  overall: BacktestSummary | null;
  byStage: BacktestGroup[];
  byStance: BacktestGroup[];
  byMonth: BacktestGroup[];
  /** 按市场状态分组（v0.47.0）：拆同质样本——同一周内的结论共享同一段行情 */
  byRegime?: BacktestGroup[];
  /** 按来源实例分组（v0.48.0）：多人共享数据时区分「谁的判断」 */
  byInstance?: BacktestGroup[];
  /** 本机实例身份（v0.48.0）：id 永久不变，name 可在判断质量页修改 */
  localInstance?: { id: string; name: string };
  byConfidence?: BacktestGroup[];
  confidenceCoverage?: number;
  /** 复权覆盖（v0.46.0）：adjCoverage / adjUniverse，标的层面有多少真的按前复权算 */
  adjCoverage?: number;
  adjUniverse?: number;
  rows: BacktestRow[];
  warnings: string[];
  lastTradeDate: string;
}

/** 结论导入结果（v0.48.0）：只追加不改写，重复导入全跳过 */
export interface ImportResponse {
  ok: boolean;
  imported: number;
  skippedDup: number;
  skippedInvalid: number;
  source: { instance: string; name: string };
  note: string;
}

/** 「本次更新」说明（v0.50.0）：由 CHANGELOG.md 生成，随包分发 */
export interface WhatsNewRelease {
  version: string;
  date: string;
  title: string;
  items: string[];
}
export interface WhatsNewResponse {
  ok: boolean;
  latest?: string;
  releases: WhatsNewRelease[];
  error?: string;
}

/** 更新检查（v0.50.0）：只读，不执行任何更新 */
export interface UpdateCheckResponse {
  ok: boolean;
  /** 本机插件版本 */
  current: string;
  /** GitHub main 上的最新版本 */
  latest?: string;
  updateAvailable?: boolean;
  /** v0.51.0：远端「比本机新」的版本变更要点（拉取失败为空数组，不影响检查本身） */
  highlights?: WhatsNewRelease[];
  /** v0.51.0：结果来自 30 分钟内存缓存（仅自动检查会出现；手动检测恒为实时） */
  cached?: boolean;
  /** link = 本地克隆（需先 git pull）；github = 从 GitHub 源安装（pnpm update 即可） */
  installKind?: 'link' | 'github' | 'unknown';
  profile?: string;
  /** 与安装方式匹配的那一条命令 */
  command?: string;
  hint?: string;
  repo?: string;
  checkedAt?: string;
  error?: string;
}

/** 结论采集审计（v0.45.0）：数据从哪来、哪些运行没进库、为什么 */
export interface ConclusionAuditResponse {
  generatedAt: string;
  runs: {
    total: number; withConclusions: number; without: number; failed: number; recovered: number;
    realTotal: number; realWith: number; realCoverage: number | null;
    recentReal: number; recentWith: number; recentCoverage: number | null; recentWindowDays: number;
  };
  conclusions: { total: number; distinctCodes: number; orphans: number; withConfidence: number };
  byMode: Array<{ mode: string; runs: number; withConclusions: number; conclusions: number; failed: number }>;
  missing: Array<{ ts: string; mode: string; question: string; reason: string }>;
  dateDist: Array<{ date: string; n: number }>;
  reports: { total: number; parseable: number };
  /** 执行率对账（v0.45.0）：建议 vs 实际持仓 */
  execution?: {
    available: boolean;
    positions: number;
    matched: number;
    notExecuted: Array<{ code: string; stance: string; ts: string; kind: string }>;
    note: string;
  } | null;
  lineage: { source: string; window: string; note: string };
}

export interface BackfillResponse {
  ok: boolean;
  applied?: boolean;
  added: number;
  candidates: number;
  reports?: Array<{ file: string; blocks: number; added: number }>;
  error?: string;
}

export interface StockResolveResponse {
  code: string;
  name?: string;
  found?: boolean;
}

// ===== 标的档案（观察 + 持仓统一监控）=====
export type WatchState = '观察' | '持有' | '已清仓' | '已移除';

export interface WatchAlert {
  ts: string;
  code: string;
  name: string;
  state: string;
  kind: string;        // buy / invalidate / stop / target / add / trim
  level: string;       // good / warn / bad / info
  /** 购买仓位数：观察期=计划买入股数(buy_qty)；持有期=持仓股数(shares) */
  qty?: number | null;
  message: string;
  key: string;
  read: boolean;
}

export interface WatchRules {
  buy_low: number | null; buy_high: number | null; ideal_buy: number | null;
  /** 观察期计划买入股数（触发买入提醒时用于标注购买仓位数；老档案可能没有该字段） */
  buy_qty?: number | null;
  invalidate_if: string; thesis: string; stance: string;
  target: number | null; stop: number | null;
  created_at: string | null; last_conclusion_ts: string | null;
}

/** v0.53.0：结论同步时被语义校验挡下的价位（如回踩位被误当止盈目标），只审计、不静默改写 */
export interface WatchPositionSyncIgnored {
  ts: string;
  field: 'target' | 'stop';
  value: number;
  stance: string;
  reason: string;
}

export interface WatchPosition {
  cost: number | null; shares: number | null; stop: number | null; target: number | null;
  add_low: number | null; add_high: number | null; trim_line: number | null; trailing_stop: number | null;
  sync_ignored?: WatchPositionSyncIgnored[];
}

export interface WatchMonitor {
  current_price: number | null; refreshed_at: string | null;
  dist_buy_pct: number | null; dist_stop_pct: number | null;
  notify: boolean; last_signal_key: string; last_signal_at: string | null;
}

export interface WatchlistItem {
  code: string; name: string; state: WatchState;
  watch: WatchRules; position: WatchPosition; monitor: WatchMonitor;
}

export interface WatchlistResponse {
  updated_at: string; items: WatchlistItem[]; alerts: WatchAlert[]; unread: number;
}

export interface WatchlistUpdateInput {
  code: string; name?: string; state?: WatchState;
  watch?: Partial<WatchRules>; position?: Partial<WatchPosition>; notify?: boolean;
}

/** 档案 → 持仓账本的反向同步结果（清仓=从账本移除；持有=upsert） */
export interface WatchHoldingSync {
  changed: boolean;
  /** 清仓 / 建仓 / 更新持仓 / skip / none */
  action: string;
  code?: string;
  warnings: string[];
  updated_at?: string;
  backup?: string;
}

export interface WatchlistUpdateResponse {
  ok: boolean; item: unknown; updated_at: string;
  holdingSync?: WatchHoldingSync | null;
  holdingSyncError?: string;
}

/** 观察仓日检（每日自动：开机补跑 + 收盘后定时）状态 */
export interface WatchDailyStatus {
  ok: boolean;
  /** 自动日检开关 */
  enabled: boolean;
  /** 收盘后定时时刻 HH:MM */
  at: string;
  /** 是否已有日检任务在跑 */
  running: boolean;
  /** 当前观察仓只数 */
  watchCount: number;
  lastRunAt: string;
  /** boot = 开机补跑 / close = 收盘定时 / manual = 手动 */
  lastTrigger: string;
  /** fired = 已为触发者排队 LLM / no-trigger = 无触发 / error */
  lastStatus: string;
  lastTriggered: string[];
  lastJobId: string;
  lastNote: string;
  checkedAt?: string;
  updated_at?: string;
}

/** 直接刷新账本现价（无需确认）：只改 current_price 并重算派生列 */
export interface HoldingsRefreshQuotesResponse {
  ok: true;
  updated_at: string;
  updated: number;
  total: number;
  missing: string[];
  prices: Record<string, number>;
  fetched_at?: string;
  backup?: string;
  diff?: { added?: unknown[]; removed?: unknown[]; changed?: unknown[] };
  watchSync?: unknown[];
  watchSyncError?: string;
}

export interface WatchlistRefreshResponse {
  ok: boolean; refreshed: number; fetched_at: string; alerts: WatchAlert[]; updated_at: string; message?: string;
  /** 刷新前做的「账本 → 档案」对账结果（有变化才有内容） */
  watchSync?: string[];
  watchSyncError?: string;
}

// ===== 个股分析知识库（报告按个股切段 → 二次整理成可读文档）=====
export interface StockNoteMeta {
  code: string;
  name: string;
  count: number;
  last_ts: string;
  modes: string[];
  kinds: string[];
  /** 最近一次二次整理的时间（空 = 还没整理过） */
  curated_at?: string;
  /** done / running / queued / error / none */
  kb_status?: string;
  /** 尚未并入知识库的新分析段数 */
  new_entries?: number;
}

export interface StockNoteEntry {
  id: string;
  ts: string;
  mode: string;
  /** marker/heading = 分段原文；report = 整份报告；mention = 历史报告节选 */
  kind: string;
  heading: string;
  report: string;
  report_name: string;
  chars: number;
  snippet: string;
}

export interface StockNoteDetail {
  code: string;
  name: string;
  count: number;
  last_ts: string;
  /** 知识库最近整理时间（空 = 尚未整理） */
  updated_at: string;
  /** done / running / queued / error / raw */
  status: string;
  model: string;
  error: string;
  new_entries: number;
  chars: number;
  file: string;
  /** 整理后的知识库 Markdown（未整理时为兜底时间线） */
  markdown: string;
  entries: StockNoteEntry[];
}

export interface StockNotesResponse {
  built_at: string;
  stats: { reports?: number; stocks?: number; entries?: number; parsed?: number; reused?: number; ms?: number };
  stocks: StockNoteMeta[];
  /** 有多少只股票还有未并入知识库的新材料 */
  pending_curation?: number;
  /** 后台整理队列是否有活 */
  curating?: boolean;
  /** 当前并发整理的只数 */
  curating_count?: number;
  /** 没有任何个股归属的报告（综合类），仅作统计展示 */
  orphans: string[];
}

export interface StockAskResponse {
  ok: boolean;
  answer: string;
  elapsedMs: number;
  kbUpdatedAt: string;
  kbStatus: string;
  newEntries: number;
}

// ===== 基本面评级（v0.58.0）：行业横截面分位口径，排雷与理解质地，非买卖信号 =====

/** 单个指标的横向分位结果 */
export interface FundamentalMetric {
  label: string;
  /** 展示用原值，如 "19.47%" */
  value: string;
  /** 同业分位 0-100（已按方向反转：越大越好）；null = 样本不足或无数据 */
  pct: number | null;
  /** 分位口径说明，如 "同业中位" */
  hint?: string;
}

/** 五个计分维度之一（风险标记走 flags，不参与计分） */
export interface FundamentalDimension {
  /** growth / valuation / profitability / quality / health */
  key: string;
  label: string;
  /** 0-100；null = 该维度无足够数据，不参与总分 */
  score: number | null;
  /** 权重 0-1 */
  weight: number;
  /** 一句话摘要，如 "净利同比 +97.5%，同业前 20%" */
  detail: string;
  metrics: FundamentalMetric[];
}

/** 风险标记：不计分，独立展示（排雷价值高于评分） */
export interface FundamentalFlag {
  level: 'bad' | 'warn' | 'info';
  label: string;
  note: string;
}

/** 评级历史快照（P2：变化比绝对值更有信息量） */
export interface FundamentalSnapshot {
  period: string;
  periodLabel: string;
  total: number | null;
  grade: string;
  at: string;
}

export interface FundamentalsResponse {
  ok: boolean;
  error?: string;
  code: string;
  name: string;
  industry: string;
  /** 同业样本数（同一 Tushare industry 分类；退回全市场时为全市场样本数） */
  peerCount: number;
  /** 分位基准：industry=同行业（首选）；market=同业样本不足时退回全市场 */
  peerBaseline?: 'industry' | 'market';
  /** 财报报告期 YYYYMMDD */
  period: string;
  periodLabel: string;
  announceDate: string;
  /** 估值取数的交易日 */
  priceDate: string;
  total: number | null;
  grade: string;
  gradeLabel: string;
  /** 如 "5/5 维" */
  coverage: string;
  dims: FundamentalDimension[];
  flags: FundamentalFlag[];
  warnings: string[];
  /** 最近几次评级快照（新→旧），用于看升降 */
  history: FundamentalSnapshot[];
  /** 与上一期比较 */
  delta: { periodLabel: string; total: number | null; change: number | null } | null;
  /** 实证提示：基本面不区分盈亏，本评级不构成买卖信号 */
  caveat: string;
  /** 快照缓存时间 */
  cachedAt: string;
}


// ===== 个股知识库「相关图表」（v0.53.0）=====
export interface StockChartItem {
  path: string;
  name: string;
  mtime: number;
  size: number;
}

export interface StockChartsResponse {
  code: string;
  charts: StockChartItem[];
  total: number;
}

// ===== 持仓工作区「当前账本」列偏好 =====
export type LedgerColKey =
  | 'code' | 'name' | 'pool' | 'shares' | 'available_shares' | 'cost' | 'current_price'
  | 'market_value' | 'pnl' | 'pnl_pct' | 'weight_pct' | 'status' | 'note';

/** 默认列顺序；用户自定义顺序以此为基准合并（版本升级新增列不会丢失） */
export const LEDGER_DEFAULT_COLUMNS: LedgerColKey[] = [
  'code', 'name', 'pool', 'shares', 'available_shares', 'cost', 'current_price',
  'market_value', 'pnl', 'pnl_pct', 'weight_pct', 'status', 'note',
];
