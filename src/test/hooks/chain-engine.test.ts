import { describe, test, expect, beforeEach } from 'bun:test';
import { HookDispatcher } from '../../hooks/dispatcher.ts';
import { ChainEngine } from '../../hooks/chain-engine.ts';
import type { HookChain, HookEvent } from '@pellux/goodvibes-sdk/platform/hooks/types';

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    path: 'Pre:tool:read',
    phase: 'Pre',
    category: 'tool',
    specific: 'read',
    sessionId: 'test',
    timestamp: Date.now(),
    payload: {},
    ...overrides,
  };
}

describe('ChainEngine', () => {
  let dispatcher: HookDispatcher;
  let engine: ChainEngine;

  beforeEach(() => {
    dispatcher = new HookDispatcher();
    engine = new ChainEngine(dispatcher);
  });

  describe('register / getStates', () => {
    test('register initializes chain state at step 0', () => {
      engine.register({
        name: 'chain-a',
        steps: [{ match: 'Pre:tool:*' }],
        action: { match: 'Post:tool:done', type: 'command', command: 'echo done' },
      });
      const states = engine.getStates();
      expect(states.has('chain-a')).toBe(true);
      expect(states.get('chain-a')!.currentStep).toBe(0);
      expect(states.get('chain-a')!.captures).toEqual({});
    });
  });

  describe('step advancement', () => {
    test('matching event advances chain step', async () => {
      engine.register({
        name: 'two-step',
        steps: [
          { match: 'Pre:tool:*' },
          { match: 'Post:tool:*' },
        ],
        action: { match: 'Lifecycle:session:done', type: 'command', command: 'echo done' },
      });

      await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
      expect(engine.getStates().get('two-step')!.currentStep).toBe(1);
    });

    test('non-matching event does not advance', async () => {
      engine.register({
        name: 'step-check',
        steps: [{ match: 'Pre:tool:*' }],
        action: { match: 'Post:tool:done', type: 'command', command: 'echo done' },
      });
      await engine.evaluate(makeEvent({ path: 'Post:tool:read', phase: 'Post' }));
      expect(engine.getStates().get('step-check')!.currentStep).toBe(0);
    });

    test('chain fires action when all steps complete', async () => {
      const received: string[] = [];
      // Register a command hook on the action event to capture when it fires
      dispatcher.register('Lifecycle:session:done', {
        match: 'Lifecycle:session:done',
        type: 'command',
        command: 'echo \'{"ok":true,"additionalContext":"chain-fired"}\'',
      });

      engine.register({
        name: 'fire-chain',
        steps: [{ match: 'Pre:tool:*' }],
        action: { match: 'Lifecycle:session:done', type: 'command', command: 'echo done' },
      });

      const result = await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(true);
    });

    test('chain resets after firing', async () => {
      engine.register({
        name: 'reset-chain',
        steps: [{ match: 'Pre:tool:*' }],
        action: { match: 'Post:tool:done', type: 'command', command: 'echo done' },
      });

      await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
      // After firing, step should be back to 0
      expect(engine.getStates().get('reset-chain')!.currentStep).toBe(0);
    });
  });

  describe('capture variables', () => {
    test('captures payload value into named variable', async () => {
      engine.register({
        name: 'capture-chain',
        steps: [
          { match: 'Pre:tool:*', capture: { toolName: 'tool' } },
          { match: 'Post:tool:*' },
        ],
        action: { match: 'Lifecycle:session:done', type: 'command', command: 'echo done' },
      });

      await engine.evaluate(makeEvent({
        path: 'Pre:tool:read',
        phase: 'Pre',
        payload: { tool: 'read', path: '/tmp/x' },
      }));

      const state = engine.getStates().get('capture-chain')!;
      expect(state.captures.toolName).toBe('read');
    });

    test('capture does not fail when payload key missing', async () => {
      engine.register({
        name: 'cap-missing',
        steps: [
          { match: 'Pre:tool:*', capture: { myVar: 'nonexistent' } },
          { match: 'Post:tool:*' },
        ],
        action: { match: 'Lifecycle:session:done', type: 'command', command: 'echo done' },
      });

      await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre', payload: {} }));
      const state = engine.getStates().get('cap-missing')!;
      expect(state.captures.myVar).toBeUndefined();
    });
  });

  describe('condition evaluation', () => {
    test('step with truthy condition advances', async () => {
      engine.register({
        name: 'cond-true',
        steps: [{ match: 'Pre:tool:*', condition: 'true' }],
        action: { match: 'Post:tool:done', type: 'command', command: 'echo done' },
      });
      await engine.evaluate(makeEvent());
      expect(engine.getStates().get('cond-true')!.currentStep).toBe(0);
      // step advanced and chain fired (only 1 step), so it resets
    });

    test('step with falsy condition does not advance', async () => {
      engine.register({
        name: 'cond-false',
        steps: [{ match: 'Pre:tool:*', condition: 'false' }],
        action: { match: 'Post:tool:done', type: 'command', command: 'echo done' },
      });
      await engine.evaluate(makeEvent());
      expect(engine.getStates().get('cond-false')!.currentStep).toBe(0);
    });

    test('condition can access payload fields', async () => {
      engine.register({
        name: 'cond-payload',
        steps: [{ match: 'Pre:tool:*', condition: 'count > 5' }],
        action: { match: 'Post:tool:done', type: 'command', command: 'echo done' },
      });
      // Payload with count <= 5 should not advance
      await engine.evaluate(makeEvent({ payload: { count: 3 } }));
      expect(engine.getStates().get('cond-payload')!.currentStep).toBe(0);

      // Payload with count > 5 should advance
      await engine.evaluate(makeEvent({ payload: { count: 10 } }));
      // After advancing (chain fires since 1 step), resets to 0
      expect(engine.getStates().get('cond-payload')!.currentStep).toBe(0);
    });

    test('invalid condition does not crash, step not advanced', async () => {
      engine.register({
        name: 'cond-bad',
        steps: [{ match: 'Pre:tool:*', condition: 'this is not valid js ###' }],
        action: { match: 'Post:tool:done', type: 'command', command: 'echo done' },
      });
      // Should not throw
      await expect(engine.evaluate(makeEvent())).resolves.toBeNull();
      expect(engine.getStates().get('cond-bad')!.currentStep).toBe(0);
    });
  });

  describe('within timeout', () => {
    test('chain resets when within timeout exceeded', async () => {
      engine.register({
        name: 'within-chain',
        steps: [
          { match: 'Pre:tool:*', within: '1ms' },
          { match: 'Post:tool:*' },
        ],
        action: { match: 'Lifecycle:session:done', type: 'command', command: 'echo done' },
      });

      // Advance step 1
      await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
      expect(engine.getStates().get('within-chain')!.currentStep).toBe(1);

      // Wait longer than 1ms
      await new Promise(r => setTimeout(r, 10));

      // Next event should see the within timeout, reset, then try step 0 again with the same event
      await engine.evaluate(makeEvent({ path: 'Post:tool:read', phase: 'Post' }));
      // Step 0 is 'Pre:tool:*', the Post event doesn't match it, so stays at 0
      expect(engine.getStates().get('within-chain')!.currentStep).toBe(0);
    });
  });

  describe('reset', () => {
    test('reset() resets a specific chain to step 0', async () => {
      engine.register({
        name: 'reset-me',
        steps: [{ match: 'Pre:tool:*' }, { match: 'Post:tool:*' }],
        action: { match: 'Post:tool:done', type: 'command', command: 'echo done' },
      });
      await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
      expect(engine.getStates().get('reset-me')!.currentStep).toBe(1);
      engine.reset('reset-me');
      expect(engine.getStates().get('reset-me')!.currentStep).toBe(0);
    });

    test('resetAll() resets all chains', async () => {
      engine.register({
        name: 'chain-1',
        steps: [{ match: 'Pre:tool:*' }, { match: 'Post:tool:*' }],
        action: { match: 'Post:tool:done', type: 'command', command: 'echo done' },
      });
      engine.register({
        name: 'chain-2',
        steps: [{ match: 'Pre:tool:*' }, { match: 'Post:tool:*' }],
        action: { match: 'Post:tool:done', type: 'command', command: 'echo done' },
      });
      await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
      engine.resetAll();
      expect(engine.getStates().get('chain-1')!.currentStep).toBe(0);
      expect(engine.getStates().get('chain-2')!.currentStep).toBe(0);
    });
  });

  describe('evaluate returns null when no chain fires', () => {
    test('returns null when no chains registered', async () => {
      const result = await engine.evaluate(makeEvent());
      expect(result).toBeNull();
    });

    test('returns null when chains do not match', async () => {
      engine.register({
        name: 'no-match',
        steps: [{ match: 'Fail:tool:*' }],
        action: { match: 'Post:tool:done', type: 'command', command: 'echo done' },
      });
      const result = await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
      expect(result).toBeNull();
    });
  });
});
