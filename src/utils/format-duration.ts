/**
 * Shared ms-duration formatters for the panel layer.
 *
 * Three families are exported, each matching a distinct behavior cluster.
 * DO NOT replace these with formatElapsed from utils/format-elapsed.ts —
 * formatElapsed floors to integer seconds and lacks the null/'?ms' guards
 * that the latency panels require.
 */

/**
 * Format a latency value in milliseconds with sub-second precision.
 *
 * Used by: debug-panel, provider-health-panel, provider-stats-panel
 *
 *   ms <= 0     → 'n/a'
 *   ms >= 10000 → '12.3s'    (one decimal)
 *   ms >= 1000  → '1.23s'   (two decimals)
 *   else        → '500ms'   (integer ms)
 */
export function formatLatencyMs(ms: number): string {
  if (ms <= 0)      return 'n/a';
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 1_000)  return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

/**
 * Format a task/agent duration with minute-rolling notation.
 *
 * Used by: tool-inspector-panel, agent-inspector-shared
 *
 *   ms < 1000   → '500ms'
 *   ms < 60000  → '3.5s'
 *   else        → '1m30s'
 */
export function formatDuration(ms: number): string {
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

/**
 * Format a short eval/forensics duration; treats undefined as '?ms'.
 *
 * Used by: incident-review-panel, eval-panel
 *
 *   undefined → '?ms'
 *   ms < 1000 → '500ms'
 *   else      → '1.5s'
 */
export function formatShortDuration(ms: number | undefined): string {
  if (ms === undefined) return '?ms';
  if (ms < 1000)        return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
