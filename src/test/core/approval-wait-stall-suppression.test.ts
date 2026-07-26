/**
 * Defect 4 (surface 2) — approval-wait mislabel.
 *
 * While an approval card waits on the USER, the stream is legitimately silent (we asked the user a
 * question). The stall watchdog must NOT emit its provider-blaming
 * "Still waiting on <provider>… Ctrl+C to cancel" hint in that state — the honest
 * "Waiting for your approval" thinking-fragment label owns the surface instead. A genuine provider
 * silence with no approval pending still fires the hint unchanged.
 *
 * Uses the watchdog's real setTimeout with a tiny threshold (via the stallThresholdMs test seam)
 * rather than fake timers, matching stream-stall-watchdog.test.ts's approach.
 */
import { describe, test, expect } from 'bun:test';
import type { WireStreamEventMetricsOptions, StreamMetrics } from '../../core/stream-event-wiring.ts';
import { wireStreamEventMetrics } from '../../core/stream-event-wiring.ts';

type TurnEvent = 'STREAM_START' | 'STREAM_DELTA' | 'STREAM_END' | 'TURN_COMPLETED' | 'TURN_ERROR' | 'TURN_CANCEL';

function makeTurnBus() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {
    STREAM_START: [], STREAM_DELTA: [], STREAM_END: [], TURN_COMPLETED: [], TURN_ERROR: [], TURN_CANCEL: [],
  };
  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(handler);
      return () => {};
    },
    // Never exercised by this test (wireStreamEventMetrics never calls it),
    // but required to structurally satisfy the real RuntimeEventFeed shape.
    onEnvelope() { return () => {}; },
    emit(event: TurnEvent) {
      for (const h of (listeners[event] ?? []).slice()) (h as () => void)();
    },
  };
}

function makeToolBus() {
  return { on() { return () => {}; }, onEnvelope() { return () => {}; } };
}

// wireStreamEventMetrics only ever reads events.turns, events.tools, and
// (optionally) events.providers — but its options type takes the full,
// un-narrowed UiRuntimeEvents, so the other five feeds need a structurally
// valid (never-called) stand-in to build a real UiRuntimeEvents value.
function makeUnusedFeed() {
  return { on: () => () => {}, onEnvelope: () => () => {} };
}

function makeMetrics(): StreamMetrics {
  return {
    startTime: 0, deltaCount: 0, tokenSpeed: 0, ttftMs: undefined, ttftRecorded: false,
    activeToolStartedAtMs: undefined, activeToolName: undefined, activeToolCallId: undefined,
    lastDeltaAtMs: undefined, stallEpisode: 0, reconnectAttempt: undefined, reconnectMaxAttempts: undefined,
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function setup(isApprovalPending?: () => boolean) {
  const low: string[] = [];
  const turns = makeTurnBus();
  const opts = {
    events: {
      turns,
      tools: makeToolBus(),
      sessions: makeUnusedFeed(),
      providers: makeUnusedFeed(),
      agents: makeUnusedFeed(),
      workflows: makeUnusedFeed(),
      planner: makeUnusedFeed(),
      ops: makeUnusedFeed(),
    } as WireStreamEventMetricsOptions['events'],
    orchestrator: { streamingOutputTokens: 0 } as WireStreamEventMetricsOptions['orchestrator'],
    providerRegistry: {
      getCurrentModel: () => ({ provider: 'openai-subscriber', registryKey: 'openai:x' }),
    } as WireStreamEventMetricsOptions['providerRegistry'],
    systemMessageRouter: { high: (_m: string) => {}, low: (m: string) => low.push(m) },
    render: () => {},
    metrics: makeMetrics(),
    stallThresholdMs: 20,
    ...(isApprovalPending ? { isApprovalPending } : {}),
  } as WireStreamEventMetricsOptions;
  const result = wireStreamEventMetrics(opts);
  return { low, turns, dispose: () => { for (const u of result.unsubs) u(); } };
}

describe('stall watchdog respects a pending approval', () => {
  test('suppresses the provider-blaming stall hint while an approval is pending', async () => {
    const { low, turns, dispose } = setup(() => true);
    turns.emit('STREAM_START'); // arm the watchdog
    await wait(60);
    expect(low.join('\n')).not.toContain('Still waiting on');
    dispose();
  });

  test('still fires the hint for a genuine provider silence with no approval pending', async () => {
    const { low, turns, dispose } = setup(() => false);
    turns.emit('STREAM_START');
    await wait(60);
    expect(low.join('\n')).toContain('Still waiting on openai-subscriber');
    dispose();
  });
});
