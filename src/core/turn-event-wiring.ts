import type { UiRuntimeEvents, RuntimeEventBus } from '@/runtime/index.ts';
import { buildPersistedSessionContext, persistConversation } from '@/runtime/index.ts';
import { buildCompactionReceiptBlock } from './compaction-receipt.ts';
import { workstreamFailureNotification } from './workstream-notification.ts';
import { persistTurnAnchors, recordTurnAnchor, summarizeTurnLabel } from '@pellux/goodvibes-sdk/platform/rewind';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { HookDispatcher, HookPhase, HookCategory, HookEventPath } from '@pellux/goodvibes-sdk/platform/hooks';
import type { ConversationManager } from './conversation.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import { journalPathFor, openTranscriptJournal, type TranscriptJournal } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import type { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations';
import { notifyCompletion } from '@pellux/goodvibes-sdk/platform/utils';
import { maybeNotifyLongTask, readNotifyAfterSeconds } from './long-task-notifier.ts';
import type { FocusTracker } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import {
  shouldFireAlert,
  FORCE_NOTIFY_DURATION_MS,
  NOTIFICATION_TEXT_LIMITS,
  TurnActivityTally,
  buildTurnNotificationLine,
  readNotificationsMetadataOnly,
  resolveTurnName,
  trimAtWordBoundary,
  type TurnOutcome,
} from '@pellux/goodvibes-sdk/platform/runtime/operations';
import { createBudgetBreachNotifier, type BudgetBreachNotifier } from './budget-breach-notifier.ts';
import { readBudgetAlertUsd } from '@pellux/goodvibes-sdk/platform/providers';

/** Minimal orchestrator surface required by turn-event wiring. */
interface TurnOrchestrator {
  readonly lastInputTokens: number;
  /** Cumulative session usage, same object CostTrackerPanel reads, used here for budget-breach checks. */
  readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  /**
   * The SDK Orchestrator's own end-of-turn popup; handOff() silences it while
   * this wiring's long-task notice owns the popup and returns the release.
   * Optional so bare test doubles still satisfy the type.
   */
  readonly turnEndNotice?: { handOff(): () => void };
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
   * UiRuntimeEvents feed, specifically the 'compaction' domain, whose
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
  /**
   * The app's declare-once session-storage handle. The turn snapshot, the
   * last-session pointer it writes, the transcript journal, and the rewind
   * anchor sidecar all resolve off this one handle, so the boot notice and
   * `--continue`, which read through the same handle, land on the files this
   * writer actually produced.
   */
  readonly surface: SessionSurface;
  readonly gitStatusProvider: { refresh(): Promise<unknown> };
  readonly lastGitInfoRef: { value: unknown };
  readonly buildSessionContinuityHints: () => Record<string, unknown>;
  readonly render: () => void;
  /**
   * Outbound webhook notifier. When provided and URLs are configured,
   * long-task push notifications are delivered to configured ntfy/webhook
   * endpoints after the configured threshold. Optional, silently skipped
   * when absent.
   */
  readonly webhookNotifier?: WebhookNotifier | null;
  /**
   * Terminal focus tracker. Gates the long-task, budget-breach, and
   * agent/chain-failure desktop alerts wired in this module, see
   * alert-gating.ts. Optional; when absent, none of the new alert
   * behavior is gated by focus (long-task keeps its always-fire
   * behavior from before focus gating existed, and budget-breach/failure alerts are
   * skipped entirely, since they have no pre-existing unconditional-fire path
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
   * Desktop delivery for the turn, budget, agent and workstream notices wired
   * here; defaults to the SDK notifyCompletion. Tests pass a spy to read the text.
   */
  readonly notifyDesktop?: typeof notifyCompletion;
  /**
   * The terminal bell for a turn over 5s that did not reach the desktop popup
   * (the popup rings it itself); defaults to writing BEL to stdout, which is
   * what the SDK Orchestrator's own popup did before this wiring took it over.
   */
  readonly ringBell?: () => void;
  /**
   * How long a failover retry may take to start before the failed turn it
   * replaces is told as failed after all. @internal, tests only.
   */
  readonly _failoverRetryGraceMs?: number;
  /**
   * Minimal test seam: injectable clock for controlling Date.now() in tests.
   * Defaults to the real Date.now when absent.
   * @internal, tests only
   */
  readonly _clock?: () => number;
}

/**
 * Wrap a TranscriptJournal so every write first checks whether
 * `runtime.sessionId` has moved on from the session the journal is currently
 * bound to, rebinding to the new session's file when it has. See the
 * `transcriptJournal` construction above for why this is necessary.
 */
function wrapJournalWithSessionRebind(
  journal: TranscriptJournal,
  surface: SessionSurface,
  runtime: { readonly sessionId: string },
): TranscriptJournal {
  let boundSessionId = runtime.sessionId;
  const ensureBoundToCurrentSession = (): void => {
    if (runtime.sessionId !== boundSessionId) {
      boundSessionId = runtime.sessionId;
      journal.rebind(journalPathFor(surface, boundSessionId), boundSessionId);
    }
  };
  return {
    get path(): string { return journal.path; },
    appendRecord: (type, messages) => { ensureBoundToCurrentSession(); journal.appendRecord(type, messages); },
    rotate: () => { ensureBoundToCurrentSession(); journal.rotate(); },
    rebind: (path, sessionId) => { boundSessionId = sessionId; journal.rebind(path, sessionId); },
  };
}

/**
 * How long a failover retry may take to reach TURN_SUBMITTED (it waits on the
 * memory-recall refresh first) before the failure it replaced is told anyway.
 */
const FAILOVER_RETRY_GRACE_MS = 30_000;

/** The Orchestrator's own popup rang the bell for a turn over this long. */
const TURN_BELL_AFTER_MS = 5_000;

/** The Orchestrator's own popup came for a turn over this long (SDK notifyCompletion). */
const TURN_DESKTOP_AFTER_MS = 30_000;

/** Most agent/workstream names kept at once; a lost terminal event cannot grow the maps unbounded. */
const MAX_REMEMBERED_NAMES = 256;

function rememberBounded<V>(map: Map<string, V>, id: string, value: V): void {
  map.delete(id);
  map.set(id, value);
  while (map.size > MAX_REMEMBERED_NAMES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function normalizeTitleSource(source: unknown): 'user' | 'system' | null {
  return source === 'user' || source === 'system' ? source : null;
}

export interface WireTurnEventHandlersResult {
  /** Trigger a git status refresh; may be called from external code after tool execution. */
  readonly refreshGit: () => void;
  /** Unsubscribe functions to push into the parent unsubs array. */
  readonly unsubs: ReadonlyArray<() => void>;
  /** The per-session transcript journal; call appendRecord() for user-submitted events. */
  readonly transcriptJournal: TranscriptJournal;
  /**
   * The failover path re-submits the failed turn on another provider (see
   * stream-event-wiring.ts onFailoverRetry). Call it synchronously from that
   * TURN_ERROR: the failure notice for the turn is withheld, and the retry's
   * TURN_SUBMITTED continues the same user turn, so the user gets one notice
   * for how it finally ended.
   */
  readonly continueTurnAfterFailover: () => void;
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
    surface, gitStatusProvider,
    lastGitInfoRef, buildSessionContinuityHints, render, webhookNotifier, focusTracker,
    terminalNotifier, runtimeBus, systemMessageRouter,
    notifyDesktop = notifyCompletion,
    ringBell = () => { process.stdout.write('\x07'); },
    _failoverRetryGraceMs = FAILOVER_RETRY_GRACE_MS,
    _clock = Date.now,
  } = options;

  const unsubs: Array<() => void> = [];
  const configGet = (k: string): unknown => configManager.get(k as Parameters<typeof configManager.get>[0]);

  // ONE POPUP PER TURN. The long-task notice below owns the turn's desktop
  // popup: it names the turn, counts what it did, honors
  // behavior.notifyAfterSeconds and the unfocused-only gate, and reaches the
  // webhook. The SDK Orchestrator pops its own end-of-turn notice too, so it
  // is handed off here for as long as this wiring lives.
  const releaseTurnEndNotice = orchestrator.turnEndNotice?.handOff();
  if (releaseTurnEndNotice) unsubs.push(releaseTurnEndNotice);

  // Create the per-session transcript journal. Path mirrors recovery-file
  // convention (homeDirectory-scoped). Created lazily on first append.
  //
  // `runtime` is the same MutableRuntimeState object /session resume and
  // /session fork reassign `sessionId` on in place (session-workflow.ts,
  // bootstrap-hook-bridge.ts), so a session switch is visible here just by
  // re-reading `runtime.sessionId`. Wrapped so every write re-checks it and
  // rebinds to the new session's file first, otherwise the journal opened
  // for the OLD session keeps appending the NEW session's snapshots into the
  // OLD session's file, and a later resume of the old session replays the
  // wrong conversation.
  const transcriptJournal: TranscriptJournal = wrapJournalWithSessionRebind(
    openTranscriptJournal(journalPathFor(surface, runtime.sessionId), runtime.sessionId),
    surface,
    runtime,
  );

  // Track turn start time for long-task notification threshold.
  let turnStartTime: number | null = null;

  // What names the turn and what it did, for the end-of-turn notices
  // (SDK runtime/turn-notification.ts): the submitted text, and a tally of
  // tool calls, changed files, agents started and the latest review score.
  let turnText: string | null = null;
  let lastTurnName: string | null = null;
  let lastEndedTurnId: string | null = null;
  const tally = new TurnActivityTally();
  const nameCurrentTurn = (): string | null => resolveTurnName({
    title: conversation.title,
    titleSource: normalizeTitleSource(conversation.getTitleSource()),
    turnText,
  });

  // Task text for agents and workstreams, from their opening events; the
  // terminal events carry only the id. Bounded, dropped at the terminal event.
  const agentTasks = new Map<string, string>();
  const workstreams = new Map<string, { task: string; reviewScore: number | null }>();

  // Budget-breach edge-trigger checker, one instance per session,
  // piggybacking on the same TURN_COMPLETED handler as the long-task
  // notification below rather than adding a second TURN_COMPLETED subscription.
  const budgetBreachNotifier: BudgetBreachNotifier | null = focusTracker
    ? createBudgetBreachNotifier({
      focusTracker, configGet, webhookNotifier: webhookNotifier ?? null, sessionId: runtime.sessionId,
      getTurnName: () => lastTurnName, notifyDesktop,
    })
    : null;

  // Provider failover (stream-event-wiring.ts) re-submits a failed turn on
  // another provider. The user asked once, so the user turn spans every
  // attempt: its failure is withheld while the retry is on its way, and the
  // retry's TURN_SUBMITTED continues it (same start time, tally and name).
  let failoverRetryPending = false;
  let withheldFailure: { turnId: string; reason: string | null; timer: ReturnType<typeof setTimeout> } | null = null;
  const clearWithheldFailure = (): void => {
    if (withheldFailure) clearTimeout(withheldFailure.timer);
    withheldFailure = null;
  };
  const continueTurnAfterFailover = (): void => {
    failoverRetryPending = true;
  };

  /**
   * The end of a turn, however it ended: the in-terminal (OSC 9) notice on
   * its own per-signal config + focus gate, then the long-task desktop and
   * webhook notice past behavior.notifyAfterSeconds. Once per turnId.
   */
  const notifyTurnEnd = (turnId: string, outcome: TurnOutcome, reason: string | null): void => {
    if (turnId === lastEndedTurnId) return;
    lastEndedTurnId = turnId;
    clearWithheldFailure();
    failoverRetryPending = false;
    const turnElapsedMs = turnStartTime !== null ? _clock() - turnStartTime : 0;
    turnStartTime = null;
    const name = nameCurrentTurn();
    lastTurnName = name;
    const activity = tally.snapshot();
    const metadataOnly = readNotificationsMetadataOnly(configGet);
    terminalNotifier?.notify('turn-end', buildTurnNotificationLine({
      outcome, elapsedMs: turnElapsedMs, name, reason, sessionId: runtime.sessionId, ...activity,
    }, { metadataOnly }, NOTIFICATION_TEXT_LIMITS.terminal));
    const notifyOnComplete = configGet('behavior.notifyOnComplete') !== false;
    const popped = maybeNotifyLongTask({
      elapsedMs: turnElapsedMs,
      status: outcome === 'completed' ? 'ok' : 'fail',
      outcome,
      name,
      reason,
      activity,
      metadataOnly,
      kind: 'turn',
      sessionId: runtime.sessionId,
      thresholdSeconds: readNotifyAfterSeconds(configGet),
      webhookNotifier: webhookNotifier ?? null,
      focusTracker,
      configGet,
      notifyDesktop,
      desktop: notifyOnComplete,
      // The SDK popup this replaces came past 30s whatever notifyAfterSeconds
      // said (default 60): the one popup keeps that, the webhook keeps the threshold.
      desktopAfterMs: TURN_DESKTOP_AFTER_MS,
    });
    // The popup rings the bell itself; a shorter turn still gets the bell the
    // Orchestrator's own popup gave it (behavior.notifyOnComplete).
    if (!popped && notifyOnComplete && turnElapsedMs > TURN_BELL_AFTER_MS) {
      try { ringBell(); } catch { /* stdout may already be torn down */ }
    }
  };

  /**
   * A TURN_ERROR. The failover path decides synchronously, in its own
   * TURN_ERROR handler, whether to re-submit the turn, and this handler runs
   * first (main.ts wires it first), so the notice waits a microtask for that
   * decision. Withheld while a retry is on its way; told anyway if the retry
   * has not started within the grace period.
   */
  const onTurnError = (turnId: string, reason: string | null): void => {
    queueMicrotask(() => {
      if (!failoverRetryPending) {
        notifyTurnEnd(turnId, 'failed', reason);
        return;
      }
      clearWithheldFailure();
      const timer = setTimeout(() => {
        if (withheldFailure?.turnId !== turnId) return;
        notifyTurnEnd(turnId, 'failed', reason);
      }, _failoverRetryGraceMs);
      (timer as { unref?: () => void }).unref?.();
      withheldFailure = { turnId, reason, timer };
    });
  };
  unsubs.push(clearWithheldFailure);

  const refreshGit = (): void => {
    gitStatusProvider.refresh().then((info) => { lastGitInfoRef.value = info; render(); }).catch(() => { /* non-fatal */ });
  };

  // Journal user message immediately on TURN_SUBMITTED so a SIGKILL during
  // the subsequent stream loses at most the in-flight token chunk.
  unsubs.push(events.turns.on('TURN_SUBMITTED', (evt) => {
    if (failoverRetryPending && withheldFailure !== null) {
      // The failover's re-submission: the same user turn goes on.
      clearWithheldFailure();
      failoverRetryPending = false;
    } else {
      clearWithheldFailure();
      failoverRetryPending = false;
      turnStartTime = _clock();
      turnText = typeof evt?.prompt === 'string' ? evt.prompt : null;
      tally.reset();
    }
    try {
      const snap = conversation.toJSON() as { messages: Array<import('./conversation.ts').ConversationMessageSnapshot> };
      transcriptJournal.appendRecord('user_message', snap.messages);
    } catch { /* best-effort */ }
  }));

  // A turn that failed or was cancelled ends without TURN_COMPLETED; it is
  // named and told the same way.
  unsubs.push(events.turns.on('TURN_ERROR', (evt) => {
    onTurnError(evt.turnId, evt.error);
  }));
  unsubs.push(events.turns.on('PREFLIGHT_FAIL', (evt) => {
    notifyTurnEnd(evt.turnId, 'failed', evt.reason);
  }));
  unsubs.push(events.turns.on('TURN_CANCEL', (evt) => {
    notifyTurnEnd(evt.turnId, 'cancelled', evt.reason ?? null);
  }));

  unsubs.push(events.turns.on('TURN_COMPLETED', (evt) => {
    // stopReason 'empty_response' signals a non-successful completion.
    notifyTurnEnd(
      evt.turnId,
      evt.stopReason === 'completed' ? 'completed' : 'failed',
      evt.stopReason === 'completed' ? null : 'The model returned an empty response',
    );
    // Budget-breach alert: edge-triggered, piggybacks on this same
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
        { surface },
        // Turn-completion persistence is machinery, not a user act: stated
        // explicitly so the retention sweep can tell it apart from a session
        // the user asked to keep via /session save.
        'auto',
      );
      hookDispatcher.fire({ path: 'Lifecycle:session:save' as HookEventPath, phase: 'Lifecycle' as HookPhase, category: 'session' as HookCategory, specific: 'save', sessionId: runtime.sessionId, timestamp: Date.now(), payload: { sessionId: runtime.sessionId } }).catch((err: unknown) => logger.debug('hook fire error', { error: summarizeError(err) }));
      // Snapshot succeeded, rotate the journal (gap-filler no longer needed).
      transcriptJournal.rotate();
    } catch (e) {
      // Snapshot failed, append the turn to the journal so recovery can
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
    // can truncate the conversation to exactly this boundary, the join key
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
      persistTurnAnchors(runtime.sessionId, surface);
    } catch { /* best-effort; a rewind-anchor miss must never break the turn */ }
    // Auto-compaction is owned by the SDK Orchestrator's post-turn maintenance
    // (handlePostTurnContextMaintenance), which runs on every turn against the
    // resolved context window (getContextWindowForModel) via the SDK's
    // getAutoCompactDecision (percentage threshold + 15k safety buffer +
    // small-window handling). The TUI must not independently re-trigger it.
    refreshGit();
  }));

  // Activity for the end-of-turn notice, counted only while a turn runs.
  unsubs.push(events.tools.on('TOOL_RECEIVED', (payload) => {
    if (turnStartTime !== null) tally.noteToolReceived(payload.callId, payload.tool, payload.args);
  }));
  unsubs.push(events.tools.on('TOOL_CANCELLED', (payload) => {
    if (turnStartTime !== null) tally.noteToolFailed(payload.callId);
  }));
  unsubs.push(events.agents.on('AGENT_SPAWNING', (payload) => {
    if (turnStartTime !== null) tally.noteAgentStarted();
    rememberBounded(agentTasks, payload.agentId, payload.task);
  }));
  unsubs.push(events.agents.on('AGENT_COMPLETED', (payload) => { agentTasks.delete(payload.agentId); }));
  unsubs.push(events.agents.on('AGENT_CANCELLED', (payload) => { agentTasks.delete(payload.agentId); }));
  unsubs.push(events.workflows.on('WORKFLOW_CHAIN_CREATED', (payload) => {
    rememberBounded(workstreams, payload.chainId, { task: payload.task, reviewScore: null });
  }));
  unsubs.push(events.workflows.on('WORKFLOW_REVIEW_COMPLETED', (payload) => {
    if (turnStartTime !== null) tally.noteReviewScore(payload.score);
    const entry = workstreams.get(payload.chainId);
    if (entry) entry.reviewScore = payload.score;
  }));
  unsubs.push(events.workflows.on('WORKFLOW_CHAIN_PASSED', (payload) => { workstreams.delete(payload.chainId); }));

  // In-terminal (OSC 9) agent-blocked notification: a delegated agent parked
  // waiting for a human message (AGENT_AWAITING_MESSAGE) is "blocked on you".
  // Gated by the notifier's own per-signal config + focus rule. Names the
  // agent's task unless behavior.notificationsMetadataOnly is on.
  if (terminalNotifier) {
    unsubs.push(events.agents.on('AGENT_AWAITING_MESSAGE', (payload) => {
      const task = readNotificationsMetadataOnly(configGet) ? null : agentTasks.get(payload.agentId);
      terminalNotifier.notify('agent-blocked', task
        ? trimAtWordBoundary(`Agent waiting for your input: ${task}`, NOTIFICATION_TEXT_LIMITS.terminal)
        : `agent ${payload.agentId.slice(0, 8)} is waiting for your input`);
    }));
  }

  unsubs.push(events.tools.on('TOOL_SUCCEEDED', (payload) => {
    if (turnStartTime !== null) tally.noteToolSucceeded(payload.callId);
    refreshGit();
  }));
  unsubs.push(events.tools.on('TOOL_FAILED', (payload) => {
    if (turnStartTime !== null) tally.noteToolFailed(payload.callId);
    refreshGit();
  }));

  // Agent/chain-failure desktop alerts. The SDK's WebhookNotifier and
  // Notifier already fire webhook/Slack/Discord notifications for these two
  // events unconditionally (attachToRuntimeBus in the SDK's
  // platform/integrations, pre-existing, not focus-gated: an out-of-band
  // push to another device is useful regardless of terminal focus). What was
  // missing was a desktop notification, gated by focus like the other three
  // alert classes, that's the only thing added here, to avoid double-firing
  // a webhook that's already covered.
  if (focusTracker) {
    unsubs.push(events.agents.on('AGENT_FAILED', (payload) => {
      const task = agentTasks.get(payload.agentId);
      agentTasks.delete(payload.agentId);
      if (!shouldFireAlert(focusTracker, configGet, 'behavior.notifyOnAgentFailure')) return;
      try {
        const metadataOnly = readNotificationsMetadataOnly(configGet);
        const name = metadataOnly ? '' : trimAtWordBoundary(task ?? '', NOTIFICATION_TEXT_LIMITS.desktopTitle - 'Agent failed: '.length);
        notifyDesktop(
          name ? `Agent failed: ${name}` : 'GoodVibes: agent failed',
          metadataOnly
            ? `agent ${payload.agentId.slice(0, 8)} failed`
            : trimAtWordBoundary(`agent ${payload.agentId.slice(0, 8)} failed: ${payload.error}`, NOTIFICATION_TEXT_LIMITS.desktopBody),
          FORCE_NOTIFY_DURATION_MS,
        );
      } catch (err) {
        logger.debug('turn-event-wiring: agent-failure notify error', { error: String(err) });
      }
    }));
    unsubs.push(events.workflows.on('WORKFLOW_CHAIN_FAILED', (payload) => {
      const workstream = workstreams.get(payload.chainId);
      workstreams.delete(payload.chainId);
      if (!shouldFireAlert(focusTracker, configGet, 'behavior.notifyOnChainFailure')) return;
      try {
        // Title and body come from workstream-notification.ts, which is where
        // the three branches (cancelled / turn budget / failed) are narrated and
        // tested. A notification is a message to a person, so it carries neither
        // the internal name for the machinery nor the chain id.
        const notice = workstreamFailureNotification(payload, {
          task: workstream?.task,
          reviewScore: workstream?.reviewScore,
          metadataOnly: readNotificationsMetadataOnly(configGet),
        });
        notifyDesktop(notice.title, notice.body, FORCE_NOTIFY_DURATION_MS);
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

  return { refreshGit, unsubs, transcriptJournal, continueTurnAfterFailover };
}
