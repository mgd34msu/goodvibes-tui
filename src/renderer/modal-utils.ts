/**
 * Shared rendering utilities for modal components.
 */

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
