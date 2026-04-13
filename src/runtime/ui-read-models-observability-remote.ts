import type { RuntimeServices } from './services.ts';
import type { UiReadModel } from './ui-read-models-base.ts';
import { createStoreBackedReadModel } from './ui-read-model-helpers.ts';
import type { RemoteSupervisorSnapshot } from './remote/supervisor.ts';
import type { DistributedPendingWork, DistributedPeerRecord, DistributedRuntimePairRequest } from './remote/distributed-runtime-types.ts';

export interface UiRemoteSnapshot {
  readonly daemon: {
    readonly transportState: string;
    readonly isRunning: boolean;
    readonly reconnectAttempts: number;
    readonly runningJobCount: number;
    readonly lastError?: string;
  };
  readonly acp: {
    readonly transportState: string;
    readonly totalMessages: number;
    readonly activeConnections: readonly import('./store/domains/acp.ts').AcpConnection[];
  };
  readonly pools: ReturnType<RuntimeServices['remoteRunnerRegistry']['listPools']>;
  readonly contracts: ReturnType<RuntimeServices['remoteRunnerRegistry']['listContracts']>;
  readonly artifacts: ReturnType<RuntimeServices['remoteRunnerRegistry']['listArtifacts']>;
  readonly supervisor: RemoteSupervisorSnapshot;
  readonly distributed: {
    readonly pairRequests: readonly DistributedRuntimePairRequest[];
    readonly peers: readonly DistributedPeerRecord[];
    readonly work: readonly DistributedPendingWork[];
  };
}

export interface UiRemoteReadModels {
  readonly remote: UiReadModel<UiRemoteSnapshot>;
}

export function createRemoteReadModels(runtimeServices: RuntimeServices): UiRemoteReadModels {
  const { runtimeStore } = runtimeServices;

  return {
    remote: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState();
      const distributedRaw = runtimeServices.distributedRuntime.getSnapshot() as {
        pairRequests?: readonly DistributedRuntimePairRequest[];
        peers?: readonly DistributedPeerRecord[];
        work?: readonly DistributedPendingWork[];
      };
      return {
        daemon: {
          transportState: state.daemon.transportState,
          isRunning: state.daemon.isRunning,
          reconnectAttempts: state.daemon.reconnectAttempts,
          runningJobCount: state.daemon.runningJobCount,
          lastError: state.daemon.lastError,
        },
        acp: {
          transportState: state.acp.managerTransportState,
          totalMessages: state.acp.totalMessages,
          activeConnections: state.acp.activeConnectionIds
            .map((id) => state.acp.connections.get(id))
            .filter((connection): connection is import('./store/domains/acp.ts').AcpConnection => connection !== undefined),
        },
        pools: runtimeServices.remoteRunnerRegistry.listPools(),
        contracts: runtimeServices.remoteRunnerRegistry.listContracts(),
        artifacts: runtimeServices.remoteRunnerRegistry.listArtifacts(),
        supervisor: runtimeServices.remoteSupervisor.getSnapshot(runtimeStore),
        distributed: {
          pairRequests: distributedRaw.pairRequests ?? [],
          peers: distributedRaw.peers ?? [],
          work: distributedRaw.work ?? [],
        },
      };
    }),
  };
}
