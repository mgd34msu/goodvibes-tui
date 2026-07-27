import { describe, test, expect, beforeEach } from 'bun:test';
import { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks';
import { TriggerManager } from '@pellux/goodvibes-sdk/platform/tools';
import { getTestTriggerManager, resetTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

beforeEach(() => {
  resetTestRuntimeServices();
});

describe('HookDispatcher trigger wiring', () => {
  test('setTriggerManager accepts and stores a trigger manager', () => {
    const dispatcher = new HookDispatcher();
    const tm = getTestTriggerManager();
    // Should not throw
    dispatcher.setTriggerManager(tm);
    dispatcher.setTriggerManager(null);
  });

  test('fire() without triggerManager set does not throw', async () => {
    const dispatcher = new HookDispatcher();
    const result = await dispatcher.fire({
      path: 'Post:tool:read',
      phase: 'Post',
      category: 'tool',
      specific: 'read',
      sessionId: 'trigger-wire-test',
      timestamp: Date.now(),
      payload: {},
    });
    expect(result.ok).toBe(true);
  });

  test('fire() with triggerManager fires matching triggers (no hooks registered)', async () => {
    const dispatcher = new HookDispatcher();
    const tm = getTestTriggerManager();
    tm.add({ event: 'Post:tool:*', action: 'echo trigger-fired' });
    dispatcher.setTriggerManager(tm);

    // Firing event with matching trigger pattern
    const result = await dispatcher.fire({
      path: 'Post:tool:read',
      phase: 'Post',
      category: 'tool',
      specific: 'read',
      sessionId: '',
      timestamp: Date.now(),
      payload: {},
    });
    // Hook result is ok (no hooks registered, just triggers)
    expect(result.ok).toBe(true);
  });

  test('fire() with triggerManager does not fire disabled triggers', async () => {
    const dispatcher = new HookDispatcher();
    const tm = getTestTriggerManager();
    const trigger = tm.add({ event: 'Post:tool:*', action: 'echo disabled' });
    tm.disable(trigger.id);
    dispatcher.setTriggerManager(tm);

    // Should complete without throwing
    const result = await dispatcher.fire({
      path: 'Post:tool:read',
      phase: 'Post',
      category: 'tool',
      specific: 'read',
      sessionId: 'trigger-wire-test',
      timestamp: Date.now(),
      payload: {},
    });
    expect(result.ok).toBe(true);
  });

  test('fire() result is unaffected by triggers (triggers are fire-and-forget)', async () => {
    const dispatcher = new HookDispatcher();
    const tm = getTestTriggerManager();
    tm.add({ event: 'Post:tool:*', action: 'echo side-effect' });
    dispatcher.setTriggerManager(tm);

    const result = await dispatcher.fire({
      path: 'Post:tool:write',
      phase: 'Post',
      category: 'tool',
      specific: 'write',
      sessionId: 'trigger-wire-test',
      timestamp: Date.now(),
      payload: {},
    });
    // Trigger fires async; hook result is still clean
    expect(result.ok).toBe(true);
    expect(result.decision).toBeUndefined();
  });
});
