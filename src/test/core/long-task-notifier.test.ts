/**
 * Tests for src/core/long-task-notifier.ts
 *
 * Covers:
 * - Threshold gating (under / over / exactly at threshold)
 * - Off-state (thresholdSeconds === 0)
 * - Content privacy pin: message never includes conversation text
 * - Platform-absent fallback (notifyCompletion throws — must not propagate)
 * - Delivery-router path: webhookNotifier.send() called when URLs configured
 * - No notification when webhookNotifier has no URLs
 */

import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import {
  maybeNotifyLongTask,
  readNotifyAfterSeconds,
  NOTIFY_AFTER_SECONDS_DEFAULT,
  NOTIFY_AFTER_SECONDS_OFF,
} from '../../core/long-task-notifier.ts';
import { FocusTracker } from '../../core/focus-tracker.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake WebhookNotifier that captures send() calls and exposes getUrls(). */
function makeFakeNotifier(urls: string[] = []) {
  const sentMessages: string[] = [];
  const notifier = {
    getUrls: () => [...urls],
    send: mock(async (text: string) => {
      sentMessages.push(text);
      return {};
    }),
    _sentMessages: sentMessages,
  };
  return notifier;
}

/** A stub configGet that returns value for a given key, undefined otherwise. */
function makeConfigGet(overrides: Record<string, unknown> = {}) {
  return (key: string): unknown => overrides[key];
}

// ---------------------------------------------------------------------------
// maybeNotifyLongTask — threshold gating
// ---------------------------------------------------------------------------

describe('maybeNotifyLongTask — threshold gating', () => {
  test('returns false when elapsed < threshold (no notification)', () => {
    const result = maybeNotifyLongTask({
      elapsedMs: 30_000, // 30s
      status: 'ok',
      kind: 'turn',
      sessionId: 'sess-abc-123',
      thresholdSeconds: 60,
      webhookNotifier: null,
    });
    expect(result).toBe(false);
  });

  test('returns false when elapsed equals threshold rounded down (< threshold)', () => {
    // 59_999ms floors to 59s, which is < 60s threshold
    const result = maybeNotifyLongTask({
      elapsedMs: 59_999,
      status: 'ok',
      kind: 'turn',
      sessionId: 'sess-abc-123',
      thresholdSeconds: 60,
      webhookNotifier: null,
    });
    expect(result).toBe(false);
  });

  test('returns true when elapsed >= threshold (notification fires)', () => {
    const result = maybeNotifyLongTask({
      elapsedMs: 60_000, // exactly 60s
      status: 'ok',
      kind: 'turn',
      sessionId: 'sess-abc-123',
      thresholdSeconds: 60,
      webhookNotifier: null,
    });
    expect(result).toBe(true);
  });

  test('returns true when elapsed far exceeds threshold', () => {
    const result = maybeNotifyLongTask({
      elapsedMs: 300_000, // 5 minutes
      status: 'fail',
      kind: 'agent',
      sessionId: 'sess-abc-123',
      thresholdSeconds: 60,
      webhookNotifier: null,
    });
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// maybeNotifyLongTask — off-state
// ---------------------------------------------------------------------------

describe('maybeNotifyLongTask — off-state', () => {
  test('returns false when thresholdSeconds is 0 (off)', () => {
    const notifier = makeFakeNotifier(['https://ntfy.sh/my-topic']);
    const result = maybeNotifyLongTask({
      elapsedMs: 600_000, // 10 minutes
      status: 'ok',
      kind: 'turn',
      sessionId: 'sess-abc-123',
      thresholdSeconds: NOTIFY_AFTER_SECONDS_OFF,
      webhookNotifier: notifier as unknown as import('@pellux/goodvibes-sdk/platform/integrations').WebhookNotifier,
    });
    expect(result).toBe(false);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  test('NOTIFY_AFTER_SECONDS_OFF constant is 0', () => {
    expect(NOTIFY_AFTER_SECONDS_OFF).toBe(0);
  });

  test('NOTIFY_AFTER_SECONDS_DEFAULT constant is 60', () => {
    expect(NOTIFY_AFTER_SECONDS_DEFAULT).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// maybeNotifyLongTask — content privacy pin
// ---------------------------------------------------------------------------

describe('maybeNotifyLongTask — content privacy pin', () => {
  test('message built by maybeNotifyLongTask contains no conversation content', () => {
    // This test pins the contract: the notifier receives only structural
    // metadata. We verify this by confirming the sent text is derived
    // solely from kind, status, elapsed, and sessionId — nothing else
    // is passed into maybeNotifyLongTask, making it structurally impossible
    // to leak conversation content.
    //
    // Negative assertion: seed a distinctive conversation-text token into
    // the local scope and verify it never appears in the sent notification.
    const CONVERSATION_SENTINEL = 'PRIVATE_USER_CONTENT_xyzzy_7a3f9b';
    const notifier = makeFakeNotifier(['https://ntfy.sh/topic']);
    maybeNotifyLongTask({
      elapsedMs: 120_000,
      status: 'ok',
      kind: 'turn',
      sessionId: 'sess-cafebabe-1234',
      thresholdSeconds: 60,
      webhookNotifier: notifier as unknown as import('@pellux/goodvibes-sdk/platform/integrations').WebhookNotifier,
    });

    // The sent message must contain structural metadata only.
    // There is no conversation text in scope in this module.
    const sentText = notifier._sentMessages[0] ?? '';
    expect(sentText).toContain('turn');
    expect(sentText).toContain('120s');
    // sessionId is truncated to first 8 chars for brevity
    expect(sentText).toContain('sess-caf');
    // Must NOT be empty (it carried a real message)
    expect(sentText.length).toBeGreaterThan(10);
    // Negative assertion: the sentinel conversation text must never appear
    // in the notification. The function receives no message/conversation
    // parameter, so this is structurally guaranteed — but we pin it literally.
    expect(sentText).not.toContain(CONVERSATION_SENTINEL);
  });

  test('MaybeNotifyLongTaskOptions compile-time privacy: no message or conversation fields accepted', () => {
    // Compile-time pin: MaybeNotifyLongTaskOptions must not accept
    // message or conversation fields. If this test file compiles with
    // @ts-expect-error on these lines, the type is correctly locked.
    const notifier = makeFakeNotifier(['https://ntfy.sh/topic']);
    // @ts-expect-error — MaybeNotifyLongTaskOptions must not accept a 'message' field
    maybeNotifyLongTask({ elapsedMs: 60_000, status: 'ok', kind: 'turn', sessionId: 's', thresholdSeconds: 60, webhookNotifier: null, message: 'should not compile' });
    // @ts-expect-error — MaybeNotifyLongTaskOptions must not accept a 'conversation' field
    maybeNotifyLongTask({ elapsedMs: 60_000, status: 'ok', kind: 'turn', sessionId: 's', thresholdSeconds: 60, webhookNotifier: null, conversation: { messages: [] } });
    // Dummy reference to notifier so the variable is used and linting does not complain
    void notifier;
  });

  test('failed status appears in message', () => {
    const notifier = makeFakeNotifier(['https://ntfy.sh/topic']);
    maybeNotifyLongTask({
      elapsedMs: 90_000,
      status: 'fail',
      kind: 'agent',
      sessionId: 'sess-deadbeef-0000',
      thresholdSeconds: 60,
      webhookNotifier: notifier as unknown as import('@pellux/goodvibes-sdk/platform/integrations').WebhookNotifier,
    });
    const sentText = notifier._sentMessages[0] ?? '';
    expect(sentText).toContain('fail');
    expect(sentText).toContain('agent');
  });
});

// ---------------------------------------------------------------------------
// maybeNotifyLongTask — platform-absent fallback
// ---------------------------------------------------------------------------

describe('maybeNotifyLongTask — platform-absent fallback', () => {
  test('does not throw when desktop notification platform is absent', () => {
    // notifyCompletion is non-throwing by SDK contract. Even if an error
    // occurs inside, maybeNotifyLongTask wraps it in try/catch. Verify
    // that no error propagates to the caller.
    expect(() =>
      maybeNotifyLongTask({
        elapsedMs: 120_000,
        status: 'ok',
        kind: 'turn',
        sessionId: 'sess-abc',
        thresholdSeconds: 60,
        webhookNotifier: null,
      })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// maybeNotifyLongTask — delivery via webhookNotifier
// ---------------------------------------------------------------------------

describe('maybeNotifyLongTask — webhook delivery', () => {
  test('calls webhookNotifier.send() when URLs are configured and threshold exceeded', async () => {
    const notifier = makeFakeNotifier(['https://ntfy.sh/my-topic']);
    maybeNotifyLongTask({
      elapsedMs: 120_000,
      status: 'ok',
      kind: 'turn',
      sessionId: 'sess-abc-123',
      thresholdSeconds: 60,
      webhookNotifier: notifier as unknown as import('@pellux/goodvibes-sdk/platform/integrations').WebhookNotifier,
    });
    // send() is called synchronously (fire-and-forget promise); verify call count
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  test('does NOT call webhookNotifier.send() when below threshold', () => {
    const notifier = makeFakeNotifier(['https://ntfy.sh/my-topic']);
    maybeNotifyLongTask({
      elapsedMs: 30_000,
      status: 'ok',
      kind: 'turn',
      sessionId: 'sess-abc-123',
      thresholdSeconds: 60,
      webhookNotifier: notifier as unknown as import('@pellux/goodvibes-sdk/platform/integrations').WebhookNotifier,
    });
    expect(notifier.send).not.toHaveBeenCalled();
  });

  test('does NOT call webhookNotifier.send() when notifier has no URLs', () => {
    const notifier = makeFakeNotifier([]); // no URLs configured
    maybeNotifyLongTask({
      elapsedMs: 120_000,
      status: 'ok',
      kind: 'turn',
      sessionId: 'sess-abc-123',
      thresholdSeconds: 60,
      webhookNotifier: notifier as unknown as import('@pellux/goodvibes-sdk/platform/integrations').WebhookNotifier,
    });
    expect(notifier.send).not.toHaveBeenCalled();
  });

  test('does NOT throw when webhookNotifier.send() rejects', async () => {
    const notifier = makeFakeNotifier(['https://ntfy.sh/topic']);
    notifier.send = mock(async () => { throw new Error('network error'); });
    expect(() =>
      maybeNotifyLongTask({
        elapsedMs: 120_000,
        status: 'ok',
        kind: 'turn',
        sessionId: 'sess-abc-123',
        thresholdSeconds: 60,
        webhookNotifier: notifier as unknown as import('@pellux/goodvibes-sdk/platform/integrations').WebhookNotifier,
      })
    ).not.toThrow();
  });

  test('skips webhook delivery entirely when webhookNotifier is null', () => {
    // Should complete without error when notifier is null
    expect(() =>
      maybeNotifyLongTask({
        elapsedMs: 120_000,
        status: 'ok',
        kind: 'turn',
        sessionId: 'sess-abc-123',
        thresholdSeconds: 60,
        webhookNotifier: null,
      })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// maybeNotifyLongTask — focus gating (W2.3)
// ---------------------------------------------------------------------------

describe('maybeNotifyLongTask — focus gating (W2.3)', () => {
  test('fires when unfocused and both focusTracker + configGet are supplied', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const notifier = makeFakeNotifier(['https://ntfy.sh/topic']);
    const result = maybeNotifyLongTask({
      elapsedMs: 120_000,
      status: 'ok',
      kind: 'turn',
      sessionId: 'sess-abc-123',
      thresholdSeconds: 60,
      webhookNotifier: notifier as unknown as import('@pellux/goodvibes-sdk/platform/integrations').WebhookNotifier,
      focusTracker: tracker,
      configGet: makeConfigGet({}),
    });
    expect(result).toBe(true);
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  test('fires when focus was never observed (unknown)', () => {
    const tracker = new FocusTracker();
    const notifier = makeFakeNotifier(['https://ntfy.sh/topic']);
    const result = maybeNotifyLongTask({
      elapsedMs: 120_000,
      status: 'ok',
      kind: 'turn',
      sessionId: 'sess-abc-123',
      thresholdSeconds: 60,
      webhookNotifier: notifier as unknown as import('@pellux/goodvibes-sdk/platform/integrations').WebhookNotifier,
      focusTracker: tracker,
      configGet: makeConfigGet({}),
    });
    expect(result).toBe(true);
  });

  test('suppressed when focused and notifyOnlyWhenUnfocused defaults on', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(true);
    const notifier = makeFakeNotifier(['https://ntfy.sh/topic']);
    const result = maybeNotifyLongTask({
      elapsedMs: 120_000,
      status: 'ok',
      kind: 'turn',
      sessionId: 'sess-abc-123',
      thresholdSeconds: 60,
      webhookNotifier: notifier as unknown as import('@pellux/goodvibes-sdk/platform/integrations').WebhookNotifier,
      focusTracker: tracker,
      configGet: makeConfigGet({}),
    });
    expect(result).toBe(false);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  test('fires even when focused, when notifyOnlyWhenUnfocused is off', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(true);
    const notifier = makeFakeNotifier(['https://ntfy.sh/topic']);
    const result = maybeNotifyLongTask({
      elapsedMs: 120_000,
      status: 'ok',
      kind: 'turn',
      sessionId: 'sess-abc-123',
      thresholdSeconds: 60,
      webhookNotifier: notifier as unknown as import('@pellux/goodvibes-sdk/platform/integrations').WebhookNotifier,
      focusTracker: tracker,
      configGet: makeConfigGet({ 'behavior.notifyOnlyWhenUnfocused': false }),
    });
    expect(result).toBe(true);
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  test('pre-W2.3 behavior preserved: always fires when focusTracker/configGet are both omitted', () => {
    const notifier = makeFakeNotifier(['https://ntfy.sh/topic']);
    const result = maybeNotifyLongTask({
      elapsedMs: 120_000,
      status: 'ok',
      kind: 'turn',
      sessionId: 'sess-abc-123',
      thresholdSeconds: 60,
      webhookNotifier: notifier as unknown as import('@pellux/goodvibes-sdk/platform/integrations').WebhookNotifier,
    });
    expect(result).toBe(true);
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// readNotifyAfterSeconds
// ---------------------------------------------------------------------------

describe('readNotifyAfterSeconds', () => {
  test('returns NOTIFY_AFTER_SECONDS_DEFAULT when key is absent', () => {
    const result = readNotifyAfterSeconds(makeConfigGet({}));
    expect(result).toBe(NOTIFY_AFTER_SECONDS_DEFAULT);
  });

  test('returns 0 when key is explicitly set to 0 (off)', () => {
    const result = readNotifyAfterSeconds(makeConfigGet({ 'behavior.notifyAfterSeconds': 0 }));
    expect(result).toBe(0);
  });

  test('returns the configured value when valid', () => {
    const result = readNotifyAfterSeconds(makeConfigGet({ 'behavior.notifyAfterSeconds': 120 }));
    expect(result).toBe(120);
  });

  test('returns NOTIFY_AFTER_SECONDS_DEFAULT when value is negative', () => {
    const result = readNotifyAfterSeconds(makeConfigGet({ 'behavior.notifyAfterSeconds': -5 }));
    expect(result).toBe(NOTIFY_AFTER_SECONDS_DEFAULT);
  });

  test('returns NOTIFY_AFTER_SECONDS_DEFAULT when value is NaN', () => {
    const result = readNotifyAfterSeconds(makeConfigGet({ 'behavior.notifyAfterSeconds': NaN }));
    expect(result).toBe(NOTIFY_AFTER_SECONDS_DEFAULT);
  });

  test('returns NOTIFY_AFTER_SECONDS_DEFAULT when value is non-numeric string', () => {
    const result = readNotifyAfterSeconds(makeConfigGet({ 'behavior.notifyAfterSeconds': 'auto' }));
    expect(result).toBe(NOTIFY_AFTER_SECONDS_DEFAULT);
  });

  test('coerces numeric string to number', () => {
    const result = readNotifyAfterSeconds(makeConfigGet({ 'behavior.notifyAfterSeconds': '45' }));
    expect(result).toBe(45);
  });
});
