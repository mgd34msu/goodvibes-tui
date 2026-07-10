/**
 * model-routing-chip — turns a mid-session model change into a visible one-line
 * conversation notice so a route/fallback/downgrade is NEVER silent.
 *
 * Driven by the provider registry's `MODEL_CHANGED` runtime event (fired on
 * every setCurrentModel — user command, automatic capability route, or
 * SDK-internal downgrade). The chip's job is the OTHERWISE-SILENT changes: the
 * SDK-internal auto-route/downgrade paths call setCurrentModel with no TUI-side
 * narration of their own.
 *
 * Division of labour with the failover path: the optimizer-gated failover in
 * stream-event-wiring.ts already renders a richer `[Failover] from → to
 * (reason)(+cost)` line AND records the transition into the optimizer's
 * fallback log. So when a MODEL_CHANGED correlates to a just-recorded fallback
 * transition, this chip stays silent (buildRoutingChip returns null) — the
 * [Failover] line already narrated that exact change with its real reason.
 * Every other change is surfaced here.
 *
 * Reason honesty: for the paths this chip surfaces the routing layer exposes no
 * machine-readable reason (a deliberate user switch has none; an SDK-internal
 * downgrade does not thread one to the TUI), so the notice states "reason
 * unknown" rather than omitting the change — per the honesty rule that a change
 * with no explanation is still reported, just marked unknown.
 */

/** The subset of a FallbackTransition this module reads (structural, SDK-agnostic). */
export interface FallbackTransitionLike {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly ts: number;
}

/** The subset of a MODEL_CHANGED event this module reads. */
export interface ModelChangedLike {
  readonly registryKey: string;
  readonly provider: string;
  readonly previous?: { readonly registryKey: string; readonly provider: string } | undefined;
}

/** How long after a recorded fallback transition a MODEL_CHANGED still counts as "that failover". */
export const FALLBACK_CORRELATION_WINDOW_MS = 4_000;

/** The forced conversation prefix so the notice is never gated as noise or routed away. */
export const ROUTING_CHIP_PREFIX = '[Routing]';

/**
 * Most recent fallback-log reason for a from→to provider transition within the
 * correlation window, or null. Scans newest-first so the freshest transition wins.
 */
export function findRecentFallbackReason(
  fallbackLog: readonly FallbackTransitionLike[],
  fromProvider: string,
  toProvider: string,
  now: number,
  windowMs: number = FALLBACK_CORRELATION_WINDOW_MS,
): string | null {
  for (let i = fallbackLog.length - 1; i >= 0; i--) {
    const t = fallbackLog[i]!;
    if (t.from === fromProvider && t.to === toProvider && now - t.ts <= windowMs) return t.reason;
  }
  return null;
}

/**
 * The routing-chip line to emit for a MODEL_CHANGED event, or null to stay
 * silent. Null only when there is no real change (no/same previous model) or
 * when the change was a failover already narrated by its own [Failover] line
 * (correlated via the fallback log). Otherwise returns the honest
 * `[Routing] model changed: old → new (reason unknown)` notice.
 */
export function buildRoutingChip(
  change: ModelChangedLike,
  fallbackLog: readonly FallbackTransitionLike[],
  now: number,
): string | null {
  const prev = change.previous;
  if (!prev || prev.registryKey === change.registryKey) return null;
  const failoverReason = findRecentFallbackReason(fallbackLog, prev.provider, change.provider, now);
  if (failoverReason !== null) return null; // [Failover] already narrated this transition
  return `${ROUTING_CHIP_PREFIX} model changed: ${prev.registryKey} → ${change.registryKey} (reason unknown)`;
}
