/**
 * The permission card the TUI draws for each request category: its label and
 * colour, the specialised card per decision kind, and the argument it shows.
 *
 * The gate itself (PermissionManager, the danger-gated daemon and listener,
 * spawn tokens, path validation) is SDK code and is tested in the SDK.
 */

import { describe, test, expect } from 'bun:test';
import { promptCardLines } from '../helpers/permission-card.ts';
import { activeTokens } from '../../renderer/theme.ts';
import { PermissionPromptUI } from '../../permissions/prompt.ts';
import { analyzePermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions';

describe('PermissionPromptUI: renders correctly per category', () => {
  const WIDTH = 80;

  test('write category: label is WRITE, color is the theme warning token', () => {
    const { label, color } = PermissionPromptUI.getCategoryLabel('write');
    expect(label).toBe('WRITE');
    expect(color).toBe(activeTokens().warning);
  });

  test('execute category: label is EXECUTE, color is the theme error token', () => {
    const { label, color } = PermissionPromptUI.getCategoryLabel('execute');
    expect(label).toBe('EXECUTE');
    expect(color).toBe(activeTokens().error);
  });

  test('delegate category: label is DELEGATE, color is the theme blocked token', () => {
    const { label, color } = PermissionPromptUI.getCategoryLabel('delegate');
    expect(label).toBe('DELEGATE');
    expect(color).toBe(activeTokens().blocked);
  });

  test('read category: falls through to default PERMISSION label', () => {
    // read is auto-approved and never shown in a prompt, but getCategoryLabel is a pure function
    const { label } = PermissionPromptUI.getCategoryLabel('read' as Parameters<typeof PermissionPromptUI.getCategoryLabel>[0]);
    expect(label).toBe('PERMISSION');
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
    const lines = promptCardLines(WIDTH, request);
    // Line is Cell[], join chars to get the text content of each line
    const hasExecuteLabel = lines.some((line) =>
      line.map((c) => c.char).join('').includes('EXECUTE')
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
    const lines = promptCardLines(WIDTH, request);
    const hasDelegateLabel = lines.some((line) =>
      line.map((c) => c.char).join('').includes('DELEGATE')
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
    const lines = promptCardLines(WIDTH, request);
    const hasToolName = lines.some((line) =>
      line.map((c) => c.char).join('').includes(toolName)
    );
    expect(hasToolName).toBe(true);
  });

  test('the card offers Allow once as a button and y as its key', () => {
    const request = {
      callId: 'test-call-5',
      tool: 'exec',
      args: { command: 'ls' },
      category: 'execute' as const,
      analysis: analyzePermissionRequest('exec', { command: 'ls' }, 'execute'),
      resolve: (_approved: boolean) => {},
    };
    const lines = promptCardLines(WIDTH, request);
    const text = lines.map((line) => line.map((c) => c.char).join('')).join('\n');
    expect(text).toContain(' Allow once ');
    expect(text).toContain(' y  allow once');
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
    const text = promptCardLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Shell Execution Approval');
    expect(text).toContain('$ ls');
    expect(text).toMatch(/Decision +shell\-execution/);
    expect(text).toMatch(/Surface +shell · radius project/);
    expect(text).toMatch(/Effects +process\ execution/);
    expect(text).toMatch(/Checklist +Confirm\ shell\ side\ effects/);
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
    const text = promptCardLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Network Access Approval');
    expect(text).toContain('Host');
    expect(text).toContain('example.com');
    expect(text).toMatch(/Decision +external\-access/);
    expect(text).toMatch(/Surface +network · radius external/);
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
    const text = promptCardLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('File Mutation Approval');
    expect(text).toMatch(/Decision +file\-mutation/);
    expect(text).toMatch(/Checklist +Confirm\ target\ path/);
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
    const text = promptCardLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Notebook Edit Approval');
    expect(text).toMatch(/Decision +notebook\-edit/);
    expect(text).toMatch(/Checklist +Confirm\ notebook\ cell\ intent/);
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
    const text = promptCardLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Configuration Mutation Approval');
    expect(text).toMatch(/Decision +config\-mutation/);
    expect(text).toMatch(/Checklist +Confirm\ configuration\ blast\ radius/);
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
    const text = promptCardLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Dependency Install Approval');
    expect(text).toMatch(/Decision +dependency\-install/);
    expect(text).toMatch(/Checklist +Confirm\ dependency\ provenance/);
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
    const text = promptCardLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Agent Delegation Approval');
    expect(text).toMatch(/Decision +delegation/);
    expect(text).toMatch(/Surface +orchestration · radius delegated/);
    expect(text).toMatch(/Checklist +Confirm\ delegated\ scope/);
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
    const text = promptCardLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Agent Spawn Approval');
    expect(text).toMatch(/Decision +agent\-spawn/);
    expect(text).toMatch(/Checklist +Confirm\ spawned\ agent\ scope/);
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
    const text = promptCardLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Remote Dispatch Approval');
    expect(text).toMatch(/Decision +remote\-dispatch/);
    expect(text).toMatch(/Checklist +Confirm\ remote\ target/);
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
    const text = promptCardLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('MCP Trust Escalation Approval');
    expect(text).toMatch(/Decision +mcp\-escalation/);
    expect(text).toMatch(/Checklist +Confirm\ server\ identity/);
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
    const text = promptCardLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Hook Execution Approval');
    expect(text).toMatch(/Decision +hook\-execution/);
    expect(text).toMatch(/Checklist +Confirm\ hook\ source/);
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
    const text = promptCardLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Plugin Lifecycle Approval');
    expect(text).toMatch(/Decision +plugin\-lifecycle/);
    expect(text).toMatch(/Checklist +Confirm\ package\ provenance/);
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
    const text = promptCardLines(WIDTH, request)
      .map((line) => line.map((c) => c.char).join(''))
      .join('\n');
    expect(text).toContain('Sandbox Policy Change Approval');
    expect(text).toMatch(/Decision +sandbox\-policy\-change/);
    expect(text).toMatch(/Checklist +Confirm\ isolation\-mode\ impact/);
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
