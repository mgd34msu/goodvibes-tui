import { describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { AgentManager } from '../../tools/agent/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { _resetRemoteRunnerRegistryForTesting } from '../../runtime/remote/index.ts';

describe('remote command', () => {
  test('exports and imports remote review artifacts through the command surface', async () => {
    AgentManager.resetInstance();
    _resetRemoteRunnerRegistryForTesting();
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const remote = registry.get('remote');
    expect(remote).toBeDefined();

    const manager = AgentManager.getInstance();
    const agent = manager.spawn({
      mode: 'spawn',
      task: 'Export remote review artifact',
      template: 'engineer',
      tools: ['read'],
      dangerously_disable_wrfc: true,
    });
    agent.status = 'completed';
    agent.fullOutput = 'Artifact generated.';
    agent.completedAt = Date.now();

    const store = createRuntimeStore();
    store.setState((state) => ({
      ...state,
      acp: {
        ...state.acp,
        activeConnectionIds: [agent.id],
        connections: new Map([
          [agent.id, {
            agentId: agent.id,
            label: 'remote export worker',
            transportState: 'connected',
            connectedAt: Date.now(),
            completing: false,
            messageCount: 3,
            errorCount: 0,
            taskId: 'task-export',
          }],
        ]),
      },
    }));

    const out: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'gv-remote-cmd-'));
    const path = join(dir, 'review-artifact.json');

    const ctx = {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-remote-command',
      },
      renderRequest: () => {},
      print: (text: string) => { out.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      runtimeStore: store,
    };

    await remote!.handler(['export', agent.id, path], ctx);
    expect(existsSync(path)).toBe(true);
    expect(out.join('\n')).toContain('Exported remote review artifact');

    out.length = 0;
    await remote!.handler(['import', path], ctx);
    expect(out.join('\n')).toContain('Imported remote review artifact');
  });

  test('dispatches a self-hosted remote runner and can rerun imported work locally', async () => {
    AgentManager.resetInstance();
    _resetRemoteRunnerRegistryForTesting();
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const remote = registry.get('remote');
    expect(remote).toBeDefined();

    const store = createRuntimeStore();
    const spawn = mock(async () => 'remote-runner-1');
    const out: string[] = [];

    const ctx = {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-remote-command',
      },
      renderRequest: () => {},
      print: (text: string) => { out.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      runtimeStore: store,
      acpManager: {
        spawn,
      } as never,
    };

    await remote!.handler(['dispatch', 'researcher', 'Inspect', 'deployment', 'logs'], ctx);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(out.join('\n')).toContain('Dispatched remote runner remote-runner-1');

    store.setState((state) => ({
      ...state,
      acp: {
        ...state.acp,
        connections: new Map([
          ['remote-runner-1', {
            agentId: 'remote-runner-1',
            label: 'researcher remote runner',
            transportState: 'connected',
            connectedAt: Date.now(),
            completing: false,
            messageCount: 2,
            errorCount: 0,
            taskId: 'task-remote-1',
          }],
        ]),
        activeConnectionIds: ['remote-runner-1'],
      },
      tasks: {
        ...state.tasks,
        tasks: new Map([
          ['task-remote-1', {
            id: 'task-remote-1',
            kind: 'acp',
            title: 'Inspect deployment logs',
            description: 'Inspect deployment logs',
            status: 'running',
            owner: 'remote-runner-1',
            cancellable: true,
            childTaskIds: [],
            queuedAt: Date.now() - 1_000,
            startedAt: Date.now() - 900,
          }],
        ]),
        runningIds: ['task-remote-1'],
      },
    }));

    out.length = 0;
    await remote!.handler(['export', 'remote-runner-1'], ctx);
    expect(out.join('\n')).toContain('Exported remote review artifact');

    const artifactId = out.join('\n').match(/artifact:[^\s]+/)?.[0];
    expect(artifactId).toBeDefined();

    out.length = 0;
    await remote!.handler(['rerun-local', artifactId!], ctx);
    expect(out.join('\n')).toContain('Spawned local rerun agent');
  });

  test('renders remote setup guidance and exports reusable environment snippets', async () => {
    AgentManager.resetInstance();
    _resetRemoteRunnerRegistryForTesting();
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const remote = registry.get('remote');
    expect(remote).toBeDefined();

    const store = createRuntimeStore();
    const out: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'gv-remote-env-'));
    const envPath = join(dir, 'remote-env.sh');

    const ctx = {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {
        getCategory: () => ({ daemon: false, httpListener: false }),
      } as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-remote-command',
      },
      renderRequest: () => {},
      print: (text: string) => { out.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      runtimeStore: store,
    };

    await remote!.handler(['setup'], ctx);
    expect(out.join('\n')).toContain('Remote Setup Review');
    expect(out.join('\n')).toContain('acp agent command:');

    out.length = 0;
    const setupBundle = join(dir, 'remote-setup.json');
    await remote!.handler(['setup', 'export', setupBundle], ctx);
    expect(out.join('\n')).toContain('Exported remote setup bundle');
    expect(readFileSync(setupBundle, 'utf-8')).toContain('acpAgentCommand');

    out.length = 0;
    await remote!.handler(['env', 'export', envPath], ctx);
    expect(out.join('\n')).toContain('Exported remote environment snippet');
    expect(readFileSync(envPath, 'utf-8')).toContain('ACP_AGENT_CMD');

    out.length = 0;
    const tunnelPath = join(dir, 'remote-tunnel.txt');
    await remote!.handler(['tunnel', 'export', tunnelPath], ctx);
    expect(out.join('\n')).toContain('Exported remote tunnel review');
    expect(readFileSync(tunnelPath, 'utf-8')).toContain('Remote Tunnel Review');

    out.length = 0;
    const bootstrapPath = join(dir, 'remote-bootstrap.json');
    await remote!.handler(['bootstrap', 'export', bootstrapPath], ctx);
    expect(out.join('\n')).toContain('Exported remote bootstrap bundle');
    expect(readFileSync(bootstrapPath, 'utf-8')).toContain('GOODVIBES_REMOTE_SESSION');

    out.length = 0;
    await remote!.handler(['bootstrap', 'inspect', bootstrapPath], ctx);
    expect(out.join('\n')).toContain('Remote Bootstrap Bundle Review');
  });

  test('manages remote runner pools and pool-aware dispatch from the command surface', async () => {
    AgentManager.resetInstance();
    _resetRemoteRunnerRegistryForTesting();
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const remote = registry.get('remote');
    expect(remote).toBeDefined();

    const store = createRuntimeStore();
    const spawn = mock(async () => 'remote-runner-pool-1');
    const out: string[] = [];
    const ctx = {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {
        getCategory: () => ({ daemon: false, httpListener: false }),
      } as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-remote-pool',
      },
      renderRequest: () => {},
      print: (text: string) => { out.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      runtimeStore: store,
      acpManager: {
        spawn,
      } as never,
    };

    await remote!.handler(['pool', 'create', 'ops', 'Ops Pool'], ctx);
    expect(out.join('\n')).toContain('Created remote runner pool ops');

    out.length = 0;
    await remote!.handler(['dispatch-pool', 'ops', 'engineer', 'Triage', 'incident'], ctx);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(out.join('\n')).toContain('Dispatched remote runner remote-runner-pool-1 via pool ops');

    out.length = 0;
    await remote!.handler(['pool', 'show', 'ops'], ctx);
    expect(out.join('\n')).toContain('Remote Runner Pool ops');
    expect(out.join('\n')).toContain('remote-runner-pool-1');

    out.length = 0;
    await remote!.handler(['list'], ctx);
    expect(out.join('\n')).toContain('runner pools: 1');
  });

  test('teleport command exports, inspects, and imports portable remote-session bundles', async () => {
    AgentManager.resetInstance();
    _resetRemoteRunnerRegistryForTesting();
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const teleport = registry.get('teleport');
    expect(teleport).toBeDefined();

    const store = createRuntimeStore();
    const out: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'gv-teleport-cmd-'));
    const ctx = {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-teleport-command',
      },
      renderRequest: () => {},
      print: (text: string) => { out.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      runtimeStore: store,
    };
    store.setState((state) => ({
      ...state,
      acp: {
        ...state.acp,
        activeConnectionIds: ['runner-1'],
        connections: new Map([
          ['runner-1', {
            agentId: 'runner-1',
            label: 'remote runner',
            transportState: 'connected',
            completing: false,
            connectedAt: 123,
            messageCount: 4,
            errorCount: 0,
            taskId: 'task-1',
            lastError: undefined,
          }],
        ]),
      },
    }));

    const bundlePath = join(dir, 'teleport.json');
    await teleport!.handler(['export', bundlePath], ctx);
    expect(out.join('\n')).toContain('Teleport bundle exported');

    out.length = 0;
    await teleport!.handler(['inspect', bundlePath], ctx);
    expect(out.join('\n')).toContain('Teleport Bundle Review');

    out.length = 0;
    await teleport!.handler(['import', bundlePath], ctx);
    expect(out.join('\n')).toContain('Imported teleport bundle');
  });
});
