/**
 * Determinism Gate — Release Gate 2
 *
 * Verifies that:
 * - Idempotency store prevents duplicate execution (in-flight deduplication)
 * - Completed operations return cached results, not re-executions
 * - Keys are deterministic (same context → same key)
 * - Failed operations can be retried (failed ≠ completed)
 * - Orchestrator invariants: no dangling tool call re-execution
 */

import { describe, test, expect } from 'bun:test';
import { IdempotencyStore } from '../../runtime/idempotency/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(opts: { ttlMs?: number; maxRecords?: number } = {}) {
  return new IdempotencyStore(opts);
}

const BASE_CTX = { sessionId: 'sess-det', turnId: 'turn-det', callId: 'call-det' };

// ---------------------------------------------------------------------------
// 1. In-flight deduplication
// ---------------------------------------------------------------------------

describe('determinism gate: in-flight deduplication', () => {
  test('first submission returns new status (allowed to proceed)', () => {
    const store = makeStore();
    const key = store.generateKey(BASE_CTX);
    const result = store.checkAndRecord(key);
    expect(result.status).toBe('new');
  });

  test('second submission while in-flight returns in-flight (blocked)', () => {
    const store = makeStore();
    const key = store.generateKey(BASE_CTX);
    store.checkAndRecord(key); // first — in-flight
    const second = store.checkAndRecord(key);
    expect(second.status).toBe('in-flight');
  });

  test('in-flight block prevents side-effect re-execution', () => {
    const store = makeStore();
    const key = store.generateKey(BASE_CTX);
    let execCount = 0;
    const check1 = store.checkAndRecord(key);
    if (check1.status === 'new') execCount++;

    const check2 = store.checkAndRecord(key);
    if (check2.status === 'new') execCount++;

    // Only the first call should trigger execution
    expect(execCount).toBe(1);
  });

  test('multiple distinct calls can all be in-flight simultaneously', () => {
    const store = makeStore();
    const k1 = store.generateKey({ ...BASE_CTX, callId: 'c1' });
    const k2 = store.generateKey({ ...BASE_CTX, callId: 'c2' });
    const k3 = store.generateKey({ ...BASE_CTX, callId: 'c3' });

    expect(store.checkAndRecord(k1).status).toBe('new');
    expect(store.checkAndRecord(k2).status).toBe('new');
    expect(store.checkAndRecord(k3).status).toBe('new');
    expect(store.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. Completed result caching (replay dedup)
// ---------------------------------------------------------------------------

describe('determinism gate: completed result caching', () => {
  test('completed operation returns cached result on duplicate submission', () => {
    const store = makeStore();
    const key = store.generateKey(BASE_CTX);
    const cachedResult = { output: 'file content', tool: 'read' };

    store.checkAndRecord(key);
    store.markComplete(key, cachedResult);

    const dup = store.checkAndRecord(key);
    expect(dup.status).toBe('duplicate');
    if (dup.status === 'duplicate') {
      expect(dup.record.result).toEqual(cachedResult);
    }
  });

  test('completed record is not re-executed (duplicate blocks re-run)', () => {
    const store = makeStore();
    const key = store.generateKey(BASE_CTX);
    let execCount = 0;

    const check1 = store.checkAndRecord(key);
    if (check1.status === 'new') {
      execCount++;
      store.markComplete(key, 'first-result');
    }

    const check2 = store.checkAndRecord(key);
    if (check2.status === 'new') execCount++;

    expect(execCount).toBe(1);
    expect(check2.status).toBe('duplicate');
  });

  test('completed result survives multiple duplicate checks', () => {
    const store = makeStore();
    const key = store.generateKey(BASE_CTX);
    store.checkAndRecord(key);
    store.markComplete(key, { value: 42 });

    for (let i = 0; i < 5; i++) {
      const dup = store.checkAndRecord(key);
      expect(dup.status).toBe('duplicate');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Key determinism
// ---------------------------------------------------------------------------

describe('determinism gate: key determinism', () => {
  test('same context always produces identical key', () => {
    const store = makeStore();
    const key1 = store.generateKey(BASE_CTX);
    const key2 = store.generateKey(BASE_CTX);
    expect(key1).toBe(key2);
  });

  test('different callId produces different key', () => {
    const store = makeStore();
    const k1 = store.generateKey({ ...BASE_CTX, callId: 'call-a' });
    const k2 = store.generateKey({ ...BASE_CTX, callId: 'call-b' });
    expect(k1).not.toBe(k2);
  });

  test('different turnId produces different key', () => {
    const store = makeStore();
    const k1 = store.generateKey({ ...BASE_CTX, turnId: 'turn-a' });
    const k2 = store.generateKey({ ...BASE_CTX, turnId: 'turn-b' });
    expect(k1).not.toBe(k2);
  });

  test('different sessionId produces different key', () => {
    const store = makeStore();
    const k1 = store.generateKey({ ...BASE_CTX, sessionId: 'sess-a' });
    const k2 = store.generateKey({ ...BASE_CTX, sessionId: 'sess-b' });
    expect(k1).not.toBe(k2);
  });

  test('key is a 64-char hex string (SHA-256 deterministic)', () => {
    const store = makeStore();
    const key = store.generateKey(BASE_CTX);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 4. Failed → retry semantics (reconnect idempotency)
// ---------------------------------------------------------------------------

describe('determinism gate: failed operation retry', () => {
  test('failed operation allows retry (not treated as duplicate)', () => {
    const store = makeStore();
    const key = store.generateKey(BASE_CTX);
    store.checkAndRecord(key);
    store.markFailed(key);

    const retry = store.checkAndRecord(key);
    expect(retry.status).toBe('new');
  });

  test('after retry the record is in-flight again (no dangling failed state)', () => {
    const store = makeStore();
    const key = store.generateKey(BASE_CTX);
    store.checkAndRecord(key);
    store.markFailed(key);
    store.checkAndRecord(key); // retry
    expect(store.getRecord(key)!.status).toBe('in-flight');
  });

  test('failed record has completedAt set (observable for audit)', () => {
    const store = makeStore();
    const key = store.generateKey(BASE_CTX);
    store.checkAndRecord(key);
    store.markFailed(key);
    const record = store.getRecord(key)!;
    expect(record.completedAt).toBeGreaterThan(0);
    expect(record.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 5. Explicit store instance sanity
// ---------------------------------------------------------------------------

describe('determinism gate: explicit store instance', () => {
  test('fresh store instances are usable and deterministic', () => {
    const store = new IdempotencyStore();
    const ctx = { sessionId: 'shared-sess', turnId: 'shared-turn', callId: 'shared-call' };
    const k1 = store.generateKey(ctx);
    const k2 = store.generateKey(ctx);
    expect(k1).toBe(k2);
  });
});

// ---------------------------------------------------------------------------
// 6. No dangling tool calls: in-flight records survive sweep
// ---------------------------------------------------------------------------

describe('determinism gate: no dangling in-flight eviction', () => {
  test('sweep never evicts in-flight records (orchestrator invariant)', () => {
    const store = makeStore({ ttlMs: 0 }); // instant TTL for non-in-flight
    const key = store.generateKey(BASE_CTX);
    store.checkAndRecord(key); // in-flight

    const record = store.getRecord(key)!;
    // Backdate to simulate age.
    // Cast is intentional: createdAt is readonly in the public type but must be
    // mutated here to simulate TTL sweep behavior without real clock delays.
    (record as { createdAt: number }).createdAt = Date.now() - 1000;

    store.sweep();
    // In-flight record must survive
    expect(store.getRecord(key)).toBeDefined();
    expect(store.getRecord(key)!.status).toBe('in-flight');
  });

  test('completed records are evicted after TTL (no memory leak)', () => {
    const store = makeStore({ ttlMs: 1 });
    const key = store.generateKey(BASE_CTX);
    store.checkAndRecord(key);
    store.markComplete(key, 'done');
    const record = store.getRecord(key)!;
    (record as { createdAt: number }).createdAt = Date.now() - 10;
    store.sweep();
    expect(store.getRecord(key)).toBeUndefined();
  });
});
