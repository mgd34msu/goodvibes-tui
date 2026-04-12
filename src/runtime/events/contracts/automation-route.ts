import {
  AUTOMATION_RUN_OUTCOMES,
  AUTOMATION_SCHEDULE_KINDS,
} from '../automation.ts';
import {
  ROUTE_SURFACE_KINDS,
  ROUTE_TARGET_KINDS,
} from '../routes.ts';
import { CONTROL_PLANE_CLIENT_KINDS, CONTROL_PLANE_PRINCIPAL_KINDS, CONTROL_PLANE_TRANSPORT_KINDS } from '../control-plane.ts';
import { DELIVERY_KINDS } from '../deliveries.ts';
import { WATCHER_SOURCE_KINDS } from '../watchers.ts';
import { SURFACE_KINDS } from '../surfaces.ts';
import { validateEventFields } from './shared.ts';
import type { ContractResult } from './shared.ts';

export function validatePluginLoaded(v: unknown): ContractResult {
  return validateEventFields('PLUGIN_LOADED', v, [
    { key: 'pluginName', kind: 'string' },
    { key: 'version', kind: 'string' },
    { key: 'toolCount', kind: 'number' },
  ]);
}

export function validatePluginFailed(v: unknown): ContractResult {
  return validateEventFields('PLUGIN_FAILED', v, [
    { key: 'pluginName', kind: 'string' },
    { key: 'error', kind: 'string' },
  ]);
}

export function validateAutomationJobCreated(v: unknown): ContractResult {
  return validateEventFields('AUTOMATION_JOB_CREATED', v, [
    { key: 'jobId', kind: 'string' },
    { key: 'name', kind: 'string' },
    { key: 'scheduleKind', kind: 'enum', values: AUTOMATION_SCHEDULE_KINDS },
    { key: 'enabled', kind: 'boolean' },
  ]);
}

export function validateAutomationJobUpdated(v: unknown): ContractResult {
  return validateEventFields('AUTOMATION_JOB_UPDATED', v, [
    { key: 'jobId', kind: 'string' },
    { key: 'changedFields', kind: 'string[]' },
  ]);
}

export function validateAutomationJobEnabled(v: unknown): ContractResult {
  return validateEventFields('AUTOMATION_JOB_ENABLED', v, [
    { key: 'jobId', kind: 'string' },
  ]);
}

export function validateAutomationJobDisabled(v: unknown): ContractResult {
  return validateEventFields('AUTOMATION_JOB_DISABLED', v, [
    { key: 'jobId', kind: 'string' },
    { key: 'reason', kind: 'string' },
  ]);
}

export function validateAutomationRunQueued(v: unknown): ContractResult {
  return validateEventFields('AUTOMATION_RUN_QUEUED', v, [
    { key: 'jobId', kind: 'string' },
    { key: 'runId', kind: 'string' },
    { key: 'scheduledAt', kind: 'number' },
    { key: 'forced', kind: 'boolean' },
  ]);
}

export function validateAutomationRunStarted(v: unknown): ContractResult {
  return validateEventFields('AUTOMATION_RUN_STARTED', v, [
    { key: 'jobId', kind: 'string' },
    { key: 'runId', kind: 'string' },
    { key: 'startedAt', kind: 'number' },
    { key: 'attempt', kind: 'number' },
  ]);
}

export function validateAutomationRunCompleted(v: unknown): ContractResult {
  return validateEventFields('AUTOMATION_RUN_COMPLETED', v, [
    { key: 'jobId', kind: 'string' },
    { key: 'runId', kind: 'string' },
    { key: 'startedAt', kind: 'number' },
    { key: 'completedAt', kind: 'number' },
    { key: 'durationMs', kind: 'number' },
    { key: 'outcome', kind: 'enum', values: AUTOMATION_RUN_OUTCOMES },
  ]);
}

export function validateAutomationRunFailed(v: unknown): ContractResult {
  return validateEventFields('AUTOMATION_RUN_FAILED', v, [
    { key: 'jobId', kind: 'string' },
    { key: 'runId', kind: 'string' },
    { key: 'startedAt', kind: 'number' },
    { key: 'failedAt', kind: 'number' },
    { key: 'error', kind: 'string' },
    { key: 'retryable', kind: 'boolean' },
  ]);
}

export function validateAutomationRunCancelled(v: unknown): ContractResult {
  return validateEventFields('AUTOMATION_RUN_CANCELLED', v, [
    { key: 'jobId', kind: 'string' },
    { key: 'runId', kind: 'string' },
    { key: 'cancelledAt', kind: 'number' },
    { key: 'reason', kind: 'string' },
  ]);
}

export function validateAutomationScheduleError(v: unknown): ContractResult {
  return validateEventFields('AUTOMATION_SCHEDULE_ERROR', v, [
    { key: 'jobId', kind: 'string' },
    { key: 'scheduleText', kind: 'string' },
    { key: 'error', kind: 'string' },
  ]);
}

export function validateAutomationJobAutoDisabled(v: unknown): ContractResult {
  return validateEventFields('AUTOMATION_JOB_AUTO_DISABLED', v, [
    { key: 'jobId', kind: 'string' },
    { key: 'reason', kind: 'string' },
    { key: 'consecutiveFailures', kind: 'number' },
  ]);
}

export function validateRouteBindingCreated(v: unknown): ContractResult {
  return validateEventFields('ROUTE_BINDING_CREATED', v, [
    { key: 'bindingId', kind: 'string' },
    { key: 'surfaceKind', kind: 'enum', values: ROUTE_SURFACE_KINDS },
    { key: 'externalId', kind: 'string' },
    { key: 'targetKind', kind: 'enum', values: ROUTE_TARGET_KINDS },
    { key: 'targetId', kind: 'string' },
  ]);
}

export function validateRouteBindingUpdated(v: unknown): ContractResult {
  return validateEventFields('ROUTE_BINDING_UPDATED', v, [
    { key: 'bindingId', kind: 'string' },
    { key: 'changedFields', kind: 'string[]' },
  ]);
}

export function validateRouteBindingResolved(v: unknown): ContractResult {
  return validateEventFields('ROUTE_BINDING_RESOLVED', v, [
    { key: 'bindingId', kind: 'string' },
    { key: 'surfaceKind', kind: 'enum', values: ROUTE_SURFACE_KINDS },
    { key: 'externalId', kind: 'string' },
    { key: 'targetKind', kind: 'enum', values: ROUTE_TARGET_KINDS },
    { key: 'targetId', kind: 'string' },
  ]);
}

export function validateRouteReplyTargetCaptured(v: unknown): ContractResult {
  return validateEventFields('ROUTE_REPLY_TARGET_CAPTURED', v, [
    { key: 'bindingId', kind: 'string' },
    { key: 'surfaceKind', kind: 'enum', values: ROUTE_SURFACE_KINDS },
    { key: 'externalId', kind: 'string' },
    { key: 'replyTargetId', kind: 'string' },
    { key: 'threadId', kind: 'string' },
  ]);
}

export function validateRouteBindingFailed(v: unknown): ContractResult {
  return validateEventFields('ROUTE_BINDING_FAILED', v, [
    { key: 'surfaceKind', kind: 'enum', values: ROUTE_SURFACE_KINDS },
    { key: 'externalId', kind: 'string' },
    { key: 'error', kind: 'string' },
  ]);
}

export function validateControlPlaneClientConnected(v: unknown): ContractResult {
  return validateEventFields('CONTROL_PLANE_CLIENT_CONNECTED', v, [
    { key: 'clientId', kind: 'string' },
    { key: 'clientKind', kind: 'enum', values: CONTROL_PLANE_CLIENT_KINDS },
    { key: 'transport', kind: 'enum', values: CONTROL_PLANE_TRANSPORT_KINDS },
  ]);
}

export function validateControlPlaneClientDisconnected(v: unknown): ContractResult {
  return validateEventFields('CONTROL_PLANE_CLIENT_DISCONNECTED', v, [
    { key: 'clientId', kind: 'string' },
    { key: 'reason', kind: 'string' },
  ]);
}

export function validateControlPlaneSubscriptionCreated(v: unknown): ContractResult {
  return validateEventFields('CONTROL_PLANE_SUBSCRIPTION_CREATED', v, [
    { key: 'clientId', kind: 'string' },
    { key: 'subscriptionId', kind: 'string' },
    { key: 'topics', kind: 'string[]' },
  ]);
}

export function validateControlPlaneSubscriptionDropped(v: unknown): ContractResult {
  return validateEventFields('CONTROL_PLANE_SUBSCRIPTION_DROPPED', v, [
    { key: 'clientId', kind: 'string' },
    { key: 'subscriptionId', kind: 'string' },
    { key: 'reason', kind: 'string' },
  ]);
}

export function validateControlPlaneAuthGranted(v: unknown): ContractResult {
  return validateEventFields('CONTROL_PLANE_AUTH_GRANTED', v, [
    { key: 'clientId', kind: 'string' },
    { key: 'principalId', kind: 'string' },
    { key: 'principalKind', kind: 'enum', values: CONTROL_PLANE_PRINCIPAL_KINDS },
    { key: 'scopes', kind: 'string[]' },
  ]);
}

export function validateControlPlaneAuthRejected(v: unknown): ContractResult {
  return validateEventFields('CONTROL_PLANE_AUTH_REJECTED', v, [
    { key: 'clientId', kind: 'string' },
    { key: 'principalId', kind: 'string' },
    { key: 'reason', kind: 'string' },
  ]);
}

export function validateDeliveryQueued(v: unknown): ContractResult {
  return validateEventFields('DELIVERY_QUEUED', v, [
    { key: 'deliveryId', kind: 'string' },
    { key: 'jobId', kind: 'string' },
    { key: 'runId', kind: 'string' },
    { key: 'surfaceKind', kind: 'enum', values: ROUTE_SURFACE_KINDS },
    { key: 'targetId', kind: 'string' },
    { key: 'deliveryKind', kind: 'enum', values: DELIVERY_KINDS },
  ]);
}

export function validateDeliveryStarted(v: unknown): ContractResult {
  return validateEventFields('DELIVERY_STARTED', v, [
    { key: 'deliveryId', kind: 'string' },
    { key: 'jobId', kind: 'string' },
    { key: 'runId', kind: 'string' },
    { key: 'surfaceKind', kind: 'enum', values: ROUTE_SURFACE_KINDS },
    { key: 'targetId', kind: 'string' },
    { key: 'startedAt', kind: 'number' },
  ]);
}

export function validateDeliverySucceeded(v: unknown): ContractResult {
  return validateEventFields('DELIVERY_SUCCEEDED', v, [
    { key: 'deliveryId', kind: 'string' },
    { key: 'jobId', kind: 'string' },
    { key: 'runId', kind: 'string' },
    { key: 'surfaceKind', kind: 'enum', values: ROUTE_SURFACE_KINDS },
    { key: 'targetId', kind: 'string' },
    { key: 'completedAt', kind: 'number' },
    { key: 'durationMs', kind: 'number' },
    { key: 'statusCode', kind: 'number' },
  ]);
}

export function validateDeliveryFailed(v: unknown): ContractResult {
  return validateEventFields('DELIVERY_FAILED', v, [
    { key: 'deliveryId', kind: 'string' },
    { key: 'jobId', kind: 'string' },
    { key: 'runId', kind: 'string' },
    { key: 'surfaceKind', kind: 'enum', values: ROUTE_SURFACE_KINDS },
    { key: 'targetId', kind: 'string' },
    { key: 'failedAt', kind: 'number' },
    { key: 'error', kind: 'string' },
    { key: 'retryable', kind: 'boolean' },
  ]);
}

export function validateDeliveryDeadLettered(v: unknown): ContractResult {
  return validateEventFields('DELIVERY_DEAD_LETTERED', v, [
    { key: 'deliveryId', kind: 'string' },
    { key: 'jobId', kind: 'string' },
    { key: 'runId', kind: 'string' },
    { key: 'surfaceKind', kind: 'enum', values: ROUTE_SURFACE_KINDS },
    { key: 'targetId', kind: 'string' },
    { key: 'reason', kind: 'string' },
    { key: 'attempts', kind: 'number' },
  ]);
}

export function validateWatcherStarted(v: unknown): ContractResult {
  return validateEventFields('WATCHER_STARTED', v, [
    { key: 'watcherId', kind: 'string' },
    { key: 'sourceKind', kind: 'enum', values: WATCHER_SOURCE_KINDS },
    { key: 'name', kind: 'string' },
  ]);
}

export function validateWatcherHeartbeat(v: unknown): ContractResult {
  return validateEventFields('WATCHER_HEARTBEAT', v, [
    { key: 'watcherId', kind: 'string' },
    { key: 'sourceKind', kind: 'enum', values: WATCHER_SOURCE_KINDS },
    { key: 'seenAt', kind: 'number' },
    { key: 'checkpoint', kind: 'string' },
  ]);
}

export function validateWatcherCheckpointAdvanced(v: unknown): ContractResult {
  return validateEventFields('WATCHER_CHECKPOINT_ADVANCED', v, [
    { key: 'watcherId', kind: 'string' },
    { key: 'sourceKind', kind: 'enum', values: WATCHER_SOURCE_KINDS },
    { key: 'checkpoint', kind: 'string' },
  ]);
}

export function validateWatcherFailed(v: unknown): ContractResult {
  return validateEventFields('WATCHER_FAILED', v, [
    { key: 'watcherId', kind: 'string' },
    { key: 'sourceKind', kind: 'enum', values: WATCHER_SOURCE_KINDS },
    { key: 'error', kind: 'string' },
    { key: 'retryable', kind: 'boolean' },
  ]);
}

export function validateWatcherStopped(v: unknown): ContractResult {
  return validateEventFields('WATCHER_STOPPED', v, [
    { key: 'watcherId', kind: 'string' },
    { key: 'sourceKind', kind: 'enum', values: WATCHER_SOURCE_KINDS },
    { key: 'reason', kind: 'string' },
  ]);
}

export function validateSurfaceEnabled(v: unknown): ContractResult {
  return validateEventFields('SURFACE_ENABLED', v, [
    { key: 'surfaceKind', kind: 'enum', values: SURFACE_KINDS },
    { key: 'surfaceId', kind: 'string' },
    { key: 'accountId', kind: 'string' },
  ]);
}

export function validateSurfaceDisabled(v: unknown): ContractResult {
  return validateEventFields('SURFACE_DISABLED', v, [
    { key: 'surfaceKind', kind: 'enum', values: SURFACE_KINDS },
    { key: 'surfaceId', kind: 'string' },
    { key: 'reason', kind: 'string' },
  ]);
}

export function validateSurfaceAccountConnected(v: unknown): ContractResult {
  return validateEventFields('SURFACE_ACCOUNT_CONNECTED', v, [
    { key: 'surfaceKind', kind: 'enum', values: SURFACE_KINDS },
    { key: 'surfaceId', kind: 'string' },
    { key: 'accountId', kind: 'string' },
    { key: 'displayName', kind: 'string' },
  ]);
}

export function validateSurfaceAccountDegraded(v: unknown): ContractResult {
  return validateEventFields('SURFACE_ACCOUNT_DEGRADED', v, [
    { key: 'surfaceKind', kind: 'enum', values: SURFACE_KINDS },
    { key: 'surfaceId', kind: 'string' },
    { key: 'accountId', kind: 'string' },
    { key: 'error', kind: 'string' },
  ]);
}

export function validateSurfaceCapabilityChanged(v: unknown): ContractResult {
  return validateEventFields('SURFACE_CAPABILITY_CHANGED', v, [
    { key: 'surfaceKind', kind: 'enum', values: SURFACE_KINDS },
    { key: 'surfaceId', kind: 'string' },
    { key: 'capability', kind: 'string' },
    { key: 'enabled', kind: 'boolean' },
  ]);
}
