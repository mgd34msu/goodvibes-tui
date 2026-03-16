import { describe, test, expect, mock } from 'bun:test';
import { fireTriggers } from '../../workflow/trigger-executor.ts';
import type { TriggerDefinition } from '../../tools/workflow/index.ts';
import type { HookEvent } from '../../hooks/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(path: string, phase: HookEvent['phase'] = 'Post'): HookEvent {
  return { path, phase, data: {} };
}

function makeTrigger(overrides: Partial<TriggerDefinition> = {}): TriggerDefinition {
  return {
    id: `trg-test-${Math.random().toString(36).slice(2, 8)}`,
    event: 'Post:tool:*',
    action: 'echo triggered',
    enabled: true,
    ...overrides,
  };
}

interface SimpleTriggerManager {
  list(): TriggerDefinition[];
}

function makeManager(triggers: TriggerDefinition[]): SimpleTriggerManager {
  return { list: () => triggers };
}

// ---------------------------------------------------------------------------
// fireTriggers
// ---------------------------------------------------------------------------

describe('fireTriggers', () => {
  test('returns empty array when no triggers', async () => {
    const results = await fireTriggers(makeEvent('Post:tool:read'), makeManager([]));
    expect(results).toEqual([]);
  });

  test('skips disabled triggers', async () => {
    const trigger = makeTrigger({ enabled: false });
    const results = await fireTriggers(makeEvent('Post:tool:read'), makeManager([trigger]));
    expect(results).toHaveLength(0);
  });

  test('skips triggers that do not match event path', async () => {
    const trigger = makeTrigger({ event: 'Pre:tool:write' });
    const results = await fireTriggers(makeEvent('Post:tool:read'), makeManager([trigger]));
    expect(results).toHaveLength(0);
  });

  test('fires trigger matching exact event path', async () => {
    const trigger = makeTrigger({ event: 'Post:tool:read', action: 'echo ok' });
    const results = await fireTriggers(makeEvent('Post:tool:read'), makeManager([trigger]));
    expect(results).toHaveLength(1);
    expect(results[0].triggerId).toBe(trigger.id);
    expect(results[0].executed).toBe(true);
  });

  test('fires trigger matching wildcard event path', async () => {
    const trigger = makeTrigger({ event: 'Post:tool:*', action: 'echo wild' });
    const results = await fireTriggers(makeEvent('Post:tool:read'), makeManager([trigger]));
    expect(results).toHaveLength(1);
    expect(results[0].executed).toBe(true);
  });

  test('condition evaluates true allows execution', async () => {
    const trigger = makeTrigger({ condition: 'true', action: 'echo cond-ok' });
    const results = await fireTriggers(makeEvent('Post:tool:read'), makeManager([trigger]));
    expect(results[0].executed).toBe(true);
  });

  test('condition evaluates false prevents execution', async () => {
    const trigger = makeTrigger({ condition: 'false', action: 'echo cond-skip' });
    const results = await fireTriggers(makeEvent('Post:tool:read'), makeManager([trigger]));
    expect(results).toHaveLength(1);
    expect(results[0].executed).toBe(false);
  });

  test('bad condition syntax prevents execution without throwing', async () => {
    const trigger = makeTrigger({ condition: '!!@#$%%^', action: 'echo bad-cond' });
    // Should not throw
    const results = await fireTriggers(makeEvent('Post:tool:read'), makeManager([trigger]));
    expect(results[0].executed).toBe(false);
  });

  test('multiple triggers: all matching ones fire', async () => {
    const t1 = makeTrigger({ event: 'Post:tool:*', action: 'echo t1' });
    const t2 = makeTrigger({ event: 'Post:tool:*', action: 'echo t2' });
    const t3 = makeTrigger({ event: 'Pre:tool:*', action: 'echo t3' }); // non-matching
    const results = await fireTriggers(
      makeEvent('Post:tool:read'),
      makeManager([t1, t2, t3]),
    );
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.executed)).toBe(true);
  });

  test('result includes triggerId, event, action fields', async () => {
    const trigger = makeTrigger({ event: 'Post:tool:read', action: 'echo info' });
    const results = await fireTriggers(makeEvent('Post:tool:read'), makeManager([trigger]));
    expect(results[0].triggerId).toBe(trigger.id);
    expect(results[0].event).toBe('Post:tool:read');
    expect(results[0].action).toBe('echo info');
  });

  test('empty action string returns executed=false with error', async () => {
    const trigger = makeTrigger({ action: '' });
    const results = await fireTriggers(makeEvent('Post:tool:read'), makeManager([trigger]));
    expect(results[0].executed).toBe(false);
    expect(results[0].error).toBeTruthy();
  });

  test('spawned action includes pid', async () => {
    const trigger = makeTrigger({ event: 'Post:tool:read', action: 'echo pid-test' });
    const results = await fireTriggers(makeEvent('Post:tool:read'), makeManager([trigger]));
    expect(results[0].pid).toBeDefined();
    expect(typeof results[0].pid).toBe('number');
  });
});
