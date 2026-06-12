/**
 * Format elapsed time (in milliseconds) as a compact human-readable string.
 *
 * Ranges:
 *   < 1 second  → "0.Xs"   (one decimal, e.g. "0.4s")
 *   1-59s       → "Xs"     (e.g. "3s", "59s")
 *   1m-59m59s   → "Xm YYs" (e.g. "1m04s", "59m59s")
 *   ≥ 1 hour    → "Xh YYm" (e.g. "1h02m")
 *
 * Used by the thinking indicator and live tool timer.
 */
export function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 1000) {
    // Truncate (not round) to one decimal so 999ms stays "0.9s" not "1.0s".
    return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  }
  const totalSecs = Math.floor(ms / 1000);
  if (totalSecs < 60) {
    return `${totalSecs}s`;
  }
  const totalMins = Math.floor(totalSecs / 60);
  if (totalMins < 60) {
    const remSecs = totalSecs % 60;
    return `${totalMins}m${String(remSecs).padStart(2, '0')}s`;
  }
  const hours = Math.floor(totalMins / 60);
  const remMins = totalMins % 60;
  return `${hours}h${String(remMins).padStart(2, '0')}m`;
}
