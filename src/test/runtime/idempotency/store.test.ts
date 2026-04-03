/**
 * IdempotencyStore — comprehensive unit tests.
 *
 * Covers:
 * - State transitions: new / in-flight / duplicate / completed / failed
 * - Cancel + retry: markFailed allows subsequent checkAndRecord to return 'new'
 * - TTL sweep evicts expired records
 * - Key determinism: same inputs always produce the same key
 * - Concurrent duplicate detection: in-flight records block re-entry
 * - markComplete stores result; markFailed allows retry
 */

import { describe, test, expect } from 'bun:test';
import { IdempotencyStore } from '../../../runtime/idempotency/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(opts: { ttlMs?: number; maxRecords?: number } = {}) {
  return new IdempotencyStore(opts);
}

const CTX = { sessionId: 'sess-1', turnId: 'turn-1', callId: 'call-1' };

// ---------------------------------------------------------------------------
// 1. State transitions
// ---------------------------------------------------------------------------

describe('state transitions', () => {
  test('unseen key → new', () => {
    const store = makeStore();
    const key = store.generateKey(CTX);
    const result = store.checkAndRecord(key);
    expect(result.status).toBe('new');
  });

  test('new key → record is in-flight immediately after checkAndRecord', () => {
    const store = makeStore();
    const key = store.generateKey(CTX);
    store.checkAndRecord(key);
    const record = store.getRecord(key);
    expect(record).toBeDefined();
    expect(record!.status).toBe('in-flight');
  });

  test('in-flight key → second checkAndRecord returns in-flight', () => {
    const store = makeStore();
    const key = store.generateKey(CTX);
    store.checkAndRecord(key); // registers as in-flight
    const second = store.checkAndRecord(key);
    expect(second.status).toBe('in-flight');
    if (second.status === 'in-flight') {
      expect(second.record.status).toBe('in-flight');
    }
  });

  test('markComplete → completed status and result cached', () => {
    const store = makeStore();
    const key = store.generateKey(CTX);
    store.checkAndRecord(key);
    store.markComplete(key, { answer: 42 });
    const record = store.getRecord(key);
    expect(record!.status).toBe('completed');
    expect(record!.result).toEqual({ answer: 42 });
    expect(record!.completedAt).toBeGreaterThan(0);
  });

  test('completed key → checkAndRecord returns duplicate with cached result', () => {
    const store = makeStore();
    const key = store.generateKey(CTX);
    store.checkAndRecord(key);
    store.markComplete(key, 'cached-value');
    const dup = store.checkAndRecord(key);
    expect(dup.status).toBe('duplicate');
    if (dup.status === 'duplicate') {
      expect(dup.record.result).toBe('cached-value');
    }
  });

  test('markFailed → failed status with completedAt set', () => {
    const store = makeStore();
    const key = store.generateKey(CTX);
    store.checkAndRecord(key);
    store.markFailed(key);
    const record = store.getRecord(key);
    expect(record!.status).toBe('failed');
    expect(record!.completedAt).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Cancel + retry (markFailed allows subsequent checkAndRecord → 'new')
// ---------------------------------------------------------------------------

describe('cancel + retry semantics', () => {
  test('markFailed then checkAndRecord returns new (retry allowed)', () => {
    const store = makeStore();
    const key = store.generateKey(CTX);

    // First attempt: starts in-flight, then fails (e.g. cancelled)
    store.checkAndRecord(key);
    store.markFailed(key);

    // Retry: should be treated as a fresh execution
    const retry = store.checkAndRecord(key);
    expect(retry.status).toBe('new');
  });

  test('after retry checkAndRecord the record is in-flight again', () => {
    const store = makeStore();
    const key = store.generateKey(CTX);
    store.checkAndRecord(key);
    store.markFailed(key);
    store.checkAndRecord(key); // retry
    const record = store.getRecord(key);
    expect(record!.status).toBe('in-flight');
  });

  test('completed records do NOT allow retry (returns duplicate)', () => {
    const store = makeStore();
    const key = store.generateKey(CTX);
    store.checkAndRecord(key);
    store.markComplete(key, 'result');
    const second = store.checkAndRecord(key);
    expect(second.status).toBe('duplicate');
  });
});

// ---------------------------------------------------------------------------
// 3. TTL sweep evicts expired records
// ---------------------------------------------------------------------------

describe('TTL sweep', () => {
  test('sweep evicts completed records older than TTL', () => {
    const store = makeStore({ ttlMs: 100 });
    const key = store.generateKey(CTX);
    store.checkAndRecord(key);
    store.markComplete(key);

    // Manually backdate the createdAt to simulate expiry
    const record = store.getRecord(key)!;
    (record as { createdAt: number }).createdAt = Date.now() - 200;

    store.sweep();
    expect(store.getRecord(key)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test('sweep evicts failed records older than TTL', () => {
    const store = makeStore({ ttlMs: 100 });
    const key = store.generateKey(CTX);
    store.checkAndRecord(key);
    store.markFailed(key);

    const record = store.getRecord(key)!;
    (record as { createdAt: number }).createdAt = Date.now() - 200;

    store.sweep();
    expect(store.getRecord(key)).toBeUndefined();
  });

  test('sweep does NOT evict in-flight records', () => {
    const store = makeStore({ ttlMs: 100 });
    const key = store.generateKey(CTX);
    store.checkAndRecord(key); // in-flight

    const record = store.getRecord(key)!;
    (record as { createdAt: number }).createdAt = Date.now() - 200;

    store.sweep();
    expect(store.getRecord(key)).toBeDefined();
    expect(store.size).toBe(1);
  });

  test('sweep does NOT evict records within TTL', () => {
    const store = makeStore({ ttlMs: 60_000 });
    const key = store.generateKey(CTX);
    store.checkAndRecord(key);
    store.markComplete(key);
    store.sweep();
    expect(store.getRecord(key)).toBeDefined();
  });

  test('_maybeSweep triggers at 80% of maxRecords', () => {
    // maxRecords = 10, threshold = floor(10 * 0.8) = 8
    // Use ttlMs=1 so we can backdate createdAt to simulate expiry.
    const store = makeStore({ maxRecords: 10, ttlMs: 1 });

    // Add 7 completed records and immediately backdate them so they are expired.
    for (let i = 0; i < 7; i++) {
      const k = store.generateKey({ sessionId: 'sess', turnId: `t${i}`, callId: 'c' });
      store.checkAndRecord(k);
      store.markComplete(k);
      // Backdate to ensure TTL expired
      const rec = store.getRecord(k)!;
      (rec as { createdAt: number }).createdAt = Date.now() - 10;
    }
    expect(store.size).toBe(7);

    // Adding the 8th record hits the 80% threshold and triggers _maybeSweep,
    // which should evict all 7 expired completed records.
    const k8 = store.generateKey({ sessionId: 'sess', turnId: 't7', callId: 'c' });
    store.checkAndRecord(k8);

    // Only k8 (in-flight) should remain — the 7 expired ones were swept.
    expect(store.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Key determinism
// ---------------------------------------------------------------------------

describe('key determinism', () => {
  test('same context always produces the same key', () => {
    const store = makeStore();
    const key1 = store.generateKey(CTX);
    const key2 = store.generateKey(CTX);
    expect(key1).toBe(key2);
  });

  test('different callId produces different key', () => {
    const store = makeStore();
    const k1 = store.generateKey({ ...CTX, callId: 'call-a' });
    const k2 = store.generateKey({ ...CTX, callId: 'call-b' });
    expect(k1).not.toBe(k2);
  });

  test('different turnId produces different key', () => {
    const store = makeStore();
    const k1 = store.generateKey({ ...CTX, turnId: 'turn-a' });
    const k2 = store.generateKey({ ...CTX, turnId: 'turn-b' });
    expect(k1).not.toBe(k2);
  });

  test('different sessionId produces different key', () => {
    const store = makeStore();
    const k1 = store.generateKey({ ...CTX, sessionId: 'sess-a' });
    const k2 = store.generateKey({ ...CTX, sessionId: 'sess-b' });
    expect(k1).not.toBe(k2);
  });

  test('key is a 64-char hex string (SHA-256)', () => {
    const store = makeStore();
    const key = store.generateKey(CTX);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 5. Concurrent duplicate detection
// ---------------------------------------------------------------------------

describe('concurrent duplicate detection', () => {
  test('in-flight key blocks a second submission', () => {
    const store = makeStore();
    const key = store.generateKey(CTX);

    const first = store.checkAndRecord(key);
    expect(first.status).toBe('new');

    const second = store.checkAndRecord(key);
    expect(second.status).toBe('in-flight');
  });

  test('two distinct keys can both be in-flight simultaneously', () => {
    const store = makeStore();
    const k1 = store.generateKey({ ...CTX, callId: 'call-1' });
    const k2 = store.generateKey({ ...CTX, callId: 'call-2' });

    expect(store.checkAndRecord(k1).status).toBe('new');
    expect(store.checkAndRecord(k2).status).toBe('new');
    expect(store.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. markComplete stores result; markFailed allows retry
// ---------------------------------------------------------------------------

describe('markComplete and markFailed', () => {
  test('markComplete without result — record has no result property', () => {
    const store = makeStore();
    const key = store.generateKey(CTX);
    store.checkAndRecord(key);
    store.markComplete(key);
    const record = store.getRecord(key)!;
    expect(record.status).toBe('completed');
    expect(record.result).toBeUndefined();
  });

  test('markComplete with result — result is retrievable on duplicate', () => {
    const store = makeStore();
    const key = store.generateKey(CTX);
    store.checkAndRecord(key);
    const payload = { tool: 'read', output: 'file contents' };
    store.markComplete(key, payload);
    const dup = store.checkAndRecord(key);
    expect(dup.status).toBe('duplicate');
    if (dup.status === 'duplicate') {
      expect(dup.record.result).toEqual(payload);
    }
  });

  test('markFailed on unknown key is a no-op (does not throw)', () => {
    const store = makeStore();
    expect(() => store.markFailed('nonexistent-key')).not.toThrow();
  });

  test('markComplete on unknown key is a no-op (does not throw)', () => {
    const store = makeStore();
    expect(() => store.markComplete('nonexistent-key', 'value')).not.toThrow();
  });

  test('markFailed allows subsequent checkAndRecord to return new (retry)', () => {
    const store = makeStore();
    const key = store.generateKey(CTX);
    store.checkAndRecord(key);
    store.markFailed(key);
    const retried = store.checkAndRecord(key);
    expect(retried.status).toBe('new');
  });

  test('full lifecycle: new → in-flight → completed → duplicate → (TTL expires) → evicted', () => {
    const store = makeStore({ ttlMs: 0 }); // instant TTL
    const key = store.generateKey(CTX);

    expect(store.checkAndRecord(key).status).toBe('new');
    store.markComplete(key, 'done');
    expect(store.checkAndRecord(key).status).toBe('duplicate');

    // Manually expire
    const record = store.getRecord(key)!;
    (record as { createdAt: number }).createdAt = Date.now() - 1;
    store.sweep();
    expect(store.getRecord(key)).toBeUndefined();
  });
});
