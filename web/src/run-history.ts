// 运行历史统一数据源：索引里的 runs + 缺运行日志的近期报告回填。
// 背景：web 任务历史上未写 runs.jsonl（v0.31 已修），若只用 index.runs，
// 概览「上次分析/最近运行」会一直停在最后一次成功写日志的时间。
import type { Id, IndexResponse, RunRecord } from './types';

/** 运行行：backfilled = 由报告回填（该次运行没有写进 runs.jsonl） */
export type RunRow = RunRecord & { report_id?: Id; backfilled?: boolean };

/** 回填窗口：只看最近 N 天 */
const BACKFILL_WINDOW_DAYS = 30;

const norm = (path: unknown): string => String(path || '').replace(/\\/g, '/').toLowerCase();

/** 从整条路径取「时间戳_随机串_标题」段（兼容 reports/*.md 与 invest-outputs/<stamp>/报告.md） */
export function parseReportPath(path: unknown): { ts: string; title: string } {
  const normalized = String(path || '').replace(/\\/g, '/');
  const match = normalized.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  const ts = match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}` : '';
  const segment = normalized.split('/').find((part) => /^\d{8}_\d{6}/.test(part)) || '';
  const title = segment
    .replace(/^\d{8}_\d{6}_[a-z0-9]+_?/i, '')
    .replace(/\.md$/i, '')
    .replace(/_/g, ' ')
    .trim();
  return { ts, title };
}

function backfillCutoff(): string {
  const date = new Date(Date.now() - BACKFILL_WINDOW_DAYS * 86400000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 缺运行日志的近期报告 → 「报告归档」运行行（窗口内、可解析时间、同秒去重） */
export function backfilledRuns(index: IndexResponse | null): RunRow[] {
  if (!index) return [];
  const runs = index.runs || [];
  const covered = new Set<string>();
  runs.forEach((run) => (run.reports || []).forEach((path) => covered.add(norm(path))));
  const runIds = new Set(runs.map((run) => String(run.id)));
  const cutoff = backfillCutoff();
  const seenTs = new Set<string>();
  const out: RunRow[] = [];
  for (const report of index.reports || []) {
    if (covered.has(norm(report.path))) continue;
    const linked = report.run_id !== undefined && report.run_id !== null && runIds.has(String(report.run_id));
    if (linked) continue;
    const { ts, title } = parseReportPath(report.path);
    if (!ts || ts < cutoff) continue;
    if (seenTs.has(ts)) continue;
    seenTs.add(ts);
    out.push({
      id: `report-${report.id}`,
      ts_local: ts,
      mode: '报告归档',
      question: `${title || '报告归档'}（缺运行日志，按报告回填）`,
      codes: report.codes || [],
      stages: [],
      reports: [report.path],
      charts: report.charts || [],
      ok: true,
      status: 'ok',
      report_id: report.id,
      backfilled: true,
    });
  }
  return out;
}

/** 索引运行 + 回填运行，按时间倒序 */
export function allRunRows(index: IndexResponse | null): RunRow[] {
  if (!index) return [];
  const rows = [...(index.runs || []), ...backfilledRuns(index)] as RunRow[];
  return rows.sort((a, b) => String(b.ts_local || b.created_at || '').localeCompare(String(a.ts_local || a.created_at || '')));
}

/** 运行行对应的报告路径（回填行直接带 reports[0]） */
export function runReportPath(run: RunRow): string {
  return String((run.reports && run.reports[0]) || '');
}

/** 某标的最近一份报告路径（优先取运行关联，其次按报告 codes 反查；供档案页「追问最近报告」） */
export function latestReportForCode(index: IndexResponse | null, code: string): string {
  if (!index || !code) return '';
  const entry = index.codes?.[code];
  const runIds = new Set((entry?.runs || []).map(String));
  const rows = allRunRows(index).filter((run) => runIds.has(String(run.id)) || (run.codes || []).includes(code));
  for (const run of rows) {
    const path = runReportPath(run);
    if (path) return path;
  }
  const reports = (index.reports || []).filter((report) => (report.codes || []).includes(code));
  const primary = reports.filter((report) => /\/\.dsh-invest\/reports\//i.test(String(report.path).replace(/\\/g, '/')));
  const pool = primary.length ? primary : reports;
  const pick = pool.slice().sort((a, b) => Number(b.id) - Number(a.id))[0];
  return pick ? String(pick.path) : '';
}
