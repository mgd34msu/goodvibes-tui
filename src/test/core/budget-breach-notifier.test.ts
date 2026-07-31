/**
 * Tests for src/core/budget-breach-notifier.ts
 *
 * Covers:
 * - one-shot semantics: fires exactly once per crossing, never re-fires while
 *   still over budget on subsequent checks
 * - re-arms when the session drops back under budget then breaches again
 * - re-arms when the threshold itself changes
 * - disabled (threshold <= 0) never fires
 * - unpriced model never fires (cost would be a placeholder, not real)
 * - focus/config gating is respected (delegates to alert-gating.ts)
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { createBudgetBreachNotifier } from '../../core/budget-breach-notifier.ts';
import { setPricingSource } from '@pellux/goodvibes-sdk/platform/providers';
import { FocusTracker } from '@pellux/goodvibes-sdk/platform/runtime/operations';

// A model with a known, real price so calcSessionCost produces a real breach.
const PRICED_MODEL = 'claude-sonnet-4-6'; // present in cost-utils.ts STATIC_FALLBACK_PRICING

function makeSpyNotifier(urls: string[] = ['https://ntfy.sh/topic']) {
  const sent: string[] = [];
  return {
    getUrls: () => [...urls],
    send: mock(async (text: string) => { sent.push(text); return {}; }),
    _sent: sent,
  } as unknown as import('@pellux/goodvibes-sdk/platform/integrations').WebhookNotifier & { _sent: string[] };
}

function makeConfigGet(overrides: Record<string, unknown> = {}) {
  return (key: string): unknown => overrides[key];
}

describe('budget-breach-notifier', () => {
  afterEach(() => {
    setPricingSource(null);
  });

  test('fires exactly once on the false->true crossing, not again while still over budget', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false); // unfocused — alert allowed
    const notifier = makeSpyNotifier();
    const checker = createBudgetBreachNotifier({
      focusTracker: tracker,
      configGet: makeConfigGet({}),
      webhookNotifier: notifier,
      sessionId: 'sess-abc-123',
    });

    // Under budget: input tokens produce $0 cost at 0 usage; use small usage under $1 threshold.
    const under = { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(checker.check(under, PRICED_MODEL, 1)).toBe(false);

    // Cross into breach.
    const over = { input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(checker.check(over, PRICED_MODEL, 1)).toBe(true);
    expect(notifier.send).toHaveBeenCalledTimes(1);

    // Still over budget on the next check — must not re-fire.
    expect(checker.check(over, PRICED_MODEL, 1)).toBe(false);
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  test('re-arms after dropping back under budget, fires again on a second crossing', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const notifier = makeSpyNotifier();
    const checker = createBudgetBreachNotifier({
      focusTracker: tracker,
      configGet: makeConfigGet({}),
      webhookNotifier: notifier,
      sessionId: 'sess-abc-123',
    });

    const over = { input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    const under = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    expect(checker.check(over, PRICED_MODEL, 1)).toBe(true);
    expect(checker.check(under, PRICED_MODEL, 1)).toBe(false); // dropped back under (re-arms)
    expect(checker.check(over, PRICED_MODEL, 1)).toBe(true); // breaches again — fires again
    expect(notifier.send).toHaveBeenCalledTimes(2);
  });

  test('re-arms when the threshold changes, even while still over the old one', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const notifier = makeSpyNotifier();
    const checker = createBudgetBreachNotifier({
      focusTracker: tracker,
      configGet: makeConfigGet({}),
      webhookNotifier: notifier,
      sessionId: 'sess-abc-123',
    });

    const usage = { input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(checker.check(usage, PRICED_MODEL, 1)).toBe(true);
    expect(checker.check(usage, PRICED_MODEL, 1)).toBe(false); // same threshold, already notified

    // Raise the threshold from $1 to $20 — session cost is $30 (10M input
    // tokens * $3/1M for claude-sonnet-4-6), so it's still breached against
    // the new, higher threshold. The latch re-arms on the threshold change
    // and fires once more even though it was already breached before.
    expect(checker.check(usage, PRICED_MODEL, 20)).toBe(true);
    expect(notifier.send).toHaveBeenCalledTimes(2);
  });

  test('never fires when the threshold is disabled (<= 0)', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const notifier = makeSpyNotifier();
    const checker = createBudgetBreachNotifier({
      focusTracker: tracker,
      configGet: makeConfigGet({}),
      webhookNotifier: notifier,
      sessionId: 'sess-abc-123',
    });
    const usage = { input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(checker.check(usage, PRICED_MODEL, 0)).toBe(false);
    expect(checker.check(usage, PRICED_MODEL, -5)).toBe(false);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  test('never fires for an unpriced model, even with huge usage', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const notifier = makeSpyNotifier();
    const checker = createBudgetBreachNotifier({
      focusTracker: tracker,
      configGet: makeConfigGet({}),
      webhookNotifier: notifier,
      sessionId: 'sess-abc-123',
    });
    const usage = { input: 10_000_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(checker.check(usage, 'totally-unknown-model-xyz', 1)).toBe(false);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  test('suppressed when the terminal is focused (default gating)', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(true); // focused — alert suppressed by default
    const notifier = makeSpyNotifier();
    const checker = createBudgetBreachNotifier({
      focusTracker: tracker,
      configGet: makeConfigGet({}),
      webhookNotifier: notifier,
      sessionId: 'sess-abc-123',
    });
    const usage = { input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    // check() itself still returns true (a breach occurred and the latch
    // fires) — the gate lives inside fireBudgetBreachAlert's delivery path.
    expect(checker.check(usage, PRICED_MODEL, 1)).toBe(true);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  test('never throws when webhookNotifier is null', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const checker = createBudgetBreachNotifier({
      focusTracker: tracker,
      configGet: makeConfigGet({}),
      webhookNotifier: null,
      sessionId: 'sess-abc-123',
    });
    const usage = { input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(() => checker.check(usage, PRICED_MODEL, 1)).not.toThrow();
  });
});
