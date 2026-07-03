import type { UiRuntimeEvents } from '@/runtime/index.ts';
import { createStreamStallWatchdog } from './stream-stall-watchdog.ts';
import { formatUserFacingErrorLine } from './format-user-error.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';

/**
 * Live stream and tool-execution metrics maintained by wireStreamEventMetrics.
 * The object is mutated in place by event handlers; callers declare it before
 * render() and pass it in, so render() can read the fields without copying.
 */
export interface StreamMetrics {
  /** Epoch ms when the most recent STREAM_START fired; 0 when idle. */
  startTime: number;
  /** Number of STREAM_DELTA events received since the last STREAM_START. */
  deltaCount: number;
  /** Computed tokens-per-second at the last STREAM_DELTA; 0 when idle. */
  tokenSpeed: number;
  /** Elapsed ms from STREAM_START to first STREAM_DELTA (time-to-first-token). */
  ttftMs: number | undefined;
  /** Whether TTFT has been recorded for the current turn. */
  ttftRecorded: boolean;
  /** Epoch ms when the most recent TOOL_EXECUTING event fired; undefined when idle. */
  activeToolStartedAtMs: number | undefined;
  /** Name of the currently executing tool; cleared when execution completes. */
  activeToolName: string | undefined;
  /**
   * Epoch ms of the most recent STREAM_START or STREAM_DELTA; undefined when
   * idle (no turn in flight). Read every render frame — not just on the
   * watchdog's one-shot hint — so "ms since last byte" can be computed even
   * when no new SDK event has arrived at all (a no-delta stall watchdog for
   * the render loop itself, independent of the low-priority system message).
   */
  lastDeltaAtMs: number | undefined;
  /**
   * 1-based count of stall episodes the watchdog has fired for the current
   * turn; 0 = no stall yet. Increments each time a fresh silence (after a
   * recovery) crosses the stall threshold.
   */
  stallEpisode: number;
  /**
   * Populated from the SDK's STREAM_RETRY event when present. SDK 0.35.0 (the
   * pinned dependency) has no such event on the TurnEvent union yet — these
   * fields are consumed structurally (see looseTurnsFeed below) and stay
   * undefined until a future SDK version emits it. Cleared on STREAM_DELTA
   * (a byte arriving means the reconnect, if any, succeeded).
   */
  reconnectAttempt: number | undefined;
  reconnectMaxAttempts: number | undefined;
}

/** Minimal orchestrator surface required for stream token-speed calculation. */
interface StreamOrchestrator {
  readonly streamingOutputTokens: number;
}

/** Minimal provider surface required for the stream stall watchdog and failover switching. */
interface StreamProviderRegistry {
  getCurrentModel(): { readonly provider: string; readonly registryKey?: string };
  setCurrentModel(registryKey: string): void;
}

/**
 * Minimal fallback-chain node shape returned by ProviderOptimizer.testFallback().
 * Only the fields consumed by the failover path are declared here.
 */
interface FailoverChainNode {
  readonly position: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly capable: boolean;
}

/** Minimal ProviderOptimizer surface required by the failover path. */
interface FailoverOptimizer {
  readonly enabled: boolean;
  testFallback(profile?: Record<string, unknown>): { readonly chain: readonly FailoverChainNode[] };
  recordFallbackTransition(from: string, to: string, reason: string): void;
}

/** Minimal system-message surface required for user-visible notifications. */
interface StreamSystemMessageRouter {
  high(message: string): void;
  low(message: string): void;
}

/**
 * Loosely-typed variant of the turns event feed, used only to subscribe to
 * event names not yet present in the SDK's TurnEvent union (STREAM_RETRY,
 * STREAM_STALL — see the structural-consumption comment at the subscription
 * site below). `events.turns.on` itself stays fully typed against the real
 * TurnEvent union everywhere else in this file.
 */
interface LooseTurnEventFeed {
  on(type: string, listener: (payload: unknown) => void): () => void;
}

/** Payload shape expected from a future SDK STREAM_RETRY event. */
interface StreamRetryLikePayload {
  readonly attempt: number;
  readonly maxAttempts: number;
}

/** Runtime guard validating an unknown STREAM_RETRY-like payload's shape. */
function isStreamRetryLikePayload(payload: unknown): payload is StreamRetryLikePayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as Record<string, unknown>).attempt === 'number' &&
    typeof (payload as Record<string, unknown>).maxAttempts === 'number'
  );
}

/**
 * Minimal cost lookup surface for attaching cost-delta information to failover notices.
 * Returns USD-per-1M-token pricing for the given model ID.
 * The implementation may consult a catalog; if the model is unknown both fields are 0.
 */
export interface FailoverCostLookup {
  getCostFromCatalog(modelId: string): { readonly input: number; readonly output: number };
}

export interface WireStreamEventMetricsOptions {
  /** The UI runtime event bus (turns + tools sub-buses). */
  readonly events: UiRuntimeEvents;
  /** Orchestrator reference used to read real output token counts. */
  readonly orchestrator: StreamOrchestrator;
  /** Provider registry used by the stall watchdog to name the current provider. */
  readonly providerRegistry: StreamProviderRegistry;
  /** System message router for turn-error and stall notifications. */
  readonly systemMessageRouter: StreamSystemMessageRouter;
  /** Trigger a UI repaint after a state mutation. */
  readonly render: () => void;
  /**
   * Caller-owned metrics object to mutate in place.  Declared before render()
   * so the render closure can read it without a forward-reference issue.
   */
  readonly metrics: StreamMetrics;
  /**
   * When provided and enabled, the optimizer is consulted on TURN_ERROR to
   * attempt the next viable provider before surfacing the error to the user.
   * When absent or optimizer.enabled is false, behaviour is identical to the
   * pre-failover baseline: error surfaces immediately via systemMessageRouter.
   */
  readonly providerOptimizer?: FailoverOptimizer;
  /**
   * Callback the caller provides to re-submit the last user turn on a
   * different provider after a successful failover switch.  Called only when
   * the optimizer is enabled and a viable next provider exists in the chain.
   */
  readonly retryTurn?: () => void;
  /**
   * Optional cost catalog for attaching per-1M-token cost information to
   * the failover notice.  When provided and both models have non-zero pricing,
   * the notice includes input and output cost comparisons.  When absent or pricing is
   * unavailable for either model, the notice honestly states "cost data unavailable".
   */
  readonly costLookup?: FailoverCostLookup;
}

/** Result of wireStreamEventMetrics. */
export interface WireStreamEventMetricsResult {
  /** Unsubscribe functions; push into the parent unsubs array for cleanup on exit. */
  readonly unsubs: ReadonlyArray<() => void>;
  /**
   * Clear the per-turn failover visited-provider set.
   * Call this on every new user submission so the visited set does not bleed
   * across independent turns (the set is also cleared automatically on
   * TURN_COMPLETED, but a new submission may arrive before TURN_COMPLETED fires).
   */
  readonly clearFailoverVisited: () => void;
  /**
   * Register a callback that fires whenever a TURN_ERROR is surfaced to the
   * user — either immediately (no optimizer) or after chain exhaustion.
   * Does NOT fire when the optimizer performs a successful automatic failover
   * (in that case the user sees a [Failover] notice, not an error).
   * Used by main.ts to activate the one-key retry affordance. The callback
   * receives exhausted=true when the failover chain was exhausted first, so
   * the notice can say honestly that a retry reuses the same failed provider.
   */
  readonly onErrorSurfaced: (cb: (exhausted: boolean) => void) => void;
}

/**
 * Build the cost-delta suffix for a failover notice.
 *
 * Extracts the model ID from registry keys (format: `provider:modelId`),
 * queries the cost catalog for both, and formats a human-readable comparison.
 * If the lookup is absent or either model returns zero pricing (unknown),
 * returns an honest "cost data unavailable" suffix instead of fabricating values.
 *
 * @param lookup - Optional cost catalog; when absent, returns unavailable notice.
 * @param fromRegistryKey - Registry key of the provider being abandoned (may be undefined).
 * @param toRegistryKey - Registry key of the provider being selected.
 * @returns A parenthesised suffix string or empty string.
 */
function buildCostDeltaSuffix(
  lookup: FailoverCostLookup | undefined,
  fromRegistryKey: string | undefined,
  toRegistryKey: string,
): string {
  if (!lookup) return '';
  // Registry key format: `provider:modelId` — modelId may itself contain `:`.
  const fromModelId = fromRegistryKey ? fromRegistryKey.split(':').slice(1).join(':') : '';
  const toModelId = toRegistryKey.split(':').slice(1).join(':');
  const fromCost = fromModelId ? lookup.getCostFromCatalog(fromModelId) : { input: 0, output: 0 };
  const toCost = lookup.getCostFromCatalog(toModelId);
  // Report unavailable when either side has zero pricing (unknown model).
  if (fromCost.input === 0 && fromCost.output === 0 && !fromModelId) {
    return ' [cost data unavailable]';
  }
  const hasFromData = fromCost.input > 0 || fromCost.output > 0;
  const hasToData = toCost.input > 0 || toCost.output > 0;
  if (!hasFromData || !hasToData) {
    return ' [cost data unavailable]';
  }
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  return ` [cost/1M: input ${fmt(fromCost.input)}→${fmt(toCost.input)}, output ${fmt(fromCost.output)}→${fmt(toCost.output)}]`;
}

/**
 * Wire STREAM_* and TOOL_* runtime events to the provided StreamMetrics object
 * and install the stream-stall watchdog.  The caller owns the metrics object
 * and declares it before render() so both the render closure and the returned
 * event handlers share the same reference.
 *
 * Returns an object with unsubscribe functions and a clearFailoverVisited helper.
 *
 * Responsibilities:
 *   - Track stream start time, delta count, token speed, and TTFT
 *   - Track the currently executing tool name and start time
 *   - Display TURN_ERROR messages via systemMessageRouter
 *   - Emit a stall hint when STREAM_START has no delta within the watchdog threshold
 */
export function wireStreamEventMetrics(
  options: WireStreamEventMetricsOptions,
): WireStreamEventMetricsResult {
  const {
    events, metrics, orchestrator, providerRegistry,
    systemMessageRouter, render, providerOptimizer, retryTurn, costLookup,
  } = options;

  const unsubs: Array<() => void> = [];

  unsubs.push(events.turns.on('STREAM_START', () => {
    metrics.startTime = Date.now();
    metrics.deltaCount = 0;
    metrics.tokenSpeed = 0;
    metrics.ttftMs = undefined;
    metrics.ttftRecorded = false;
    metrics.lastDeltaAtMs = Date.now();
    metrics.stallEpisode = 0;
    metrics.reconnectAttempt = undefined;
    metrics.reconnectMaxAttempts = undefined;
  }));

  unsubs.push(events.turns.on('STREAM_DELTA', () => {
    metrics.deltaCount++;
    metrics.lastDeltaAtMs = Date.now();
    // A byte arrived: any in-flight reconnect (if the SDK reported one)
    // has succeeded.
    metrics.reconnectAttempt = undefined;
    metrics.reconnectMaxAttempts = undefined;
    const elapsed = (Date.now() - metrics.startTime) / 1000;
    // Record TTFT on the first delta of each turn.
    if (!metrics.ttftRecorded) {
      metrics.ttftMs = Date.now() - metrics.startTime;
      metrics.ttftRecorded = true;
    }
    // Use real output token count for accurate tok/s; fall back to delta count.
    const tokenCount = orchestrator.streamingOutputTokens > 0
      ? orchestrator.streamingOutputTokens
      : metrics.deltaCount;
    metrics.tokenSpeed = elapsed > 0 ? tokenCount / elapsed : 0;
  }));

  // Per-turn visited-provider set: tracks providers already attempted this turn
  // so failover cannot ping-pong between two mutually-failing providers.
  // True invariant: at most one retry per provider per turn; exhaustion fires
  // after the chain is consumed.
  // Cleared on TURN_COMPLETED (see handler below) and on new user submission
  // (caller clears via clearFailoverVisited(), wired in main.ts).
  const failoverVisited = new Set<string>();

  unsubs.push(events.turns.on('TURN_COMPLETED', () => {
    failoverVisited.clear();
  }));

  unsubs.push(events.turns.on('TURN_ERROR', (event) => {
    const errVal: string = event.error;

    // --- Optimizer-gated failover path ---
    // When the optimizer is present and enabled, attempt to advance to the next
    // viable provider in the fallback chain before surfacing the error.  When
    // the optimizer is absent or disabled, behaviour is identical to baseline:
    // error surfaces immediately.
    if (providerOptimizer?.enabled && retryTurn) {
      const fromProvider = providerRegistry.getCurrentModel().provider;
      // Mark the failing provider as visited so it will never be selected again
      // in this turn, even if a second TURN_ERROR arrives (e.g. ping-pong).
      failoverVisited.add(fromProvider);
      const result = providerOptimizer.testFallback({});
      // Find the first capable node that is NOT already visited this turn and
      // is NOT synthetic. Synthetic nodes are skipped permanently by design:
      // a synthetic model is itself a fallback ladder over real backends, so
      // failing over INTO one after a real backend already failed is unsound
      // double-indirection (it can route straight back to the failed provider).
      const next = result.chain.find(
        (node) =>
          node.capable &&
          !failoverVisited.has(node.providerId) &&
          node.providerId !== 'synthetic',
      );

      if (next) {
        const toRegistryKey = `${next.providerId}:${next.modelId}`;
        const errorClass = formatUserFacingErrorLine(errVal);
        // Capture FROM registry key before switching — needed for cost comparison.
        const fromRegistryKey = providerRegistry.getCurrentModel().registryKey;
        try {
          providerRegistry.setCurrentModel(toRegistryKey);
        } catch (switchErr) {
          // Switch failed — fall through to honest error display.
          logger.debug('failover setCurrentModel failed', { toRegistryKey, error: String(switchErr) });
          systemMessageRouter.high(`[Error] ${errorClass}`);
          render();
          return;
        }
        // Record the selected provider as visited before the retry fires so
        // a subsequent TURN_ERROR from that provider also skips it.
        failoverVisited.add(next.providerId);
        providerOptimizer.recordFallbackTransition(fromProvider, next.providerId, errorClass);
        const costSuffix = buildCostDeltaSuffix(costLookup, fromRegistryKey, toRegistryKey);
        systemMessageRouter.high(
          `[Failover] ${fromProvider} -> ${next.providerId} (${errorClass})${costSuffix}`,
        );
        render();
        // Re-submit the last user turn on the new provider.
        retryTurn();
        return;
      }

      // Chain exhausted — all capable candidates have been visited or none exist.
      systemMessageRouter.high(
        `[Failover] Chain exhausted — no alternative provider available. Original error: ${formatUserFacingErrorLine(errVal)}`,
      );
      notifyErrorSurfaced(true);
      render();
      return;
    }

    // Baseline: optimizer disabled or not wired — surface error immediately.
    const formatted = formatUserFacingErrorLine(errVal);
    systemMessageRouter.high(`[Error] ${formatted}`);
    notifyErrorSurfaced(false);
    render();
  }));

  // --- Stream stall watchdog: emit a low hint each time a no-delta gap (at
  // start of turn OR mid-stream, after a re-arm) crosses 30s. The transient
  // system message below is the initial alert; streamMetrics.stallEpisode
  // (read every render frame) drives the persistent "stalled Ns" indicator
  // in the thinking fragment, so the two coexist rather than conflict — the
  // message announces the stall, the indicator tracks it ongoing.
  const stallWatchdog = createStreamStallWatchdog({
    events: events.turns,
    onStall: (providerName, episode) => {
      metrics.stallEpisode = episode;
      systemMessageRouter.low(`Still waiting on ${providerName}… Ctrl+C to cancel`);
      render();
    },
    getProviderName: () => providerRegistry.getCurrentModel().provider,
    // thresholdMs uses the default 30 000
  });
  unsubs.push(() => stallWatchdog.dispose());

  // --- Structural consumption of STREAM_RETRY / STREAM_STALL ---
  // Neither event exists on the pinned SDK's (0.35.0) TurnEvent union today —
  // both are proposed additions for the transport-level withRetry() callback
  // (see the stall-honesty audit brief). The typed `events.turns.on` feed
  // rejects unknown event names at compile time, so this casts the feed to a
  // loosely-typed variant and validates each payload with a runtime guard
  // instead of importing a type name that doesn't exist yet — same pattern
  // used elsewhere in this codebase for settings pending SDK schema additions
  // (see src/input/settings-modal-data.ts). Compiles today against 0.35.0;
  // lights up automatically once the SDK adds the real event.
  const looseTurnsFeed = events.turns as unknown as LooseTurnEventFeed;
  unsubs.push(looseTurnsFeed.on('STREAM_RETRY', (payload) => {
    if (!isStreamRetryLikePayload(payload)) return;
    metrics.reconnectAttempt = payload.attempt;
    metrics.reconnectMaxAttempts = payload.maxAttempts;
    render();
  }));
  unsubs.push(looseTurnsFeed.on('STREAM_STALL', () => {
    // Informational only: the TUI's own createStreamStallWatchdog above is
    // the authoritative no-delta detector and already drives the visible
    // indicator via streamMetrics.stallEpisode. This subscription exists so
    // the SDK's own signal (once it lands) is observed rather than silently
    // dropped, without duplicating or fighting the local watchdog.
    render();
  }));

  unsubs.push(events.tools.on('TOOL_EXECUTING', (ev) => {
    metrics.activeToolStartedAtMs = ev.startedAt;
    metrics.activeToolName = ev.tool;
    render();
  }));
  // On every tool-completion path, reset lastDeltaAtMs to "now" so the
  // post-tool silence window starts fresh. Tool execution suppresses stall
  // detection at the render call site (see main.ts), but lastDeltaAtMs itself
  // keeps its pre-tool value the whole time the tool runs — without this
  // reset, the instant a tool completes (potentially long after the last real
  // delta), the very next frame would read msSinceLastDelta as the full
  // tool-execution duration and immediately report a stall, even though the
  // model hasn't had a chance to resume producing tokens yet.
  unsubs.push(events.tools.on('TOOL_SUCCEEDED', () => {
    metrics.activeToolStartedAtMs = undefined;
    metrics.activeToolName = undefined;
    metrics.lastDeltaAtMs = Date.now();
  }));
  unsubs.push(events.tools.on('TOOL_FAILED', () => {
    metrics.activeToolStartedAtMs = undefined;
    metrics.activeToolName = undefined;
    metrics.lastDeltaAtMs = Date.now();
  }));
  unsubs.push(events.tools.on('TOOL_CANCELLED', () => {
    metrics.activeToolStartedAtMs = undefined;
    metrics.activeToolName = undefined;
    metrics.lastDeltaAtMs = Date.now();
  }));

  let _errorSurfacedCb: ((exhausted: boolean) => void) | undefined;
  function notifyErrorSurfaced(exhausted: boolean) { _errorSurfacedCb?.(exhausted); }
  return {
    unsubs,
    clearFailoverVisited: () => failoverVisited.clear(),
    onErrorSurfaced: (cb: (exhausted: boolean) => void) => { _errorSurfacedCb = cb; },
  };
}
