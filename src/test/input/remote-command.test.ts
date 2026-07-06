import { describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import { createShellPathService } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import type { PeerClient } from '@/runtime/index.ts';
import { getDistributedNodeHostContract } from '@/runtime/index.ts';
import { createStaticUiReadModel } from '../helpers/ui-read-models.ts';
import {
  getTestAgentManager,
  getTestRemoteRunnerRegistry,
  getTestRemoteSupervisor,
  resetTestRuntimeServices,
} from '../helpers/runtime-services.ts';

type CommandContextOverrides =
  Omit<Partial<CommandContext>, 'session' | 'provider' | 'workspace' | 'platform' | 'ops' | 'extensions'> & {
    session?: Partial<CommandContext['session']> & {
      runtime?: Partial<CommandContext['session']['runtime']>;
    };
    provider?: Partial<CommandContext['provider']>;
    workspace?: Partial<CommandContext['workspace']>;
    platform?: Partial<CommandContext['platform']>;
    ops?: Partial<CommandContext['ops']>;
    extensions?: Partial<CommandContext['extensions']>;
  };

function createRemoteCommandContext(
  store: ReturnType<typeof createRuntimeStore>,
  out: string[],
  overrides: CommandContextOverrides = {},
): CommandContext {
  const shellRoot = mkdtempSync(join(tmpdir(), 'gv-remote-shell-'));
  const remoteRunnerRegistry = getTestRemoteRunnerRegistry();
  const remoteSupervisor = getTestRemoteSupervisor();
  const remoteRuntime = {
    listActiveConnections: () => {
      const state = store.getState().acp;
      return state.activeConnectionIds
        .map((id) => state.connections.get(id))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    },
    getSnapshot: () => ({
      daemon: { transportState: 'connected', isRunning: true, reconnectAttempts: 0, runningJobCount: 0, lastError: undefined },
      acp: {
        transportState: store.getState().acp.managerTransportState,
        totalMessages: store.getState().acp.totalMessages,
        activeConnections: remoteRuntime.listActiveConnections(),
      },
      pools: remoteRunnerRegistry.listPools(),
      contracts: remoteRunnerRegistry.listContracts(),
      artifacts: remoteRunnerRegistry.listArtifacts(),
      supervisor: remoteSupervisor.getSnapshot(store),
      distributed: { pairRequests: [], peers: [], work: [] },
    }),
    listPools: () => remoteRunnerRegistry.listPools(),
    getPool: (id: string) => remoteRunnerRegistry.getPool(id),
    createPool: (input: { id: string; label: string }) => remoteRunnerRegistry.createPool(input),
    assignRunnerToPool: (poolId: string, runnerId: string) => remoteRunnerRegistry.assignRunnerToPool(poolId, runnerId),
    removeRunnerFromPool: (poolId: string, runnerId: string) => remoteRunnerRegistry.removeRunnerFromPool(poolId, runnerId),
    listContracts: () => remoteRunnerRegistry.listContracts(),
    getContract: (runnerId: string) => remoteRunnerRegistry.getContract(runnerId),
    registerContract: (contract: Parameters<typeof remoteRunnerRegistry.registerContract>[0]) => remoteRunnerRegistry.registerContract(contract),
    upsertContractForAgent: (runnerId: string) => remoteRunnerRegistry.upsertContractForAgent(runnerId, store),
    listArtifacts: () => remoteRunnerRegistry.listArtifacts(),
    getArtifact: (artifactId: string) => remoteRunnerRegistry.getArtifact(artifactId),
    buildReviewSummary: (artifactId: string) => remoteRunnerRegistry.buildReviewSummary(artifactId),
    exportArtifact: (artifactId: string, path?: string) => remoteRunnerRegistry.exportArtifact(artifactId, path),
    exportArtifactForAgent: async (agentId: string, path?: string) => {
      const artifact = remoteRunnerRegistry.captureArtifactForRunner(agentId, store);
      if (!artifact) return null;
      return remoteRunnerRegistry.exportArtifact(artifact.id, path);
    },
    importArtifact: (path: string) => remoteRunnerRegistry.importArtifact(path),
    exportSessionBundle: (path: string) => remoteRunnerRegistry.exportSessionBundle(store, path),
    importSessionBundle: (path: string) => remoteRunnerRegistry.importSessionBundle(path),
  };
  const peerClient: Pick<PeerClient, 'getSnapshot' | 'runners'> = {
    getSnapshot: () => ({
      capturedAt: Date.now(),
      nodeHostContract: getDistributedNodeHostContract(),
      acp: {
        transportState: store.getState().acp.managerTransportState,
        totalMessages: store.getState().acp.totalMessages,
        activeConnections: remoteRuntime.listActiveConnections(),
      },
      pairing: {
        requests: [],
        total: 0,
        pending: 0,
        approved: 0,
        verified: 0,
        rejected: 0,
        expired: 0,
      },
      peers: [],
      peerSnapshots: [],
      work: [],
      runners: {
        pools: remoteRunnerRegistry.listPools(),
        contracts: remoteRunnerRegistry.listContracts(),
        artifacts: remoteRunnerRegistry.listArtifacts(),
      },
      supervisor: remoteSupervisor.getSnapshot(store),
    }),
    runners: {
      listPools: () => remoteRunnerRegistry.listPools(),
      getPool: (id: string) => remoteRunnerRegistry.getPool(id),
      createPool: (input) => remoteRunnerRegistry.createPool(input),
      assignRunnerToPool: (poolId: string, runnerId: string) => remoteRunnerRegistry.assignRunnerToPool(poolId, runnerId),
      removeRunnerFromPool: (poolId: string, runnerId: string) => remoteRunnerRegistry.removeRunnerFromPool(poolId, runnerId),
      listContracts: () => remoteRunnerRegistry.listContracts(),
      getContract: (runnerId: string) => remoteRunnerRegistry.getContract(runnerId),
      registerContract: (contract) => remoteRunnerRegistry.registerContract(contract),
      upsertContractForAgent: (agentId: string) => remoteRunnerRegistry.upsertContractForAgent(agentId, store),
      listArtifacts: () => remoteRunnerRegistry.listArtifacts(),
      getArtifact: (artifactId: string) => remoteRunnerRegistry.getArtifact(artifactId),
      captureArtifactForAgent: (agentId: string) => remoteRunnerRegistry.captureArtifactForAgent(agentId, store),
      captureArtifactForRunner: (runnerId: string) => remoteRunnerRegistry.captureArtifactForRunner(runnerId, store),
      exportArtifact: (artifactId: string, path?: string) => remoteRunnerRegistry.exportArtifact(artifactId, path),
      importArtifact: (path: string) => remoteRunnerRegistry.importArtifact(path),
      buildReviewSummary: (artifactId: string) => remoteRunnerRegistry.buildReviewSummary(artifactId),
      exportSessionBundle: (path?: string) => remoteRunnerRegistry.exportSessionBundle(store, path),
      importSessionBundle: (path: string) => remoteRunnerRegistry.importSessionBundle(path),
    },
  };
  const providerRegistry = {} as never;
  const conversationManager = {} as never;
  const configManager = {} as never;
  const base: CommandContext = {
    session: {
      conversationManager,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-remote-command',
      },
    },
    provider: {
      providerRegistry,
    },
    workspace: {
      shellPaths: createShellPathService({
        workingDirectory: shellRoot,
        homeDirectory: shellRoot,
      }),
    },
    platform: {
      config: {} as never,
      configManager,
      readModels: {
        remote: createStaticUiReadModel(remoteRuntime.getSnapshot()),
      } as never,
    },
    ops: {
      remoteRuntime,
      agentManager: getTestAgentManager(),
    },
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
    },
    clients: {
      peer: peerClient as PeerClient,
    },
    renderRequest: () => {},
    print: (text: string) => { out.push(text); },
    exit: () => {},
  };
  return {
    ...base,
    ...overrides,
    session: {
      ...base.session,
      ...overrides.session,
    },
    provider: {
      ...base.provider,
      ...overrides.provider,
    },
    workspace: {
      ...base.workspace,
      ...overrides.workspace,
    },
    platform: {
      ...base.platform,
      ...overrides.platform,
    },
    ops: {
      ...base.ops,
      ...overrides.ops,
    },
    extensions: {
      ...base.extensions,
      ...overrides.extensions,
    },
  };
}

describe('remote command', () => {
  test('exports and imports remote review artifacts through the command surface', async () => {
    resetTestRuntimeServices();
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const remote = registry.get('remote');
    expect(remote).toBeDefined();

    const manager = getTestAgentManager();
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

    const ctx = createRemoteCommandContext(store, out);

    await remote!.handler(['export', agent.id, path], ctx);
    expect(existsSync(path)).toBe(true);
    expect(out.join('\n')).toContain('Exported remote review artifact');

    out.length = 0;
    await remote!.handler(['import', path], ctx);
    expect(out.join('\n')).toContain('Imported remote review artifact');
  });

  test('dispatches a self-hosted remote runner and can rerun imported work locally', async () => {
    resetTestRuntimeServices();
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const remote = registry.get('remote');
    expect(remote).toBeDefined();

    const store = createRuntimeStore();
    const spawn = mock(async () => 'remote-runner-1');
    const out: string[] = [];

    const ctx = createRemoteCommandContext(store, out, {
      ops: {
        acpManager: {
          spawn,
        } as never,
      },
    });

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
    resetTestRuntimeServices();
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const remote = registry.get('remote');
    expect(remote).toBeDefined();

    const store = createRuntimeStore();
    const out: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'gv-remote-env-'));
    const envPath = join(dir, 'remote-env.sh');

    const ctx = createRemoteCommandContext(store, out, {
      platform: {
        configManager: {
          getCategory: () => ({ daemon: false, httpListener: false }),
          get: (key: string) => (key === 'danger.daemon' ? false : undefined),
        } as never,
      },
    });

    await remote!.handler(['setup'], ctx);
    expect(out.join('\n')).toContain('Remote Setup Review');
    expect(out.join('\n')).toContain('acp agent command:');
    expect(out.join('\n')).toContain('daemon enabled: no');

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

  test('/remote setup reports the daemon enabled by default when the legacy alias is untouched, and honors an explicit override', async () => {
    // Same bug class as the onboarding daemon-default fix: danger.daemon has no
    // default of its own, so reading it directly reported "disabled" for a
    // fresh install even though the daemon runs by default via daemon.enabled.
    resetTestRuntimeServices();
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const remote = registry.get('remote');
    expect(remote).toBeDefined();

    const store = createRuntimeStore();
    const out: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'gv-remote-setup-daemon-'));

    const defaultCtx = createRemoteCommandContext(store, out, {
      platform: {
        configManager: {
          getCategory: () => ({ daemon: undefined, httpListener: false }),
          get: () => undefined,
        } as never,
      },
    });

    await remote!.handler(['setup'], defaultCtx);
    expect(out.join('\n')).toContain('daemon enabled: yes');

    out.length = 0;
    const defaultBundle = join(dir, 'remote-setup-default.json');
    await remote!.handler(['setup', 'export', defaultBundle], defaultCtx);
    expect(JSON.parse(readFileSync(defaultBundle, 'utf-8')).daemonEnabled).toBe(true);

    out.length = 0;
    const overrideCtx = createRemoteCommandContext(store, out, {
      platform: {
        configManager: {
          getCategory: () => ({ daemon: false, httpListener: false }),
          get: (key: string) => (key === 'danger.daemon' ? false : undefined),
        } as never,
      },
    });

    await remote!.handler(['setup'], overrideCtx);
    expect(out.join('\n')).toContain('daemon enabled: no');

    out.length = 0;
    const overrideBundle = join(dir, 'remote-setup-override.json');
    await remote!.handler(['setup', 'export', overrideBundle], overrideCtx);
    expect(JSON.parse(readFileSync(overrideBundle, 'utf-8')).daemonEnabled).toBe(false);
  });

  test('manages remote runner pools and pool-aware dispatch from the command surface', async () => {
    resetTestRuntimeServices();
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const remote = registry.get('remote');
    expect(remote).toBeDefined();

    const store = createRuntimeStore();
    const spawn = mock(async () => 'remote-runner-pool-1');
    const out: string[] = [];
    const ctx = createRemoteCommandContext(store, out, {
      platform: {
        configManager: {
          getCategory: () => ({ daemon: false, httpListener: false }),
          get: (key: string) => (key === 'danger.daemon' ? false : undefined),
        } as never,
      },
      session: {
        runtime: {
          model: '',
          provider: '',
          debugMode: false,
          systemPrompt: '',
          reasoningEffort: '',
          sessionId: 'sess-remote-pool',
        },
      },
      ops: {
        acpManager: {
          spawn,
        } as never,
      },
    });

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
    resetTestRuntimeServices();
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const teleport = registry.get('teleport');
    expect(teleport).toBeDefined();

    const store = createRuntimeStore();
    const out: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'gv-teleport-cmd-'));
    const ctx = createRemoteCommandContext(store, out, {
      session: {
        runtime: {
          model: '',
          provider: '',
          debugMode: false,
          systemPrompt: '',
          reasoningEffort: '',
          sessionId: 'sess-teleport-command',
        },
      },
    });
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
