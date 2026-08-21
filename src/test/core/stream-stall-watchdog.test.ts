/**
 * Tests for StreamStallWatchdog.
 *
 * Uses real setTimeout with a very short threshold (10ms) instead of fake
 * timers (not available in bun:test as of this codebase) to keep tests fast
 * while exercising the real timer contract.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import {
  createStreamStallWatchdog,
  STALL_THRESHOLD_MS,
  type WatchdogTurnEvents,
} from '../../core/stream-stall-watchdog.ts';

// ---------------------------------------------------------------------------
// Minimal event surface stub
// ---------------------------------------------------------------------------

type SupportedEvent =
  | 'STREAM_START'
  | 'STREAM_DELTA'
  | 'STREAM_END'
  | 'TURN_COMPLETED'
  | 'TURN_ERROR'
  | 'TURN_CANCEL';

type EventMap = { [K in SupportedEvent]: Array<() => void> };

function makeEvents(): WatchdogTurnEvents & { emit: (event: SupportedEvent) => void } {
  const listeners: EventMap = {
    STREAM_START: [],
    STREAM_DELTA: [],
    STREAM_END: [],
    TURN_COMPLETED: [],
    TURN_ERROR: [],
    TURN_CANCEL: [],
  };

  return {
    on(event: SupportedEvent, handler: () => void) {
      listeners[event].push(handler);
      return () => {
        const idx = listeners[event].indexOf(handler);
        if (idx !== -1) listeners[event].splice(idx, 1);
      };
    },
    emit(event: SupportedEvent) {
      for (const h of listeners[event].slice()) h();
    },
  };
}

/** Wait at least `ms` milliseconds (real time). */
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Short threshold for tests to keep suite fast. */
const TEST_THRESHOLD_MS = 20;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamStallWatchdog', () => {
  test('STALL_THRESHOLD_MS is 30000', () => {
    expect(STALL_THRESHOLD_MS).toBe(30_000);
  });

  test('fires onStall exactly once after STREAM_START with no delta', async () => {
    const events = makeEvents();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      onStall: (provider) => stallCalls.push(provider),
      getProviderName: () => 'anthropic',
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    await wait(TEST_THRESHOLD_MS + 10);

    expect(stallCalls).toHaveLength(1);
    expect(stallCalls[0]).toBe('anthropic');

    watchdog.dispose();
  });

  test('does NOT fire when the gap after STREAM_DELTA stays under threshold', async () => {
    const events = makeEvents();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      onStall: (provider) => stallCalls.push(provider),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    // Delta arrives well before threshold, and nothing exceeds the
    // (re-armed) threshold afterwards either.
    await wait(5);
    events.emit('STREAM_DELTA');
    await wait(TEST_THRESHOLD_MS - 10);

    expect(stallCalls).toHaveLength(0);
    watchdog.dispose();
  });

  test('DOES fire on a mid-stream stall; silence after a delta re-arms the watchdog', async () => {
    // Regression test for the reported multi-minute mid-turn stall: tokens
    // were already flowing (so a delta had arrived), then the stream went
    // silent for longer than the threshold. The watchdog must still fire,
    // it must NOT be permanently disarmed by the first delta.
    const events = makeEvents();
    const stallCalls: Array<{ provider: string; episode: number }> = [];
    const watchdog = createStreamStallWatchdog({
      events,
      onStall: (provider, episode) => stallCalls.push({ provider, episode }),
      getProviderName: () => 'anthropic',
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    await wait(5);
    events.emit('STREAM_DELTA');
    // No further deltas, silence exceeds the threshold from this point on.
    await wait(TEST_THRESHOLD_MS + 10);

    expect(stallCalls).toHaveLength(1);
    expect(stallCalls[0]).toEqual({ provider: 'anthropic', episode: 1 });
    watchdog.dispose();
  });

  test('fires again for a second stall episode after a recovery', async () => {
    const events = makeEvents();
    const stallCalls: Array<{ provider: string; episode: number }> = [];
    const watchdog = createStreamStallWatchdog({
      events,
      onStall: (provider, episode) => stallCalls.push({ provider, episode }),
      getProviderName: () => 'anthropic',
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    await wait(TEST_THRESHOLD_MS + 10);
    expect(stallCalls).toHaveLength(1);
    expect(stallCalls[0].episode).toBe(1);

    // Stream recovers (a delta arrives), then stalls again.
    events.emit('STREAM_DELTA');
    await wait(TEST_THRESHOLD_MS + 10);

    expect(stallCalls).toHaveLength(2);
    expect(stallCalls[1].episode).toBe(2);
    watchdog.dispose();
  });

  test('fires only ONCE per turn even if threshold elapses multiple times', async () => {
    const events = makeEvents();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    // Wait for the stall to fire
    await wait(TEST_THRESHOLD_MS + 10);
    // Wait again well past the threshold, should not fire again
    await wait(TEST_THRESHOLD_MS + 10);

    expect(stallCalls).toHaveLength(1);
    watchdog.dispose();
  });

  test('re-arms on next STREAM_START after a stall', async () => {
    const events = makeEvents();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    // First turn stalls
    events.emit('STREAM_START');
    await wait(TEST_THRESHOLD_MS + 10);
    expect(stallCalls).toHaveLength(1);

    // Second turn also stalls, should fire again (re-armed)
    events.emit('STREAM_START');
    await wait(TEST_THRESHOLD_MS + 10);
    expect(stallCalls).toHaveLength(2);

    watchdog.dispose();
  });

  test('disarms on TURN_COMPLETED: no stall fires after turn ends', async () => {
    const events = makeEvents();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    await wait(5);
    events.emit('TURN_COMPLETED');
    await wait(TEST_THRESHOLD_MS + 10);

    expect(stallCalls).toHaveLength(0);
    watchdog.dispose();
  });

  test('disarms on TURN_ERROR: no stall fires after error', async () => {
    const events = makeEvents();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    await wait(5);
    events.emit('TURN_ERROR');
    await wait(TEST_THRESHOLD_MS + 10);

    expect(stallCalls).toHaveLength(0);
    watchdog.dispose();
  });

  test('disarms on TURN_CANCEL', async () => {
    const events = makeEvents();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    await wait(5);
    events.emit('TURN_CANCEL');
    await wait(TEST_THRESHOLD_MS + 10);

    expect(stallCalls).toHaveLength(0);
    watchdog.dispose();
  });

  test('disarms on STREAM_END', async () => {
    const events = makeEvents();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    await wait(5);
    events.emit('STREAM_END');
    await wait(TEST_THRESHOLD_MS + 10);

    expect(stallCalls).toHaveLength(0);
    watchdog.dispose();
  });

  test('dispose() cancels pending timer: no stall fires after dispose', async () => {
    const events = makeEvents();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    await wait(5);
    watchdog.dispose();
    await wait(TEST_THRESHOLD_MS + 10);

    expect(stallCalls).toHaveLength(0);
  });

  test('dispose() removes all event subscriptions', async () => {
    const events = makeEvents();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });
    watchdog.dispose();

    // Emitting after dispose should not trigger anything
    events.emit('STREAM_START');
    await wait(TEST_THRESHOLD_MS + 10);

    expect(stallCalls).toHaveLength(0);
  });

  test('uses default provider name when getProviderName not supplied', async () => {
    const events = makeEvents();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      onStall: (name) => stallCalls.push(name),
      thresholdMs: TEST_THRESHOLD_MS,
      // No getProviderName
    });

    events.emit('STREAM_START');
    await wait(TEST_THRESHOLD_MS + 10);

    expect(stallCalls[0]).toBe('provider');
    watchdog.dispose();
  });
});
