import type { SharedApprovalRecord, SharedSessionRecord, ControlPlaneRecentEvent } from '@pellux/goodvibes-sdk/platform/control-plane/index';
import type {
  UiAutomationSnapshot,
  UiCockpitSnapshot,
  UiCommunicationSnapshot,
  UiControlPlaneSnapshot,
  UiOrchestrationSnapshot,
  UiReadModel,
  UiRoutesSnapshot,
  UiTasksSnapshot,
  UiWatchersSnapshot,
} from '../../runtime/ui-read-models.ts';
import type { RuntimeStore } from '../../runtime/store/index.ts';
import type { AutomationJob } from '@pellux/goodvibes-sdk/platform/automation/jobs';
import type { AutomationRun } from '@pellux/goodvibes-sdk/platform/automation/runs';
import type { AutomationRouteBinding } from '@pellux/goodvibes-sdk/platform/automation/routes';
import type { WatcherRecord } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/watchers';
import type { RuntimeCommunicationRecord } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/communication';
import type { RuntimeTask } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/tasks';
import type { OrchestrationGraphRecord } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/orchestration';
import type { ControlPlaneClientRecord } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/control-plane';

export function createStaticUiReadModel<TSnapshot>(snapshot: TSnapshot): UiReadModel<TSnapshot> {
  return {
    getSnapshot() {
      return snapshot;
    },
    subscribe() {
      return () => {};
    },
  };
}

export function createStoreBackedUiReadModel<TSnapshot>(
  store: RuntimeStore,
  getSnapshot: () => TSnapshot,
): UiReadModel<TSnapshot> {
  return {
    getSnapshot,
    subscribe(listener) {
      return store.subscribe(listener);
    },
  };
}

export function createTasksReadModel(store: RuntimeStore): UiReadModel<UiTasksSnapshot> {
  return createStoreBackedUiReadModel(store, () => ({
    tasks: [...store.getState().tasks.tasks.values()] as RuntimeTask[],
  }));
}

export function createAutomationReadModel(store: RuntimeStore): UiReadModel<UiAutomationSnapshot> {
  return createStoreBackedUiReadModel(store, () => {
    const state = store.getState();
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
  });
}

export function createRoutesReadModel(store: RuntimeStore): UiReadModel<UiRoutesSnapshot> {
  return createStoreBackedUiReadModel(store, () => {
    const state = store.getState().routes;
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
  });
}

export function createWatchersReadModel(store: RuntimeStore): UiReadModel<UiWatchersSnapshot> {
  return createStoreBackedUiReadModel(store, () => {
    const state = store.getState().watchers;
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
  });
}

export function createCommunicationReadModel(store: RuntimeStore): UiReadModel<UiCommunicationSnapshot> {
  return createStoreBackedUiReadModel(store, () => {
    const state = store.getState().communication;
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
  });
}

export function createOrchestrationReadModel(store: RuntimeStore): UiReadModel<UiOrchestrationSnapshot> {
  return createStoreBackedUiReadModel(store, () => {
    const state = store.getState().orchestration;
    const graphs = [...state.graphs.values()].sort((a, b) => b.createdAt - a.createdAt) as OrchestrationGraphRecord[];
    return {
      graphs,
      totalGraphs: state.totalGraphs,
      activeGraphIds: state.activeGraphIds,
      totalCompletedGraphs: state.totalCompletedGraphs,
      totalFailedGraphs: state.totalFailedGraphs,
      recursionGuardTrips: state.recursionGuardTrips,
    };
  });
}

export function createControlPlaneReadModel(
  store: RuntimeStore,
  input: {
    approvals: readonly SharedApprovalRecord[];
    sessions: readonly SharedSessionRecord[];
    recentEvents: readonly ControlPlaneRecentEvent[];
  },
): UiReadModel<UiControlPlaneSnapshot> {
  return createStoreBackedUiReadModel(store, () => {
    const state = store.getState().controlPlane;
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
      approvals: input.approvals,
      sessions: input.sessions,
      recentEvents: input.recentEvents,
    };
  });
}

export function createCockpitReadModel(snapshot: UiCockpitSnapshot): UiReadModel<UiCockpitSnapshot> {
  return createStaticUiReadModel(snapshot);
}
