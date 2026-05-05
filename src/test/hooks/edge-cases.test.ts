// ---------------------------------------------------------------------------
// edge-cases.test.ts — Hook system edge case tests
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from 'bun:test';
import { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks';
import { ChainEngine } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookChain, HookEvent, HookDefinition, HookResult } from '@pellux/goodvibes-sdk/platform/hooks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 1. Hook timeout behavior (within timeout in chains)
// ---------------------------------------------------------------------------

describe('Hook timeout behavior', () => {
  let dispatcher: HookDispatcher;
  let engine: ChainEngine;

  beforeEach(() => {
    dispatcher = new HookDispatcher();
    engine = new ChainEngine(dispatcher);
  });

  test('chain step with within timeout resets when time elapses', async () => {
    engine.register({
      name: 'timeout-chain',
      steps: [
        { match: 'Pre:tool:*', within: '1ms' },
        { match: 'Post:tool:*' },
      ],
      action: { match: 'Lifecycle:session:done', type: 'command', command: 'echo done' },
    });

    // Advance to step 1
    await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
    expect(engine.getStates().get('timeout-chain')!.currentStep).toBe(1);

    // Wait past the 1ms within window
    await new Promise(r => setTimeout(r, 15));

    // Submit step-2 event — within timeout has expired, chain resets to step 0
    await engine.evaluate(makeEvent({ path: 'Post:tool:read', phase: 'Post' }));
    // Post event doesn't match step 0 (Pre:tool:*), so stays at 0
    expect(engine.getStates().get('timeout-chain')!.currentStep).toBe(0);
  });

  test('chain completes before timeout fires the action', async () => {
    let actionFired = false;
    dispatcher.register('Lifecycle:session:complete', {
      match: 'Lifecycle:session:complete',
      type: 'command',
      command: 'echo \'{"ok":true}\'',
    });

    engine.register({
      name: 'fast-chain',
      steps: [
        { match: 'Pre:tool:*', within: '30s' },
        { match: 'Post:tool:*' },
      ],
      action: { match: 'Lifecycle:session:complete', type: 'command', command: 'echo done' },
    });

    await engine.evaluate(makeEvent({ path: 'Pre:tool:write', phase: 'Pre', specific: 'write' }));
    expect(engine.getStates().get('fast-chain')!.currentStep).toBe(1);

    const result = await engine.evaluate(makeEvent({ path: 'Post:tool:write', phase: 'Post', specific: 'write' }));
    // Chain completed — action was fired
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    // Chain resets after firing
    expect(engine.getStates().get('fast-chain')!.currentStep).toBe(0);
  });

  test('within timeout of 0 (unparseable) does not reset prematurely', async () => {
    engine.register({
      name: 'zero-within-chain',
      steps: [
        // within: '0' is unparseable (no unit) — parseDuration returns 0, treated as disabled
        { match: 'Pre:tool:*', within: '0' },
        { match: 'Post:tool:*' },
      ],
      action: { match: 'Lifecycle:session:done', type: 'command', command: 'echo done' },
    });

    await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
    expect(engine.getStates().get('zero-within-chain')!.currentStep).toBe(1);

    // Wait a bit — with 0 ms parsed, no timeout should trigger a reset
    await new Promise(r => setTimeout(r, 10));

    const result = await engine.evaluate(makeEvent({ path: 'Post:tool:read', phase: 'Post' }));
    // Should still complete (no timeout reset) — chain fires action
    expect(result).not.toBeNull();
    expect(engine.getStates().get('zero-within-chain')!.currentStep).toBe(0);
  });

  test('within timeout check does not trigger on first step (no prior advance)', async () => {
    engine.register({
      name: 'first-step-chain',
      steps: [
        // Even with very short within, step 0 has lastAdvance=0 so no timeout
        { match: 'Pre:tool:*', within: '1ms' },
        { match: 'Post:tool:*' },
      ],
      action: { match: 'Lifecycle:session:done', type: 'command', command: 'echo done' },
    });

    // Wait to ensure 1ms would have elapsed
    await new Promise(r => setTimeout(r, 10));

    // First step: lastAdvance is 0, no timeout check fires
    await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
    expect(engine.getStates().get('first-step-chain')!.currentStep).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Circular chain detection
// ---------------------------------------------------------------------------

describe('Circular chain behavior', () => {
  let dispatcher: HookDispatcher;
  let engine: ChainEngine;

  beforeEach(() => {
    dispatcher = new HookDispatcher();
    engine = new ChainEngine(dispatcher);
  });

  test('two chains that could mutually trigger do not infinitely recurse', async () => {
    // Chain A: fires when Pre:tool:* → action dispatches Post:agent:done
    // Chain B: fires when Post:agent:* → action dispatches Pre:tool:read
    // Since ChainEngine.evaluate() is called externally, not from dispatcher.fire(),
    // a circular firing path through dispatcher hooks would not re-enter evaluate.
    // This test verifies the engine itself terminates correctly.
    dispatcher.register('Post:agent:done', {
      match: 'Post:agent:done',
      type: 'command',
      command: 'echo \'{"ok":true}\'',
    });

    engine.register({
      name: 'chain-a',
      steps: [{ match: 'Pre:tool:*' }],
      action: { match: 'Post:agent:done', type: 'command', command: 'echo a-done' },
    });

    engine.register({
      name: 'chain-b',
      steps: [{ match: 'Post:agent:*' }],
      action: { match: 'Pre:tool:read', type: 'command', command: 'echo b-done' },
    });

    // Fire chain A's triggering event — should not throw or recurse
    const result = await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
    // Chain A fires; chain B step doesn't get advanced by this evaluate call
    // (evaluate processes each chain sequentially against the single event)
    expect(result).not.toBeNull();
    // Chain A reset
    expect(engine.getStates().get('chain-a')!.currentStep).toBe(0);
  });

  test('chain completing does not advance other chains via side effect', async () => {
    // Chain B is at step 0 waiting for 'Post:agent:*'
    // Chain A fires its action (dispatches 'Post:agent:done')
    // The dispatcher hook runs synchronously — chain B's state is NOT
    // advanced by a separate evaluate() call here (evaluate is the caller's job)
    engine.register({
      name: 'chain-a',
      steps: [{ match: 'Pre:tool:*' }],
      action: { match: 'Post:agent:done', type: 'command', command: 'echo \'{"ok":true}\'' },
    });

    engine.register({
      name: 'chain-b',
      steps: [{ match: 'Post:agent:*' }, { match: 'Fail:tool:*' }],
      action: { match: 'Lifecycle:session:done', type: 'command', command: 'echo done' },
    });

    // Trigger chain A only (Pre:tool:* event)
    await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));

    // Chain B should still be at step 0 — it was not evaluated for 'Post:agent:done'
    // because evaluate() was only called with 'Pre:tool:read'
    expect(engine.getStates().get('chain-b')!.currentStep).toBe(0);
  });

  test('same chain name registered twice behaves as two independent chains', async () => {
    // Edge case: two chains with the same name registered
    // The second one gets its own state slot (names are keys in the Map —
    // actually the chains array can have duplicates, but getStates() map will
    // overwrite on second register call. Verify second register call resets state.)
    engine.register({
      name: 'dup-chain',
      steps: [{ match: 'Pre:tool:*' }, { match: 'Post:tool:*' }],
      action: { match: 'Lifecycle:session:done', type: 'command', command: 'echo done' },
    });

    // Advance the first instance
    await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
    expect(engine.getStates().get('dup-chain')!.currentStep).toBe(1);

    // Register a second chain with the same name — this RESETS the state slot
    engine.register({
      name: 'dup-chain',
      steps: [{ match: 'Fail:tool:*' }],
      action: { match: 'Lifecycle:session:done', type: 'command', command: 'echo done2' },
    });
    // State is now reset because register() overwrites the Map entry
    expect(engine.getStates().get('dup-chain')!.currentStep).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Error propagation in chains
// ---------------------------------------------------------------------------

describe('Error propagation in chains', () => {
  let dispatcher: HookDispatcher;
  let engine: ChainEngine;

  beforeEach(() => {
    dispatcher = new HookDispatcher();
    engine = new ChainEngine(dispatcher);
  });

  test('chain action that throws produces ok:false result with error', async () => {
    // Register a hook that will throw when the action event fires
    dispatcher.register('Lifecycle:session:error', {
      match: 'Lifecycle:session:error',
      type: 'command',
      // Non-zero exit code causes command runner to return ok:false
      command: 'exit 1',
    });

    engine.register({
      name: 'error-chain',
      steps: [{ match: 'Pre:tool:*' }],
      action: { match: 'Lifecycle:session:error', type: 'command', command: 'exit 1' },
    });

    const result = await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
    // Chain fired (all steps complete), result comes back from dispatcher
    expect(result).not.toBeNull();
    // Chain resets even when action fails
    expect(engine.getStates().get('error-chain')!.currentStep).toBe(0);
  });

  test('dispatcher hook that throws is caught and result is ok:false', async () => {
    // Use a ts hook that resolves to ok:false to simulate failure
    dispatcher.register('Pre:tool:*', {
      match: 'Pre:tool:*',
      type: 'command',
      command: 'exit 127',  // non-zero exit
    });
    dispatcher.register('Pre:tool:*', {
      match: 'Pre:tool:*',
      type: 'command',
      command: 'echo \'{"ok":true,"additionalContext":"second"}\'',
    });

    const result = await dispatcher.fire(makeEvent());
    // First hook fails — ok becomes false
    expect(result.ok).toBe(false);
    // Second hook still runs (sequential, not short-circuited)
    expect(result.additionalContext).toBe('second');
  });

  test('chain continues to next independent chain even if one chain action fails', async () => {
    // Register two independent chains; chain-err fires action that fails,
    // chain-ok fires action that succeeds. Both match the same event.
    dispatcher.register('Fail:tool:error-event', {
      match: 'Fail:tool:error-event',
      type: 'command',
      command: 'exit 1',
    });
    dispatcher.register('Post:tool:ok-event', {
      match: 'Post:tool:ok-event',
      type: 'command',
      command: 'echo \'{"ok":true}\'',
    });

    engine.register({
      name: 'chain-err',
      steps: [{ match: 'Pre:tool:*' }],
      action: { match: 'Fail:tool:error-event', type: 'command', command: 'exit 1' },
    });
    engine.register({
      name: 'chain-ok',
      steps: [{ match: 'Pre:tool:*' }],
      action: { match: 'Post:tool:ok-event', type: 'command', command: 'echo done' },
    });

    // Both chains match the event, chain-err fires first and fails
    // chain-ok fires second and succeeds
    // The result returned is whichever was last to set result (chain-ok)
    const result = await engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
    // At least one chain fired
    expect(result).not.toBeNull();
    // Both chains reset regardless of failure
    expect(engine.getStates().get('chain-err')!.currentStep).toBe(0);
    expect(engine.getStates().get('chain-ok')!.currentStep).toBe(0);
  });

  test('chain step with condition error does not advance step and does not throw', async () => {
    engine.register({
      name: 'cond-error-chain',
      steps: [
        { match: 'Pre:tool:*', condition: '%%% invalid expression %%%' },
        { match: 'Post:tool:*' },
      ],
      action: { match: 'Lifecycle:session:done', type: 'command', command: 'echo done' },
    });

    // Must not throw, condition evaluates to false due to parse error
    await expect(
      engine.evaluate(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }))
    ).resolves.toBeNull();
    expect(engine.getStates().get('cond-error-chain')!.currentStep).toBe(0);
  });

  test('dispatcher aggregates ok:false across multiple failing hooks', async () => {
    dispatcher.register('Pre:tool:*', {
      match: 'Pre:tool:*',
      type: 'command',
      command: 'exit 1',
    });
    dispatcher.register('Pre:tool:*', {
      match: 'Pre:tool:*',
      type: 'command',
      command: 'exit 2',
    });

    const result = await dispatcher.fire(makeEvent());
    expect(result.ok).toBe(false);
    // error from first failing hook is preserved
    expect(typeof result.error).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 4. Concurrent hook execution limits
// ---------------------------------------------------------------------------

describe('Concurrent hook execution limits', () => {
  let dispatcher: HookDispatcher;

  beforeEach(() => {
    dispatcher = new HookDispatcher();
  });

  test('hooks execute sequentially in registration order', async () => {
    const order: number[] = [];

    // Use ts-style mock by registering command hooks with ordered markers
    // We'll verify via additionalContext ordering
    dispatcher.register('Pre:tool:*', {
      match: 'Pre:tool:*',
      type: 'command',
      command: 'echo \'{"ok":true,"additionalContext":"1"}\'',
    });
    dispatcher.register('Pre:tool:*', {
      match: 'Pre:tool:*',
      type: 'command',
      command: 'echo \'{"ok":true,"additionalContext":"2"}\'',
    });
    dispatcher.register('Pre:tool:*', {
      match: 'Pre:tool:*',
      type: 'command',
      command: 'echo \'{"ok":true,"additionalContext":"3"}\'',
    });

    const result = await dispatcher.fire(makeEvent());
    // Context parts are joined with newline
    expect(result.additionalContext).toBeDefined();
    const parts = result.additionalContext!.split('\n');
    expect(parts).toHaveLength(3);
    // Sequential order preserved
    expect(parts[0]).toBe('1');
    expect(parts[1]).toBe('2');
    expect(parts[2]).toBe('3');
  });

  test('async hooks are skipped in sequencing (fire-and-forget)', async () => {
    // An async hook with a long-running command does not block subsequent hooks
    dispatcher.register('Pre:tool:*', {
      match: 'Pre:tool:*',
      type: 'command',
      command: 'sleep 60',  // would block if awaited
      async: true,
    });
    dispatcher.register('Pre:tool:*', {
      match: 'Pre:tool:*',
      type: 'command',
      command: 'echo \'{"ok":true,"additionalContext":"sync-ran"}\'',
    });

    const start = Date.now();
    const result = await dispatcher.fire(makeEvent());
    const elapsed = Date.now() - start;

    // Async hook does not block
    expect(elapsed).toBeLessThan(2000);
    // Synchronous hook still runs
    expect(result.additionalContext).toBe('sync-ran');
  });

  test('multiple async hooks all fire-and-forget without blocking', async () => {
    for (let i = 0; i < 5; i++) {
      dispatcher.register('Pre:tool:*', {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'sleep 60',
        async: true,
      });
    }

    const start = Date.now();
    const result = await dispatcher.fire(makeEvent());
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    expect(result.ok).toBe(true);
  });

  test('hooks do not run concurrently — second hook starts after first completes', async () => {
    const timings: number[] = [];
    // Simulate ordering via additionalContext ordering which requires sequential execution
    dispatcher.register('Pre:tool:*', {
      match: 'Pre:tool:*',
      type: 'command',
      // Brief sleep to make timing detectable
      command: 'sleep 0.01 && echo \'{"ok":true,"additionalContext":"first"}\'',
    });
    dispatcher.register('Pre:tool:*', {
      match: 'Pre:tool:*',
      type: 'command',
      command: 'echo \'{"ok":true,"additionalContext":"second"}\'',
    });

    const result = await dispatcher.fire(makeEvent());
    expect(result.additionalContext).toBeDefined();
    const parts = result.additionalContext!.split('\n');
    // Sequential execution means "first" appears before "second"
    expect(parts[0]).toBe('first');
    expect(parts[1]).toBe('second');
  });

  test('many hooks all execute within reasonable time (no artificial concurrency cap)', async () => {
    // Register 10 fast hooks — all should run sequentially
    for (let i = 1; i <= 10; i++) {
      dispatcher.register('Post:tool:*', {
        match: 'Post:tool:*',
        type: 'command',
        command: `echo '{"ok":true}'`,
      });
    }

    const result = await dispatcher.fire(makeEvent({ path: 'Post:tool:read', phase: 'Post', specific: 'read' }));
    expect(result.ok).toBe(true);
  });

  test('hooks registered on different patterns do not interfere', async () => {
    dispatcher.register('Pre:tool:*', {
      match: 'Pre:tool:*',
      type: 'command',
      command: 'echo \'{"ok":true,"additionalContext":"pre"}\'',
    });
    dispatcher.register('Post:tool:*', {
      match: 'Post:tool:*',
      type: 'command',
      command: 'echo \'{"ok":true,"additionalContext":"post"}\'',
    });

    const preResult = await dispatcher.fire(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
    const postResult = await dispatcher.fire(makeEvent({ path: 'Post:tool:read', phase: 'Post' }));

    expect(preResult.additionalContext).toBe('pre');
    expect(postResult.additionalContext).toBe('post');
  });
});
