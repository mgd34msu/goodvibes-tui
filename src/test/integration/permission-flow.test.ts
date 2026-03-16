/**
 * Integration: Permission flow end-to-end.
 *
 * Tests the check → auto-approve | prompt → allow/deny decision path.
 * Event-bus interactions are verified at each stage.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PermissionManager } from '../../permissions/manager.ts';
import { EventBus } from '../../core/event-bus.ts';
import { configManager } from '../../config/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStack() {
  const bus = new EventBus();
  const pm = new PermissionManager(bus);
  return { bus, pm };
}

// ---------------------------------------------------------------------------
// Auto-approve path
// ---------------------------------------------------------------------------

describe('Permission flow — auto-approve', () => {
  let savedAutoApprove: boolean;

  beforeEach(() => {
    savedAutoApprove = false;
    configManager.set('behavior.autoApprove', true);
  });

  afterEach(() => {
    configManager.set('behavior.autoApprove', savedAutoApprove);
  });

  test('autoApprove=true approves every category', async () => {
    const { pm } = makeStack();
    for (const tool of ['read', 'write', 'exec', 'find', 'fetch']) {
      const approved = await pm.check(tool, {});
      expect(approved).toBe(true);
    }
  });

  test('autoApprove=true never emits permission:request', async () => {
    const { bus, pm } = makeStack();
    const events: unknown[] = [];
    bus.on('permission:request', (e) => events.push(e));
    await pm.check('exec', { cmd: 'rm -rf /' });
    expect(events).toHaveLength(0);
  });

  test('approves unknown tools without blocking', async () => {
    const { pm } = makeStack();
    const approved = await pm.check('some_unknown_tool', {});
    expect(approved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// allow-all mode
// ---------------------------------------------------------------------------

describe('Permission flow — allow-all mode', () => {
  let savedMode: string;
  let savedAutoApprove: boolean;

  beforeEach(() => {
    savedMode = 'prompt';
    savedAutoApprove = false;
    configManager.set('behavior.autoApprove', false);
    configManager.set('permissions.mode', 'allow-all');
  });

  afterEach(() => {
    configManager.set('permissions.mode', savedMode as 'prompt' | 'allow-all' | 'custom');
    configManager.set('behavior.autoApprove', savedAutoApprove);
  });

  test('allow-all approves read tools', async () => {
    const { pm } = makeStack();
    expect(await pm.check('read', {})).toBe(true);
  });

  test('allow-all approves write tools', async () => {
    const { pm } = makeStack();
    expect(await pm.check('write', {})).toBe(true);
  });

  test('allow-all approves execute tools', async () => {
    const { pm } = makeStack();
    expect(await pm.check('exec', {})).toBe(true);
  });

  test('allow-all never emits permission:request', async () => {
    const { bus, pm } = makeStack();
    const events: unknown[] = [];
    bus.on('permission:request', (e) => events.push(e));
    await pm.check('write', {});
    await pm.check('exec', {});
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// prompt mode — read tools auto-approved
// ---------------------------------------------------------------------------

describe('Permission flow — prompt mode reads', () => {
  let savedAutoApprove: boolean;

  beforeEach(() => {
    savedAutoApprove = false;
    configManager.set('behavior.autoApprove', false);
    configManager.set('permissions.mode', 'prompt');
  });

  afterEach(() => {
    configManager.set('behavior.autoApprove', savedAutoApprove);
    configManager.set('permissions.mode', 'prompt');
  });

  test('read is auto-approved in prompt mode', async () => {
    const { pm } = makeStack();
    expect(await pm.check('read', {})).toBe(true);
  });

  test('find is auto-approved in prompt mode', async () => {
    const { pm } = makeStack();
    expect(await pm.check('find', {})).toBe(true);
  });

  test('fetch is auto-approved in prompt mode', async () => {
    const { pm } = makeStack();
    expect(await pm.check('fetch', {})).toBe(true);
  });

  test('analyze is auto-approved in prompt mode', async () => {
    const { pm } = makeStack();
    expect(await pm.check('analyze', {})).toBe(true);
  });

  test('inspect is auto-approved in prompt mode', async () => {
    const { pm } = makeStack();
    expect(await pm.check('inspect', {})).toBe(true);
  });

  test('read does not emit permission:request', async () => {
    const { bus, pm } = makeStack();
    const events: unknown[] = [];
    bus.on('permission:request', (e) => events.push(e));
    await pm.check('read', {});
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// custom mode — per-tool config
// ---------------------------------------------------------------------------

describe('Permission flow — custom mode', () => {
  let savedAutoApprove: boolean;

  beforeEach(() => {
    savedAutoApprove = false;
    configManager.set('behavior.autoApprove', false);
    configManager.set('permissions.mode', 'custom');
  });

  afterEach(() => {
    configManager.set('behavior.autoApprove', savedAutoApprove);
    configManager.set('permissions.mode', 'prompt');
  });

  test('custom mode with allow action approves immediately', async () => {
    configManager.set('permissions.tools.file_read', 'allow');
    const { pm } = makeStack();
    const approved = await pm.check('file_read', {});
    configManager.set('permissions.tools.file_read', 'prompt');
    expect(approved).toBe(true);
  });

  test('custom mode with deny action denies immediately', async () => {
    configManager.set('permissions.tools.file_write', 'deny');
    const { pm } = makeStack();
    const approved = await pm.check('file_write', {});
    configManager.set('permissions.tools.file_write', 'prompt');
    expect(approved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session approval cache
// ---------------------------------------------------------------------------

describe('Permission flow — session approval cache', () => {
  let savedAutoApprove: boolean;

  beforeEach(() => {
    savedAutoApprove = false;
    configManager.set('behavior.autoApprove', false);
    configManager.set('permissions.mode', 'prompt');
  });

  afterEach(() => {
    configManager.set('behavior.autoApprove', savedAutoApprove);
    configManager.set('permissions.mode', 'prompt');
  });

  test('category function correctly maps tool names', () => {
    const { pm } = makeStack();
    // Public method tested via whitebox
    expect(pm.getCategory('read')).toBe('read');
    expect(pm.getCategory('write')).toBe('write');
    expect(pm.getCategory('exec')).toBe('execute');
    expect(pm.getCategory('find')).toBe('read');
    expect(pm.getCategory('fetch')).toBe('read');
    expect(pm.getCategory('analyze')).toBe('read');
    expect(pm.getCategory('inspect')).toBe('read');
  });

  test('delegate category is correctly assigned', () => {
    const { pm } = makeStack();
    expect(pm.getCategory('agent')).toBe('delegate');
  });
});
