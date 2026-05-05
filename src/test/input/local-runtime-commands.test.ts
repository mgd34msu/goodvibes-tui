import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerRemoteRuntimeCommands } from '../../input/commands/remote-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import { createStaticUiReadModel } from '../helpers/ui-read-models.ts';
import {
  getTestAgentManager,
  getTestRemoteRunnerRegistry,
  getTestRemoteSupervisor,
  resetTestRuntimeServices,
} from '../helpers/runtime-services.ts';

function makeContext(store = createRuntimeStore()) {
  const printed: string[] = [];
  const shellRoot = mkdtempSync(join(tmpdir(), 'gv-local-remote-shell-'));
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
  const providerRegistry = {} as never;
  const conversationManager = {} as never;
  const configManager = {} as never;
  const context: CommandContext = {
    session: {
      conversationManager,
      runtime: {
        model: 'mock',
        provider: 'mock',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: 'medium',
        sessionId: 'session-test',
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
      peer: {
        getSnapshot: () => ({
          capturedAt: Date.now(),
          nodeHostContract: {
            schemaVersion: 'v1',
            platform: 'test',
            capabilities: [],
          },
          acp: remoteRuntime.getSnapshot().acp,
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
            pools: remoteRuntime.listPools(),
            contracts: remoteRuntime.listContracts(),
            artifacts: remoteRuntime.listArtifacts(),
          },
          supervisor: remoteRuntime.getSnapshot().supervisor,
        }),
        runners: {
          listPools: () => [...remoteRuntime.listPools()],
          getPool: (poolId: string) => remoteRuntime.getPool(poolId),
          createPool: (input: { id: string; label: string }) => remoteRuntime.createPool(input),
          assignRunnerToPool: (poolId: string, runnerId: string) => remoteRuntime.assignRunnerToPool(poolId, runnerId),
          removeRunnerFromPool: (poolId: string, runnerId: string) => remoteRuntime.removeRunnerFromPool(poolId, runnerId),
          listContracts: () => [...remoteRuntime.listContracts()],
          getContract: (runnerId: string) => remoteRuntime.getContract(runnerId),
          registerContract: (contract: Parameters<typeof remoteRuntime.registerContract>[0]) => remoteRuntime.registerContract(contract),
          upsertContractForAgent: (agentId: string) => remoteRuntime.upsertContractForAgent(agentId),
          listArtifacts: () => [...remoteRuntime.listArtifacts()],
          getArtifact: (artifactId: string) => remoteRuntime.getArtifact(artifactId),
          captureArtifactForAgent: () => null,
          captureArtifactForRunner: () => null,
          exportArtifact: (artifactId: string, path?: string) => remoteRuntime.exportArtifact(artifactId, path),
          importArtifact: (path: string) => remoteRuntime.importArtifact(path),
          buildReviewSummary: (artifactId: string) => remoteRuntime.buildReviewSummary(artifactId),
          exportSessionBundle: (path?: string) => remoteRuntime.exportSessionBundle(path ?? ''),
          importSessionBundle: (path: string) => remoteRuntime.importSessionBundle(path),
        },
      } as never,
    },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  };

  return {
    printed,
    context,
  };
}

describe('local runtime remote commands', () => {
  test('shows active remote connection details', async () => {
    const registry = new CommandRegistry();
    registerRemoteRuntimeCommands(registry);
    const store = createRuntimeStore();
    store.setState((state) => ({
      ...state,
      acp: {
        ...state.acp,
        activeConnectionIds: ['agent-remote'],
        connections: new Map([
          ['agent-remote', {
            agentId: 'agent-remote',
            label: 'remote researcher',
            transportState: 'connected',
            connectedAt: 1_700_000_000_000,
            completing: false,
            messageCount: 5,
            errorCount: 1,
            lastError: 'network blip',
            taskId: 'task-remote',
          }],
        ]),
      },
    }));
    const { context, printed } = makeContext(store);

    await registry.execute('remote', ['show', 'agent-remote'], context);

    expect(printed.join('\n')).toContain('Remote connection agent-remote');
    expect(printed.join('\n')).toContain('remote researcher');
    expect(printed.join('\n')).toContain('task-remote');
  });

  test('cancels a remote agent through the normal agent manager path', async () => {
    resetTestRuntimeServices();
    const manager = getTestAgentManager();
    const record = manager.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [], orchestrationNodeId: 'remote-node', orchestrationGraphId: 'graph-remote' });

    const registry = new CommandRegistry();
    registerRemoteRuntimeCommands(registry);
    const store = createRuntimeStore();
    store.setState((state) => ({
      ...state,
      acp: {
        ...state.acp,
        activeConnectionIds: [record.id],
        connections: new Map([
          [record.id, {
            agentId: record.id,
            label: 'remote worker',
            transportState: 'connected',
            connectedAt: Date.now(),
            completing: false,
            messageCount: 0,
            errorCount: 0,
          }],
        ]),
      },
    }));
    const { context, printed } = makeContext(store);

    await registry.execute('remote', ['cancel', record.id], context);

    expect(manager.getStatus(record.id)?.status).toBe('cancelled');
    expect(printed.join('\n')).toContain(`Cancelled remote agent ${record.id}`);
  });
});
