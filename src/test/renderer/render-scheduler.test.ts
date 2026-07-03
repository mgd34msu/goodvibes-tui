// ---------------------------------------------------------------------------
// render-scheduler.test.ts — WO-208 coalescing semantics.
//
// Pins the same-tick render coalescer that sits over main.ts's direct render()
// fan-out: k schedule() calls in one tick collapse to exactly ONE composite,
// while flushNow() keeps a synchronous immediate path (terminal resize) and
// never lets a tick composite twice.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { createRenderScheduler } from '../../runtime/render-scheduler.ts';

/** A manual flush queue so tick boundaries are deterministic (no real microtask wait). */
function manualQueue() {
  const pending: Array<() => void> = [];
  return {
    schedule: (flush: () => void): void => { pending.push(flush); },
    /** Drain everything queued so far, mimicking the tick's microtask checkpoint. */
    drain: (): void => { const batch = pending.splice(0); for (const f of batch) f(); },
    get size() { return pending.length; },
  };
}

describe('render-scheduler: same-tick coalescing (WO-208)', () => {
  test('k schedule() calls within one tick produce exactly one composite', () => {
    let composites = 0;
    const q = manualQueue();
    const s = createRenderScheduler(() => { composites++; }, q.schedule);

    // Burst of k=5 within a single tick.
    s.schedule(); s.schedule(); s.schedule(); s.schedule(); s.schedule();

    expect(composites).toBe(0); // nothing composited synchronously
    expect(q.size).toBe(1);     // only ONE flush queued for the whole burst

    q.drain(); // tick boundary
    expect(composites).toBe(1); // 5 calls -> 1 composite
  });

  test('a fresh burst after the flush schedules another single composite', () => {
    let composites = 0;
    const q = manualQueue();
    const s = createRenderScheduler(() => { composites++; }, q.schedule);

    s.schedule(); s.schedule();
    q.drain();
    expect(composites).toBe(1);

    s.schedule(); s.schedule(); s.schedule();
    expect(q.size).toBe(1); // one flush queued for burst 2
    q.drain();
    expect(composites).toBe(2); // second burst -> one more composite
  });

  test('flushNow() composites synchronously — the immediate path', () => {
    let composites = 0;
    const q = manualQueue();
    const s = createRenderScheduler(() => { composites++; }, q.schedule);

    s.flushNow();
    expect(composites).toBe(1); // synchronous, no tick needed
    expect(q.size).toBe(0);     // nothing deferred
  });

  test('flushNow() satisfies a pending coalesced flush — no double composite', () => {
    let composites = 0;
    const q = manualQueue();
    const s = createRenderScheduler(() => { composites++; }, q.schedule);

    s.schedule();  // queues a coalesced flush
    s.flushNow();  // immediate paint before the microtask ran
    expect(composites).toBe(1);

    q.drain();     // the queued flush now runs
    expect(composites).toBe(1); // still 1 — the pending flush was already satisfied
  });

  test('immediate paint then a later schedule still yields one more composite', () => {
    let composites = 0;
    const q = manualQueue();
    const s = createRenderScheduler(() => { composites++; }, q.schedule);

    s.flushNow(); // 1 (immediate)
    s.schedule(); // new state wants a paint -> queues a flush
    expect(composites).toBe(1);
    q.drain();
    expect(composites).toBe(2); // immediate + one coalesced follow-up
  });

  test('default scheduler defers to the real microtask queue', async () => {
    let composites = 0;
    const s = createRenderScheduler(() => { composites++; }); // real queueMicrotask

    s.schedule(); s.schedule(); s.schedule();
    expect(composites).toBe(0);   // deferred, not synchronous
    await Promise.resolve();      // drain microtasks
    expect(composites).toBe(1);   // burst collapsed to one
  });
});
