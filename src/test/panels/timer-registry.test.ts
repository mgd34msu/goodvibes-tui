// ---------------------------------------------------------------------------
// timer-registry.test.ts
//
// Contract tests for the BasePanel timer registry:
//   1. registerTimer returns the same id unchanged.
//   2. clearTimer stops the timer and removes it from the registry.
//   3. onDestroy clears all registered timers.
// ---------------------------------------------------------------------------

import { describe, test, expect, mock } from 'bun:test';
import { BasePanel } from '../../panels/base-panel.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';

// ---------------------------------------------------------------------------
// Minimal concrete subclass
// ---------------------------------------------------------------------------

class TestPanel extends BasePanel {
  constructor() {
    super('test', 'Test', 'T', 'agent');
  }

  render(_width: number, height: number): Line[] {
    return Array<Line>(height).fill([] as unknown as Line);
  }

  // Expose protected methods for testing
  exposeRegisterTimer<T extends ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>(id: T): T {
    return this.registerTimer(id);
  }

  exposeClearTimer(id: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
    this.clearTimer(id);
  }

  getTimerCount(): number {
    // Access private field via a trick: registerTimer adds, clearTimer removes.
    // We can verify indirectly: register a sentinel, check it appears in onDestroy.
    return (this as unknown as { _timers: Set<unknown> })._timers.size;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BasePanel timer registry', () => {
  test('registerTimer returns the same id', () => {
    const panel = new TestPanel();
    const id = setInterval(() => {}, 10_000);
    try {
      const returned = panel.exposeRegisterTimer(id);
      expect(returned).toBe(id);
    } finally {
      clearInterval(id);
    }
    panel.onDestroy();
  });

  test('registerTimer adds id to the registry', () => {
    const panel = new TestPanel();
    expect(panel.getTimerCount()).toBe(0);
    const id = setInterval(() => {}, 10_000);
    panel.exposeRegisterTimer(id);
    expect(panel.getTimerCount()).toBe(1);
    clearInterval(id);
    panel.onDestroy();
  });

  test('clearTimer removes the id from the registry', () => {
    const panel = new TestPanel();
    const id = setInterval(() => {}, 10_000);
    panel.exposeRegisterTimer(id);
    expect(panel.getTimerCount()).toBe(1);
    panel.exposeClearTimer(id);
    expect(panel.getTimerCount()).toBe(0);
    panel.onDestroy();
  });

  test('onDestroy clears all registered timers and empties the registry', async () => {
    const panel = new TestPanel();
    const ticks: number[] = [];

    // Use short real intervals (10ms) — no multi-second waits.
    const id1 = setInterval(() => { ticks.push(1); }, 10);
    const id2 = setInterval(() => { ticks.push(2); }, 10);

    panel.exposeRegisterTimer(id1);
    panel.exposeRegisterTimer(id2);
    expect(panel.getTimerCount()).toBe(2);

    // Let both fire at least once to confirm they're alive.
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(ticks.length).toBeGreaterThan(0);

    // onDestroy should clear both.
    panel.onDestroy();
    expect(panel.getTimerCount()).toBe(0);

    // After destroy, no further ticks should arrive.
    const countAfterDestroy = ticks.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(ticks.length).toBe(countAfterDestroy);
  });

  test('onDestroy is safe to call on a panel with no registered timers', () => {
    const panel = new TestPanel();
    expect(() => panel.onDestroy()).not.toThrow();
  });

  test('clearTimer is safe to call with an unregistered id', () => {
    const panel = new TestPanel();
    const id = setInterval(() => {}, 10_000);
    // Not registered — should not throw.
    expect(() => panel.exposeClearTimer(id)).not.toThrow();
    clearInterval(id); // clean up manually since it was never registered
    panel.onDestroy();
  });

  test('subclass onDestroy calling super clears registry', () => {
    class SubPanel extends TestPanel {
      override onDestroy(): void {
        super.onDestroy();
      }
    }
    const panel = new SubPanel();
    const id = setInterval(() => {}, 10_000);
    panel.exposeRegisterTimer(id);
    expect(panel.getTimerCount()).toBe(1);
    panel.onDestroy();
    expect(panel.getTimerCount()).toBe(0);
  });
});
