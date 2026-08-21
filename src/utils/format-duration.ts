/**
 * Shared ms-duration formatters for the panel layer.
 *
 * Two families are exported, each matching a distinct behavior cluster.
 * DO NOT replace these with formatElapsed from utils/format-elapsed.ts,
 * formatElapsed floors to integer seconds and lacks the null/'?ms' guards
 * that the latency panels require.
 *
 * (the purge): formatShortDuration (used only by incident-review-panel
 * and eval-panel, both removed, RETIRE-INTO-FLEET and DELETE respectively)
 * was removed as a genuinely orphaned export, no remaining caller anywhere
 * in src/.
 */

/**
 * Format a latency value in milliseconds with sub-second precision.
 *
 * Used by: provider-health-panel
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
 * Used by: agent-inspector-shared
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
