export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] || char);
}

export function formatNumber(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('zh-CN').format(number) : '—';
}

export function formatDateTime(value: unknown, short = false): string {
  if (value === null || value === undefined || value === '') return '—';
  const raw = String(value);
  const date = typeof value === 'number' || /^\d{4}-\d{2}-\d{2}[T\s]/.test(raw) ? new Date(raw) : null;
  if (date && !Number.isNaN(date.getTime())) {
    return new Intl.DateTimeFormat('zh-CN', short
      ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
      : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false },
    ).format(date).replace(/\//g, '-');
  }
  return escapeHtml(raw.slice(0, short ? 16 : 19).replace('T', ' '));
}

export function formatDuration(ms: unknown): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const minutes = Math.floor(value / 60_000);
  return `${minutes} min ${Math.round((value % 60_000) / 1000)} s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function truncate(value: unknown, length = 72): string {
  const text = String(value ?? '').trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.map(displayValue).join('；');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}：${displayValue(item)}`).join('；');
  }
  return String(value);
}
