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
  }));

  unsubs.push(events.turns.on('STREAM_DELTA', () => {
    metrics.deltaCount++;
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
      render();
      return;
    }

    // Baseline: optimizer disabled or not wired — surface error immediately.
    const formatted = formatUserFacingErrorLine(errVal);
    systemMessageRouter.high(`[Error] ${formatted}`);
    render();
  }));

  // --- Stream stall watchdog: emit one low hint if STREAM_START has no delta within 30s ---
  const stallWatchdog = createStreamStallWatchdog({
    events: events.turns,
    onStall: (providerName) => {
      systemMessageRouter.low(`Still waiting on ${providerName}… Ctrl+C to cancel`);
      render();
    },
    getProviderName: () => providerRegistry.getCurrentModel().provider,
    // thresholdMs uses the default 30 000
  });
  unsubs.push(() => stallWatchdog.dispose());

  unsubs.push(events.tools.on('TOOL_EXECUTING', (ev) => {
    metrics.activeToolStartedAtMs = ev.startedAt;
    metrics.activeToolName = ev.tool;
    render();
  }));
  unsubs.push(events.tools.on('TOOL_SUCCEEDED', () => {
    metrics.activeToolStartedAtMs = undefined;
    metrics.activeToolName = undefined;
  }));
  unsubs.push(events.tools.on('TOOL_FAILED', () => {
    metrics.activeToolStartedAtMs = undefined;
    metrics.activeToolName = undefined;
  }));
  unsubs.push(events.tools.on('TOOL_CANCELLED', () => {
    metrics.activeToolStartedAtMs = undefined;
    metrics.activeToolName = undefined;
  }));

  return { unsubs, clearFailoverVisited: () => failoverVisited.clear() };
}
