import type { RuntimeServices } from './services.ts';
import type { UiReadModel } from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-base';
import { createStoreBackedReadModel } from '@pellux/goodvibes-sdk/platform/runtime/ui-read-model-helpers';
import type { RemoteSupervisorSnapshot } from '@pellux/goodvibes-sdk/platform/runtime/remote/supervisor';
import type { DistributedPendingWork, DistributedPeerRecord, DistributedRuntimePairRequest } from '@pellux/goodvibes-sdk/platform/runtime/remote/distributed-runtime-types';

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
    readonly activeConnections: readonly import('@pellux/goodvibes-sdk/platform/runtime/store/domains/acp').AcpConnection[];
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
            .filter((connection): connection is import('@pellux/goodvibes-sdk/platform/runtime/store/domains/acp').AcpConnection => connection !== undefined),
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
