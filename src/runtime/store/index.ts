/**
 * Runtime store — Zustand vanilla store for goodvibes-tui.
 *
 * Uses `createStore` from `zustand/vanilla` (NOT the React `create` hook)
 * because goodvibes-tui is a terminal app with no React renderer.
 */

import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand';
import type { TurnEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/turn';
import type { ToolEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/tools';
import type { PermissionEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/permissions';
import type { TaskEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/tasks';
import type { AgentEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/agents';
import type { OrchestrationEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/orchestration';
import type { CommunicationEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/communication';
import type { PluginEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/plugins';
import type { McpEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/mcp';
import type { TransportEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/transport';
import type { CompactionEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/compaction';
import type {
  SessionDomainState,
  ConversationDomainState,
  TaskDomainState,
  TaskLifecycleState,
  RuntimeTask,
  AgentDomainState,
  AgentLifecycleState,
  RuntimeAgent,
  PermissionDomainState,
  PermissionDecision,
  OrchestrationDomainState,
  CommunicationDomainState,
  PluginDomainState,
  McpDomainState,
  AcpDomainState,
  DaemonDomainState,
  IntegrationDomainState,
  IntegrationRecord,
  IntegrationStatus,
  AutomationDomainState,
  RoutesDomainState,
  ControlPlaneDomainState,
  ControlPlaneClientRecord,
  DeliveryDomainState,
  WatcherDomainState,
  WatcherRecord,
  SurfaceDomainState,
  SurfaceRecord,
} from '@pellux/goodvibes-sdk/platform/runtime/store/domains/index';
import type { AutomationJob } from '@pellux/goodvibes-sdk/platform/automation/jobs';
import type { AutomationRun } from '@pellux/goodvibes-sdk/platform/automation/runs';
import type { AutomationSourceRecord } from '@pellux/goodvibes-sdk/platform/automation/sources';
import type { AutomationRouteBinding } from '@pellux/goodvibes-sdk/platform/automation/routes';
import type { AutomationSurfaceKind } from '@pellux/goodvibes-sdk/platform/automation/types';
import type { AutomationDeliveryAttempt } from '@pellux/goodvibes-sdk/platform/automation/delivery';
import { createInitialRuntimeState } from './state.ts';
import type { RuntimeState } from './state.ts';
import {
  patchControlPlaneDomain,
  syncSessionStatePatch,
  transitionAgentDomainRecord,
  transitionTaskDomainRecord,
  updateAgentState,
  updateAutomationDomainFromJob,
  updateAutomationDomainFromRun,
  updateAutomationDomainFromSource,
  updateCommunicationState,
  updateConversationState,
  updateControlPlaneDomainFromClient,
  updateDeliveryDomainFromAttempt,
  updateIntegrationDomainFromRecord,
  updateMcpState,
  updateOrchestrationState,
  updatePermissionState,
  updatePluginState,
  updateRouteFailureState,
  updateRoutesDomainFromBinding,
  updateSessionState,
  updateSurfaceDomainFromRecord,
  updateTaskDomainFromRecord,
  updateTaskState,
  updateTransportState,
  updateWatcherDomainFromRecord,
} from '@pellux/goodvibes-sdk/platform/runtime/store/helpers/reducers';

export type RuntimeStore = StoreApi<RuntimeState>;

export function createRuntimeStore(): RuntimeStore {
  return createStore<RuntimeState>(() => createInitialRuntimeState());
}

function mutateRuntimeStore(store: RuntimeStore, updater: (state: RuntimeState) => RuntimeState): void {
  store.setState(updater);
}

export interface DomainDispatch {
  dispatchTurnEvent(event: TurnEvent): void;
  dispatchToolEvent(event: ToolEvent): void;
  dispatchPermissionEvent(event: PermissionEvent): void;
  dispatchTaskEvent(event: TaskEvent): void;
  dispatchAgentEvent(event: AgentEvent): void;
  dispatchOrchestrationEvent(event: OrchestrationEvent): void;
  dispatchCommunicationEvent(event: CommunicationEvent): void;
  dispatchPluginEvent(event: PluginEvent): void;
  dispatchMcpEvent(event: McpEvent): void;
  dispatchTransportEvent(event: TransportEvent): void;
  dispatchCompactionEvent(event: CompactionEvent): void;
  syncSessionState(patch: Partial<SessionDomainState>, source?: string): void;
  syncRuntimeTask(task: RuntimeTask, source?: string): void;
  transitionRuntimeTask(
    taskId: string,
    status: TaskLifecycleState,
    patch?: Partial<RuntimeTask>,
    source?: string,
  ): void;
  transitionRuntimeAgent(
    agentId: string,
    status: AgentLifecycleState,
    patch?: Partial<RuntimeAgent>,
    source?: string,
  ): void;
  syncIntegration(record: IntegrationRecord, source?: string): void;
  syncAutomationSource(record: AutomationSourceRecord, source?: string): void;
  syncAutomationJob(record: AutomationJob, source?: string): void;
  syncAutomationRun(record: AutomationRun, source?: string): void;
  syncRouteBinding(record: AutomationRouteBinding, source?: string): void;
  recordRouteBindingFailure(
    surfaceKind: AutomationSurfaceKind,
    externalId: string,
    source?: string,
  ): void;
  syncControlPlaneClient(record: ControlPlaneClientRecord, source?: string): void;
  syncControlPlaneState(patch: Partial<ControlPlaneDomainState>, source?: string): void;
  syncDeliveryAttempt(record: AutomationDeliveryAttempt, source?: string): void;
  syncSurface(record: SurfaceRecord, source?: string): void;
  syncWatcher(record: WatcherRecord, source?: string): void;
}

export function createDomainDispatch(store: RuntimeStore): DomainDispatch {
  return {
    dispatchTurnEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        conversation: updateConversationState(state.conversation, event),
      }));
    },
    dispatchToolEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        conversation: updateConversationState(state.conversation, event),
      }));
    },
    dispatchPermissionEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        permissions: updatePermissionState(state.permissions, event),
      }));
    },
    dispatchTaskEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        tasks: updateTaskState(state.tasks, event),
      }));
    },
    dispatchAgentEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        agents: updateAgentState(state.agents, event),
      }));
    },
    dispatchOrchestrationEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        orchestration: updateOrchestrationState(state.orchestration, event),
      }));
    },
    dispatchCommunicationEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        communication: updateCommunicationState(state.communication, event),
      }));
    },
    dispatchPluginEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        plugins: updatePluginState(state.plugins, event),
      }));
    },
    dispatchMcpEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        mcp: updateMcpState(state.mcp, event),
      }));
    },
    dispatchTransportEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        ...updateTransportState(state.acp, state.daemon, event),
      }));
    },
    dispatchCompactionEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        session: updateSessionState(state.session, event),
      }));
    },
    syncSessionState(patch, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        session: syncSessionStatePatch(state.session, patch, source),
      }));
    },
    syncRuntimeTask(task, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        tasks: updateTaskDomainFromRecord(state.tasks, task, source),
      }));
    },
    transitionRuntimeTask(taskId, status, patch, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        tasks: transitionTaskDomainRecord(state.tasks, taskId, status, patch, source),
      }));
    },
    transitionRuntimeAgent(agentId, status, patch, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        agents: transitionAgentDomainRecord(state.agents, agentId, status, patch, source),
      }));
    },
    syncIntegration(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        integrations: updateIntegrationDomainFromRecord(state.integrations, record, source),
      }));
    },
    syncAutomationSource(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        automation: updateAutomationDomainFromSource(state.automation, record, source),
      }));
    },
    syncAutomationJob(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        automation: updateAutomationDomainFromJob(state.automation, record, source),
      }));
    },
    syncAutomationRun(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        automation: updateAutomationDomainFromRun(state.automation, record, source),
      }));
    },
    syncRouteBinding(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        routes: updateRoutesDomainFromBinding(state.routes, record, source),
      }));
    },
    recordRouteBindingFailure(surfaceKind, externalId, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        routes: updateRouteFailureState(state.routes, surfaceKind, externalId, source),
      }));
    },
    syncControlPlaneClient(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        controlPlane: updateControlPlaneDomainFromClient(state.controlPlane, record, source),
      }));
    },
    syncControlPlaneState(patch, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        controlPlane: patchControlPlaneDomain(state.controlPlane, patch, source),
      }));
    },
    syncDeliveryAttempt(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        deliveries: updateDeliveryDomainFromAttempt(state.deliveries, record, source),
      }));
    },
    syncSurface(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        surfaces: updateSurfaceDomainFromRecord(state.surfaces, record, source),
      }));
    },
    syncWatcher(record, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        watchers: updateWatcherDomainFromRecord(state.watchers, record, source),
      }));
    },
  };
}

export type { RuntimeState } from './state.ts';
export { createInitialRuntimeState } from './state.ts';
export * from './selectors/index.ts';
export * from '@pellux/goodvibes-sdk/platform/runtime/store/domains/index';
