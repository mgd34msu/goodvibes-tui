// ---------------------------------------------------------------------------
// retry-affordance.test.ts
//
// Covers the one-key retry/switch-model affordance's lifecycle: it renders
// as a transient hint only while armed and disappears the instant it's
// disarmed (never a permanent transcript message), and 'm' is gated on
// armed exactly like 'r', pressing 'm' before any error surfaced (or after
// the affordance already disarmed) must not open the model picker.
//
// Also covers the disarm timer: arming starts a real time bound (60s in
// production, injectable here) so a stray keypress hours after the error
// can never fire a retry. The timer must disarm the state AND null out the
// hint at the same moment, a keypress before the timer still disarms and
// cancels the pending timer, and re-arming after a new error restarts the
// window rather than reusing the old one.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import {
  armRetryAffordance,
  createRetryAffordanceState,
  disarmRetryAffordance,
  retryAffordanceHint,
  wireRetryAffordanceOnError,
  type RetryAffordanceSchedule,
} from '../../shell/retry-affordance.ts';
import { handleErrorAffordanceKey } from '../../shell/recovery-input-helpers.ts';

/**
 * A deterministic stand-in for setTimeout/clearTimeout: tests fire the timer
 * on demand (fireAll) instead of waiting out the real 60s window, and can
 * inspect how many timers are still pending to confirm cancellation.
 */
function makeFakeSchedule(): RetryAffordanceSchedule & { fireAll: () => void; pendingCount: () => number } {
  let nextId = 0;
  const pending = new Map<number, () => void>();
  return {
    setTimeout: (cb) => {
      const id = ++nextId;
      pending.set(id, cb);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as unknown as number);
    },
    fireAll: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const cb of callbacks) cb();
    },
    pendingCount: () => pending.size,
  };
}

describe('retry affordance lifecycle', () => {
  test('starts disarmed with no hint', () => {
    const state = createRetryAffordanceState();
    expect(state.armed).toBe(false);
    expect(retryAffordanceHint(state)).toBeNull();
  });

  test('arming produces a visible, time-bounded hint', () => {
    const state = createRetryAffordanceState();
    armRetryAffordance(state, false);
    expect(retryAffordanceHint(state)).toBe('[Retry] r retry · m switch model');
    // Arming with the REAL schedule starts a 60s disarm timer; the assertion is
    // about the hint, so hand the timer back rather than leaving it pending.
    disarmRetryAffordance(state);
  });

  test('arming with exhausted=true uses the same-provider wording', () => {
    const state = createRetryAffordanceState();
    armRetryAffordance(state, true);
    expect(retryAffordanceHint(state)).toBe('[Retry] r retry same provider · m switch model');
    disarmRetryAffordance(state);
  });

  test('disarming removes the hint entirely; never lingers', () => {
    const state = createRetryAffordanceState();
    armRetryAffordance(state, false);
    expect(retryAffordanceHint(state)).not.toBeNull();
    disarmRetryAffordance(state);
    expect(retryAffordanceHint(state)).toBeNull();
    expect(state.armed).toBe(false);
  });

  test('the disarm timer firing disarms the state and makes the hint null', () => {
    const schedule = makeFakeSchedule();
    let expired = 0;
    const state = createRetryAffordanceState({ schedule, onExpire: () => { expired++; } });
    armRetryAffordance(state, false);
    expect(state.armed).toBe(true);
    expect(schedule.pendingCount()).toBe(1);

    schedule.fireAll();

    expect(state.armed).toBe(false);
    expect(retryAffordanceHint(state)).toBeNull();
    expect(expired).toBe(1);
  });

  test('a keypress (disarm) before the timer fires cancels the pending timer', () => {
    const schedule = makeFakeSchedule();
    let expired = 0;
    const state = createRetryAffordanceState({ schedule, onExpire: () => { expired++; } });
    armRetryAffordance(state, false);
    expect(schedule.pendingCount()).toBe(1);

    disarmRetryAffordance(state);
    expect(state.armed).toBe(false);
    expect(schedule.pendingCount()).toBe(0);

    // Firing whatever is left over must not resurrect the affordance or call onExpire,
    // the timer was actually cancelled, not just superseded.
    schedule.fireAll();
    expect(state.armed).toBe(false);
    expect(expired).toBe(0);
  });

  test('re-arming after a new error restarts the disarm window rather than reusing the old one', () => {
    const schedule = makeFakeSchedule();
    const state = createRetryAffordanceState({ schedule });
    armRetryAffordance(state, false);
    expect(schedule.pendingCount()).toBe(1);

    armRetryAffordance(state, true);
    // The first timer must have been cancelled, not left running alongside the new one.
    expect(schedule.pendingCount()).toBe(1);
    expect(state.armed).toBe(true);
    expect(state.exhausted).toBe(true);

    schedule.fireAll();
    expect(state.armed).toBe(false);
  });

  test('default window is 60s and uses real setTimeout/clearTimeout when no schedule is injected', () => {
    const state = createRetryAffordanceState();
    armRetryAffordance(state, false);
    expect(state.windowMs).toBe(60_000);
    expect(state.timer).not.toBeNull();
    disarmRetryAffordance(state);
    expect(state.timer).toBeNull();
  });

  test('wireRetryAffordanceOnError only arms when a retry is actually possible (hasRetryCtx)', () => {
    const state = createRetryAffordanceState();
    let handler: ((exhausted: boolean) => void) | null = null;
    let renderCount = 0;
    wireRetryAffordanceOnError(
      (cb) => { handler = cb; },
      state,
      () => false, // no retryCtx
      () => { renderCount++; },
    );
    handler!(false);
    expect(state.armed).toBe(false);
    expect(renderCount).toBe(0);
  });

  test('wireRetryAffordanceOnError arms and triggers a render when a retry is possible', () => {
    const state = createRetryAffordanceState();
    let handler: ((exhausted: boolean) => void) | null = null;
    let renderCount = 0;
    wireRetryAffordanceOnError(
      (cb) => { handler = cb; },
      state,
      () => true,
      () => { renderCount++; },
    );
    handler!(true);
    expect(state.armed).toBe(true);
    expect(state.exhausted).toBe(true);
    expect(renderCount).toBe(1);
    disarmRetryAffordance(state);
  });
});

describe('handleErrorAffordanceKey: both r and m gated on armed', () => {
  test('r retries when armed', () => {
    let retried = 0;
    let rendered = 0;
    const handled = handleErrorAffordanceKey('r', {
      retryArmed: true,
      retry: () => { retried++; },
      openModelPicker: () => {},
      render: () => { rendered++; },
    });
    expect(handled).toBe(true);
    expect(retried).toBe(1);
    expect(rendered).toBe(1);
  });

  test('r does nothing when unarmed; falls through as normal input', () => {
    let retried = 0;
    const handled = handleErrorAffordanceKey('r', {
      retryArmed: false,
      retry: () => { retried++; },
      openModelPicker: () => {},
      render: () => {},
    });
    expect(handled).toBe(false);
    expect(retried).toBe(0);
  });

  test('m opens the model picker when armed', () => {
    let opened = 0;
    const handled = handleErrorAffordanceKey('m', {
      retryArmed: true,
      retry: () => {},
      openModelPicker: () => { opened++; },
      render: () => {},
    });
    expect(handled).toBe(true);
    expect(opened).toBe(1);
  });

  test('m does NOT open the model picker when unarmed (the bug this fixes)', () => {
    let opened = 0;
    const handled = handleErrorAffordanceKey('m', {
      retryArmed: false,
      retry: () => {},
      openModelPicker: () => { opened++; },
      render: () => {},
    });
    expect(handled).toBe(false);
    expect(opened).toBe(0);
  });

  test('any other key is never consumed, armed or not', () => {
    expect(handleErrorAffordanceKey('x', { retryArmed: true, retry: () => {}, openModelPicker: () => {}, render: () => {} })).toBe(false);
    expect(handleErrorAffordanceKey('x', { retryArmed: false, retry: () => {}, openModelPicker: () => {}, render: () => {} })).toBe(false);
  });
});
