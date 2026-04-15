import type { ControlPlaneRecentEvent, SharedApprovalRecord, SharedSessionRecord } from '../control-plane/index.ts';
import type { RuntimeServices } from './services.ts';
import type { AutomationJob } from '@pellux/goodvibes-sdk/platform/automation/jobs';
import type { AutomationRun } from '@pellux/goodvibes-sdk/platform/automation/runs';
import type { AutomationRouteBinding } from '@pellux/goodvibes-sdk/platform/automation/routes';
import type { WatcherRecord } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/watchers';
import type { OrchestrationGraphRecord } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/orchestration';
import type { RuntimeCommunicationRecord } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/communication';
import type { ControlPlaneClientRecord } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/control-plane';
import type { AcpConnection } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/acp';
import { combineSubscriptions, createStoreBackedReadModel } from './ui-read-model-helpers.ts';
import type { UiReadModel } from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-base';

export interface UiAutomationSnapshot {
  readonly jobs: readonly AutomationJob[];
  readonly runs: readonly AutomationRun[];
  readonly totalJobs: number;
  readonly totalRuns: number;
  readonly activeRunIds: readonly string[];
  readonly totalFailed: number;
  readonly sourceCount: number;
  readonly deliveryTotals: {
    readonly succeeded: number;
    readonly failed: number;
    readonly deadLettered: number;
  };
}

export interface UiRoutesSnapshot {
  readonly bindings: readonly AutomationRouteBinding[];
  readonly bindingIdsBySurface: Readonly<Record<string, readonly string[]>>;
  readonly totalBindings: number;
  readonly activeBindingIds: readonly string[];
  readonly totalResolved: number;
  readonly totalFailures: number;
}

export interface UiWatchersSnapshot {
  readonly watchers: readonly WatcherRecord[];
  readonly totalWatchers: number;
  readonly activeWatcherIds: readonly string[];
  readonly totalDegraded: number;
  readonly totalLagged: number;
}

export interface UiOrchestrationSnapshot {
  readonly graphs: readonly OrchestrationGraphRecord[];
  readonly totalGraphs: number;
  readonly activeGraphIds: readonly string[];
  readonly totalCompletedGraphs: number;
  readonly totalFailedGraphs: number;
  readonly recursionGuardTrips: number;
}

export interface UiCommunicationSnapshot {
  readonly records: readonly RuntimeCommunicationRecord[];
  readonly totalSent: number;
  readonly totalDelivered: number;
  readonly totalBlocked: number;
}

export interface UiControlPlaneSnapshot {
  readonly connectionState: string;
  readonly activeClientIds: readonly string[];
  readonly requestCount: number;
  readonly errorCount: number;
  readonly host: string;
  readonly port: number;
  readonly clients: readonly ControlPlaneClientRecord[];
  readonly approvals: readonly SharedApprovalRecord[];
  readonly sessions: readonly SharedSessionRecord[];
  readonly recentEvents: readonly ControlPlaneRecentEvent[];
}

export interface UiOperationsReadModels {
  readonly automation: UiReadModel<UiAutomationSnapshot>;
  readonly routes: UiReadModel<UiRoutesSnapshot>;
  readonly watchers: UiReadModel<UiWatchersSnapshot>;
  readonly orchestration: UiReadModel<UiOrchestrationSnapshot>;
  readonly communication: UiReadModel<UiCommunicationSnapshot>;
  readonly controlPlane: UiReadModel<UiControlPlaneSnapshot>;
}

export interface UiOperationsReadModelOptions {
  readonly getControlPlaneRecentEvents?: (limit: number) => readonly ControlPlaneRecentEvent[];
}

export function createOperationsReadModels(
  runtimeServices: RuntimeServices,
  options: UiOperationsReadModelOptions = {},
): UiOperationsReadModels {
  const { runtimeStore } = runtimeServices;

  return {
    automation: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState();
      const jobs = state.automation.jobIds
        .map((id) => state.automation.jobs.get(id))
        .filter((job): job is AutomationJob => job !== undefined)
        .sort((a, b) => (b.nextRunAt ?? 0) - (a.nextRunAt ?? 0) || a.name.localeCompare(b.name));
      const runs = state.automation.runIds
        .map((id) => state.automation.runs.get(id))
        .filter((run): run is AutomationRun => run !== undefined)
        .sort((a, b) => b.queuedAt - a.queuedAt || a.id.localeCompare(b.id));
      return {
        jobs,
        runs,
        totalJobs: state.automation.totalJobs,
        totalRuns: state.automation.totalRuns,
        activeRunIds: state.automation.activeRunIds,
        totalFailed: state.automation.totalFailed,
        sourceCount: state.automation.sourceIds.length,
        deliveryTotals: {
          succeeded: state.deliveries.totalSucceeded,
          failed: state.deliveries.totalFailed,
          deadLettered: state.deliveries.totalDeadLettered,
        },
      };
    }),
    routes: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState().routes;
      const bindings = state.bindingIds
        .map((id) => state.bindings.get(id))
        .filter((binding): binding is AutomationRouteBinding => binding !== undefined)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id));
      return {
        bindings,
        bindingIdsBySurface: state.bindingIdsBySurface,
        totalBindings: state.totalBindings,
        activeBindingIds: state.activeBindingIds,
        totalResolved: state.totalResolved,
        totalFailures: state.totalFailures,
      };
    }),
    watchers: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState().watchers;
      const watchers = state.watcherIds
        .map((id) => state.watchers.get(id))
        .filter((watcher): watcher is WatcherRecord => watcher !== undefined)
        .sort((a, b) => (b.lastHeartbeatAt ?? 0) - (a.lastHeartbeatAt ?? 0) || a.id.localeCompare(b.id));
      return {
        watchers,
        totalWatchers: state.watcherIds.length,
        activeWatcherIds: state.activeWatcherIds,
        totalDegraded: state.totalDegraded,
        totalLagged: state.totalLagged,
      };
    }),
    orchestration: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState().orchestration;
      const graphs = [...state.graphs.values()].sort((a, b) => b.createdAt - a.createdAt);
      return {
        graphs,
        totalGraphs: state.totalGraphs,
        activeGraphIds: state.activeGraphIds,
        totalCompletedGraphs: state.totalCompletedGraphs,
        totalFailedGraphs: state.totalFailedGraphs,
        recursionGuardTrips: state.recursionGuardTrips,
      };
    }),
    communication: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState().communication;
      const records = state.recentRecordIds
        .map((id) => state.records.get(id))
        .filter((record): record is RuntimeCommunicationRecord => record !== undefined)
        .sort((a, b) => b.timestamp - a.timestamp);
      return {
        records,
        totalSent: state.totalSent,
        totalDelivered: state.totalDelivered,
        totalBlocked: state.totalBlocked,
      };
    }),
    controlPlane: {
      getSnapshot() {
        const state = runtimeStore.getState().controlPlane;
        const clients = state.clientIds
          .map((id) => state.clients.get(id))
          .filter((client): client is ControlPlaneClientRecord => client !== undefined)
          .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.id.localeCompare(b.id));
        return {
          connectionState: state.connectionState,
          activeClientIds: state.activeClientIds,
          requestCount: state.requestCount,
          errorCount: state.errorCount,
          host: state.host,
          port: state.port,
          clients,
          approvals: runtimeServices.approvalBroker.listApprovals(6),
          sessions: runtimeServices.sessionBroker.listSessions(6),
          recentEvents: options.getControlPlaneRecentEvents?.(6) ?? [],
        };
      },
      subscribe(listener) {
        const unsubs = [
          runtimeStore.subscribe(listener),
          runtimeServices.approvalBroker.subscribe(listener),
        ];
        return combineSubscriptions(...unsubs);
      },
    },
  };
}
