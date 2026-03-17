/**
 * Shared rendering utilities for modal components.
 */

/** Format elapsed milliseconds as a compact duration string. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m${remSecs}s`;
}

/**
 * Format a Unix millisecond timestamp as YYYY-MM-DD HH:MM.
 * Returns '(unknown)' for falsy timestamps.
 */
export function formatTimestamp(ts: number): string {
  if (!ts) return '(unknown)';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
