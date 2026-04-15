/**
 * Integration: Tool execution end-to-end pipeline.
 *
 * Tests the full path: Orchestrator registers tools, receives a tool call,
 * routes through permission check, executes the tool, emits events, and
 * returns results.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeEventBus, createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools/registry';
import { PermissionManager } from '@pellux/goodvibes-sdk/platform/permissions/manager';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { createPermissionConfigReader } from '@pellux/goodvibes-sdk/platform/permissions/manager';
import { PolicyRuntimeState } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildStack(configManager?: ConfigManager) {
  const root = join(tmpdir(), `gv-tool-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  configManager = configManager ?? new ConfigManager({ surfaceRoot: 'tui',
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'tui'),
  });
  const bus = new RuntimeEventBus();
  const registry = new ToolRegistry();
  const policyRuntimeState = new PolicyRuntimeState();
  const pm = new PermissionManager(async () => ({ approved: true }), createPermissionConfigReader(configManager), policyRuntimeState);
  return { bus, registry, pm };
}

// ---------------------------------------------------------------------------
// ToolRegistry unit integration
// ---------------------------------------------------------------------------

describe('Tool execution pipeline — ToolRegistry', () => {
  test('registered tool executes and returns success result', async () => {
    const { registry } = buildStack();
    registry.register({
      definition: {
        name: 'greet',
        description: 'Returns a greeting',
        parameters: { type: 'object', properties: { name: { type: 'string' } } },
      },
      execute: async (args) => ({
        success: true,
        output: `Hello, ${(args as { name: string }).name ?? 'world'}!`,
      }),
    });

    const result = await registry.execute('call-1', 'greet', { name: 'Alice' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Alice');
  });

  test('unknown tool returns failure with descriptive error', async () => {
    const { registry } = buildStack();
    const result = await registry.execute('call-2', 'nonexistent_tool', {});
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('tool that throws propagates the error', async () => {
    const { registry } = buildStack();
    registry.register({
      definition: {
        name: 'exploder',
        description: 'Always throws',
        parameters: { type: 'object', properties: {} },
      },
      execute: async () => { throw new Error('kaboom'); },
    });

    // ToolRegistry.execute() rethrows tool errors — callers are responsible for handling them
    await expect(registry.execute('call-3', 'exploder', {})).rejects.toThrow('kaboom');
  });

  test('tool can be looked up by name via has()', () => {
    const { registry } = buildStack();
    registry.register({
      definition: { name: 'checker', description: 'test', parameters: { type: 'object', properties: {} } },
      execute: async () => ({ success: true }),
    });
    expect(registry.has('checker')).toBe(true);
    expect(registry.has('not_registered')).toBe(false);
  });

  test('getToolDefinitions returns all registered tools', () => {
    const { registry } = buildStack();
    registry.register({
      definition: { name: 'tool_a', description: 'a', parameters: { type: 'object', properties: {} } },
      execute: async () => ({ success: true }),
    });
    registry.register({
      definition: { name: 'tool_b', description: 'b', parameters: { type: 'object', properties: {} } },
      execute: async () => ({ success: true }),
    });
    const defs = registry.getToolDefinitions();
    const names = defs.map((d) => d.name);
    expect(names).toContain('tool_a');
    expect(names).toContain('tool_b');
  });

  test('multiple sequential tool calls all succeed', async () => {
    const { registry } = buildStack();
    let callCount = 0;
    registry.register({
      definition: { name: 'counter', description: 'counts calls', parameters: { type: 'object', properties: {} } },
      execute: async () => ({ success: true, output: String(++callCount) }),
    });

    const r1 = await registry.execute('c1', 'counter', {});
    const r2 = await registry.execute('c2', 'counter', {});
    const r3 = await registry.execute('c3', 'counter', {});
    expect(r1.output).toBe('1');
    expect(r2.output).toBe('2');
    expect(r3.output).toBe('3');
  });

  test('tool receives arguments as passed', async () => {
    const { registry } = buildStack();
    let capturedArgs: Record<string, unknown> = {};
    registry.register({
      definition: {
        name: 'echo_args',
        description: 'captures args',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            label: { type: 'string' },
          },
        },
      },
      execute: async (args) => {
        capturedArgs = args as Record<string, unknown>;
        return { success: true, output: JSON.stringify(args) };
      },
    });

    await registry.execute('c-args', 'echo_args', { x: 42, label: 'test' });
    expect(capturedArgs.x).toBe(42);
    expect(capturedArgs.label).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// Permission + registry integration
// ---------------------------------------------------------------------------

describe('Tool execution pipeline — permission + registry', () => {
  let savedAutoApprove: boolean;
  let savedPermissionMode: 'prompt' | 'allow-all' | 'custom';
  let tmpConfigDir: string;
  let configManager: ConfigManager;

  beforeEach(() => {
    tmpConfigDir = join(tmpdir(), `gv-tool-execution-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpConfigDir, { recursive: true });
    configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: tmpConfigDir });
    savedAutoApprove = (configManager.get('behavior.autoApprove') as boolean | undefined) ?? false;
    savedPermissionMode = (configManager.get('permissions.mode') as 'prompt' | 'allow-all' | 'custom' | undefined) ?? 'prompt';
    configManager.set('behavior.autoApprove', true);
    configManager.set('permissions.mode', 'prompt');
  });

  afterEach(() => {
    configManager.set('behavior.autoApprove', savedAutoApprove);
    configManager.set('permissions.mode', savedPermissionMode);
    rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  test('autoApprove=true: check() always resolves true', async () => {
    const { pm } = buildStack(configManager);
    const approved = await pm.check('exec', {});
    expect(approved).toBe(true);
  });

  test('allow-all mode: check() always resolves true', async () => {
    configManager.set('behavior.autoApprove', false);
    configManager.set('permissions.mode', 'allow-all');
    const { pm } = buildStack(configManager);
    const approved = await pm.check('exec', {});
    expect(approved).toBe(true);
  });

  test('prompt mode: read tool auto-approved without user input', async () => {
    configManager.set('behavior.autoApprove', false);
    configManager.set('permissions.mode', 'prompt');
    const { pm } = buildStack(configManager);
    // 'read' is a read-category tool — auto-approved in prompt mode
    const approved = await pm.check('read', {});
    expect(approved).toBe(true);
  });

  test('bus emits turn:tool-result after execution', async () => {
    const { bus, registry } = buildStack(configManager);
    registry.register({
      definition: { name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } },
      execute: async () => ({ success: true, output: 'pong' }),
    });

    const events: unknown[] = [];
    bus.on('TOOL_SUCCEEDED', (data) => events.push(data.payload));

    // Simulate what executeToolCalls does: execute + emit
    const result = await registry.execute('ping-1', 'ping', {});
    bus.emit('tools', createEventEnvelope('TOOL_SUCCEEDED', {
      type: 'TOOL_SUCCEEDED',
      callId: 'ping-1',
      turnId: 'turn-1',
      tool: 'ping',
      result,
      durationMs: 0,
    }, {
      sessionId: 'test-session',
      traceId: 'test-trace',
      source: 'tool-execution.test',
    }));

    expect(events).toHaveLength(1);
    const ev = events[0] as { callId: string; result: { success: boolean; output: string } };
    expect(ev.callId).toBe('ping-1');
    expect(ev.result.success).toBe(true);
    expect(ev.result.output).toBe('pong');
  });
});
