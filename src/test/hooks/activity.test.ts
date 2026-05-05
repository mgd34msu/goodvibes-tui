import { describe, expect, test } from 'bun:test';
import { HookActivityTracker } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookEvent } from '@pellux/goodvibes-sdk/platform/hooks';

function makeEvent(): HookEvent {
  return {
    path: 'Pre:tool:read',
    phase: 'Pre',
    category: 'tool',
    specific: 'read',
    sessionId: 'test-session',
    timestamp: Date.now(),
    payload: {},
  };
}

describe('HookActivityTracker', () => {
  test('records recent hook runs', () => {
    const tracker = new HookActivityTracker();
    tracker.record(makeEvent(), {
      pattern: 'Pre:tool:*',
      hookName: 'guard-read',
      hookType: 'command',
      result: { ok: true, decision: 'allow' },
      durationMs: 12,
      async: false,
    });

    const recent = tracker.listRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]?.hookName).toBe('guard-read');
    expect(recent[0]?.decision).toBe('allow');
  });
});
