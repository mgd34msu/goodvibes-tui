/**
 * Tests for src/core/turn-event-wiring.ts
 *
 * Covers:
 * - TURN_SUBMITTED → TURN_COMPLETED integration: maybeNotifyLongTask fires
 *   exactly once with the correct status and elapsedMs.
 * - stopReason mapping: 'completed' → 'ok', non-completed → 'fail'.
 * - No double-fire across the persist/rotate branches (notification fires
 *   before the auto-save block, not again in the catch/journal path).
 */

import { describe, test, expect, mock } from 'bun:test';
import { wireTurnEventHandlers } from '../../core/turn-event-wiring.ts';
import type { WireTurnEventHandlersOptions } from '../../core/turn-event-wiring.ts';
import type { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations';

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
  // UiRuntimeEvents shape: { turns, tools, ... } — only turns and tools used by wireTurnEventHandlers
  return {
    // @ts-expect-error — duck-typed minimal fake for UiRuntimeEvents
    events: { turns, tools } as WireTurnEventHandlersOptions['events'],
    emitTurn: (type: string, payload: unknown) => turns.emit(type, payload),
    emitTool: (type: string, payload: unknown) => tools.emit(type, payload),
  };
}

// ---------------------------------------------------------------------------
// Minimal spy webhook notifier
// ---------------------------------------------------------------------------

function makeSpyNotifier(urls: string[] = ['https://ntfy.sh/test-topic']) {
  const sentMessages: string[] = [];
  const notifier: WebhookNotifier = {
    getUrls: () => [...urls],
    send: mock(async (text: string) => {
      sentMessages.push(text);
      return {};
    }) as WebhookNotifier['send'],
  };
  return { notifier, sentMessages };
}

// ---------------------------------------------------------------------------
// Minimal stubs for all required options
// ---------------------------------------------------------------------------

function makeMinimalOptions(
  overrides: Partial<WireTurnEventHandlersOptions> = {},
): WireTurnEventHandlersOptions & {
  emitTurn: (type: string, payload: unknown) => void;
} {
  const { events, emitTurn } = makeFakeEvents();

  const defaults: WireTurnEventHandlersOptions = {
    events,
    conversation: {
      toJSON: () => { throw new Error('stub: no conversation'); },
      getTitleSource: () => 'stub',
      title: '',
      // Satisfy ConversationManager duck-type — only toJSON/getTitleSource/title used in TURN_COMPLETED
    } as WireTurnEventHandlersOptions['conversation'],
    runtime: { sessionId: 'test-sess-id-001', model: 'test-model', provider: 'test-provider' },
    orchestrator: { lastInputTokens: 0 },
    configManager: {
      // Return 60s threshold so notifications fire when elapsedMs >= 60_000
      get: (key: string): unknown => (key === 'behavior.notifyAfterSeconds' ? 60 : undefined),
    },
    providerRegistry: {
      getCurrentModel: () => ({ contextWindow: 200_000 }),
      getContextWindowForModel: (m: { contextWindow: number }) => m.contextWindow,
    },
    systemMessageRouter: {
      high: () => {},
      low: () => {},
      routeSystemMessage: () => {},
    },
    hookDispatcher: {
      fire: mock(async () => ({})) as WireTurnEventHandlersOptions['hookDispatcher']['fire'],
    } as WireTurnEventHandlersOptions['hookDispatcher'],
    workingDir: '/tmp/test-workdir',
    homeDirectory: '/tmp/test-home',
    sessionManager: undefined as WireTurnEventHandlersOptions['sessionManager'],
    gitStatusProvider: { refresh: async () => null },
    lastGitInfoRef: { value: null },
    buildSessionContinuityHints: () => ({}),
    render: () => {},
    webhookNotifier: null,
    _clock: () => 0,
  };

  return { ...defaults, ...overrides, emitTurn };
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
      } as WireTurnEventHandlersOptions['conversation'],
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
