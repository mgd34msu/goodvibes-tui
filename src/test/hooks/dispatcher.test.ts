import { describe, test, expect, beforeEach } from 'bun:test';
import { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookDefinition, HookEvent, HookResult } from '@pellux/goodvibes-sdk/platform/hooks';

/** Helper to create a minimal HookEvent */
function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    path: 'Pre:tool:read',
    phase: 'Pre',
    category: 'tool',
    specific: 'read',
    sessionId: 'test-session',
    timestamp: Date.now(),
    payload: {},
    ...overrides,
  };
}


describe('HookDispatcher', () => {
  let dispatcher: HookDispatcher;

  beforeEach(() => {
    dispatcher = new HookDispatcher();
  });

  describe('registration', () => {
    test('register() adds hook to pattern', () => {
      const hook: HookDefinition = { match: 'Pre:tool:read', type: 'command', command: 'echo ok' };
      dispatcher.register('Pre:tool:read', hook);
      const hooks = dispatcher.getHooks();
      expect(hooks.has('Pre:tool:read')).toBe(true);
      expect(hooks.get('Pre:tool:read')).toHaveLength(1);
    });

    test('register() multiple hooks on same pattern', () => {
      const h1: HookDefinition = { match: 'Pre:tool:read', type: 'command', command: 'echo 1' };
      const h2: HookDefinition = { match: 'Pre:tool:read', type: 'command', command: 'echo 2' };
      dispatcher.register('Pre:tool:read', h1);
      dispatcher.register('Pre:tool:read', h2);
      expect(dispatcher.getHooks().get('Pre:tool:read')).toHaveLength(2);
    });

    test('registerChain() adds chain', () => {
      dispatcher.registerChain({
        name: 'test-chain',
        steps: [{ match: 'Pre:tool:*' }],
        action: { match: 'Post:tool:read', type: 'command', command: 'echo done' },
      });
      expect(dispatcher.getChains()).toHaveLength(1);
      expect(dispatcher.getChains()[0].name).toBe('test-chain');
    });

    test('clear() removes all hooks and chains', () => {
      dispatcher.register('Pre:tool:read', { match: 'Pre:tool:read', type: 'command', command: 'echo ok' });
      dispatcher.registerChain({
        name: 'c',
        steps: [{ match: 'Pre:tool:*' }],
        action: { match: 'Post:tool:read', type: 'command', command: 'echo done' },
      });
      dispatcher.clear();
      expect(dispatcher.getHooks().size).toBe(0);
      expect(dispatcher.getChains()).toHaveLength(0);
    });
  });

  describe('fire() — no hooks', () => {
    test('returns ok:true when no hooks match', async () => {
      const result = await dispatcher.fire(makeEvent());
      expect(result.ok).toBe(true);
    });
  });

  describe('fire() — command hooks', () => {
    test('runs matching hook and returns ok', async () => {
      dispatcher.register('Pre:tool:*', {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'echo \'{"ok":true}\'',
      });
      const result = await dispatcher.fire(makeEvent());
      expect(result.ok).toBe(true);
    });

    test('non-matching pattern does not run hook', async () => {
      dispatcher.register('Post:tool:*', {
        match: 'Post:tool:*',
        type: 'command',
        command: 'exit 1',  // would fail if run
      });
      // Fire a Pre event — should not match Post pattern
      const result = await dispatcher.fire(makeEvent({ phase: 'Pre', path: 'Pre:tool:read' }));
      expect(result.ok).toBe(true);
    });

    test('hook that returns deny causes aggregated deny', async () => {
      dispatcher.register('Pre:tool:*', {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'echo \'{"ok":true,"decision":"deny","reason":"not allowed"}\'',
      });
      const result = await dispatcher.fire(makeEvent({ phase: 'Pre' }));
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('not allowed');
    });

    test('first deny wins when multiple hooks run', async () => {
      dispatcher.register('Pre:tool:*', {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'echo \'{"ok":true,"decision":"deny","reason":"first"}\'',
      });
      dispatcher.register('Pre:tool:*', {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'echo \'{"ok":true,"decision":"deny","reason":"second"}\'',
      });
      const result = await dispatcher.fire(makeEvent({ phase: 'Pre' }));
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('first');
    });

    test('updatedInput: last modification wins', async () => {
      dispatcher.register('Pre:tool:*', {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'echo \'{"ok":true,"updatedInput":{"x":1}}\'',
      });
      dispatcher.register('Pre:tool:*', {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'echo \'{"ok":true,"updatedInput":{"x":2}}\'',
      });
      const result = await dispatcher.fire(makeEvent({ phase: 'Pre' }));
      expect(result.updatedInput).toEqual({ x: 2 });
    });

    test('additionalContext strings are concatenated', async () => {
      dispatcher.register('Pre:tool:*', {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'echo \'{"ok":true,"additionalContext":"ctx1"}\'',
      });
      dispatcher.register('Pre:tool:*', {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'echo \'{"ok":true,"additionalContext":"ctx2"}\'',
      });
      const result = await dispatcher.fire(makeEvent());
      expect(result.additionalContext).toContain('ctx1');
      expect(result.additionalContext).toContain('ctx2');
    });
  });

  describe('once hooks', () => {
    test('once hook fires once then is removed', async () => {
      let runCount = 0;
      const hook: HookDefinition = {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'echo \'{"ok":true}\'',
        once: true,
      };
      dispatcher.register('Pre:tool:*', hook);

      await dispatcher.fire(makeEvent());
      // After first fire the hook should be removed
      const hooksAfter = dispatcher.getHooks();
      const remaining = hooksAfter.get('Pre:tool:*') ?? [];
      expect(remaining).toHaveLength(0);
    });

    test('non-once hook persists after multiple fires', async () => {
      dispatcher.register('Pre:tool:*', {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'echo \'{"ok":true}\'',
      });
      await dispatcher.fire(makeEvent());
      await dispatcher.fire(makeEvent());
      expect(dispatcher.getHooks().get('Pre:tool:*')).toHaveLength(1);
    });
  });

  describe('async hooks', () => {
    test('async hook does not block and returns ok immediately', async () => {
      dispatcher.register('Pre:tool:*', {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'sleep 10',  // would block if awaited
        async: true,
      });
      const start = Date.now();
      const result = await dispatcher.fire(makeEvent());
      const elapsed = Date.now() - start;
      // Should complete almost instantly (< 500ms)
      expect(elapsed).toBeLessThan(500);
      expect(result.ok).toBe(true);
    });
  });

  describe('matcher filtering', () => {
    test('hook with matcher only fires for matching specific', async () => {
      dispatcher.register('Pre:tool:*', {
        match: 'Pre:tool:*',
        matcher: 'read',
        type: 'command',
        command: 'echo \'{"ok":true,"additionalContext":"read-hook"}\'',
      });
      // Fire with specific=read — should match
      const r1 = await dispatcher.fire(makeEvent({ specific: 'read' }));
      expect(r1.additionalContext).toBe('read-hook');

      // Fire with specific=write — should not match
      const r2 = await dispatcher.fire(makeEvent({ path: 'Pre:tool:write', specific: 'write' }));
      expect(r2.additionalContext).toBeUndefined();
    });
  });

  describe('Post/Fail hooks', () => {
    test('Post hook fires for Post events', async () => {
      dispatcher.register('Post:tool:*', {
        match: 'Post:tool:*',
        type: 'command',
        command: 'echo \'{"ok":true,"additionalContext":"post-ctx"}\'',
      });
      const result = await dispatcher.fire(makeEvent({
        path: 'Post:tool:read',
        phase: 'Post',
        specific: 'read',
      }));
      expect(result.additionalContext).toBe('post-ctx');
    });

    test('Fail hook fires for Fail events', async () => {
      dispatcher.register('Fail:tool:*', {
        match: 'Fail:tool:*',
        type: 'command',
        command: 'echo \'{"ok":true,"additionalContext":"fail-ctx"}\'',
      });
      const result = await dispatcher.fire(makeEvent({
        path: 'Fail:tool:exec',
        phase: 'Fail',
        specific: 'exec',
      }));
      expect(result.additionalContext).toBe('fail-ctx');
    });

    test('Post hook cannot force a deny decision through the contract layer', async () => {
      dispatcher.register('Post:tool:*', {
        match: 'Post:tool:*',
        type: 'command',
        command: 'echo \'{"ok":true,"decision":"deny","reason":"should-be-ignored"}\'',
      });
      const result = await dispatcher.fire(makeEvent({
        path: 'Post:tool:read',
        phase: 'Post',
        specific: 'read',
      }));
      expect(result.decision).not.toBe('deny');
    });
  });
});
