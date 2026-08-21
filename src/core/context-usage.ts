/**
 * Shared context-window usage computation.
 *
 * Centralises the tokens/contextWindow ratio so all panels, auto-compact,
 * and session-maintenance read from one formula rather than six diverging
 * hand-rolled copies.
 *
 * IMPORTANT: compaction-preview.ts intentionally displays usage > 100%
 * ("exceeds window"), callers that need the unclamped value must use
 * rawRatio, not clampedRatio / pct.
 */

export interface ContextUsage {
  /**
   * Raw (unclamped) ratio: max(0, tokens) / contextWindow.
   * May exceed 1.0 when token count surpasses the context window.
   * 0 when contextWindow <= 0.
   */
  rawRatio: number;
  /**
   * Ratio clamped to [0, 1]. Use for progress-bar fill and color bands.
   */
  clampedRatio: number;
  /**
   * Integer percentage clamped to [0, 100].
   * Equivalent to Math.min(100, Math.round(rawRatio * 100)).
   * Use for numeric displays and threshold comparisons.
   */
  pct: number;
  /**
   * Remaining tokens: max(0, contextWindow - tokens).
   * 0 when contextWindow <= 0.
   */
  remaining: number;
}

/**
 * Compute context-window usage metrics from raw token counts.
 *
 * @param tokens        Current input-token count (negative values are treated as 0).
 * @param contextWindow Model context window size (0 or negative → all fields return 0).
 */
export function computeContextUsage(tokens: number, contextWindow: number): ContextUsage {
  if (contextWindow <= 0) {
    return { rawRatio: 0, clampedRatio: 0, pct: 0, remaining: 0 };
  }
  const safeTokens   = Math.max(0, tokens);
  const rawRatio     = safeTokens / contextWindow;
  const clampedRatio = Math.min(1, rawRatio);
  const pct          = Math.min(100, Math.round(rawRatio * 100));
  const remaining    = Math.max(0, contextWindow - tokens);
  return { rawRatio, clampedRatio, pct, remaining };
}
