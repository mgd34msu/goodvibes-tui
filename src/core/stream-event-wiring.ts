import type { UiRuntimeEvents } from '@/runtime/index.ts';
import { createStreamStallWatchdog } from './stream-stall-watchdog.ts';
import { buildRoutingChip, FALLBACK_CORRELATION_WINDOW_MS } from './model-routing-chip.ts';
import { formatUserFacingErrorLine } from './format-user-error.ts';
import { classifyProviderSetup } from '../providers/provider-classification.ts';
import type { FailoverTurnState } from './active-model-identity.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { ReasoningEffortSpec } from '@pellux/goodvibes-sdk/platform/providers';
import {
  publishActiveEffortOptions,
  remapEffortForServingModel,
} from '../providers/reasoning-effort-surface.ts';

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
   * callId of the currently executing tool call; cleared when execution
   * completes. This is the real orchestrator callId (from TOOL_EXECUTING),
   * so a per-tool cancel affordance targets exactly the running call — never
   * the synthetic 'live' render id.
   */
  activeToolCallId: string | undefined;
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

/** The idle initial StreamMetrics — mutated in place by wireStreamEventMetrics handlers. */
export function createStreamMetrics(): StreamMetrics {
  return {
    startTime: 0, deltaCount: 0, tokenSpeed: 0, ttftMs: undefined, ttftRecorded: false,
    activeToolStartedAtMs: undefined, activeToolName: undefined, activeToolCallId: undefined,
    lastDeltaAtMs: undefined, stallEpisode: 0,
    reconnectAttempt: undefined, reconnectMaxAttempts: undefined,
  };
}

/** Minimal orchestrator surface required for stream token-speed calculation. */
interface StreamOrchestrator {
  readonly streamingOutputTokens: number;
}

/** Minimal provider surface required for the stream stall watchdog and failover switching. */
interface StreamProviderRegistry {
  getCurrentModel(): {
    readonly provider: string;
    readonly registryKey?: string;
    /**
     * Model id, display name and reasoning-effort spec, all optional so a test
     * double carrying only provider/registryKey still satisfies this surface.
     * When the id is present the failover path can re-resolve the configured
     * reasoning level against the model that is about to serve; when it is
     * absent that step is skipped rather than guessed at.
     */
    readonly id?: string;
    readonly displayName?: string;
    readonly reasoningEffort?: ReasoningEffortSpec | undefined;
  };
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
  /** Recent fallback transitions — read by the routing chip to skip double-narrating a failover. */
  readonly fallbackLog: readonly { readonly from: string; readonly to: string; readonly reason: string; readonly ts: number }[];
}

/** Minimal system-message surface required for user-visible notifications. */
interface StreamSystemMessageRouter {
  high(message: string): void;
  low(message: string): void;
  /**
   * Unconditional conversation delivery (see system-message-router.ts). Used
   * for provider-switch notices: which backend serves a turn — and therefore
   * who bills for it — is never ambient chatter that a routing preference or
   * the noise gate may filter out. Optional so bare test doubles that supply
   * only high/low still type-check; announce() below falls back to high().
   */
  userReceipt?(message: string): void;
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
 * Returns USD-per-1M-token pricing for the given model ID, or null when the
 * catalog honestly does not know the model (never a fabricated zero).
 */
export interface FailoverCostLookup {
  getCostFromCatalog(modelId: string): { readonly input: number; readonly output: number } | null;
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
   *
   * The re-submission rolls the conversation back to its pre-submission
   * message count, which deletes everything the failed turn added — including
   * a failover notice appended before the call. So the notice is passed IN
   * rather than emitted before: the caller re-posts it after its rollback, and
   * it survives to be read. Implementations that do not roll back may ignore
   * the argument, but must then post the notice themselves.
   *
   * Returns whether the turn was actually re-submitted. False means there was
   * nothing to retry (no pre-submission snapshot — the failed turn did not
   * come from the composer) and the notice was NOT posted, so the caller must
   * narrate the switch and surface the error itself rather than let a turn end
   * in silence on a backend the user did not choose.
   */
  readonly retryTurn?: (notice?: string) => boolean;
  /**
   * Optional cost catalog for attaching per-1M-token cost information to
   * the failover notice.  When provided and both models have non-zero pricing,
   * the notice includes input and output cost comparisons.  When absent or pricing is
   * unavailable for either model, the notice honestly states "cost data unavailable".
   */
  readonly costLookup?: FailoverCostLookup;
  /**
   * Optional accessor for whether an approval card is currently waiting on the USER. When it
   * returns true, the stall watchdog does NOT emit its "Still waiting on <provider>… Ctrl+C to
   * cancel" hint: the stream is legitimately silent because we asked the user a question, so
   * blaming the provider (or framing it as a stall) would be dishonest. The approval surface owns
   * the honest "Waiting for your approval" label instead.
   */
  readonly isApprovalPending?: (() => boolean) | undefined;
  /**
   * Stall watchdog threshold in ms. Defaults to the watchdog's own default (STALL_THRESHOLD_MS,
   * 30 000). Exposed only so unit tests can drive the stall path without waiting 30s — production
   * callers omit it.
   */
  readonly stallThresholdMs?: number | undefined;
  /**
   * Shared holder for the live failover record (core/active-model-identity.ts).
   * Set when failover switches the registry off the user's configured
   * selection, cleared once serving is restored to it. The render frame reads
   * the same object, so the header and footer describe the switch while it is
   * in effect. Omitted by unit tests that only exercise notice content.
   */
  readonly failoverState?: FailoverTurnState;
  /**
   * The user's configured model selection (config `provider.model`) as a
   * registry key. Read at the moment of a failover switch so the turn-end
   * restore targets what the user actually chose — not whatever the registry
   * happened to hold. Without it, failover still works but no restore or
   * divergence marker is possible, so both are skipped rather than guessed at.
   */
  readonly getConfiguredRegistryKey?: () => string | undefined;
  /**
   * The user's configured reasoning level (config `provider.reasoningEffort`).
   * Read at the moment of a failover switch so the level can be re-resolved
   * against the model that is about to serve: a level the configured model
   * offers may not exist on the fallback, and sending it unchanged is how a
   * failover turns into a provider-side 400 the user cannot explain. Omitted
   * means the re-resolution is skipped entirely, never guessed.
   */
  readonly getConfiguredReasoningEffort?: () => string | undefined;
}

/** Result of wireStreamEventMetrics. */
export interface WireStreamEventMetricsResult {
  /** Unsubscribe functions; push into the parent unsubs array for cleanup on exit. */
  readonly unsubs: ReadonlyArray<() => void>;
  /**
   * Clear the per-turn failover visited-provider set AND restore the user's
   * configured model selection if a failover left serving somewhere else.
   * Call this on every new user submission so neither the visited set nor a
   * per-turn provider switch bleeds across independent turns (both are also
   * handled on TURN_COMPLETED/TURN_CANCEL, but a new submission may arrive
   * before either fires).
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
  // A null catalog answer means honestly unknown — treated exactly like the
  // legacy zero-pricing sentinel below.
  const fromCost = (fromModelId ? lookup.getCostFromCatalog(fromModelId) : null) ?? { input: 0, output: 0 };
  const toCost = lookup.getCostFromCatalog(toModelId) ?? { input: 0, output: 0 };
  // Report unavailable when either side has no pricing (unknown model).
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
 * Build the billing-class segment of a failover notice, e.g.
 * ` [billing: API key → Subscription — billing class changed]`.
 *
 * This path is NOT the synthetic provider's tier-isolated failover, which is
 * where the documented "free, paid and subscription tiers never mix" contract
 * lives (docs/providers-and-routing.md:77-128, enforced in the SDK's
 * synthetic.ts by CanonicalModel.tier). The optimizer chain consumed here
 * carries no tier metadata at all — its nodes are
 * `{ position, providerId, modelId, capable, explanation }` and `explanation`
 * describes functional capability (streaming, tool calling, context size),
 * never billing. So the switch cannot be constrained by a tier it cannot see;
 * what it CAN do is say out loud which billing class it moved to, so a user
 * who does not want their subscription spent on an automatic retry can object
 * and turn the optimizer off.
 *
 * Classification comes from providers/provider-classification.ts, which is
 * honest about ignorance: an unrecognised provider id reports "Unknown" rather
 * than being quietly assumed safe.
 */
function buildBillingSuffix(fromProviderId: string, toProviderId: string): string {
  const from = classifyProviderSetup({ providerId: fromProviderId }).setupLabel;
  const to = classifyProviderSetup({ providerId: toProviderId }).setupLabel;
  const changed = from !== to ? ' — billing class changed' : '';
  return ` [billing: ${from} → ${to}${changed}]`;
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
    isApprovalPending, stallThresholdMs, failoverState, getConfiguredRegistryKey,
    getConfiguredReasoningEffort,
  } = options;

  const unsubs: Array<() => void> = [];

  /**
   * Deliver a provider-switch notice to the conversation unconditionally.
   * Prefers the router's userReceipt channel, which skips the noise gate and
   * the ui.operationalMessages routing target entirely, so the line cannot be
   * filtered away by a preference and is treated as real content even while
   * the splash still owns the screen. Falls back to high() for bare doubles.
   */
  const announce = (message: string): void => {
    if (systemMessageRouter.userReceipt) systemMessageRouter.userReceipt(message);
    else systemMessageRouter.high(message);
  };

  /**
   * Put serving back on the user's configured selection after a failed-over
   * turn ends.
   *
   * Failover is per-turn recovery, not a permanent re-selection. Without this,
   * the one setCurrentModel() call that rescued a single failed turn stayed in
   * force for the rest of the session: every later turn ran on the fallback
   * backend while nothing in the session state or the footer had changed to
   * say so. The user's configured selection is authoritative, so the NEXT turn
   * starts from it again. If that backend is still unhealthy, the normal
   * per-turn failover handles it again — visibly, with a fresh notice — which
   * is exactly the behaviour a sticky override was hiding.
   *
   * The record is kept (not cleared) when the restore itself fails, so the
   * header and footer keep reporting the real serving backend rather than
   * claiming a revert that did not happen.
   */
  /**
   * Registry keys THIS module switched to and narrated itself, with the time
   * of the switch. The MODEL_CHANGED listener consumes an entry instead of
   * emitting the generic routing chip, so neither half of a failover is
   * narrated twice: the switch out is announced by `[Failover] from -> to
   * (reason)` and the switch back by `[Failover] Restored …`, and a second
   * line reading "(reason unknown)" for the same event would be both a
   * duplicate and a lie — the reason is known in both cases.
   *
   * A timestamped map rather than a flag cleared around the setCurrentModel
   * call, because MODEL_CHANGED does NOT arrive synchronously: the TUI reads
   * it through the runtime event feed, which delivers after the emitting call
   * has returned (observed live — a flag cleared in a finally block was always
   * already null by the time the listener ran, and both failover halves got a
   * duplicate chip). Entries expire on the same window the fallback-log
   * correlation uses, so a switch whose event never arrives cannot silence an
   * unrelated later change to the same model.
   */
  const selfNarratedSwitches = new Map<string, number>();

  /**
   * Run a registry switch this module narrates itself, with the chip suppressed
   * for it. Returns the effort-remap sentence when the switch changed the level
   * that goes on the wire, for the CALLER to place — see
   * reconcileEffortWithServingModel for why it is not announced here.
   */
  const switchNarrated = (registryKey: string): string | undefined => {
    selfNarratedSwitches.set(registryKey, Date.now());
    try {
      providerRegistry.setCurrentModel(registryKey);
    } catch (err) {
      selfNarratedSwitches.delete(registryKey); // no switch happened, nothing to suppress
      throw err;
    }
    return reconcileEffortWithServingModel();
  };

  /**
   * Re-resolve the REQUESTED reasoning level against whichever model is now
   * serving, and hand back the sentence that says so when it had to change.
   *
   * Both halves of a failover come through switchNarrated, so this covers the
   * switch out and the switch back. The requested level is left untouched in
   * config — the fallback is temporary and the user's choice must survive it —
   * but the level actually sent is the resolved one, and the SDK's own sentence
   * explaining the remap is surfaced verbatim rather than reworded.
   *
   * The sentence is RETURNED rather than announced. On the failover-out path
   * this function runs before retryTurn, and retryTurn rolls the conversation
   * back to its pre-submission message count — which deleted this notice every
   * time, exactly as it used to delete the failover notice itself. The caller
   * folds it into the notice it hands to retryTurn so it survives the rollback;
   * the restore path, which has no rollback after it, announces it directly.
   */
  const reconcileEffortWithServingModel = (): string | undefined => {
    const serving = providerRegistry.getCurrentModel();
    if (!serving.id) return undefined; // no model id on this surface: nothing to resolve against
    const model = {
      id: serving.id,
      provider: serving.provider,
      ...(serving.displayName ? { displayName: serving.displayName } : {}),
      ...(serving.reasoningEffort ? { reasoningEffort: serving.reasoningEffort } : {}),
    };
    publishActiveEffortOptions(model);
    // getConfiguredReasoningEffort reads config `provider.reasoningEffort` —
    // the REQUESTED level. It must never be re-seeded from a previously snapped
    // effective value, or a single failover onto a capped model would ratchet
    // the level down for the rest of the session.
    const requested = getConfiguredReasoningEffort?.();
    if (requested === undefined || requested === '') return undefined;
    return remapEffortForServingModel(requested, model).note;
  };

  /** True when this MODEL_CHANGED is one of our own narrated switches (consumes the record). */
  const wasSelfNarrated = (registryKey: string): boolean => {
    const narratedAt = selfNarratedSwitches.get(registryKey);
    if (narratedAt === undefined) return false;
    selfNarratedSwitches.delete(registryKey);
    return Date.now() - narratedAt <= FALLBACK_CORRELATION_WINDOW_MS;
  };

  const restoreConfiguredSelection = (): void => {
    const record = failoverState?.current();
    if (!record || !failoverState) return;
    if (providerRegistry.getCurrentModel().registryKey === record.configuredRegistryKey) {
      failoverState.clear();
      return;
    }
    try {
      const effortNote = switchNarrated(record.configuredRegistryKey);
      failoverState.clear();
      // Nothing rolls the transcript back after this point, so the restore line
      // and any effort remap that came with it are announced directly.
      announce(
        `[Failover] Restored ${record.configuredRegistryKey} for the next turn.`
        + (effortNote ? `\n[Failover] ${effortNote}` : ''),
      );
    } catch (restoreErr) {
      logger.debug('failover restore failed', {
        configuredRegistryKey: record.configuredRegistryKey, error: String(restoreErr),
      });
      announce(
        `[Failover] Could not switch back to ${record.configuredRegistryKey}; still serving ${record.servingRegistryKey}.`,
      );
    }
    render();
  };

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

  // Both terminal turn outcomes end the failover's authority over the
  // registry: a completed turn got its answer, a cancelled one will not.
  // (TURN_COMPLETED and TURN_ERROR are mutually exclusive per turn in the SDK
  // — TURN_COMPLETED is emitted only on the success path in
  // orchestrator-turn-helpers, TURN_ERROR only from the orchestrator's catch —
  // so restoring here can never undo a switch whose retry has not run yet.)
  unsubs.push(events.turns.on('TURN_COMPLETED', () => {
    failoverVisited.clear();
    restoreConfiguredSelection();
  }));

  unsubs.push(events.turns.on('TURN_CANCEL', () => {
    failoverVisited.clear();
    restoreConfiguredSelection();
  }));

  // Routing chip (never-silent model change): every MODEL_CHANGED that is not
  // already narrated by the richer [Failover] line becomes a one-line
  // conversation notice. Deferred a microtask so a failover's
  // recordFallbackTransition (which runs right AFTER its setCurrentModel) has
  // landed in the fallback log before buildRoutingChip checks for correlation.
  // Degrade gracefully when a bare test double omits the providers feed.
  if (events.providers) {
    unsubs.push(events.providers.on('MODEL_CHANGED', (change) => {
      if (wasSelfNarrated(change.registryKey)) return; // a [Failover] line already said this, with its reason
      queueMicrotask(() => {
        const chip = buildRoutingChip(change, providerOptimizer?.fallbackLog ?? [], Date.now());
        if (chip === null) return;
        systemMessageRouter.high(chip);
        render();
      });
    }));
  }

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
        // The effort remap that comes with the switch is carried, not announced:
        // retryTurn's rollback below would delete it (see
        // reconcileEffortWithServingModel).
        let effortNote: string | undefined;
        try {
          effortNote = switchNarrated(toRegistryKey);
        } catch (switchErr) {
          // Switch failed — fall through to honest error display. This ends the
          // turn, so an EARLIER hop's switch (if this is a second failover
          // within the same turn) loses its authority here just as it would on
          // any other terminal outcome.
          logger.debug('failover setCurrentModel failed', { toRegistryKey, error: String(switchErr) });
          systemMessageRouter.high(`[Error] ${errorClass}`);
          restoreConfiguredSelection();
          render();
          return;
        }
        // Record the selected provider as visited before the retry fires so
        // a subsequent TURN_ERROR from that provider also skips it.
        failoverVisited.add(next.providerId);
        // Remember the user's configured selection so the turn-end restore
        // targets it, and so both shell surfaces can name it while the switch
        // is in force. Sticky across a second hop within the same turn.
        const configuredRegistryKey = getConfiguredRegistryKey?.();
        if (configuredRegistryKey) {
          failoverState?.begin({ configuredRegistryKey, servingRegistryKey: toRegistryKey });
        }
        providerOptimizer.recordFallbackTransition(fromProvider, next.providerId, errorClass);
        const costSuffix = buildCostDeltaSuffix(costLookup, fromRegistryKey, toRegistryKey);
        const billingSuffix = buildBillingSuffix(fromProvider, next.providerId);
        // Re-submit the last user turn on the new provider, handing the notice
        // to retryTurn so it outlives that call's transcript rollback (see the
        // retryTurn option doc). Emitting it here instead would delete it.
        const failoverNotice = `[Failover] ${fromProvider} -> ${next.providerId} (${errorClass})${billingSuffix}${costSuffix}`
          + (effortNote ? `\n[Failover] ${effortNote}` : '');
        if (!retryTurn(failoverNotice)) {
          // No turn to re-submit (the failed turn did not come from the
          // composer, so there is no pre-submission snapshot to roll back to).
          // The registry has still MOVED, so the switch gets narrated here and
          // the original error surfaces — silence would leave the user on a
          // different backend with no turn running and nothing said about it.
          announce(failoverNotice);
          systemMessageRouter.high(`[Error] ${errorClass}`);
          restoreConfiguredSelection();
          notifyErrorSurfaced(false);
        }
        render();
        return;
      }

      // Chain exhausted — all capable candidates have been visited or none exist.
      // The turn is over, so any switch made earlier in it loses its authority:
      // restore the configured selection before surfacing the error, or the
      // user's next turn would silently start on the last fallback tried.
      announce(
        `[Failover] Chain exhausted — no alternative provider available. Original error: ${formatUserFacingErrorLine(errVal)}`,
      );
      restoreConfiguredSelection();
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
      // Suppress the provider-blaming stall hint while an approval card is waiting on the user: the
      // stream is silent because WE asked the user a question, not because the provider stalled.
      if (isApprovalPending?.()) return;
      metrics.stallEpisode = episode;
      systemMessageRouter.low(`Still waiting on ${providerName}… Ctrl+C to cancel`);
      render();
    },
    getProviderName: () => providerRegistry.getCurrentModel().provider,
    // thresholdMs defaults to 30 000 in the watchdog; only unit tests override it.
    ...(stallThresholdMs !== undefined ? { thresholdMs: stallThresholdMs } : {}),
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
    metrics.activeToolCallId = ev.callId;
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
    metrics.activeToolCallId = undefined;
    metrics.lastDeltaAtMs = Date.now();
  }));
  unsubs.push(events.tools.on('TOOL_FAILED', () => {
    metrics.activeToolStartedAtMs = undefined;
    metrics.activeToolName = undefined;
    metrics.activeToolCallId = undefined;
    metrics.lastDeltaAtMs = Date.now();
  }));
  unsubs.push(events.tools.on('TOOL_CANCELLED', () => {
    metrics.activeToolStartedAtMs = undefined;
    metrics.activeToolName = undefined;
    metrics.activeToolCallId = undefined;
    metrics.lastDeltaAtMs = Date.now();
  }));

  let _errorSurfacedCb: ((exhausted: boolean) => void) | undefined;
  function notifyErrorSurfaced(exhausted: boolean) { _errorSurfacedCb?.(exhausted); }
  return {
    unsubs,
    // A new user submission is also a turn boundary: restore here too, so a
    // turn that ended without any terminal event (an aborted stream that
    // emitted neither TURN_COMPLETED nor TURN_CANCEL) still cannot leave the
    // next turn silently pinned to a fallback backend.
    clearFailoverVisited: () => { failoverVisited.clear(); restoreConfiguredSelection(); },
    onErrorSurfaced: (cb: (exhausted: boolean) => void) => { _errorSurfacedCb = cb; },
  };
}
