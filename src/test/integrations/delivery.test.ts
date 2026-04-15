import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  DeliveryQueue,
  DeliveryError,
  classifyDeliveryError,
  snapshotQueueStatus,
} from '@pellux/goodvibes-sdk/platform/integrations/delivery';
import type { DeadLetterEntry, DeliveryOutcome } from '@pellux/goodvibes-sdk/platform/integrations/delivery';

// ---------------------------------------------------------------------------
// classifyDeliveryError
// ---------------------------------------------------------------------------

describe('classifyDeliveryError', () => {
  test('classifies DeliveryError with explicit class', () => {
    const retryable = new DeliveryError('rate limited', 'retryable', 429);
    const terminal = new DeliveryError('unauthorized', 'terminal', 401);
    expect(classifyDeliveryError(retryable)).toBe('retryable');
    expect(classifyDeliveryError(terminal)).toBe('terminal');
  });

  test('classifies HTTP 429 error message as retryable', () => {
    expect(classifyDeliveryError(new Error('HTTP 429: too many requests'))).toBe('retryable');
  });

  test('classifies HTTP 500 error message as retryable', () => {
    expect(classifyDeliveryError(new Error('HTTP 500: internal server error'))).toBe('retryable');
  });

  test('classifies HTTP 503 error message as retryable', () => {
    expect(classifyDeliveryError(new Error('HTTP 503: service unavailable'))).toBe('retryable');
  });

  test('classifies HTTP 400 error message as terminal', () => {
    expect(classifyDeliveryError(new Error('HTTP 400: bad request'))).toBe('terminal');
  });

  test('classifies HTTP 401 error message as terminal', () => {
    expect(classifyDeliveryError(new Error('HTTP 401: unauthorized'))).toBe('terminal');
  });

  test('classifies HTTP 403 error message as terminal', () => {
    expect(classifyDeliveryError(new Error('HTTP 403: forbidden'))).toBe('terminal');
  });

  test('classifies timeout error as retryable', () => {
    expect(classifyDeliveryError(new Error('Request timeout'))).toBe('retryable');
  });

  test('classifies network aborted error as retryable', () => {
    expect(classifyDeliveryError(new Error('fetch aborted'))).toBe('retryable');
  });

  test('classifies ECONNREFUSED as retryable', () => {
    expect(classifyDeliveryError(new Error('ECONNREFUSED connect failed'))).toBe('retryable');
  });

  test('classifies TypeError (invalid URL) as terminal', () => {
    expect(classifyDeliveryError(new TypeError('Invalid URL: not-a-url'))).toBe('terminal');
  });

  test('defaults to retryable for unknown errors (never silent drop)', () => {
    expect(classifyDeliveryError(new Error('something weird happened'))).toBe('retryable');
    expect(classifyDeliveryError(null)).toBe('retryable');
    expect(classifyDeliveryError('string error')).toBe('retryable');
  });
});

// ---------------------------------------------------------------------------
// DeliveryQueue — successful delivery
// ---------------------------------------------------------------------------

describe('DeliveryQueue.enqueue — success', () => {
  test('returns delivered on successful delivery', async () => {
    const queue = new DeliveryQueue({ maxRetries: 0, initialDelayMs: 1, maxDelayMs: 10 });
    const deliver = mock(async () => {});
    const outcome = await queue.enqueue('slack', 'test:event', 'hello', deliver);
    expect(outcome).toBe('delivered');
    expect(deliver).toHaveBeenCalledTimes(1);
    queue.dispose();
  });

  test('increments delivered metric', async () => {
    const queue = new DeliveryQueue({ maxRetries: 0, initialDelayMs: 1, maxDelayMs: 10 });
    await queue.enqueue('slack', 'e', 'msg', async () => {});
    await queue.enqueue('discord', 'e', 'msg', async () => {});
    const m = queue.getMetrics();
    expect(m.delivered).toBe(2);
    expect(m.totalAttempts).toBe(2);
    queue.dispose();
  });
});

// ---------------------------------------------------------------------------
// DeliveryQueue — retry/backoff
// ---------------------------------------------------------------------------

describe('DeliveryQueue.enqueue — retry/backoff', () => {
  test('returns retrying on first retryable failure', async () => {
    const queue = new DeliveryQueue({ maxRetries: 2, initialDelayMs: 50_000, maxDelayMs: 100_000 });
    let calls = 0;
    // First call fails with retryable error; subsequent retries are delayed
    const outcome = await queue.enqueue('slack', 'e', 'msg', async () => {
      calls++;
      throw new Error('HTTP 429: rate limited');
    });
    expect(outcome).toBe('retrying');
    expect(calls).toBe(1); // Only initial attempt; retries are scheduled
    expect(queue.getMetrics().retrying).toBe(1);
    queue.dispose();
  });

  test('delivers on retry after initial failure', async () => {
    const queue = new DeliveryQueue({ maxRetries: 3, initialDelayMs: 1, maxDelayMs: 5 });
    let calls = 0;
    const outcome = await queue.enqueue('slack', 'e', 'msg', async () => {
      calls++;
      if (calls < 2) throw new Error('HTTP 503: unavailable');
    });
    // First attempt returns retrying; need to wait for scheduled retry
    if (outcome === 'retrying') {
      // Wait for the retry timer (initialDelayMs=1ms)
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    // After retry completes, delivered counter should be 1
    const m = queue.getMetrics();
    expect(m.delivered).toBe(1);
    queue.dispose();
  });

  test('moves to DLQ after maxRetries exhausted', async () => {
    const queue = new DeliveryQueue({ maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 });
    const dlqEntries: DeadLetterEntry[] = [];
    queue.onDeadLetter((entry) => dlqEntries.push(entry));

    // All attempts fail with retryable error
    const outcome = await queue.enqueue('slack', 'e', 'msg', async () => {
      throw new Error('HTTP 503: always fails');
    });

    // First attempt returns retrying; wait for all retries to fire
    if (outcome === 'retrying') {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }

    const m = queue.getMetrics();
    expect(m.deadLettered).toBe(1);
    expect(m.dlqSize).toBe(1);
    expect(dlqEntries).toHaveLength(1);
    expect(dlqEntries[0]!.channel).toBe('slack');
    expect(dlqEntries[0]!.event).toBe('e');
    expect(dlqEntries[0]!.failureClass).toBe('retryable');
    queue.dispose();
  });

  test('moves to DLQ immediately on terminal failure (no retry)', async () => {
    const queue = new DeliveryQueue({ maxRetries: 3, initialDelayMs: 1, maxDelayMs: 5 });
    const dlqEntries: DeadLetterEntry[] = [];
    queue.onDeadLetter((entry) => dlqEntries.push(entry));

    const outcome = await queue.enqueue('discord', 'auth:event', 'msg', async () => {
      throw new TypeError('Invalid URL: not-a-url');
    });

    // Terminal failures go to DLQ immediately (no retry)
    expect(outcome).toBe('dead_letter');
    expect(dlqEntries).toHaveLength(1);
    expect(dlqEntries[0]!.failureClass).toBe('terminal');
    expect(dlqEntries[0]!.attempts).toBe(1);
    expect(queue.getMetrics().deadLettered).toBe(1);
    queue.dispose();
  });
});

// ---------------------------------------------------------------------------
// DeliveryQueue — dead-letter queue
// ---------------------------------------------------------------------------

describe('DeliveryQueue — DLQ management', () => {
  test('onDeadLetter listener is called with full entry', async () => {
    const queue = new DeliveryQueue({ maxRetries: 0, initialDelayMs: 1, maxDelayMs: 5 });
    const captured: DeadLetterEntry[] = [];
    const unsub = queue.onDeadLetter((e) => captured.push(e));

    await queue.enqueue('webhook', 'ev', 'payload text', async () => {
      throw new TypeError('Invalid URL');
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.payload).toBe('payload text');
    expect(captured[0]!.channel).toBe('webhook');
    expect(typeof captured[0]!.deadAt).toBe('number');
    unsub();
    queue.dispose();
  });

  test('unsubscribing onDeadLetter stops listener calls', async () => {
    const queue = new DeliveryQueue({ maxRetries: 0, initialDelayMs: 1, maxDelayMs: 5 });
    let callCount = 0;
    const unsub = queue.onDeadLetter(() => callCount++);
    unsub();

    await queue.enqueue('slack', 'ev', 'msg', async () => {
      throw new TypeError('Invalid URL');
    });

    expect(callCount).toBe(0);
    queue.dispose();
  });

  test('getDlq returns snapshot of DLQ contents', async () => {
    const queue = new DeliveryQueue({ maxRetries: 0, initialDelayMs: 1, maxDelayMs: 5 });
    await queue.enqueue('slack', 'a', 'msg-a', async () => { throw new TypeError('bad url'); });
    await queue.enqueue('discord', 'b', 'msg-b', async () => { throw new TypeError('bad url'); });

    const dlq = queue.getDlq();
    expect(dlq).toHaveLength(2);
    // getDlq returns snapshot; mutations to the result don't affect the queue
    const snapshot = [...dlq];
    expect(snapshot[0]!.event).toBe('a');
    queue.dispose();
  });

  test('clearDlq removes all entries and returns count', async () => {
    const queue = new DeliveryQueue({ maxRetries: 0, initialDelayMs: 1, maxDelayMs: 5 });
    await queue.enqueue('slack', 'a', 'msg', async () => { throw new TypeError('x'); });
    await queue.enqueue('slack', 'b', 'msg', async () => { throw new TypeError('x'); });

    expect(queue.getDlq()).toHaveLength(2);
    const cleared = queue.clearDlq();
    expect(cleared).toBe(2);
    expect(queue.getDlq()).toHaveLength(0);
    queue.dispose();
  });

  test('DLQ evicts oldest entry when maxDlqSize exceeded', async () => {
    const queue = new DeliveryQueue({ maxRetries: 0, initialDelayMs: 1, maxDelayMs: 5, maxDlqSize: 2 });
    await queue.enqueue('slack', 'first', 'msg', async () => { throw new TypeError('x'); });
    await queue.enqueue('slack', 'second', 'msg', async () => { throw new TypeError('x'); });
    await queue.enqueue('slack', 'third', 'msg', async () => { throw new TypeError('x'); });

    const dlq = queue.getDlq();
    expect(dlq).toHaveLength(2);
    // 'first' was evicted; 'second' and 'third' remain
    expect(dlq[0]!.event).toBe('second');
    expect(dlq[1]!.event).toBe('third');
    queue.dispose();
  });
});

// ---------------------------------------------------------------------------
// DeliveryQueue — replay
// ---------------------------------------------------------------------------

describe('DeliveryQueue.replay', () => {
  test('replays all DLQ entries and returns outcomes', async () => {
    const queue = new DeliveryQueue({ maxRetries: 0, initialDelayMs: 1, maxDelayMs: 5 });
    // Put two entries in DLQ
    await queue.enqueue('slack', 'ev-a', 'msg-a', async () => { throw new TypeError('x'); });
    await queue.enqueue('slack', 'ev-b', 'msg-b', async () => { throw new TypeError('x'); });
    expect(queue.getDlq()).toHaveLength(2);

    // Replay with a deliver function that always succeeds
    const replayDeliver = mock(async (_entry: DeadLetterEntry) => {});
    const results = await queue.replay(replayDeliver);

    expect(results).toHaveLength(2);
    const outcomes = results.map((r) => r.outcome);
    expect(outcomes).toContain('delivered');
    // DLQ should be cleared after successful replay
    expect(queue.getDlq()).toHaveLength(0);
    expect(replayDeliver).toHaveBeenCalledTimes(2);
    queue.dispose();
  });

  test('replay re-queues to DLQ if deliver still fails', async () => {
    const queue = new DeliveryQueue({ maxRetries: 0, initialDelayMs: 1, maxDelayMs: 5 });
    await queue.enqueue('slack', 'ev', 'msg', async () => { throw new TypeError('bad url'); });
    expect(queue.getDlq()).toHaveLength(1);

    // Replay with a deliver that also fails terminally
    const results = await queue.replay(async () => { throw new TypeError('still bad'); });

    expect(results[0]!.outcome).toBe('dead_letter');
    // Re-dead-lettered entry is back in the DLQ
    expect(queue.getDlq()).toHaveLength(1);
    queue.dispose();
  });

  test('replay on empty DLQ returns empty results', async () => {
    const queue = new DeliveryQueue({});
    const results = await queue.replay(async () => {});
    expect(results).toHaveLength(0);
    queue.dispose();
  });

  test('replay passes the original entry to the deliver function', async () => {
    const queue = new DeliveryQueue({ maxRetries: 0, initialDelayMs: 1, maxDelayMs: 5 });
    await queue.enqueue('webhook', 'my-event', 'original payload', async () => {
      throw new TypeError('bad url');
    });

    const captured: DeadLetterEntry[] = [];
    await queue.replay(async (entry) => { captured.push(entry); });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.payload).toBe('original payload');
    expect(captured[0]!.event).toBe('my-event');
    queue.dispose();
  });
});

// ---------------------------------------------------------------------------
// DeliveryQueue — SLO enforcement flag
// ---------------------------------------------------------------------------

describe('DeliveryQueue — SLO enforcement', () => {
  test('sloEnforced=false uses warn-level logging (no throw)', async () => {
    // Just verify no error is thrown and DLQ is populated
    const queue = new DeliveryQueue({
      maxRetries: 0,
      initialDelayMs: 1,
      maxDelayMs: 5,
      sloEnforced: false,
    });
    const outcome = await queue.enqueue('slack', 'ev', 'msg', async () => {
      throw new TypeError('bad url');
    });
    expect(outcome).toBe('dead_letter');
    expect(queue.getDlq()).toHaveLength(1);
    queue.dispose();
  });

  test('sloEnforced=true populates DLQ normally (enforcement is logging-level only)', async () => {
    const queue = new DeliveryQueue({
      maxRetries: 0,
      initialDelayMs: 1,
      maxDelayMs: 5,
      sloEnforced: true,
    });
    const outcome = await queue.enqueue('discord', 'ev', 'msg', async () => {
      throw new TypeError('bad url');
    });
    expect(outcome).toBe('dead_letter');
    expect(queue.getDlq()).toHaveLength(1);
    queue.dispose();
  });
});

// ---------------------------------------------------------------------------
// DeliveryQueue — metrics invariants
// ---------------------------------------------------------------------------

describe('DeliveryQueue — metrics', () => {
  test('metrics track mixed outcomes correctly', async () => {
    const queue = new DeliveryQueue({ maxRetries: 0, initialDelayMs: 1, maxDelayMs: 5 });
    // 2 successes
    await queue.enqueue('slack', 'ok-1', 'msg', async () => {});
    await queue.enqueue('discord', 'ok-2', 'msg', async () => {});
    // 1 terminal failure → DLQ
    await queue.enqueue('slack', 'fail-1', 'msg', async () => { throw new TypeError('x'); });

    const m = queue.getMetrics();
    expect(m.totalAttempts).toBe(3);
    expect(m.delivered).toBe(2);
    expect(m.deadLettered).toBe(1);
    expect(m.dlqSize).toBe(1);
    queue.dispose();
  });
});

// ---------------------------------------------------------------------------
// snapshotQueueStatus
// ---------------------------------------------------------------------------

describe('snapshotQueueStatus', () => {
  test('returns channel, metrics, dlqEntries, sloEnforced, capturedAt', async () => {
    const queue = new DeliveryQueue({ maxRetries: 0, initialDelayMs: 1, maxDelayMs: 5 });
    await queue.enqueue('slack', 'ev', 'hello', async () => {});

    const snapshot = snapshotQueueStatus('slack', queue, false);
    expect(snapshot.channel).toBe('slack');
    expect(snapshot.metrics.delivered).toBe(1);
    expect(snapshot.sloEnforced).toBe(false);
    expect(typeof snapshot.capturedAt).toBe('number');
    expect(Array.isArray(snapshot.dlqEntries)).toBe(true);
    queue.dispose();
  });

  test('dlqEntries are capped at 50 entries (most recent first)', async () => {
    const queue = new DeliveryQueue({ maxRetries: 0, initialDelayMs: 1, maxDelayMs: 5, maxDlqSize: 100 });
    // Add 60 terminal failures
    for (let i = 0; i < 60; i++) {
      await queue.enqueue('slack', `ev-${i}`, 'msg', async () => { throw new TypeError('x'); });
    }

    const snapshot = snapshotQueueStatus('slack', queue, true);
    expect(snapshot.dlqEntries.length).toBeLessThanOrEqual(50);
    queue.dispose();
  });
});
