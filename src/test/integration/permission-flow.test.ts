/**
 * Integration: Permission flow end-to-end.
 *
 * Tests the check → auto-approve | prompt → allow/deny decision path.
 * Direct permission handler interactions are verified at each stage.
 */
import { describe, test, expect } from 'bun:test';
import { PermissionManager } from '../../permissions/manager.ts';
import type { PermissionPromptRequest } from '../../permissions/prompt.ts';
import type { GoodVibesConfig, PermissionAction } from '../../config/schema.ts';
import { PolicyRuntimeState } from '../../runtime/permissions/policy-runtime.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConfigState(overrides: Partial<GoodVibesConfig['permissions']> = {}, autoApprove = false) {
  const defaultTools: GoodVibesConfig['permissions']['tools'] = {
    read: 'allow',
    write: 'prompt',
    edit: 'prompt',
    exec: 'prompt',
    find: 'allow',
    fetch: 'allow',
    analyze: 'allow',
    inspect: 'allow',
    agent: 'prompt',
    state: 'allow',
    workflow: 'prompt',
    registry: 'allow',
    delegate: 'prompt',
    mcp: 'prompt',
  };

  const config: GoodVibesConfig = {
    behavior: { autoApprove } as GoodVibesConfig['behavior'],
    permissions: {
      mode: 'prompt',
      ...overrides,
      tools: { ...defaultTools, ...(overrides.tools ?? {}) },
    },
  } as GoodVibesConfig;

  return {
    getSnapshot: () => config,
    isAutoApproveEnabled: () => config.behavior.autoApprove,
    getWorkingDirectory: () => '/tmp/goodvibes-permission-flow',
    setAutoApprove(value: boolean) {
      config.behavior.autoApprove = value;
    },
    setMode(value: GoodVibesConfig['permissions']['mode']) {
      config.permissions.mode = value;
    },
    setTool(tool: keyof GoodVibesConfig['permissions']['tools'], value: PermissionAction) {
      config.permissions.tools[tool] = value;
    },
  };
}

function makeStack(config = createConfigState()) {
  const requests: PermissionPromptRequest[] = [];
  const policyRuntimeState = new PolicyRuntimeState();
  const pm = new PermissionManager(async (request) => {
    requests.push(request);
    return { approved: true };
  }, config, policyRuntimeState);
  return { pm, requests, config, policyRuntimeState };
}

// ---------------------------------------------------------------------------
// Auto-approve path
// ---------------------------------------------------------------------------

describe('Permission flow — auto-approve', () => {
  test('autoApprove=true approves every category', async () => {
    const { pm } = makeStack(createConfigState({}, true));
    for (const tool of ['read', 'write', 'exec', 'find', 'fetch']) {
      const approved = await pm.check(tool, {});
      expect(approved).toBe(true);
    }
  });

  test('autoApprove=true never emits permission:request', async () => {
    const { pm, requests } = makeStack(createConfigState({}, true));
    await pm.check('exec', { cmd: 'rm -rf /' });
    expect(requests).toHaveLength(0);
  });

  test('approves unknown tools without blocking', async () => {
    const { pm } = makeStack(createConfigState({}, true));
    const approved = await pm.check('some_unknown_tool', {});
    expect(approved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// allow-all mode
// ---------------------------------------------------------------------------

describe('Permission flow — allow-all mode', () => {
  test('allow-all approves read tools', async () => {
    const { pm } = makeStack(createConfigState({ mode: 'allow-all' }, false));
    expect(await pm.check('read', {})).toBe(true);
  });

  test('allow-all approves write tools', async () => {
    const { pm } = makeStack(createConfigState({ mode: 'allow-all' }, false));
    expect(await pm.check('write', {})).toBe(true);
  });

  test('allow-all approves execute tools', async () => {
    const { pm } = makeStack(createConfigState({ mode: 'allow-all' }, false));
    expect(await pm.check('exec', {})).toBe(true);
  });

  test('allow-all never emits permission:request', async () => {
    const { pm, requests } = makeStack(createConfigState({ mode: 'allow-all' }, false));
    await pm.check('write', {});
    await pm.check('exec', {});
    expect(requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// prompt mode — read tools auto-approved
// ---------------------------------------------------------------------------

describe('Permission flow — prompt mode reads', () => {
  test('read is auto-approved in prompt mode', async () => {
    const { pm } = makeStack(createConfigState({ mode: 'prompt' }, false));
    expect(await pm.check('read', {})).toBe(true);
  });

  test('find is auto-approved in prompt mode', async () => {
    const { pm } = makeStack(createConfigState({ mode: 'prompt' }, false));
    expect(await pm.check('find', {})).toBe(true);
  });

  test('fetch is auto-approved in prompt mode', async () => {
    const { pm } = makeStack(createConfigState({ mode: 'prompt' }, false));
    expect(await pm.check('fetch', {})).toBe(true);
  });

  test('analyze is auto-approved in prompt mode', async () => {
    const { pm } = makeStack(createConfigState({ mode: 'prompt' }, false));
    expect(await pm.check('analyze', {})).toBe(true);
  });

  test('inspect is auto-approved in prompt mode', async () => {
    const { pm } = makeStack(createConfigState({ mode: 'prompt' }, false));
    expect(await pm.check('inspect', {})).toBe(true);
  });

  test('read does not emit permission:request', async () => {
    const { pm, requests } = makeStack(createConfigState({ mode: 'prompt' }, false));
    await pm.check('read', {});
    expect(requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// custom mode — per-tool config
// ---------------------------------------------------------------------------

describe('Permission flow — custom mode', () => {
  test('custom mode with allow action approves immediately', async () => {
    const config = createConfigState({ mode: 'custom' }, false);
    config.setTool('read', 'allow');
    const { pm } = makeStack(config);
    const approved = await pm.check('read', {});
    expect(approved).toBe(true);
  });

  test('custom mode with deny action denies immediately', async () => {
    const config = createConfigState({ mode: 'custom' }, false);
    config.setTool('write', 'deny');
    const { pm } = makeStack(config);
    const approved = await pm.check('write', {});
    expect(approved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session approval cache
// ---------------------------------------------------------------------------

describe('Permission flow — session approval cache', () => {
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
