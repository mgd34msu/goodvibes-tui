/**
 * Integration: Permission flow end-to-end.
 *
 * Tests the check → auto-approve | prompt → allow/deny decision path.
 * Direct permission handler interactions are verified at each stage.
 */
import { describe, test, expect } from 'bun:test';
import { PermissionManager } from '@pellux/goodvibes-sdk/platform/permissions';
import type { PermissionPromptRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import type { GoodVibesConfig, PermissionAction } from '@pellux/goodvibes-sdk/platform/config';
import { PolicyRuntimeState } from '@/runtime/index.ts';

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

// ---------------------------------------------------------------------------
// Per-hunk modifiedArgs
//
// When the owner deselects hunks in an edit prompt, the approval carries the
// narrowed `edits` array back as `modifiedArgs`, and those are the arguments
// the tool executes with. The TUI's hunk-selection code
// (src/permissions/hunk-selection.ts, src/shell/blocking-input.ts) builds that
// object; PermissionManager.checkDetailed threads it verbatim onto the result
// the tool call reads. Asserted against the real manager, so a change to the
// threading fails here rather than in a hand-written shape beside it.
// ---------------------------------------------------------------------------

describe('Permission flow — per-hunk modifiedArgs', () => {
  const hunks = [
    { path: 'a.ts', find: 'x', replace: 'y' },
    { path: 'a.ts', find: 'p', replace: 'q' },
    { path: 'a.ts', find: 'm', replace: 'n' },
  ];

  function makeStackReturning(decision: Record<string, unknown>) {
    const config = createConfigState();
    const requests: PermissionPromptRequest[] = [];
    const pm = new PermissionManager(async (request) => {
      requests.push(request);
      return decision as never;
    }, config, new PolicyRuntimeState());
    return { pm, requests };
  }

  test('the narrowed edits an approval carries are the ones the result exposes', async () => {
    // "The owner deselected hunk 1" — the exact handler shape blocking-input's
    // resolve() hands back.
    const { pm } = makeStackReturning({
      approved: true,
      remember: false,
      modifiedArgs: { edits: [hunks[0], hunks[2]] },
    });

    const result = await pm.checkDetailed('edit', { edits: hunks });

    expect(result.approved).toBe(true);
    expect(result.sourceLayer).toBe('user_prompt');
    expect(result.modifiedArgs).toEqual({ edits: [hunks[0], hunks[2]] });
  });

  test('an approval that narrows nothing carries no modifiedArgs, so the original args stand', async () => {
    const { pm } = makeStackReturning({ approved: true });

    const result = await pm.checkDetailed('edit', { edits: hunks });

    expect(result.approved).toBe(true);
    expect(result.modifiedArgs).toBeUndefined();
  });

  test('a decision that reaches no prompt carries none either', async () => {
    // read is 'allow', so the layered decision settles before the ask.
    const { pm, requests } = makeStackReturning({
      approved: true,
      modifiedArgs: { edits: [] },
    });

    const result = await pm.checkDetailed('read', { path: 'a.ts' });

    expect(requests).toHaveLength(0);
    expect(result.approved).toBe(true);
    expect(result.modifiedArgs).toBeUndefined();
  });
});
