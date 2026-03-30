/**
 * Shared circuit breaker for consecutive all-error turn detection.
 *
 * These thresholds are intentionally fixed constants for now.
 * Thresholds are hardcoded; could be made configurable via configManager in the future.
 */
export const CONSECUTIVE_ERROR_WARN = 5;
export const CONSECUTIVE_ERROR_BREAK = 10;

export class ConsecutiveErrorBreaker {
  private count = 0;

  /** Record an all-failed turn. Returns 'warn' at WARN threshold, 'break' at BREAK threshold, 'ok' otherwise. */
  recordAllFailed(): 'ok' | 'warn' | 'break' {
    this.count++;
    this.count = Math.min(this.count, CONSECUTIVE_ERROR_BREAK);
    if (this.count >= CONSECUTIVE_ERROR_BREAK) return 'break';
    if (this.count >= CONSECUTIVE_ERROR_WARN) return 'warn';
    return 'ok';
  }

  /** Reset counter on any success. */
  recordSuccess(): void { this.count = 0; }

  /** Current consecutive error count. */
  get consecutiveErrors(): number { return this.count; }
}
