import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import { registerAllTools } from '@pellux/goodvibes-sdk/platform/tools';
import { createTestManagers } from '../helpers/test-managers.ts';
import { CrossSessionTaskRegistry } from '@pellux/goodvibes-sdk/platform/sessions';
import { SandboxSessionRegistry } from '@/runtime/index.ts';
import { RemoteRunnerRegistry } from '@/runtime/index.ts';
import { AgentMessageBus } from '@pellux/goodvibes-sdk/platform/agents';
import { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import { OverflowHandler } from '@pellux/goodvibes-sdk/platform/tools';
import { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state';
import { ModeManager } from '@pellux/goodvibes-sdk/platform/state';
import { ProcessManager } from '@pellux/goodvibes-sdk/platform/tools';
import { createWorkflowServices } from '@pellux/goodvibes-sdk/platform/tools';

function registerTools(registry: ToolRegistry): void {
  const services = createTestManagers();
  const workingDirectory = mkdtempSync(join(tmpdir(), 'gv-tool-registry-'));
  const agentManager = new AgentManager({
    messageBus: new AgentMessageBus(),
    configManager: services.configManager,
  });
  const sessionOrchestration = new CrossSessionTaskRegistry(
    join(workingDirectory, '.goodvibes', 'tui', 'sessions', 'task-graph.json'),
  );
  const sandboxSessionRegistry = new SandboxSessionRegistry(workingDirectory);
  const remoteRunnerRegistry = new RemoteRunnerRegistry(agentManager);
  const agentMessageBus = new AgentMessageBus();
  registerAllTools(registry, {
    surfaceRoot: 'tui',
    fileUndoManager: new FileUndoManager(),
    modeManager: new ModeManager(),
    processManager: new ProcessManager(),
    agentManager,
    agentMessageBus,
    configManager: services.configManager,
    providerRegistry: services.providerRegistry,
    toolLLM: services.toolLLM,
    sessionOrchestration,
    sandboxSessionRegistry,
    workingDirectory,
    overflowHandler: new OverflowHandler({ baseDir: workingDirectory }),
    webSearchService: {
      search: async () => [],
    } as never,
    channelRegistry: null,
    remoteRunnerRegistry,
    workflowServices: createWorkflowServices(),
    mcpRegistry: {
      list: () => [],
    } as never,
  });
}

describe('registerAllTools', () => {
  test('registers exactly 25 tools', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    expect(registry.list()).toHaveLength(25);
  });

  test('registers a tool named "read"', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    expect(registry.has('read')).toBe(true);
  });

  test('registers a tool named "write"', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    expect(registry.has('write')).toBe(true);
  });

  test('registers a tool named "edit"', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    expect(registry.has('edit')).toBe(true);
  });

  test('registers a tool named "find"', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    expect(registry.has('find')).toBe(true);
  });

  test('registers a tool named "exec"', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    expect(registry.has('exec')).toBe(true);
  });

  test('registers a tool named "analyze"', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    expect(registry.has('analyze')).toBe(true);
  });

  test('registers a tool named "inspect"', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    expect(registry.has('inspect')).toBe(true);
  });

  test('registers a tool named "agent"', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    expect(registry.has('agent')).toBe(true);
  });

  test('registers a tool named "state"', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    expect(registry.has('state')).toBe(true);
  });

  test('registers a tool named "workflow"', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    expect(registry.has('workflow')).toBe(true);
  });

  test('registers a tool named "fetch"', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    expect(registry.has('fetch')).toBe(true);
  });

  test('registers a tool named "web_search"', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    expect(registry.has('web_search')).toBe(true);
  });

  test('registers a tool named "registry"', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    expect(registry.has('registry')).toBe(true);
  });

  test('registers breadth tools for channel, control, task, team, worklist, mcp, query, packet, remote, and repl', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    for (const name of ['channel', 'control', 'task', 'team', 'worklist', 'mcp', 'query', 'packet', 'remote', 'repl']) {
      expect(registry.has(name)).toBe(true);
    }
    expect(registry.has('powershell')).toBe(false);
  });

  test('registers SDK-owned GoodVibes context and settings tools', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    expect(registry.has('goodvibes_context')).toBe(true);
    expect(registry.has('goodvibes_settings')).toBe(true);
  });

  test('each tool has a definition with name and description', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    for (const tool of registry.list()) {
      expect(typeof tool.definition.name).toBe('string');
      expect(tool.definition.name.length).toBeGreaterThan(0);
      expect(typeof tool.definition.description).toBe('string');
      expect(tool.definition.description.length).toBeGreaterThan(0);
      expect(typeof tool.definition.parameters).toBe('object');
    }
  });

  test('each tool has an execute function', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    for (const tool of registry.list()) {
      expect(typeof tool.execute).toBe('function');
    }
  });
});
