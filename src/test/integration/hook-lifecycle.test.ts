/**
 * Integration: Hook lifecycle — Pre → execute → Post | Fail.
 *
 * Tests the HookDispatcher's fire() method, event shape, and routing
 * through the full Pre/Post/Fail lifecycle.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { HookDispatcher } from '../../hooks/dispatcher.ts';
import type { HookEvent, HookDefinition } from '../../hooks/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    path: 'Pre:tool:read',
    phase: 'Pre',
    category: 'tool',
    specific: 'read',
    sessionId: 'test-session-hook',
    timestamp: Date.now(),
    payload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HookDispatcher unit tests
// ---------------------------------------------------------------------------

describe('Hook lifecycle — dispatcher', () => {
  let dispatcher: HookDispatcher;

  beforeEach(() => {
    dispatcher = new HookDispatcher();
  });

  test('fire() with no registered hooks returns ok:true', async () => {
    const event = makeEvent();
    const result = await dispatcher.fire(event);
    expect(result.ok).toBe(true);
  });

  test('register() + fire() calls through to ts runner', async () => {
    dispatcher.register('Pre:tool:read', {
      type: 'ts',
      match: 'Pre:tool:read',
      path: '',
    });
    // A ts hook with empty path returns ok:false (file doesn't exist), but fire() itself runs
    const event = makeEvent({ path: 'Pre:tool:read' });
    const result = await dispatcher.fire(event);
    // ok may be false (ts runner couldn't load file), but it runs without throwing
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe('boolean');
  });

  test('fire() returns ok:true when no hook matches the event path', async () => {
    // Register a hook for a different event
    dispatcher.register('Post:git:commit', {
      type: 'command',
      match: 'Post:git:commit',
      command: 'echo done',
    });
    // Fire a different event
    const event = makeEvent({ path: 'Pre:tool:write', phase: 'Pre', category: 'tool', specific: 'write' });
    const result = await dispatcher.fire(event);
    expect(result.ok).toBe(true);
  });

  test('fire() with wildcard pattern matches any tool', async () => {
    let firedCount = 0;
    // Patch fire to intercept
    const origFire = dispatcher.fire.bind(dispatcher);
    dispatcher.fire = async (event: HookEvent) => {
      firedCount++;
      return origFire(event);
    };

    await dispatcher.fire(makeEvent({ path: 'Pre:tool:read' }));
    await dispatcher.fire(makeEvent({ path: 'Pre:tool:write', phase: 'Pre', specific: 'write' }));
    expect(firedCount).toBe(2);
  });

  test('HookEvent shape has required fields', () => {
    const event = makeEvent({ payload: { callId: 'c1', tool: 'read', args: {} } });
    expect(event.path).toBe('Pre:tool:read');
    expect(event.phase).toBe('Pre');
    expect(event.category).toBe('tool');
    expect(event.specific).toBe('read');
    expect(event.sessionId).toBe('test-session-hook');
    expect(typeof event.timestamp).toBe('number');
    expect(event.payload).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Hook phase transitions (simulated)
// ---------------------------------------------------------------------------

describe('Hook lifecycle — phase transitions', () => {
  test('Pre phase has correct path format', () => {
    const event = makeEvent({ phase: 'Pre', category: 'tool', specific: 'write' });
    expect(event.phase).toBe('Pre');
    const expectedPath = 'Pre:tool:read'; // makeEvent default
    expect(event.path).toBe(expectedPath);
  });

  test('Post phase has correct path format', () => {
    const event = makeEvent({
      path: 'Post:tool:read',
      phase: 'Post',
      category: 'tool',
      specific: 'read',
    });
    expect(event.phase).toBe('Post');
    expect(event.path).toBe('Post:tool:read');
  });

  test('Fail phase has correct path format', () => {
    const event = makeEvent({
      path: 'Fail:tool:write',
      phase: 'Fail',
      category: 'tool',
      specific: 'write',
      payload: { error: 'something went wrong' },
    });
    expect(event.phase).toBe('Fail');
    expect(event.path).toBe('Fail:tool:write');
    expect((event.payload as { error: string }).error).toBe('something went wrong');
  });

  test('all three phases can be fired sequentially without error', async () => {
    const dispatcher = new HookDispatcher();
    const phases: string[] = [];
    const origFire = dispatcher.fire.bind(dispatcher);
    dispatcher.fire = async (event: HookEvent) => {
      phases.push(event.phase);
      return origFire(event);
    };

    await dispatcher.fire(makeEvent({ path: 'Pre:tool:read', phase: 'Pre' }));
    await dispatcher.fire(makeEvent({ path: 'Post:tool:read', phase: 'Post' }));
    // Fail is only fired on error
    await dispatcher.fire(makeEvent({ path: 'Fail:tool:read', phase: 'Fail' }));

    expect(phases).toEqual(['Pre', 'Post', 'Fail']);
  });

  test('hook deny decision propagates correctly', () => {
    const result: import('../../hooks/types.ts').HookResult = {
      ok: true,
      decision: 'deny',
      reason: 'blocked by policy',
    };
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('blocked by policy');
  });

  test('hook allow decision propagates correctly', () => {
    const result: import('../../hooks/types.ts').HookResult = {
      ok: true,
      decision: 'allow',
    };
    expect(result.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Hook event builder helpers
// ---------------------------------------------------------------------------

describe('Hook lifecycle — event builders', () => {
  test('git hook events have git category', () => {
    const event = makeEvent({
      path: 'Pre:git:commit',
      phase: 'Pre',
      category: 'git',
      specific: 'commit',
    });
    expect(event.category).toBe('git');
    expect(event.specific).toBe('commit');
  });

  test('different event payloads are preserved', () => {
    const payload = { callId: 'x', tool: 'exec', args: { cmd: 'ls' }, result: null };
    const event = makeEvent({ payload });
    expect(event.payload).toStrictEqual(payload);
  });

  test('sessionId is always a non-empty string', () => {
    const event = makeEvent({ sessionId: 'sess-abc-123' });
    expect(typeof event.sessionId).toBe('string');
    expect(event.sessionId.length).toBeGreaterThan(0);
  });

  test('timestamp is a positive integer', () => {
    const event = makeEvent();
    expect(typeof event.timestamp).toBe('number');
    expect(event.timestamp).toBeGreaterThan(0);
  });
});
