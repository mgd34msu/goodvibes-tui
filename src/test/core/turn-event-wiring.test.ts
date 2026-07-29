/**
 * Tests for src/core/turn-event-wiring.ts
 *
 * Covers:
 * - TURN_SUBMITTED → TURN_COMPLETED integration: maybeNotifyLongTask fires
 *   exactly once with the correct status and elapsedMs.
 * - stopReason mapping: 'completed' → 'ok', non-completed → 'fail'.
 * - No double-fire across the persist/rotate branches (notification fires
 *   before the auto-save block, not again in the catch/journal path).
 * - budget-breach edge-trigger fires once per crossing on TURN_COMPLETED.
 * - AGENT_FAILED / WORKFLOW_CHAIN_FAILED fire a desktop alert gated by
 *   focus + the per-class config keys.
 */

import { describe, test, expect, mock, spyOn, afterEach, beforeEach } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { wireTurnEventHandlers } from '../../core/turn-event-wiring.ts';
import type { WireTurnEventHandlersOptions } from '../../core/turn-event-wiring.ts';
import type { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations';
import { FocusTracker } from '../../core/focus-tracker.ts';
import { journalPathFor } from '../../core/transcript-journal.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

// ---------------------------------------------------------------------------
// Minimal fake event bus
// ---------------------------------------------------------------------------

type EventHandler<E> = (event: E) => void;

function makeFakeTurnEventBus() {
  const listeners = new Map<string, EventHandler<unknown>[]>();

  function on(type: string, handler: EventHandler<unknown>): () => void {
    const existing = listeners.get(type) ?? [];
    existing.push(handler);
    listeners.set(type, existing);
    return () => {
      const arr = listeners.get(type);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  function emit(type: string, event: unknown): void {
    for (const handler of listeners.get(type) ?? []) handler(event);
  }

  return { on, emit };
}

function makeFakeEvents() {
  const turns = makeFakeTurnEventBus();
  const tools = makeFakeTurnEventBus();
  const agents = makeFakeTurnEventBus();
  const workflows = makeFakeTurnEventBus();
  // UiRuntimeEvents shape: { turns, tools, agents, workflows, ... } — these
  // four are what wireTurnEventHandlers reads (added agents/workflows
  // for the agent/chain-failure desktop alerts).
  return {
    // @ts-expect-error — duck-typed minimal fake for UiRuntimeEvents
    events: { turns, tools, agents, workflows } as WireTurnEventHandlersOptions['events'],
    emitTurn: (type: string, payload: unknown) => turns.emit(type, payload),
    emitTool: (type: string, payload: unknown) => tools.emit(type, payload),
    emitAgent: (type: string, payload: unknown) => agents.emit(type, payload),
    emitWorkflow: (type: string, payload: unknown) => workflows.emit(type, payload),
  };
}

// ---------------------------------------------------------------------------
// Minimal spy webhook notifier
// ---------------------------------------------------------------------------

function makeSpyNotifier(urls: string[] = ['https://ntfy.sh/test-topic']) {
  const sentMessages: string[] = [];
  // WebhookNotifier is a real class with private fields, so a duck-typed
  // fake can never satisfy it structurally — the same `as unknown as
  // WebhookNotifier` cast already used by long-task-notifier.test.ts,
  // approval-alert.test.ts, and budget-breach-notifier.test.ts for this
  // exact class.
  const notifier = {
    getUrls: () => [...urls],
    send: mock(async (text: string) => {
      sentMessages.push(text);
      return {};
    }),
  } as unknown as WebhookNotifier;
  return { notifier, sentMessages };
}

// ---------------------------------------------------------------------------
// Minimal stubs for all required options
// ---------------------------------------------------------------------------

function makeMinimalOptions(
  overrides: Partial<WireTurnEventHandlersOptions> = {},
): WireTurnEventHandlersOptions & {
  emitTurn: (type: string, payload: unknown) => void;
  emitAgent: (type: string, payload: unknown) => void;
  emitWorkflow: (type: string, payload: unknown) => void;
} {
  const { events, emitTurn, emitAgent, emitWorkflow } = makeFakeEvents();

  const defaults: WireTurnEventHandlersOptions = {
    events,
    conversation: {
      toJSON: () => { throw new Error('stub: no conversation'); },
      getTitleSource: () => 'stub',
      title: '',
      // Satisfy ConversationManager duck-type — only toJSON/getTitleSource/title used in TURN_COMPLETED.
      // ConversationManager is a real class with private fields, so the fake
      // can't satisfy it structurally — same `as unknown as` pattern already
      // used for this class in format-user-error.test.ts / system-message-router.test.ts.
    } as unknown as WireTurnEventHandlersOptions['conversation'],
    runtime: { sessionId: 'test-sess-id-001', model: 'test-model', provider: 'test-provider' },
    orchestrator: { lastInputTokens: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    configManager: {
      // Return 60s threshold so notifications fire when elapsedMs >= 60_000
      get: (key: string): unknown => (key === 'behavior.notifyAfterSeconds' ? 60 : undefined),
    },
    providerRegistry: {
      getCurrentModel: () => ({ contextWindow: 200_000, id: 'test-model' }),
      getContextWindowForModel: (m: { contextWindow: number }) => m.contextWindow,
    },
    systemMessageRouter: {
      high: () => {},
      low: () => {},
      routeSystemMessage: () => {},
    },
    hookDispatcher: {
      fire: mock(async () => ({ ok: true })) as WireTurnEventHandlersOptions['hookDispatcher']['fire'],
    } as WireTurnEventHandlersOptions['hookDispatcher'],
    surface: makeTestSurface('/tmp/test-workdir', '/tmp/test-home'),
    gitStatusProvider: { refresh: async () => null },
    lastGitInfoRef: { value: null },
    buildSessionContinuityHints: () => ({}),
    render: () => {},
    webhookNotifier: null,
    _clock: () => 0,
  };

  return { ...defaults, ...overrides, emitTurn, emitAgent, emitWorkflow };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wireTurnEventHandlers — TURN_COMPLETED notification integration', () => {
  test('maybeNotifyLongTask fires exactly once on TURN_COMPLETED with correct elapsedMs', () => {
    // Controlled clock: TURN_SUBMITTED at t=1000, TURN_COMPLETED at t=62000 → elapsed = 61000ms
    let clockValue = 1000;
    const { notifier, sentMessages } = makeSpyNotifier();

    const opts = makeMinimalOptions({
      webhookNotifier: notifier,
      _clock: () => clockValue,
      // Threshold: 60s from configManager default
    });

    wireTurnEventHandlers(opts);

    // Emit TURN_SUBMITTED to record start time
    opts.emitTurn('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'turn-test-1', prompt: 'hello' });

    // Advance clock by 61 seconds
    clockValue = 1000 + 61_000;

    // Emit TURN_COMPLETED (stopReason 'completed' → status 'ok')
    opts.emitTurn('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-test-1', response: 'hi', stopReason: 'completed' });

    // Notification fires exactly once (fire-and-forget send call)
    expect(notifier.send).toHaveBeenCalledTimes(1);
    // Sent message must contain 61s elapsed and 'turn' kind
    const sentText = sentMessages[0] ?? '';
    expect(sentText).toContain('61s');
    expect(sentText).toContain('turn');
  });

  test('stopReason non-completed maps to fail status', () => {
    let clockValue = 5000;
    const { notifier, sentMessages } = makeSpyNotifier();

    const opts = makeMinimalOptions({
      webhookNotifier: notifier,
      _clock: () => clockValue,
    });

    wireTurnEventHandlers(opts);

    opts.emitTurn('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'turn-fail-1', prompt: 'test' });
    clockValue = 5000 + 90_000; // 90s elapsed — above threshold

    // stopReason 'empty_response' → fail
    opts.emitTurn('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-fail-1', response: '', stopReason: 'empty_response' });

    expect(notifier.send).toHaveBeenCalledTimes(1);
    const sentText = sentMessages[0] ?? '';
    expect(sentText).toContain('fail');
    expect(sentText).toContain('90s');
  });

  test('no notification when elapsed is below threshold', () => {
    let clockValue = 1000;
    const { notifier } = makeSpyNotifier();

    const opts = makeMinimalOptions({
      webhookNotifier: notifier,
      _clock: () => clockValue,
    });

    wireTurnEventHandlers(opts);

    opts.emitTurn('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'turn-short-1', prompt: 'quick' });
    clockValue = 1000 + 30_000; // 30s — below 60s threshold

    opts.emitTurn('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-short-1', response: 'done', stopReason: 'completed' });

    // No notification sent
    expect(notifier.send).not.toHaveBeenCalled();
  });

  test('no double-fire across persist/rotate branches: exactly one notification per TURN_COMPLETED', () => {
    // The notification fires before the persist try/catch. Even when the persist
    // block throws (simulated by conversation.toJSON throwing), the notification
    // must fire exactly once — never again in the journal catch branch.
    let clockValue = 0;
    const { notifier } = makeSpyNotifier();

    // conversation.toJSON() throws → falls into journal catch path
    const opts = makeMinimalOptions({
      webhookNotifier: notifier,
      _clock: () => clockValue,
      conversation: {
        toJSON: () => { throw new Error('persist-fail: simulated'); },
        getTitleSource: () => 'stub',
        title: '',
      } as unknown as WireTurnEventHandlersOptions['conversation'],
    });

    wireTurnEventHandlers(opts);

    opts.emitTurn('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'turn-ndf-1', prompt: 'test' });
    clockValue = 65_000; // 65s elapsed

    opts.emitTurn('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-ndf-1', response: 'hi', stopReason: 'completed' });

    // Notification fires exactly once even though persist branch threw
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  test('no notification when TURN_COMPLETED fires without prior TURN_SUBMITTED (elapsed=0)', () => {
    // When turnStartTime is null, elapsedMs defaults to 0 — below any threshold.
    const { notifier } = makeSpyNotifier();

    const opts = makeMinimalOptions({
      webhookNotifier: notifier,
      _clock: () => 99_999_999, // would produce huge elapsed if turnStartTime were set
    });

    wireTurnEventHandlers(opts);

    // No TURN_SUBMITTED — turnStartTime stays null
    opts.emitTurn('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-no-start', response: 'hi', stopReason: 'completed' });

    // elapsedMs == 0 < threshold (60s) → no notification
    expect(notifier.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// — budget-breach edge trigger on TURN_COMPLETED
// ---------------------------------------------------------------------------

describe('wireTurnEventHandlers — budget-breach alert', () => {
  // 'claude-sonnet-4-6' has real fallback pricing in cost-utils.ts ($3/1M input)
  // so calcSessionCost produces a real, non-zero cost.
  const PRICED_MODEL = 'claude-sonnet-4-6';

  function makeBudgetOptions(overrides: Partial<WireTurnEventHandlersOptions> = {}) {
    const tracker = new FocusTracker();
    tracker.setFocused(false); // unfocused — alerts allowed
    return makeMinimalOptions({
      focusTracker: tracker,
      providerRegistry: {
        getCurrentModel: () => ({ contextWindow: 200_000, id: PRICED_MODEL }),
        getContextWindowForModel: (m: { contextWindow: number }) => m.contextWindow,
      },
      configManager: {
        get: (key: string): unknown => {
          if (key === 'behavior.notifyAfterSeconds') return 0; // disable long-task noise in this suite
          if (key === 'behavior.budgetAlertUsd') return 1; // $1 budget
          return undefined;
        },
      },
      ...overrides,
    });
  }

  test('fires once when session cost crosses the configured budget', () => {
    const { notifier, sentMessages } = makeSpyNotifier();
    const opts = makeBudgetOptions({
      webhookNotifier: notifier,
      orchestrator: { lastInputTokens: 0, usage: { input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } }, // $30 cost
    });
    wireTurnEventHandlers(opts);
    opts.emitTurn('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 't1', response: 'hi', stopReason: 'completed' });
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(sentMessages[0]).toContain('budget');
  });

  test('does not fire again on a second TURN_COMPLETED while still over budget', () => {
    const { notifier } = makeSpyNotifier();
    const opts = makeBudgetOptions({
      webhookNotifier: notifier,
      orchestrator: { lastInputTokens: 0, usage: { input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
    });
    wireTurnEventHandlers(opts);
    opts.emitTurn('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 't1', response: 'hi', stopReason: 'completed' });
    opts.emitTurn('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 't2', response: 'hi', stopReason: 'completed' });
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  test('does not fire when under budget', () => {
    const { notifier } = makeSpyNotifier();
    const opts = makeBudgetOptions({
      webhookNotifier: notifier,
      orchestrator: { lastInputTokens: 0, usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } }, // tiny cost
    });
    wireTurnEventHandlers(opts);
    opts.emitTurn('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 't1', response: 'hi', stopReason: 'completed' });
    expect(notifier.send).not.toHaveBeenCalled();
  });

  test('does not fire when no focusTracker is supplied (feature inert without one)', () => {
    const { notifier } = makeSpyNotifier();
    const opts = makeBudgetOptions({
      webhookNotifier: notifier,
      focusTracker: undefined,
      orchestrator: { lastInputTokens: 0, usage: { input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
    });
    wireTurnEventHandlers(opts);
    opts.emitTurn('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 't1', response: 'hi', stopReason: 'completed' });
    expect(notifier.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// — agent/chain-failure desktop alerts
// ---------------------------------------------------------------------------

describe('wireTurnEventHandlers — agent/chain-failure alerts', () => {
  // notifyCompletion (SDK) writes a terminal bell ('\x07') synchronously for
  // any durationMs > 5000 — the alert modules pass FORCE_NOTIFY_DURATION_MS
  // (30_001) precisely so this is observable without mocking the SDK module
  // (process-global module mocking is disallowed by this repo's test
  // discipline rules). Same technique as src/test/utils/notify.test.ts.

  test('AGENT_FAILED rings the bell when unfocused and notifyOnAgentFailure is on', () => {
    const spy = spyOnStdoutWrite();
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const opts = makeMinimalOptions({
      focusTracker: tracker,
      configManager: { get: () => undefined }, // all defaults: notifyAfterSeconds off (undefined->default 60 unrelated), notifyOnAgentFailure default true
    });
    wireTurnEventHandlers(opts);
    opts.emitAgent('AGENT_FAILED', { type: 'AGENT_FAILED', agentId: 'agent-12345678', error: 'boom', durationMs: 1000 });
    expect(spy).toHaveBeenCalledWith('\x07');
    spy.mockRestore();
  });

  test('AGENT_FAILED is suppressed when focused (default gating)', () => {
    const spy = spyOnStdoutWrite();
    const tracker = new FocusTracker();
    tracker.setFocused(true);
    const opts = makeMinimalOptions({
      focusTracker: tracker,
      configManager: { get: () => undefined },
    });
    wireTurnEventHandlers(opts);
    opts.emitAgent('AGENT_FAILED', { type: 'AGENT_FAILED', agentId: 'agent-12345678', error: 'boom', durationMs: 1000 });
    expect(spy).not.toHaveBeenCalledWith('\x07');
    spy.mockRestore();
  });

  test('AGENT_FAILED never fires when notifyOnAgentFailure is off', () => {
    const spy = spyOnStdoutWrite();
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const opts = makeMinimalOptions({
      focusTracker: tracker,
      configManager: { get: (k: string) => (k === 'behavior.notifyOnAgentFailure' ? false : undefined) },
    });
    wireTurnEventHandlers(opts);
    opts.emitAgent('AGENT_FAILED', { type: 'AGENT_FAILED', agentId: 'agent-12345678', error: 'boom', durationMs: 1000 });
    expect(spy).not.toHaveBeenCalledWith('\x07');
    spy.mockRestore();
  });

  test('no agent/chain-failure listeners are registered when focusTracker is absent', () => {
    const spy = spyOnStdoutWrite();
    const opts = makeMinimalOptions({ focusTracker: undefined });
    wireTurnEventHandlers(opts);
    expect(() => opts.emitAgent('AGENT_FAILED', { type: 'AGENT_FAILED', agentId: 'a', error: 'e', durationMs: 1 })).not.toThrow();
    expect(spy).not.toHaveBeenCalledWith('\x07');
    spy.mockRestore();
  });

  test('WORKFLOW_CHAIN_FAILED (failure state) rings the bell when unfocused', () => {
    const spy = spyOnStdoutWrite();
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const opts = makeMinimalOptions({
      focusTracker: tracker,
      configManager: { get: () => undefined },
    });
    wireTurnEventHandlers(opts);
    opts.emitWorkflow('WORKFLOW_CHAIN_FAILED', { type: 'WORKFLOW_CHAIN_FAILED', chainId: 'chain-abcdef123456', reason: 'review rejected', failureKind: 'other' });
    expect(spy).toHaveBeenCalledWith('\x07');
    spy.mockRestore();
  });

  test('WORKFLOW_CHAIN_FAILED with failureKind=cancelled still alerts (operator-cancel branch, WO item 2)', () => {
    // The cancelled branch narrates a cancellation rather than a failure but must
    // still ring the bell when unfocused — the operator asked to stop and wants to
    // know it stopped. (The distinct title is asserted at the SDK narration level;
    // process-global module mocking to read the title is disallowed here.)
    const spy = spyOnStdoutWrite();
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const opts = makeMinimalOptions({ focusTracker: tracker, configManager: { get: () => undefined } });
    wireTurnEventHandlers(opts);
    opts.emitWorkflow('WORKFLOW_CHAIN_FAILED', { type: 'WORKFLOW_CHAIN_FAILED', chainId: 'chain-abcdef123456', reason: 'operator cancellation — 2 files already modified on disk', failureKind: 'cancelled' });
    expect(spy).toHaveBeenCalledWith('\x07');
    spy.mockRestore();
  });

  test('WORKFLOW_CHAIN_FAILED never fires when notifyOnChainFailure is off', () => {
    const spy = spyOnStdoutWrite();
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const opts = makeMinimalOptions({
      focusTracker: tracker,
      configManager: { get: (k: string) => (k === 'behavior.notifyOnChainFailure' ? false : undefined) },
    });
    wireTurnEventHandlers(opts);
    opts.emitWorkflow('WORKFLOW_CHAIN_FAILED', { type: 'WORKFLOW_CHAIN_FAILED', chainId: 'chain-abcdef123456', reason: 'transient transport error', failureKind: 'transport' });
    expect(spy).not.toHaveBeenCalledWith('\x07');
    spy.mockRestore();
  });

  test('WORKFLOW_CHAIN_FAILED with failureKind=max_turns alerts via the budget branch (limit + source from the event)', () => {
    const spy = spyOnStdoutWrite();
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const opts = makeMinimalOptions({
      focusTracker: tracker,
      configManager: { get: () => undefined },
    });
    wireTurnEventHandlers(opts);
    // The typed budget branch reads turnLimit/turnLimitSource off the event; it
    // must alert without throwing and without regex-matching the prose reason.
    expect(() => opts.emitWorkflow('WORKFLOW_CHAIN_FAILED', {
      type: 'WORKFLOW_CHAIN_FAILED',
      chainId: 'chain-abcdef123456',
      reason: 'agent reached the turn limit of 50',
      failureKind: 'max_turns',
      turnLimit: 50,
      turnLimitSource: 'default',
    })).not.toThrow();
    expect(spy).toHaveBeenCalledWith('\x07');
    spy.mockRestore();
  });
});

function spyOnStdoutWrite(): ReturnType<typeof spyOn> {
  return spyOn(process.stdout, 'write').mockImplementation(() => true);
}

// ---------------------------------------------------------------------------
// — transcript journal rebinds across a session switch (cross-session
//   contamination regression — see turn-event-wiring.ts's transcriptJournal
//   construction)
// ---------------------------------------------------------------------------

describe('wireTurnEventHandlers — transcript journal rebinds on session switch', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = makeProjectTempDir('gv-turn-wiring-journal-rebind');
  });

  afterEach(() => {
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  });

  /** A conversation stub whose toJSON() reflects a mutable marker so each
   *  appended journal record is distinguishable in the test's assertions —
   *  appendRecord persists conversation.toJSON(), not the TURN_SUBMITTED
   *  event payload. */
  function makeMarkedConversation(): { conversation: WireTurnEventHandlersOptions['conversation']; setMarker: (m: string) => void } {
    let marker = '';
    return {
      conversation: {
        toJSON: () => ({ messages: [{ role: 'user', content: marker }] }),
        getTitleSource: () => 'stub',
        title: '',
      } as unknown as WireTurnEventHandlersOptions['conversation'],
      setMarker: (m: string) => { marker = m; },
    };
  }

  test('switching runtime.sessionId rebinds the journal — each file only ever contains its own session', () => {
    // `runtime` is mutated in place the same way /session resume and
    // /session fork reassign sessionId on the shared MutableRuntimeState object.
    const runtime = { sessionId: 'sess-A', model: 'm', provider: 'p' };
    const { conversation, setMarker } = makeMarkedConversation();
    const opts = makeMinimalOptions({ surface: makeTestSurface(tmpHome), runtime, conversation });
    wireTurnEventHandlers(opts);

    // Turn under session A.
    setMarker('marker-first');
    opts.emitTurn('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'a-1', prompt: 'first' });

    const pathA = journalPathFor(makeTestSurface(tmpHome), 'sess-A');
    expect(existsSync(pathA)).toBe(true);
    const contentAAfterFirst = readFileSync(pathA, 'utf-8');
    expect(contentAAfterFirst).toContain('sess-A');
    expect(contentAAfterFirst).toContain('marker-first');

    // Simulate a resume: the shared runtime object's sessionId is reassigned.
    runtime.sessionId = 'sess-B';

    // A turn under the new session must land in session B's own journal file,
    // never appended into session A's file.
    setMarker('marker-second');
    opts.emitTurn('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'b-1', prompt: 'second' });

    const pathB = journalPathFor(makeTestSurface(tmpHome), 'sess-B');
    expect(existsSync(pathB)).toBe(true);
    const contentB = readFileSync(pathB, 'utf-8');
    expect(contentB).toContain('sess-B');
    expect(contentB).toContain('marker-second');

    // Session A's file is unchanged by the post-switch write.
    const contentAAfterSwitch = readFileSync(pathA, 'utf-8');
    expect(contentAAfterSwitch).toBe(contentAAfterFirst);
    expect(contentAAfterSwitch).not.toContain('marker-second');
  });

  test('a second switch back to a previously-seen session rebinds again (no stale binding)', () => {
    const runtime = { sessionId: 'sess-X', model: 'm', provider: 'p' };
    const { conversation, setMarker } = makeMarkedConversation();
    const opts = makeMinimalOptions({ surface: makeTestSurface(tmpHome), runtime, conversation });
    wireTurnEventHandlers(opts);

    setMarker('marker-x');
    opts.emitTurn('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'x-1', prompt: 'x' });
    runtime.sessionId = 'sess-Y';
    setMarker('marker-y');
    opts.emitTurn('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'y-1', prompt: 'y' });
    runtime.sessionId = 'sess-X';
    setMarker('marker-x-again');
    opts.emitTurn('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'x-2', prompt: 'x again' });

    const pathX = journalPathFor(makeTestSurface(tmpHome), 'sess-X');
    const contentX = readFileSync(pathX, 'utf-8');
    expect(contentX).toContain('marker-x-again');
    // Never contaminated with session Y's record.
    expect(contentX).not.toContain('marker-y');
  });
});

describe('a desktop notification carries no chain identifier', () => {
  /**
   * Asserted against the source rather than by intercepting the notification.
   *
   * `notifyCompletion` is an SDK import and this file already records why the
   * title cannot be read here: reading it needs process-global module mocking,
   * which is disallowed in this suite. So the check is made where the defect
   * actually lives — the call site. Every `notifyCompletion` in this module must
   * be free of the chain id, and that is a property of the text being built, not
   * of the notifier being called.
   *
   * The rule: no wave, work-order or register ids in outward-facing text. A
   * desktop popup is read by the person, not by an operator console, and
   * `chain 7f3a91c02b4e` is nothing they can act on. The id stays on the event
   * for correlation and stays in the operator feed.
   *
   * The workstream narration itself now lives in core/workstream-notification.ts
   * as a pure function, and src/test/core/workstream-notification.test.ts calls
   * it and asserts the actual title and body. What is left for this file is the
   * call-site half: no notifyCompletion in the wiring may assemble text out of
   * the chain id or the internal name for the machinery, and the workstream
   * branch must keep delegating to that narration rather than growing its own
   * inline copy again.
   */
  const SOURCE = readFileSync(new URL('../../core/turn-event-wiring.ts', import.meta.url), 'utf-8');

  /** Every `notifyCompletion(...)` call in the module, argument text included. */
  function notifyCalls(): string[] {
    const calls: string[] = [];
    const pattern = /notifyCompletion\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(SOURCE)) !== null) {
      const open = SOURCE.indexOf('(', match.index);
      let depth = 0;
      for (let i = open; i < SOURCE.length; i += 1) {
        if (SOURCE[i] === '(') depth += 1;
        else if (SOURCE[i] === ')') {
          depth -= 1;
          if (depth === 0) { calls.push(SOURCE.slice(open, i + 1)); break; }
        }
      }
    }
    return calls;
  }

  test('the module actually notifies, so this test cannot pass vacuously', () => {
    expect(notifyCalls().length).toBeGreaterThanOrEqual(2);
  });

  test('the scraper actually finds argument text, not just bare call sites', () => {
    // Without this the three checks below would pass on a parser that returned
    // "()" for every call. Every captured call must carry its arguments.
    for (const call of notifyCalls()) {
      expect(call).toContain('FORCE_NOTIFY_DURATION_MS');
    }
  });

  test('no notification body interpolates the chain id', () => {
    for (const call of notifyCalls()) {
      expect(call).not.toContain('chainId');
    }
  });

  test('no notification names the internal machinery', () => {
    for (const call of notifyCalls()) {
      expect(call).not.toContain('WRFC');
    }
  });

  test('the workstream branch delegates its words — this is not a suppression fix', () => {
    // The three narrated outcomes (cancelled / spent turn budget / failed) moved
    // into workstream-notification.ts, where they are asserted by calling the
    // function. The guard that belongs here is that the wiring still routes
    // through it: a branch that stopped notifying, or that rebuilt the text
    // inline, would both show up as this import disappearing.
    expect(SOURCE).toContain('workstreamFailureNotification');
    const workstreamCall = notifyCalls().find((call) => call.includes('notice.title'));
    expect(workstreamCall).toBeDefined();
    expect(workstreamCall).toContain('notice.body');
  });
});
