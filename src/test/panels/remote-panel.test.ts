import { describe, expect, test } from 'bun:test';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { RemotePanel } from '../../panels/remote-panel.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import { RemoteRunnerRegistry, RemoteSupervisor } from '@pellux/goodvibes-sdk/platform/runtime/remote/index';
import type { UiRemoteSnapshot } from '../../runtime/ui-read-models.ts';
import { getTestAgentManager, resetTestRuntimeServices } from '../helpers/runtime-services.ts';
import { createStoreBackedUiReadModel } from '../helpers/ui-read-models.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

function createRemoteReadModel(
  store: ReturnType<typeof createRuntimeStore>,
  remoteRunnerRegistry = new RemoteRunnerRegistry(getTestAgentManager()),
) {
  const remoteSupervisor = new RemoteSupervisor(remoteRunnerRegistry);
  return createStoreBackedUiReadModel<UiRemoteSnapshot>(store, () => ({
    daemon: {
      transportState: store.getState().daemon.transportState,
      isRunning: store.getState().daemon.isRunning,
      reconnectAttempts: store.getState().daemon.reconnectAttempts,
      runningJobCount: store.getState().daemon.runningJobCount,
      lastError: store.getState().daemon.lastError,
    },
    acp: {
      transportState: store.getState().acp.managerTransportState,
      totalMessages: store.getState().acp.totalMessages,
      activeConnections: store.getState().acp.activeConnectionIds
        .map((id) => store.getState().acp.connections.get(id))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
    },
    pools: remoteRunnerRegistry.listPools(),
    contracts: remoteRunnerRegistry.listContracts(),
    artifacts: remoteRunnerRegistry.listArtifacts(),
    supervisor: remoteSupervisor.getSnapshot(store),
    distributed: {
      pairRequests: [],
      peers: [],
      work: [],
    },
  }));
}

function createRemotePanel(
  store?: ReturnType<typeof createRuntimeStore>,
  remoteRunnerRegistry = new RemoteRunnerRegistry(getTestAgentManager()),
): RemotePanel {
  return new RemotePanel(store ? createRemoteReadModel(store, remoteRunnerRegistry) : undefined);
}

describe('RemotePanel', () => {
  test('renders runner contract and recent review artifact details', () => {
    resetTestRuntimeServices();
    const manager = getTestAgentManager();
    const agent = manager.spawn({
      mode: 'spawn',
      task: 'Inspect remote artifact panel',
      template: 'engineer',
      tools: ['read', 'edit'],
      dangerously_disable_wrfc: true,
    });
    agent.status = 'completed';
    agent.fullOutput = 'Remote artifact export complete.';
    agent.completedAt = Date.now();

    const store = createRuntimeStore();
    store.setState((state) => ({
      ...state,
      daemon: {
        ...state.daemon,
        transportState: 'connected',
        isRunning: true,
      },
      acp: {
        ...state.acp,
        activeConnectionIds: [agent.id],
        connections: new Map([
          [agent.id, {
            agentId: agent.id,
            label: 'remote implementer',
            transportState: 'connected',
            connectedAt: Date.now(),
            completing: false,
            messageCount: 11,
            errorCount: 0,
            taskId: 'task-remote-artifact',
          }],
        ]),
      },
    }));
    const registry = new RemoteRunnerRegistry(manager);
    registry.captureArtifactForAgent(agent.id, store);

    const text = linesText(createRemotePanel(store, registry).render(140, 22));
    expect(text).toContain('runner contracts');
    expect(text).toContain('review artifacts');
    expect(text).toContain('Contract:');
    expect(text).toContain('Task:');
    expect(text).toContain('remote implementer');
  });

  test('renders empty guidance without a runtime store', () => {
    const text = linesText(createRemotePanel().render(120, 12));
    expect(text).toContain('Remote Control Room');
    expect(text).toContain('Runtime store not wired');
    expect(text).toContain('/remote setup');
  });

  test('renders daemon posture and selected ACP connection detail', () => {
    const store = createRuntimeStore();
    store.setState((state) => ({
      ...state,
      daemon: {
        ...state.daemon,
        transportState: 'connected',
        isRunning: true,
        reconnectAttempts: 1,
        runningJobCount: 2,
      },
      acp: {
        ...state.acp,
        managerTransportState: 'syncing',
        activeConnectionIds: ['agent-1', 'agent-2'],
        totalMessages: 18,
        connections: new Map([
          ['agent-1', {
            agentId: 'agent-1',
            label: 'remote implementer',
            transportState: 'connected',
            connectedAt: Date.now(),
            completing: false,
            messageCount: 14,
            errorCount: 0,
            taskId: 'task-1',
          }],
          ['agent-2', {
            agentId: 'agent-2',
            label: 'remote reviewer',
            transportState: 'reconnecting',
            connectedAt: Date.now() - 1_000,
            completing: true,
            messageCount: 4,
            errorCount: 1,
            lastError: 'connection lost',
            taskId: 'task-2',
          }],
        ]),
      },
    }));

    const panel = createRemotePanel(store);
    expect(panel.handleInput('down')).toBe(true);
    const text = linesText(panel.render(140, 18));
    expect(text).toContain('daemon');
    expect(text).toContain('ACP');
    expect(text).toContain('active connections');
    expect(text).toContain('Selected connection');
    expect(text).toContain('agent-2');
    expect(text).toContain('remote reviewer');
    expect(text).toContain('connection lost');
    expect(text).toContain('/remote recover');
  });

  test('can switch to contract browsing when no active connection is selected', () => {
    resetTestRuntimeServices();
    const manager = getTestAgentManager();
    const agent = manager.spawn({
      mode: 'spawn',
      task: 'Inspect remote contracts',
      template: 'engineer',
      tools: ['read'],
      dangerously_disable_wrfc: true,
    });

    const store = createRuntimeStore();
    const registry = new RemoteRunnerRegistry(manager);
    registry.ensureContractsFromStore(store);
    registry.upsertContractForAgent(agent.id, store);

    const panel = createRemotePanel(store, registry);
    expect(panel.handleInput('tab')).toBe(true);
    const text = linesText(panel.render(140, 20));
    expect(text).toContain('focus=contracts');
    expect(text).toContain('Registered Remote Runner Contracts');
    expect(text).toContain('Selected contract');
    expect(text).toContain(agent.id);
  });
});
