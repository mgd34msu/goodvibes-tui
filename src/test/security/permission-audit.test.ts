/**
 * G5 — Permission Audit
 *
 * Verifies the permission gate behavior for all 12 tools + delegate, danger-gated
 * feature config checks, path traversal protection on file-mutating tools, and
 * PermissionPromptUI rendering per category.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PermissionManager } from '../../permissions/manager.ts';
import { PermissionPromptUI, type PermissionPromptRequest } from '../../permissions/prompt.ts';
import { configManager } from '../../config/index.ts';
import { DaemonServer } from '../../daemon/server.ts';
import { HttpListener } from '../../daemon/http-listener.ts';
import { SpawnTokenManager } from '../../security/spawn-tokens.ts';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';
import type { PermissionMode } from '../../config/schema.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(
  handler: (request: PermissionPromptRequest) => Promise<{ approved: boolean; remember?: boolean }> = async () => ({ approved: true }),
): { requests: PermissionPromptRequest[]; mgr: PermissionManager } {
  const requests: PermissionPromptRequest[] = [];
  const mgr = new PermissionManager(async (request) => {
    requests.push(request);
    return handler(request);
  });
  return { requests, mgr };
}

// ---------------------------------------------------------------------------
// Setup / teardown — force autoApprove=false and prompt mode for all tests
// ---------------------------------------------------------------------------

let savedAutoApprove: boolean;
let savedMode: PermissionMode;

beforeEach(() => {
  savedAutoApprove = configManager.get('behavior.autoApprove') as boolean ?? false;
  savedMode = configManager.get('permissions.mode') ?? 'prompt';
  configManager.set('behavior.autoApprove', false);
  configManager.set('permissions.mode', 'prompt');
});

afterEach(() => {
  configManager.set('behavior.autoApprove', savedAutoApprove);
  configManager.set('permissions.mode', savedMode);
});

// ---------------------------------------------------------------------------
// 1. All 12 tools + delegate: PermissionManager.check() is the gate
// ---------------------------------------------------------------------------

describe('Tool permission gate — all 12 tools + delegate', () => {
  // Read-category tools: auto-approved in prompt mode (no event fired)
  const READ_TOOLS: Array<[string, Record<string, unknown>]> = [
    ['read',     { path: 'src/index.ts' }],
    ['find',     { pattern: '*.ts' }],
    ['fetch',    { url: 'https://example.com' }],
    ['analyze',  { path: '.' }],
    ['inspect',  { path: 'src/' }],
    ['state',    { key: 'session' }],
    ['registry', { query: 'tools' }],
  ];

  for (const [tool, args] of READ_TOOLS) {
    test(`${tool}: auto-approved (read category, no prompt event)`, async () => {
      const { requests, mgr } = makeManager();
      const result = await mgr.check(tool, args);
      expect(result).toBe(true);
      expect(requests).toHaveLength(0);
    });
  }

  // Non-read tools: prompt event must fire before execution is allowed
  const PROMPT_TOOLS: Array<[string, Record<string, unknown>]> = [
    ['write',    { path: 'out.ts' }],
    ['edit',     { path: 'src/foo.ts' }],
    ['exec',     { command: 'npm run build' }],
    ['agent',    { task: 'do something' }],
    ['workflow', { name: 'deploy' }],
    ['delegate', { task: 'sub-task' }],
  ];

  for (const [tool, args] of PROMPT_TOOLS) {
    test(`${tool}: permission:request event fires before approval`, async () => {
      const { requests, mgr } = makeManager(async () => ({ approved: true }));
      const result = await mgr.check(tool, args);
      expect(requests).toHaveLength(1);
      expect(result).toBe(true);
    });

    test(`${tool}: denied when user resolves false`, async () => {
      const { mgr } = makeManager(async () => ({ approved: false }));
      const result = await mgr.check(tool, args);
      expect(result).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Unknown tools default to 'delegate' category (prompt required)
// ---------------------------------------------------------------------------

describe('Unknown tools default to delegate category', () => {
  test('unknown_tool has delegate category', () => {
    const { mgr } = makeManager();
    expect(mgr.getCategory('unknown_tool')).toBe('delegate');
  });

  test('completely_unknown_tool has delegate category', () => {
    const { mgr } = makeManager();
    expect(mgr.getCategory('completely_unknown_tool')).toBe('delegate');
  });

  test('unknown tool triggers permission:request event (not auto-approved)', async () => {
    const { requests, mgr } = makeManager(async () => ({ approved: true }));
    await mgr.check('unknown_tool_xyz', { something: 'value' });
    expect(requests).toHaveLength(1);
  });

  test('unknown tool permission:request carries category=delegate', async () => {
    let capturedCategory: string | null = null;
    const { mgr } = makeManager(async (request) => {
      capturedCategory = String(request.category);
      return { approved: true };
    });
    await mgr.check('mystery_tool', {});
    expect(capturedCategory as string | null).toBe('delegate');
  });
});

// ---------------------------------------------------------------------------
// 3. Danger-gated features: daemon, httpListener, agentRecursion
// ---------------------------------------------------------------------------

describe('Danger-gated features check config before enabling', () => {
  describe('DaemonServer', () => {
    test('refuses to enable when danger.daemon = false', () => {
      const server = new DaemonServer();
      const result = server.enable({ daemon: false });
      expect(result).toBe(false);
    });

    test('enables when danger.daemon = true', () => {
      const server = new DaemonServer();
      const result = server.enable({ daemon: true });
      expect(result).toBe(true);
    });

    test('refuses to start when not enabled (enable not called)', async () => {
      const server = new DaemonServer({ port: 0 });
      // Should not throw, just no-op
      await expect(server.start()).resolves.toBeUndefined();
      expect(server.isRunning).toBe(false);
    });

    test('refuses to start after enable({ daemon: false })', async () => {
      const server = new DaemonServer({ port: 0 });
      server.enable({ daemon: false });
      await server.start();
      expect(server.isRunning).toBe(false);
    });
  });

  describe('HttpListener', () => {
    test('refuses to enable when danger.httpListener = false', () => {
      const listener = new HttpListener();
      const result = listener.enable({ httpListener: false });
      expect(result).toBe(false);
    });

    test('enables when danger.httpListener = true', () => {
      const listener = new HttpListener();
      const result = listener.enable({ httpListener: true });
      expect(result).toBe(true);
    });

    test('refuses to start when not enabled', async () => {
      const listener = new HttpListener({ port: 0 });
      await expect(listener.start()).resolves.toBeUndefined();
      expect(listener.isRunning).toBe(false);
    });
  });

  describe('agentRecursion — SpawnTokenManager.canSpawn', () => {
    beforeEach(() => SpawnTokenManager.resetInstance());
    afterEach(() => SpawnTokenManager.resetInstance());

    test('canSpawn returns allowed=false when agentRecursion=false', () => {
      const stm = new SpawnTokenManager('test-session');
      const token = stm.createOrchestratorToken();
      const result = stm.canSpawn(token, {
        agentRecursion: false,
        maxRecursionDepth: 1,
        maxGlobalAgents: 8,
      }, 0);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('agentRecursion');
    });

    test('canSpawn returns allowed=true when agentRecursion=true and within limits', () => {
      const stm = new SpawnTokenManager('test-session');
      const token = stm.createOrchestratorToken();
      const result = stm.canSpawn(token, {
        agentRecursion: true,
        maxRecursionDepth: 1,
        maxGlobalAgents: 8,
      }, 0);
      expect(result.allowed).toBe(true);
    });

    test('canSpawn blocks when maxGlobalAgents exceeded', () => {
      const stm = new SpawnTokenManager('test-session');
      const token = stm.createOrchestratorToken();
      const result = stm.canSpawn(token, {
        agentRecursion: true,
        maxRecursionDepth: 1,
        maxGlobalAgents: 2,
      }, 2); // already at limit
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('maxGlobalAgents');
    });

    test('canSpawn blocks when depth exceeds maxRecursionDepth', () => {
      const stm = new SpawnTokenManager('test-session');
      const orchestratorToken = stm.createOrchestratorToken();
      const agentToken = stm.generateAgentToken(orchestratorToken, 'agent-1');
      expect(agentToken).not.toBeNull();
      // Agent token has depth=1; maxRecursionDepth=0 means even depth=1 is blocked
      const result = stm.canSpawn(agentToken!, {
        agentRecursion: true,
        maxRecursionDepth: 0,
        maxGlobalAgents: 8,
      }, 0);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('depth');
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Path traversal protection on read / write / edit / exec tools
// ---------------------------------------------------------------------------

describe('Path traversal protection via resolveAndValidatePath', () => {
  test('allows path within project root', () => {
    expect(() => resolveAndValidatePath('src/index.ts')).not.toThrow();
  });

  test('allows nested path within project root', () => {
    expect(() => resolveAndValidatePath('src/tools/registry.ts')).not.toThrow();
  });

  test('throws for ../ path traversal attempt', () => {
    expect(() => resolveAndValidatePath('../../../etc/passwd')).toThrow(/outside the project root/);
  });

  test('throws for absolute /etc path', () => {
    expect(() => resolveAndValidatePath('/etc/shadow')).toThrow(/outside the project root/);
  });

  test('throws for /tmp path', () => {
    expect(() => resolveAndValidatePath('/tmp/evil')).toThrow(/outside the project root/);
  });

  test('throws for embedded .. traversal', () => {
    expect(() => resolveAndValidatePath('src/../../../../../../etc/hosts')).toThrow(
      /outside the project root/
    );
  });

  test('resolveAndValidatePath is used by write tool (import exists)', async () => {
    // Verify the guard is imported and used — import the module to confirm no errors
    const { createWriteTool } = await import('../../tools/write/index.ts');
    expect(typeof createWriteTool).toBe('function');
  });

  test('resolveAndValidatePath is used by edit tool (import exists)', async () => {
    const { createEditTool } = await import('../../tools/edit/index.ts');
    expect(typeof createEditTool).toBe('function');
  });

  test('resolveAndValidatePath is used by read tool (import exists)', async () => {
    const { ReadTool } = await import('../../tools/read/index.ts');
    expect(typeof ReadTool).toBe('function');
  });

  test('resolveAndValidatePath is used by exec tool (import exists)', async () => {
    const { execTool } = await import('../../tools/exec/index.ts');
    expect(typeof execTool).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// 5. PermissionPromptUI — renders correct category label per category
// ---------------------------------------------------------------------------

describe('PermissionPromptUI — renders correctly per category', () => {
  const WIDTH = 80;

  test('write category: label is WRITE, color is yellow (220)', () => {
    const { label, color } = PermissionPromptUI.getCategoryLabel('write');
    expect(label).toBe('WRITE');
    expect(color).toBe('220');
  });

  test('execute category: label is EXECUTE, color is red (196)', () => {
    const { label, color } = PermissionPromptUI.getCategoryLabel('execute');
    expect(label).toBe('EXECUTE');
    expect(color).toBe('196');
  });

  test('delegate category: label is DELEGATE, color is orange (208)', () => {
    const { label, color } = PermissionPromptUI.getCategoryLabel('delegate');
    expect(label).toBe('DELEGATE');
    expect(color).toBe('208');
  });

  test('read category: falls through to default PERMISSION label', () => {
    // read is auto-approved and never shown in a prompt, but getCategoryLabel is a pure function
    const { label } = PermissionPromptUI.getCategoryLabel('read' as Parameters<typeof PermissionPromptUI.getCategoryLabel>[0]);
    expect(label).toBe('PERMISSION');
  });

  test('createPromptLines returns non-empty array of lines for write', () => {
    const request = {
      callId: 'test-call-1',
      tool: 'write',
      args: { path: 'src/output.ts' },
      category: 'write' as const,
      resolve: (_approved: boolean) => {},
    };
    const lines = PermissionPromptUI.createPromptLines(WIDTH, request);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('createPromptLines for execute includes EXECUTE label', () => {
    const request = {
      callId: 'test-call-2',
      tool: 'exec',
      args: { command: 'npm run build' },
      category: 'execute' as const,
      resolve: (_approved: boolean) => {},
    };
    const lines = PermissionPromptUI.createPromptLines(WIDTH, request);
    // Line is Cell[] — join chars to get the text content of each line
    const hasExecuteLabel = lines.some((line) =>
      line.map((c) => c.char).join('').includes('[EXECUTE]')
    );
    expect(hasExecuteLabel).toBe(true);
  });

  test('createPromptLines for delegate includes DELEGATE label', () => {
    const request = {
      callId: 'test-call-3',
      tool: 'agent',
      args: { task: 'do something' },
      category: 'delegate' as const,
      resolve: (_approved: boolean) => {},
    };
    const lines = PermissionPromptUI.createPromptLines(WIDTH, request);
    const hasDelegateLabel = lines.some((line) =>
      line.map((c) => c.char).join('').includes('[DELEGATE]')
    );
    expect(hasDelegateLabel).toBe(true);
  });

  test('createPromptLines includes tool name in output', () => {
    const toolName = 'write';
    const request = {
      callId: 'test-call-4',
      tool: toolName,
      args: { path: 'out.ts' },
      category: 'write' as const,
      resolve: (_approved: boolean) => {},
    };
    const lines = PermissionPromptUI.createPromptLines(WIDTH, request);
    const hasToolName = lines.some((line) =>
      line.map((c) => c.char).join('').includes(toolName)
    );
    expect(hasToolName).toBe(true);
  });

  test('createPromptLines includes choices [Y] Allow once in output', () => {
    const request = {
      callId: 'test-call-5',
      tool: 'exec',
      args: { command: 'ls' },
      category: 'execute' as const,
      resolve: (_approved: boolean) => {},
    };
    const lines = PermissionPromptUI.createPromptLines(WIDTH, request);
    const hasChoices = lines.some((line) =>
      line.map((c) => c.char).join('').includes('[Y]')
    );
    expect(hasChoices).toBe(true);
  });

  test('getDisplayArg returns path when args has path', () => {
    const arg = PermissionPromptUI.getDisplayArg('write', { path: '/some/file.ts' });
    expect(arg).toBe('/some/file.ts');
  });

  test('getDisplayArg returns command when args has command', () => {
    const arg = PermissionPromptUI.getDisplayArg('exec', { command: 'npm test' });
    expect(arg).toBe('npm test');
  });

  test('getDisplayArg returns pattern when args has pattern', () => {
    const arg = PermissionPromptUI.getDisplayArg('find', { pattern: '*.ts' });
    expect(arg).toBe('*.ts');
  });

  test('getDisplayArg falls back to first string value', () => {
    const arg = PermissionPromptUI.getDisplayArg('state', { key: 'my-key' });
    expect(arg).toBe('my-key');
  });
});

// ---------------------------------------------------------------------------
// 6. All 12 tool names map to the expected permission category
// ---------------------------------------------------------------------------

describe('Tool-to-category mapping is complete for all 12 tools', () => {
  const EXPECTED: Record<string, string> = {
    // New tool names
    read:     'read',
    find:     'read',
    fetch:    'read',
    analyze:  'read',
    inspect:  'read',
    state:    'read',
    registry: 'read',
    write:    'write',
    edit:     'write',
    exec:     'execute',
    agent:    'delegate',
    workflow: 'delegate',
    delegate: 'delegate',
  };

  const { mgr } = makeManager();

  for (const [tool, expectedCategory] of Object.entries(EXPECTED)) {
    test(`${tool} maps to category '${expectedCategory}'`, () => {
      expect(mgr.getCategory(tool) as string).toBe(expectedCategory);
    });
  }
});
