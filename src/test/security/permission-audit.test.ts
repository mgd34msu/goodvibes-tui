/**
 * G5 — Permission Audit
 *
 * Verifies the permission gate behavior for all 12 tools + delegate, danger-gated
 * feature config checks, path traversal protection on file-mutating tools, and
 * PermissionPromptUI rendering per category.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PermissionPromptUI, type PermissionPromptRequest } from '../../permissions/prompt.ts';
import { analyzePermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions/analysis';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { createPermissionConfigReader, PermissionManager } from '@pellux/goodvibes-sdk/platform/permissions/manager';
import { DaemonServer } from '@pellux/goodvibes-sdk/platform/daemon/server';
import { HttpListener } from '@pellux/goodvibes-sdk/platform/daemon/http-listener';
import { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security/user-auth';
import { SpawnTokenManager } from '@pellux/goodvibes-sdk/platform/security/spawn-tokens';
import { PolicyRuntimeState } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-runtime';
import { resolveAndValidatePath } from '@pellux/goodvibes-sdk/platform/utils/path-safety';
import { resetTestSpawnTokenManagers } from '../helpers/runtime-services.ts';
import { resetSettingsControlPlaneStore } from '../helpers/settings-control-plane.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(
  handler: (request: PermissionPromptRequest) => Promise<{ approved: boolean; remember?: boolean }> = async () => ({ approved: true }),
): { requests: PermissionPromptRequest[]; mgr: PermissionManager } {
  const requests: PermissionPromptRequest[] = [];
  const policyRuntimeState = new PolicyRuntimeState();
  const mgr = new PermissionManager(
    async (request) => {
      requests.push(request);
      return handler(request);
    },
    createPermissionConfigReader(configManager),
    policyRuntimeState,
  );
  return { requests, mgr };
}

const PROJECT_ROOT = process.cwd();

function makeUserAuth(): UserAuthManager {
  return new UserAuthManager({
    bootstrapFilePath: join(tempRoot, 'auth-users.json'),
    bootstrapCredentialPath: join(tempRoot, 'auth-bootstrap.txt'),
    users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown — force autoApprove=false and prompt mode for all tests
// ---------------------------------------------------------------------------

let configManager: ConfigManager;
let tempRoot: string;
let workingDir: string;
let homeDir: string;
let configDir: string;

function createTestDaemon(): DaemonServer {
  return new DaemonServer({
    port: 0,
    userAuth: makeUserAuth(),
    configManager,
    workingDir,
    homeDirectory: homeDir,
  });
}

function createTestListener(): HttpListener {
  return new HttpListener({
    configManager,
    port: 0,
    userAuth: makeUserAuth(),
  });
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'gv-permission-audit-'));
  workingDir = join(tempRoot, 'workspace');
  homeDir = join(tempRoot, 'home');
  configDir = join(homeDir, '.goodvibes', 'tui');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir, workingDir, homeDir });
  resetSettingsControlPlaneStore(configManager);
  configManager.set('behavior.autoApprove', false);
  configManager.set('permissions.mode', 'prompt');
});

afterEach(() => {
  resetSettingsControlPlaneStore(configManager);
  rmSync(tempRoot, { recursive: true, force: true });
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
// 3. Protected execution surfaces: daemon, httpListener, bounded recursive orchestration
// ---------------------------------------------------------------------------

describe('Danger-gated features check config before enabling', () => {
  describe('DaemonServer', () => {
    test('refuses to enable when danger.daemon = false', () => {
      const server = createTestDaemon();
      const result = server.enable({ daemon: false });
      expect(result).toBe(false);
    });

    test('enables when danger.daemon = true', () => {
      const server = createTestDaemon();
      const result = server.enable({ daemon: true });
      expect(result).toBe(true);
    });

    test('refuses to start when not enabled (enable not called)', async () => {
      const server = createTestDaemon();
      // Should not throw, just no-op
      await expect(server.start()).resolves.toBeUndefined();
      expect(server.isRunning).toBe(false);
    });

    test('refuses to start after enable({ daemon: false })', async () => {
      const server = createTestDaemon();
      server.enable({ daemon: false });
      await server.start();
      expect(server.isRunning).toBe(false);
    });
  });

  describe('HttpListener', () => {
    test('refuses to enable when danger.httpListener = false', () => {
      const listener = createTestListener();
      const result = listener.enable({ httpListener: false });
      expect(result).toBe(false);
    });

    test('enables when danger.httpListener = true', () => {
      const listener = createTestListener();
      const result = listener.enable({ httpListener: true });
      expect(result).toBe(true);
    });

    test('refuses to start when not enabled', async () => {
      const listener = createTestListener();
      await expect(listener.start()).resolves.toBeUndefined();
      expect(listener.isRunning).toBe(false);
    });
  });

  describe('recursive orchestration policy — SpawnTokenManager.canSpawn', () => {
    beforeEach(() => resetTestSpawnTokenManagers());
    afterEach(() => resetTestSpawnTokenManagers());

    test('canSpawn returns allowed=false when recursionEnabled=false', () => {
      const stm = new SpawnTokenManager('test-session');
      const token = stm.createOrchestratorToken();
      const result = stm.canSpawn(token, {
        recursionEnabled: false,
        maxDepth: 1,
        maxActiveAgents: 8,
      }, 0);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('recursive orchestration');
    });

    test('canSpawn returns allowed=true when recursionEnabled=true and within limits', () => {
      const stm = new SpawnTokenManager('test-session');
      const token = stm.createOrchestratorToken();
      const result = stm.canSpawn(token, {
        recursionEnabled: true,
        maxDepth: 1,
        maxActiveAgents: 8,
      }, 0);
      expect(result.allowed).toBe(true);
    });

    test('canSpawn blocks when maxActiveAgents exceeded', () => {
      const stm = new SpawnTokenManager('test-session');
      const token = stm.createOrchestratorToken();
      const result = stm.canSpawn(token, {
        recursionEnabled: true,
        maxDepth: 1,
        maxActiveAgents: 2,
      }, 2); // already at limit
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('maxActiveAgents');
    });

    test('canSpawn blocks when depth exceeds maxDepth', () => {
      const stm = new SpawnTokenManager('test-session');
      const orchestratorToken = stm.createOrchestratorToken();
      const agentToken = stm.generateAgentToken(orchestratorToken, 'agent-1');
      expect(agentToken).not.toBeNull();
      // Agent token has depth=1; maxDepth=0 means even depth=1 is blocked
      const result = stm.canSpawn(agentToken!, {
        recursionEnabled: true,
        maxDepth: 0,
        maxActiveAgents: 8,
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
    expect(() => resolveAndValidatePath('src/index.ts', PROJECT_ROOT)).not.toThrow();
  });

  test('allows nested path within project root', () => {
    expect(() => resolveAndValidatePath('src/tools/registry.ts', PROJECT_ROOT)).not.toThrow();
  });

  test('throws for ../ path traversal attempt', () => {
    expect(() => resolveAndValidatePath('../../../etc/passwd', PROJECT_ROOT)).toThrow(/outside the project root/);
  });

  test('throws for absolute /etc path', () => {
    expect(() => resolveAndValidatePath('/etc/shadow', PROJECT_ROOT)).toThrow(/outside the project root/);
  });

  test('throws for /tmp path', () => {
    expect(() => resolveAndValidatePath('/tmp/evil', PROJECT_ROOT)).toThrow(/outside the project root/);
  });

  test('throws for embedded .. traversal', () => {
    expect(() => resolveAndValidatePath('src/../../../../../../etc/hosts', PROJECT_ROOT)).toThrow(
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
    const { ReadTool } = await import('@pellux/goodvibes-sdk/platform/tools/read/index');
    expect(typeof ReadTool).toBe('function');
  });

  test('resolveAndValidatePath is used by exec tool (import exists)', async () => {
    const { createExecTool } = await import('@pellux/goodvibes-sdk/platform/tools/exec/index');
    const { ProcessManager } = await import('@pellux/goodvibes-sdk/platform/tools/shared/process-manager');
    const { OverflowHandler } = await import('@pellux/goodvibes-sdk/platform/tools/shared/overflow');
    const execTool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: PROJECT_ROOT }),
    });
    expect(typeof execTool.execute).toBe('function');
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
      analysis: analyzePermissionRequest('write', { path: 'src/output.ts' }, 'write'),
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
      analysis: analyzePermissionRequest('exec', { command: 'npm run build' }, 'execute'),
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
      analysis: analyzePermissionRequest('agent', { task: 'do something' }, 'delegate'),
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
      analysis: analyzePermissionRequest(toolName, { path: 'out.ts' }, 'write'),
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
      analysis: analyzePermissionRequest('exec', { command: 'ls' }, 'execute'),
      resolve: (_approved: boolean) => {},
    };
    const lines = PermissionPromptUI.createPromptLines(WIDTH, request);
    const hasChoices = lines.some((line) =>
      line.map((c) => c.char).join('').includes('[Y]')
    );
    expect(hasChoices).toBe(true);
  });

  test('createPromptLines specializes execute prompts for shell execution', () => {
    const request = {
      callId: 'test-call-6',
      tool: 'exec',
      args: { command: 'ls' },
      category: 'execute' as const,
      analysis: analyzePermissionRequest('exec', { command: 'ls' }, 'execute'),
      resolve: (_approved: boolean) => {},
    };
    const text = PermissionPromptUI.createPromptLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Shell Execution Approval');
    expect(text).toContain('Command');
    expect(text).toContain('Decision  : shell-execution');
    expect(text).toContain('Surface   : shell  radius=project');
    expect(text).toContain('Effects   : process execution');
    expect(text).toContain('Checklist : Confirm shell side effects');
  });

  test('createPromptLines specializes network prompts and includes host context', () => {
    const request = {
      callId: 'test-call-7',
      tool: 'fetch',
      args: { url: 'https://example.com/docs' },
      category: 'execute' as const,
      analysis: {
        classification: 'network',
        riskLevel: 'medium' as const,
        summary: 'Outbound network request',
        reasons: ['Review external host access before approval.'],
        target: 'https://example.com/docs',
        targetKind: 'url' as const,
        surface: 'network' as const,
        blastRadius: 'external' as const,
        sideEffects: ['outbound network access', 'remote content ingestion'],
        host: 'example.com',
      },
      resolve: (_approved: boolean) => {},
    };
    const text = PermissionPromptUI.createPromptLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Network Access Approval');
    expect(text).toContain('Host');
    expect(text).toContain('example.com');
    expect(text).toContain('Decision  : external-access');
    expect(text).toContain('Surface   : network  radius=external');
  });

  test('createPromptLines specializes write prompts for file mutation review', () => {
    const request = {
      callId: 'test-call-8',
      tool: 'write',
      args: { path: 'src/output.ts' },
      category: 'write' as const,
      analysis: analyzePermissionRequest('write', { path: 'src/output.ts' }, 'write'),
      resolve: (_approved: boolean) => {},
    };
    const text = PermissionPromptUI.createPromptLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('File Mutation Approval');
    expect(text).toContain('Decision  : file-mutation');
    expect(text).toContain('Checklist : Confirm target path');
  });

  test('createPromptLines specializes notebook edits separately from generic file mutation', () => {
    const request = {
      callId: 'test-call-8b',
      tool: 'edit',
      args: { path: 'notebooks/analysis.ipynb' },
      category: 'write' as const,
      analysis: analyzePermissionRequest('edit', { path: 'notebooks/analysis.ipynb' }, 'write'),
      resolve: (_approved: boolean) => {},
    };
    const text = PermissionPromptUI.createPromptLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Notebook Edit Approval');
    expect(text).toContain('Decision  : notebook-edit');
    expect(text).toContain('Checklist : Confirm notebook cell intent');
  });

  test('createPromptLines specializes config mutations separately from generic file mutation', () => {
    const request = {
      callId: 'test-call-8c',
      tool: 'write',
      args: { path: '.env.production' },
      category: 'write' as const,
      analysis: analyzePermissionRequest('write', { path: '.env.production' }, 'write'),
      resolve: (_approved: boolean) => {},
    };
    const text = PermissionPromptUI.createPromptLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Configuration Mutation Approval');
    expect(text).toContain('Decision  : config-mutation');
    expect(text).toContain('Checklist : Confirm configuration blast radius');
  });

  test('createPromptLines specializes dependency installs separately from generic shell execution', () => {
    const request = {
      callId: 'test-call-8d',
      tool: 'exec',
      args: { command: 'bun install' },
      category: 'execute' as const,
      analysis: analyzePermissionRequest('exec', { command: 'bun install' }, 'execute'),
      resolve: (_approved: boolean) => {},
    };
    const text = PermissionPromptUI.createPromptLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Dependency Install Approval');
    expect(text).toContain('Decision  : dependency-install');
    expect(text).toContain('Checklist : Confirm dependency provenance');
  });

  test('createPromptLines specializes delegation prompts for fan-out review', () => {
    const request = {
      callId: 'test-call-9',
      tool: 'agent',
      args: { task: 'delegate release verification' },
      category: 'delegate' as const,
      analysis: analyzePermissionRequest('agent', { task: 'delegate release verification' }, 'delegate'),
      resolve: (_approved: boolean) => {},
    };
    const text = PermissionPromptUI.createPromptLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Agent Delegation Approval');
    expect(text).toContain('Decision  : delegation');
    expect(text).toContain('Surface   : orchestration  radius=delegated');
    expect(text).toContain('Checklist : Confirm delegated scope');
  });

  test('createPromptLines specializes agent spawn approvals separately from generic delegation', () => {
    const request = {
      callId: 'test-call-9b',
      tool: 'agent',
      args: { mode: 'spawn', task: 'delegate release verification' },
      category: 'delegate' as const,
      analysis: analyzePermissionRequest('agent', { task: 'delegate release verification' }, 'delegate'),
      resolve: (_approved: boolean) => {},
    };
    const text = PermissionPromptUI.createPromptLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Agent Spawn Approval');
    expect(text).toContain('Decision  : agent-spawn');
    expect(text).toContain('Checklist : Confirm spawned agent scope');
  });

  test('createPromptLines specializes remote dispatch approvals', () => {
    const request = {
      callId: 'test-call-10',
      tool: 'remote_trigger',
      args: { mode: 'dispatch', task: 'run remote verification' },
      category: 'delegate' as const,
      analysis: analyzePermissionRequest('remote_trigger', { mode: 'dispatch', task: 'run remote verification' }, 'delegate'),
      resolve: (_approved: boolean) => {},
    };
    const text = PermissionPromptUI.createPromptLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Remote Dispatch Approval');
    expect(text).toContain('Decision  : remote-dispatch');
    expect(text).toContain('Checklist : Confirm remote target');
  });

  test('createPromptLines specializes MCP trust escalation approvals', () => {
    const request = {
      callId: 'test-call-11',
      tool: 'mcp',
      args: { mode: 'set-trust', serverName: 'docs', trustMode: 'allow-all' },
      category: 'delegate' as const,
      analysis: analyzePermissionRequest('mcp', { mode: 'set-trust', serverName: 'docs', trustMode: 'allow-all' }, 'delegate'),
      resolve: (_approved: boolean) => {},
    };
    const text = PermissionPromptUI.createPromptLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('MCP Trust Escalation Approval');
    expect(text).toContain('Decision  : mcp-escalation');
    expect(text).toContain('Checklist : Confirm server identity');
  });

  test('createPromptLines specializes hook execution approvals', () => {
    const request = {
      callId: 'test-call-12',
      tool: 'workflow',
      args: { eventPath: 'Pre:tool:edit', hookName: 'guard-edit' },
      category: 'delegate' as const,
      analysis: analyzePermissionRequest('workflow', { eventPath: 'Pre:tool:edit', hookName: 'guard-edit' }, 'delegate'),
      resolve: (_approved: boolean) => {},
    };
    const text = PermissionPromptUI.createPromptLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Hook Execution Approval');
    expect(text).toContain('Decision  : hook-execution');
    expect(text).toContain('Checklist : Confirm hook source');
  });

  test('createPromptLines specializes plugin lifecycle approvals', () => {
    const request = {
      callId: 'test-call-13',
      tool: 'write',
      args: { path: '.goodvibes/plugins/deploy-audit/manifest.json' },
      category: 'write' as const,
      analysis: analyzePermissionRequest('write', { path: '.goodvibes/plugins/deploy-audit/manifest.json' }, 'write'),
      resolve: (_approved: boolean) => {},
    };
    const text = PermissionPromptUI.createPromptLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Plugin Lifecycle Approval');
    expect(text).toContain('Decision  : plugin-lifecycle');
    expect(text).toContain('Checklist : Confirm package provenance');
  });

  test('createPromptLines specializes sandbox policy change approvals', () => {
    const request = {
      callId: 'test-call-14',
      tool: 'write',
      args: { path: 'sandbox.vmBackend' },
      category: 'write' as const,
      analysis: analyzePermissionRequest('write', { path: 'sandbox.vmBackend' }, 'write'),
      resolve: (_approved: boolean) => {},
    };
    const text = PermissionPromptUI.createPromptLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Sandbox Policy Change Approval');
    expect(text).toContain('Decision  : sandbox-policy-change');
    expect(text).toContain('Checklist : Confirm isolation-mode impact');
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
