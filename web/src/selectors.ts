import type { ConclusionRecord, IndexResponse, RunRecord } from './types';

export function sortRuns(runs: RunRecord[]): RunRecord[] {
  return [...runs].sort((a, b) => {
    const time = String(b.ts_local || b.created_at || '').localeCompare(String(a.ts_local || a.created_at || ''));
    if (time) return time;
    const numeric = Number(b.id) - Number(a.id);
    return Number.isFinite(numeric) ? numeric : String(b.id).localeCompare(String(a.id));
  });
}

export function sortConclusions(records: ConclusionRecord[]): ConclusionRecord[] {
  return [...records].sort((a, b) => String(b.asof || b.ts || '').localeCompare(String(a.asof || a.ts || '')) || Number(b.id) - Number(a.id));
}

export function recordsForCode(index: IndexResponse, code: string): ConclusionRecord[] {
  const entry = index.codes?.[code];
  if (!entry?.records?.length) return (index.records || []).filter((record) => record.code === code);
  const ids = new Set(entry.records.map(String));
  const mapped = (index.records || []).filter((record) => ids.has(String(record.id)));
  const known = new Set(mapped.map((record) => String(record.id)));
  return [...mapped, ...(index.records || []).filter((record) => record.code === code && !known.has(String(record.id)))];
}

export function runsForCode(index: IndexResponse, code: string): RunRecord[] {
  const entry = index.codes?.[code];
  const ids = new Set((entry?.runs || []).map(String));
  return sortRuns((index.runs || []).filter((run) => ids.has(String(run.id)) || (run.codes || []).includes(code)));
}

export function codeEntries(index: IndexResponse, query = '') {
  const normalized = query.trim().toLowerCase();
  return Object.entries(index.codes || {})
    .map(([code, entry]) => ({
      code, entry,
      activity: (entry.records?.length || 0) * 3 + (entry.runs?.length || 0),
    }))
    .filter(({ code, entry }) => !normalized || code.toLowerCase().includes(normalized) || (entry.name || '').toLowerCase().includes(normalized))
    .sort((a, b) => b.activity - a.activity || a.code.localeCompare(b.code));
}

export function reportForRun(index: IndexResponse | null, run: RunRecord): { path: string; charts: string[] } | null {
  if (run.reports?.[0]) return { path: run.reports[0], charts: run.charts || [] };
  const report = index?.reports?.find((item) => String(item.run_id) === String(run.id));
  return report ? { path: report.path, charts: report.charts?.length ? report.charts : (run.charts || []) } : null;
}
