import type { UiRuntimeEvents, RuntimeEventBus } from '@/runtime/index.ts';
import { buildPersistedSessionContext, persistConversation } from '@/runtime/index.ts';
import { buildCompactionReceiptBlock } from './compaction-receipt.ts';
import { persistTurnAnchors, recordTurnAnchor, summarizeTurnLabel } from './rewind-turn-anchors.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { HookDispatcher, HookPhase, HookCategory, HookEventPath } from '@pellux/goodvibes-sdk/platform/hooks';
import type { ConversationManager } from './conversation.ts';
import { journalPathFor, openTranscriptJournal, type TranscriptJournal } from './transcript-journal.ts';
import type { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations';
import { notifyCompletion } from '@pellux/goodvibes-sdk/platform/utils';
import { maybeNotifyLongTask, readNotifyAfterSeconds, type LongTaskStatus } from './long-task-notifier.ts';
import type { FocusTracker } from './focus-tracker.ts';
import { shouldFireAlert, FORCE_NOTIFY_DURATION_MS } from './alert-gating.ts';
import { createBudgetBreachNotifier, type BudgetBreachNotifier } from './budget-breach-notifier.ts';
import { readBudgetAlertUsd } from '../export/cost-utils.ts';

/** Infer the options param of persistConversation to pick up SessionManager correctly. */
type PersistOptions = NonNullable<Parameters<typeof persistConversation>[5]>;

/** Minimal orchestrator surface required by turn-event wiring. */
interface TurnOrchestrator {
  readonly lastInputTokens: number;
  /** Cumulative session usage — same object CostTrackerPanel reads, used here for budget-breach checks. */
  readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
}

/** Minimal provider registry surface required by turn-event wiring. */
interface TurnProviderRegistry {
  getCurrentModel(): { readonly contextWindow: number; readonly id?: string };
  getContextWindowForModel(model: { readonly contextWindow: number }): number;
}

/** Minimal config manager surface required by turn-event wiring. */
interface TurnConfigManager {
  get(key: string): unknown;
  /** Subscribe to a config-key change; returns an unsubscribe. Used to keep the
   *  footer permission-mode pill live without polling. Optional so bare test
   *  doubles that only implement get() still satisfy the type. */
  subscribe?(key: string, cb: (...args: unknown[]) => void): () => void;
}

/** Minimal system message router surface required by turn-event wiring. */
interface TurnSystemMessageRouter {
  high(message: string): void;
  low(message: string): void;
  routeSystemMessage(message: string, level: string): void;
}

export interface WireTurnEventHandlersOptions {
  readonly events: UiRuntimeEvents;
  /**
   * Raw runtime event bus. Needed for domains NOT surfaced by the grouped
   * UiRuntimeEvents feed — specifically the 'compaction' domain, whose
   * mandatory COMPACTION_RECEIPT the transcript renders as a distinct block.
   * Optional so headless/test callers can omit it.
   */
  readonly runtimeBus?: RuntimeEventBus | null;
  readonly conversation: ConversationManager;
  readonly runtime: { sessionId: string; model: string; provider: string };
  readonly orchestrator: TurnOrchestrator;
  readonly configManager: TurnConfigManager;
  readonly providerRegistry: TurnProviderRegistry;
  readonly systemMessageRouter: TurnSystemMessageRouter;
  readonly hookDispatcher: HookDispatcher;
  readonly workingDir: string;
  readonly homeDirectory: string;
  readonly sessionManager: PersistOptions['sessionManager'];
  readonly gitStatusProvider: { refresh(): Promise<unknown> };
  readonly lastGitInfoRef: { value: unknown };
  readonly buildSessionContinuityHints: () => Record<string, unknown>;
  readonly render: () => void;
  /**
   * Outbound webhook notifier. When provided and URLs are configured,
   * long-task push notifications are delivered to configured ntfy/webhook
   * endpoints after the configured threshold. Optional — silently skipped
   * when absent.
   */
  readonly webhookNotifier?: WebhookNotifier | null;
  /**
   * Terminal focus tracker (W2.3). Gates the long-task, budget-breach, and
   * agent/chain-failure desktop alerts wired in this module — see
   * alert-gating.ts. Optional; when absent, none of the new W2.3 alert
   * behavior is gated by focus (long-task keeps its pre-W2.3 always-fire
   * behavior, and budget-breach/failure alerts are skipped entirely, since
   * they are new-in-W2.3 and have no pre-existing unconditional-fire path
   * to fall back to).
   */
  readonly focusTracker?: Pick<FocusTracker, 'shouldAlertWhenUnfocused'> | null;
  /**
   * Optional in-terminal (OSC 9) notifier. When present: a turn finishing emits
   * a 'turn-end' notification, and a delegated agent blocking on human input
   * (AGENT_AWAITING_MESSAGE) emits an 'agent-blocked' notification. Each is
   * gated independently by the notifier's own per-signal config + focus rule.
   * Absent in tests/headless.
   */
  readonly terminalNotifier?: import('./terminal-notifier.ts').TerminalNotifier | null;
  /**
   * Minimal test seam: injectable clock for controlling Date.now() in tests.
   * Defaults to the real Date.now when absent.
   * @internal — tests only
   */
  readonly _clock?: () => number;
}

export interface WireTurnEventHandlersResult {
  /** Trigger a git status refresh; may be called from external code after tool execution. */
  readonly refreshGit: () => void;
  /** Unsubscribe functions to push into the parent unsubs array. */
  readonly unsubs: ReadonlyArray<() => void>;
  /** The per-session transcript journal; call appendRecord() for user-submitted events. */
  readonly transcriptJournal: TranscriptJournal;
}

/**
 * Wire TURN_COMPLETED, TOOL_SUCCEEDED, and TOOL_FAILED runtime events.
 *
 * Responsibilities:
 *   - Auto-save conversation to persistent store after each LLM turn
 *   - Fire the Lifecycle:session:save hook
 *   - Refresh git status after turns and tool results
 *
 * Note: auto-compaction is intentionally NOT performed here. The SDK
 * Orchestrator already runs post-turn context maintenance every turn
 * (handlePostTurnContextMaintenance) using the resolved context window and
 * its own getAutoCompactDecision; re-triggering it from the TUI duplicated
 * that work and raced the SDK's compaction on the shared message array.
 *
 * Returns refreshGit (callable externally) and unsubs (push into parent unsubs).
 */
export function wireTurnEventHandlers(
  options: WireTurnEventHandlersOptions,
): WireTurnEventHandlersResult {
  const {
    events, conversation, runtime, configManager, hookDispatcher, orchestrator, providerRegistry,
    workingDir, homeDirectory, sessionManager, gitStatusProvider,
    lastGitInfoRef, buildSessionContinuityHints, render, webhookNotifier, focusTracker,
    terminalNotifier, runtimeBus, systemMessageRouter,
    _clock = Date.now,
  } = options;

  const unsubs: Array<() => void> = [];
  const configGet = (k: string): unknown => configManager.get(k as Parameters<typeof configManager.get>[0]);

  // Create the per-session transcript journal. Path mirrors recovery-file
  // convention (homeDirectory-scoped). Created lazily on first append.
  const transcriptJournal: TranscriptJournal = openTranscriptJournal(
    journalPathFor(homeDirectory, runtime.sessionId),
    runtime.sessionId,
  );

  // Track turn start time for long-task notification threshold.
  let turnStartTime: number | null = null;

  // Budget-breach edge-trigger checker (W2.3) — one instance per session,
  // piggybacking on the same TURN_COMPLETED handler as the long-task
  // notification below rather than adding a second TURN_COMPLETED subscription.
  const budgetBreachNotifier: BudgetBreachNotifier | null = focusTracker
    ? createBudgetBreachNotifier({ focusTracker, configGet, webhookNotifier: webhookNotifier ?? null, sessionId: runtime.sessionId })
    : null;

  const refreshGit = (): void => {
    gitStatusProvider.refresh().then((info) => { lastGitInfoRef.value = info; render(); }).catch(() => { /* non-fatal */ });
  };

  // Journal user message immediately on TURN_SUBMITTED so a SIGKILL during
  // the subsequent stream loses at most the in-flight token chunk.
  unsubs.push(events.turns.on('TURN_SUBMITTED', () => {
    turnStartTime = _clock();
    try {
      const snap = conversation.toJSON() as { messages: Array<import('./conversation.ts').ConversationMessageSnapshot> };
      transcriptJournal.appendRecord('user_message', snap.messages);
    } catch { /* best-effort */ }
  }));

  unsubs.push(events.turns.on('TURN_COMPLETED', (evt) => {
    // Long-task push notification: fires when the turn exceeded the threshold.
    const turnElapsedMs = turnStartTime !== null ? _clock() - turnStartTime : 0;
    turnStartTime = null;
    const notifyThreshold = readNotifyAfterSeconds((k) => configManager.get(k as Parameters<typeof configManager.get>[0]));
    // stopReason 'empty_response' signals a non-successful completion.
    const taskStatus: LongTaskStatus = evt.stopReason === 'completed' ? 'ok' : 'fail';
    // In-terminal (OSC 9) turn-end notification — fires on its own per-signal
    // config + focus gate, independent of the long-task duration threshold below.
    terminalNotifier?.notify('turn-end', taskStatus === 'ok' ? 'Turn finished' : 'Turn finished with errors');
    maybeNotifyLongTask({
      elapsedMs: turnElapsedMs,
      status: taskStatus,
      kind: 'turn',
      sessionId: runtime.sessionId,
      thresholdSeconds: notifyThreshold,
      webhookNotifier: webhookNotifier ?? null,
      focusTracker,
      configGet,
    });
    // Budget-breach alert (W2.3): edge-triggered, piggybacks on this same
    // TURN_COMPLETED handler rather than a second subscription.
    if (budgetBreachNotifier) {
      const sessionModel = providerRegistry.getCurrentModel().id ?? 'unknown';
      budgetBreachNotifier.check(orchestrator.usage, sessionModel, readBudgetAlertUsd(configGet));
    }
    // Auto-save after every LLM turn so kills don't lose the session
    try {
      const snapshot = conversation.toJSON() as { messages: Array<import('./conversation.ts').ConversationMessageSnapshot>; timestamp?: number };
      const persisted = buildPersistedSessionContext(snapshot.messages, conversation.getTitleSource(), buildSessionContinuityHints());
      persistConversation(
        runtime.sessionId,
        { ...snapshot, ...persisted },
        runtime.model,
        runtime.provider,
        conversation.title || '',
        { workingDirectory: workingDir, homeDirectory, sessionManager },
      );
      hookDispatcher.fire({ path: 'Lifecycle:session:save' as HookEventPath, phase: 'Lifecycle' as HookPhase, category: 'session' as HookCategory, specific: 'save', sessionId: runtime.sessionId, timestamp: Date.now(), payload: { sessionId: runtime.sessionId } }).catch((err: unknown) => logger.debug('hook fire error', { error: summarizeError(err) }));
      // Snapshot succeeded — rotate the journal (gap-filler no longer needed).
      transcriptJournal.rotate();
    } catch (e) {
      // Snapshot failed — append the turn to the journal so recovery can
      // reconstruct it. Best-effort; never crash the TUI.
      try {
        const snap = conversation.toJSON() as { messages: Array<import('./conversation.ts').ConversationMessageSnapshot> };
        transcriptJournal.appendRecord('assistant_turn', snap.messages);
      } catch { /* best-effort */ }
      logger.debug('auto-save on turn:complete failed', { error: summarizeError(e) });
    }
    // Record this turn's rewind anchor: pair the turnId (shared with the
    // workspace checkpoint the turn engine snapshots for this same turn) with
    // the live conversation message count, so a later message-anchored /rewind
    // can truncate the conversation to exactly this boundary — the join key
    // between conversation and files rewind (see core/rewind-turn-anchors.ts).
    try {
      recordTurnAnchor(runtime.sessionId, {
        turnId: evt.turnId,
        label: summarizeTurnLabel(conversation.getLastUserMessage()),
        messageCount: conversation.getMessageCount(),
        at: _clock(),
      });
      // Mirror the anchors to the session's sidecar so message-anchored /rewind
      // survives a resume (the in-memory registry alone is process-local).
      persistTurnAnchors(runtime.sessionId, workingDir);
    } catch { /* best-effort; a rewind-anchor miss must never break the turn */ }
    // Auto-compaction is owned by the SDK Orchestrator's post-turn maintenance
    // (handlePostTurnContextMaintenance), which runs on every turn against the
    // resolved context window (getContextWindowForModel) via the SDK's
    // getAutoCompactDecision (percentage threshold + 15k safety buffer +
    // small-window handling). The TUI must not independently re-trigger it.
    refreshGit();
  }));

  // In-terminal (OSC 9) agent-blocked notification: a delegated agent parked
  // waiting for a human message (AGENT_AWAITING_MESSAGE) is "blocked on you".
  // Gated by the notifier's own per-signal config + focus rule. PRIVACY: the
  // short agent id only — never task text.
  if (terminalNotifier) {
    unsubs.push(events.agents.on('AGENT_AWAITING_MESSAGE', (payload) => {
      terminalNotifier.notify('agent-blocked', `agent ${payload.agentId.slice(0, 8)} is waiting for your input`);
    }));
  }

  unsubs.push(events.tools.on('TOOL_SUCCEEDED', () => {
    refreshGit();
  }));
  unsubs.push(events.tools.on('TOOL_FAILED', () => {
    refreshGit();
  }));

  // Agent/chain-failure desktop alerts (W2.3). The SDK's WebhookNotifier and
  // Notifier already fire webhook/Slack/Discord notifications for these two
  // events unconditionally (attachToRuntimeBus in the SDK's
  // platform/integrations — pre-existing, not focus-gated: an out-of-band
  // push to another device is useful regardless of terminal focus). What was
  // missing was a desktop notification, gated by focus like the other three
  // alert classes — that's the only thing added here, to avoid double-firing
  // a webhook that's already covered.
  if (focusTracker) {
    unsubs.push(events.agents.on('AGENT_FAILED', (payload) => {
      if (!shouldFireAlert(focusTracker, configGet, 'behavior.notifyOnAgentFailure')) return;
      try {
        notifyCompletion('GoodVibes — agent failed', `agent ${payload.agentId.slice(0, 8)} failed: ${payload.error}`, FORCE_NOTIFY_DURATION_MS);
      } catch (err) {
        logger.debug('turn-event-wiring: agent-failure notify error', { error: String(err) });
      }
    }));
    unsubs.push(events.workflows.on('WORKFLOW_CHAIN_FAILED', (payload) => {
      if (!shouldFireAlert(focusTracker, configGet, 'behavior.notifyOnChainFailure')) return;
      try {
        // An operator cancellation is an intended stop, not a failure — narrate it
        // as cancelled (the reason already carries the landed-work count from the
        // chain's edit ledger), so the notification never contradicts the cancelled
        // chain/owner/cohort surfaces.
        if (payload.failureKind === 'cancelled') {
          notifyCompletion('GoodVibes — WRFC chain cancelled', `chain ${payload.chainId.slice(0, 12)} cancelled: ${payload.reason}`, FORCE_NOTIFY_DURATION_MS);
        } else {
          const kindLabel = payload.failureKind === 'transport' ? 'transient transport error' : payload.reason;
          notifyCompletion('GoodVibes — WRFC chain failed', `chain ${payload.chainId.slice(0, 12)} failed: ${kindLabel}`, FORCE_NOTIFY_DURATION_MS);
        }
      } catch (err) {
        logger.debug('turn-event-wiring: chain-failure notify error', { error: String(err) });
      }
    }));
  }

  // Live footer permission-mode pill: re-render whenever the SDK config
  // surface reports permissions.mode changed. Mode changes are made through
  // configManager.set('permissions.mode', ...) (the SDK-owned surface the
  // PermissionManager reads), so this covers our own Shift+Tab / /plan toggles
  // as well as any other in-process writer. No polling.
  if (typeof configManager.subscribe === 'function') {
    unsubs.push(configManager.subscribe('permissions.mode', () => { render(); }));
  }

  // Post-compaction receipt (never-silent): the SDK emits a mandatory
  // COMPACTION_RECEIPT on the 'compaction' domain after every automatic (and
  // the manual) compaction. That domain is NOT in the grouped UiRuntimeEvents
  // feed, so we subscribe on the raw bus and render the receipt as a distinct
  // [Compaction] block. Automatic compaction previously left no transcript
  // trace; this makes the audit visible.
  if (runtimeBus) {
    unsubs.push(runtimeBus.on('COMPACTION_RECEIPT', (envelope) => {
      try {
        const payload = envelope.payload;
        if (payload.type !== 'COMPACTION_RECEIPT') return;
        systemMessageRouter.high(buildCompactionReceiptBlock(payload));
        render();
      } catch (err) {
        logger.debug('turn-event-wiring: compaction-receipt render error', { error: String(err) });
      }
    }));
  }

  return { refreshGit, unsubs, transcriptJournal };
}
