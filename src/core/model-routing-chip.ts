/**
 * model-routing-chip, turns a mid-session model change into a visible one-line
 * conversation notice so a route/fallback/downgrade is NEVER silent.
 *
 * Driven by the provider registry's `MODEL_CHANGED` runtime event (fired on
 * every setCurrentModel, user command, automatic capability route, or
 * SDK-internal downgrade). The chip's job is the OTHERWISE-SILENT changes: the
 * SDK-internal auto-route/downgrade paths call setCurrentModel with no TUI-side
 * narration of their own.
 *
 * Division of labour with the failover path: the optimizer-gated failover in
 * stream-event-wiring.ts renders a richer `[Failover] from → to
 * (reason)(+cost)` line for the switches it makes itself, and tells this
 * listener so directly (see the self-narrated guard there) rather than relying
 * on this module to infer it. Those changes never reach buildRoutingChip.
 *
 * Reason honesty, in three tiers:
 *   1. a change the failover path already narrated → not offered here at all;
 *   2. a change that correlates to a transition in the optimizer's fallback
 *      log → the log's own reason is quoted, because the reason IS known. The
 *      log is shared: the TUI's failover records provider ids ("abacusai"),
 *      the SDK's agent-orchestrator fallback records registry keys
 *      ("abacusai:route-llm"), and a match on either form counts. Reading only
 *      one form is what made a real, explained failover print
 *      "(reason unknown)";
 *   3. no correlation → "(reason unknown)", because a change with no
 *      explanation is still reported, just honestly marked as unexplained.
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
 * The provider id of a fallback-log endpoint, which may be written either as a
 * bare provider id or as a `provider:model` registry key depending on which
 * writer recorded it. Everything before the first ':' is the provider in both
 * forms, so one rule reads both.
 */
function providerOf(endpoint: string): string {
  const separator = endpoint.indexOf(':');
  return separator === -1 ? endpoint : endpoint.slice(0, separator);
}

/**
 * Most recent fallback-log reason for a from→to provider transition within the
 * correlation window, or null. Scans newest-first so the freshest transition wins.
 * Endpoints are compared by provider id, so entries recorded as registry keys
 * correlate exactly like entries recorded as bare provider ids.
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
    if (providerOf(t.from) === providerOf(fromProvider)
      && providerOf(t.to) === providerOf(toProvider)
      && now - t.ts <= windowMs) return t.reason;
  }
  return null;
}

/**
 * The routing-chip line to emit for a MODEL_CHANGED event, or null to stay
 * silent. Null only when there is no real change (no/same previous model),
 * changes the failover path narrates itself never reach this function.
 *
 * A change that correlates to a logged fallback transition is reported WITH
 * that transition's reason; anything else is reported as "reason unknown".
 */
export function buildRoutingChip(
  change: ModelChangedLike,
  fallbackLog: readonly FallbackTransitionLike[],
  now: number,
): string | null {
  const prev = change.previous;
  if (!prev || prev.registryKey === change.registryKey) return null;
  const failoverReason = findRecentFallbackReason(fallbackLog, prev.provider, change.provider, now);
  const reason = failoverReason === null ? 'reason unknown' : `failover: ${failoverReason}`;
  return `${ROUTING_CHIP_PREFIX} model changed: ${prev.registryKey} → ${change.registryKey} (${reason})`;
}
