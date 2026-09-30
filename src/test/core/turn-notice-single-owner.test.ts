/**
 * One end-of-turn notice per user turn (owner rulings 2026-09-29: every
 * notification names the work; fixes are automatic).
 *
 * 1. The TUI's long-task notifier owns the turn's desktop popup, so the wiring
 *    hands the SDK Orchestrator's own end-of-turn popup off: a long turn pops
 *    once, not twice. What the Orchestrator's popup gave the TUI and the
 *    long-task path did not (the bell above 5s, behavior.notifyOnComplete) is
 *    kept here.
 * 2. Provider failover re-submits the failed turn on another provider. The
 *    user asked once, so the user gets one notice, for how it finally ended:
 *    a failover that then succeeds says it finished, a failover whose retry
 *    also fails says it failed, never a failure and then a success.
 *
 * The turn wiring and the stream wiring are linked here the way main.ts links
 * them (onFailoverRetry: continueTurnAfterFailover), on one shared bus, with
 * the turn wiring subscribed first as in main.ts.
 */
import { describe, expect, mock, test } from 'bun:test';
import { wireTurnEventHandlers, type WireTurnEventHandlersOptions } from '../../core/turn-event-wiring.ts';
import { wireStreamEventMetrics, type WireStreamEventMetricsOptions, type StreamMetrics } from '../../core/stream-event-wiring.ts';
import type { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations';
import { FocusTracker } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import { makeTestSurface } from '../helpers/session-surface.ts';

const ASK = 'Migrate the billing tables to the new schema';

type Bus = { on(type: string, h: (e: unknown) => void): () => void; emit(type: string, e: unknown): void };
function bus(): Bus {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  return {
    on(type, h) {
      listeners.set(type, [...(listeners.get(type) ?? []), h]);
      return () => listeners.set(type, (listeners.get(type) ?? []).filter((x) => x !== h));
    },
    emit(type, e) { for (const h of (listeners.get(type) ?? []).slice()) h(e); },
  };
}

function metrics(): StreamMetrics {
  return {
    startTime: 0, deltaCount: 0, tokenSpeed: 0,
    ttftMs: undefined, ttftRecorded: false,
    activeToolStartedAtMs: undefined, activeToolName: undefined, activeToolCallId: undefined,
    toolArgsByCallId: new Map(),
    lastDeltaAtMs: undefined, stallEpisode: 0,
    reconnectAttempt: undefined, reconnectMaxAttempts: undefined,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface HarnessOptions {
  readonly config?: Record<string, unknown>;
  /** The failover chain; empty means the optimizer is off. */
  readonly chain?: Array<{ providerId: string; modelId: string }>;
  readonly handOff?: () => () => void;
  readonly graceMs?: number;
}

function harness(opts: HarnessOptions = {}) {
  const desktop: Array<{ title: string; body: string }> = [];
  const terminal: string[] = [];
  const webhook: string[] = [];
  const bells: number[] = [];
  const retries: string[] = [];
  const turns = bus(); const tools = bus(); const agents = bus(); const workflows = bus();
  let now = 1_000;
  const tracker = new FocusTracker();
  tracker.setFocused(false);
  const settings: Record<string, unknown> = { 'behavior.notifyAfterSeconds': 30, ...opts.config };
  const orchestrator: Record<string, unknown> = { lastInputTokens: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  if (opts.handOff) orchestrator['turnEndNotice'] = { handOff: opts.handOff };
  const turnOptions = {
    events: { turns, tools, agents, workflows },
    conversation: {
      toJSON: () => { throw new Error('stub: no persistence in this test'); },
      getTitleSource: () => 'system',
      title: '',
      getLastUserMessage: () => null,
      getMessageCount: () => 0,
    },
    runtime: { sessionId: 'test-sess-id-001', model: 'm', provider: 'p' },
    orchestrator,
    configManager: { get: (key: string) => settings[key] },
    providerRegistry: {
      getCurrentModel: () => ({ contextWindow: 200_000, id: 'test-model' }),
      getContextWindowForModel: (m: { contextWindow: number }) => m.contextWindow,
    },
    systemMessageRouter: { high: () => {}, low: () => {}, routeSystemMessage: () => {} },
    hookDispatcher: { fire: mock(async () => ({ ok: true })) },
    surface: makeTestSurface('/tmp/notice-owner-workdir', '/tmp/notice-owner-home'),
    gitStatusProvider: { refresh: async () => null },
    lastGitInfoRef: { value: null },
    buildSessionContinuityHints: () => ({}),
    render: () => {},
    webhookNotifier: {
      getUrls: () => ['https://example.invalid/hook'],
      send: mock(async (text: string) => { webhook.push(text); return {}; }),
    } as unknown as WebhookNotifier,
    focusTracker: tracker,
    terminalNotifier: { notify: (_signal: string, message: string) => { terminal.push(message); } },
    notifyDesktop: (title: string, body: string) => { desktop.push({ title, body }); },
    ringBell: () => { bells.push(now); },
    _failoverRetryGraceMs: opts.graceMs ?? 5_000,
    _clock: () => now,
  } as unknown as WireTurnEventHandlersOptions;
  const turnWiring = wireTurnEventHandlers(turnOptions) as ReturnType<typeof wireTurnEventHandlers> & {
    continueTurnAfterFailover?: () => void;
  };

  let currentKey = 'anthropic:claude-sonnet';
  const chain = opts.chain ?? [];
  const streamOptions = {
    events: { turns, tools },
    orchestrator: { streamingOutputTokens: 0 },
    providerRegistry: {
      getCurrentModel: () => ({ provider: currentKey.split(':')[0]!, registryKey: currentKey }),
      setCurrentModel: (key: string) => { currentKey = key; },
    },
    systemMessageRouter: { high: () => {}, low: () => {}, userReceipt: () => {} },
    render: () => {},
    metrics: metrics(),
    providerOptimizer: chain.length > 0 ? {
      enabled: true,
      testFallback: () => ({ chain: chain.map((node, position) => ({ position, capable: true, ...node })) }),
      recordFallbackTransition: () => {},
      fallbackLog: [],
    } : undefined,
    // As in main.ts: a pre-submission snapshot exists, so the turn is re-submitted.
    retryTurn: (notice?: string) => { retries.push(notice ?? ''); return true; },
    onFailoverRetry: turnWiring.continueTurnAfterFailover,
  } as unknown as WireStreamEventMetricsOptions;
  wireStreamEventMetrics(streamOptions);

  return {
    desktop, terminal, webhook, bells, retries, turnWiring,
    advance: (ms: number) => { now += ms; },
    turn: (type: string, payload: Record<string, unknown>) => turns.emit(type, { type, ...payload }),
  };
}

describe('one desktop popup per turn: the TUI owns it, the Orchestrator hands its own off', () => {
  test('the wiring hands the Orchestrator popup off, and its unsubscribe gives it back', () => {
    let released = 0;
    const handOff = mock(() => () => { released += 1; });
    const h = harness({ handOff });
    expect(handOff).toHaveBeenCalledTimes(1);
    for (const unsub of h.turnWiring.unsubs) unsub();
    expect(released).toBe(1);
  });

  test('a turn under the popup threshold still rings the bell above 5s, as the Orchestrator popup did', async () => {
    const h = harness();
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(12_000);
    h.turn('TURN_COMPLETED', { turnId: 't1', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toHaveLength(0);
    expect(h.bells).toHaveLength(1);
  });

  test('behavior.notifyOnComplete off keeps the desktop popup and the bell off, as it did for the Orchestrator popup', async () => {
    const h = harness({ config: { 'behavior.notifyOnComplete': false } });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(45_000);
    h.turn('TURN_COMPLETED', { turnId: 't1', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toHaveLength(0);
    expect(h.bells).toHaveLength(0);
    // The webhook is the long-task path's own channel, governed by notifyAfterSeconds.
    expect(h.webhook).toHaveLength(1);
  });
});

describe('the one popup comes past 30s, as the Orchestrator popup it replaced did, whatever notifyAfterSeconds says', () => {
  // behavior.notifyAfterSeconds unset: its default (60) applies.
  const defaults = { 'behavior.notifyAfterSeconds': undefined };

  test('a 35s turn with the default threshold pops exactly once, naming the work; the webhook waits for the threshold', async () => {
    const h = harness({ config: defaults });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(35_000);
    h.turn('TURN_COMPLETED', { turnId: 't1', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toHaveLength(1);
    expect(`${h.desktop[0]!.title} ${h.desktop[0]!.body}`).toContain('Migrate the billing tables');
    expect(h.webhook).toHaveLength(0);
    expect(h.bells).toHaveLength(0); // the popup rings the bell itself
  });

  test('a 75s turn with the default threshold: one popup and the webhook', async () => {
    const h = harness({ config: defaults });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(75_000);
    h.turn('TURN_COMPLETED', { turnId: 't1', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toHaveLength(1);
    expect(h.webhook).toHaveLength(1);
  });

  test('notifyAfterSeconds 0 turns the webhook off; a 35s turn still pops once', async () => {
    const h = harness({ config: { 'behavior.notifyAfterSeconds': 0 } });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(35_000);
    h.turn('TURN_COMPLETED', { turnId: 't1', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toHaveLength(1);
    expect(h.webhook).toHaveLength(0);
  });

  test('a 25s turn with the default threshold: no popup, the bell', async () => {
    const h = harness({ config: defaults });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(25_000);
    h.turn('TURN_COMPLETED', { turnId: 't1', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toHaveLength(0);
    expect(h.bells).toHaveLength(1);
  });
});

describe('one notice per user turn across a provider failover', () => {
  test('failover then success: one notice, it finished, timed from the user submission', async () => {
    const h = harness({ chain: [{ providerId: 'anthropic', modelId: 'claude-sonnet' }, { providerId: 'openai', modelId: 'gpt-5' }] });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(40_000);
    h.turn('TURN_ERROR', { turnId: 't1', error: 'Provider returned HTTP 502', stopReason: 'provider_error' });
    await flush();
    expect(h.retries).toHaveLength(1);
    h.turn('TURN_SUBMITTED', { turnId: 't2', prompt: ASK });
    h.advance(20_000);
    h.turn('TURN_COMPLETED', { turnId: 't2', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toEqual([{ title: ASK, body: 'Done in 1m' }]);
    expect(h.terminal).toEqual([`${ASK}: Done in 1m`]);
    expect(h.webhook).toEqual([`${ASK}\nDone in 1m`]);
  });

  test('failover whose retry also fails: one failure notice, with the final reason', async () => {
    const h = harness({ chain: [{ providerId: 'anthropic', modelId: 'claude-sonnet' }, { providerId: 'openai', modelId: 'gpt-5' }] });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(40_000);
    h.turn('TURN_ERROR', { turnId: 't1', error: 'Provider returned HTTP 502', stopReason: 'provider_error' });
    await flush();
    h.turn('TURN_SUBMITTED', { turnId: 't2', prompt: ASK });
    h.advance(20_000);
    h.turn('TURN_ERROR', { turnId: 't2', error: 'Rate limited by openai', stopReason: 'provider_error' });
    await flush();
    expect(h.retries).toHaveLength(1);
    expect(h.desktop).toEqual([{ title: ASK, body: 'Failed after 1m: Rate limited by openai' }]);
    expect(h.terminal).toHaveLength(1);
    expect(h.terminal[0]).toContain('Failed after 1m');
  });

  test('without failover a failed turn is told once, as before', async () => {
    const h = harness();
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(40_000);
    h.turn('TURN_ERROR', { turnId: 't1', error: 'Provider returned HTTP 502', stopReason: 'provider_error' });
    await flush();
    expect(h.desktop).toEqual([{ title: ASK, body: 'Failed after 40s: Provider returned HTTP 502' }]);
    expect(h.terminal).toHaveLength(1);
  });

  test('a retry that never starts still gets its failure told, after the grace period', async () => {
    const h = harness({ chain: [{ providerId: 'anthropic', modelId: 'claude-sonnet' }, { providerId: 'openai', modelId: 'gpt-5' }], graceMs: 20 });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(40_000);
    h.turn('TURN_ERROR', { turnId: 't1', error: 'Provider returned HTTP 502', stopReason: 'provider_error' });
    await flush();
    expect(h.desktop).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(h.desktop).toEqual([{ title: ASK, body: 'Failed after 40s: Provider returned HTTP 502' }]);
    expect(h.terminal).toHaveLength(1);
  });

  test('the next user turn after a finished failover is its own turn', async () => {
    const h = harness({ chain: [{ providerId: 'anthropic', modelId: 'claude-sonnet' }, { providerId: 'openai', modelId: 'gpt-5' }] });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(40_000);
    h.turn('TURN_ERROR', { turnId: 't1', error: 'Provider returned HTTP 502', stopReason: 'provider_error' });
    await flush();
    h.turn('TURN_SUBMITTED', { turnId: 't2', prompt: ASK });
    h.advance(20_000);
    h.turn('TURN_COMPLETED', { turnId: 't2', response: 'ok', stopReason: 'completed' });
    await flush();
    h.turn('TURN_SUBMITTED', { turnId: 't3', prompt: 'Now update the README' });
    h.advance(35_000);
    h.turn('TURN_COMPLETED', { turnId: 't3', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toEqual([
      { title: ASK, body: 'Done in 1m' },
      { title: 'Now update the README', body: 'Done in 35s' },
    ]);
  });
});
