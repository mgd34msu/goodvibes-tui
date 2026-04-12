/**
 * Event schema contracts for runtime event validation.
 */
export {
  type ContractResult,
  type EventEnvelopeShape,
  type FieldKind,
  type FieldSpec,
  validateEnvelope,
  validateEventFields,
  isString,
  isNumber,
  isBoolean,
  isObject,
} from './contracts/shared.ts';

import {
  isObject,
  isString,
} from './contracts/shared.ts';

export {
  validateTurnStarted,
  validateTurnStreaming,
  validateTurnCompleted,
  validateTurnFailed,
  validateTurnCancelled,
  validateToolReceived,
  validateToolSucceeded,
  validateToolFailed,
} from './contracts/turn-tool.ts';

export {
  validateAgentSpawning,
  validateAgentCompleted,
  validateAgentFailed,
  validateMcpConnected,
  validateMcpDisconnected,
  validateMcpReconnecting,
} from './contracts/agent-mcp.ts';

export {
  validatePluginLoaded,
  validatePluginFailed,
  validateAutomationJobCreated,
  validateAutomationJobUpdated,
  validateAutomationJobEnabled,
  validateAutomationJobDisabled,
  validateAutomationRunQueued,
  validateAutomationRunStarted,
  validateAutomationRunCompleted,
  validateAutomationRunFailed,
  validateAutomationRunCancelled,
  validateAutomationScheduleError,
  validateAutomationJobAutoDisabled,
  validateRouteBindingCreated,
  validateRouteBindingUpdated,
  validateRouteBindingResolved,
  validateRouteReplyTargetCaptured,
  validateRouteBindingFailed,
  validateControlPlaneClientConnected,
  validateControlPlaneClientDisconnected,
  validateControlPlaneSubscriptionCreated,
  validateControlPlaneSubscriptionDropped,
  validateControlPlaneAuthGranted,
  validateControlPlaneAuthRejected,
  validateDeliveryQueued,
  validateDeliveryStarted,
  validateDeliverySucceeded,
  validateDeliveryFailed,
  validateDeliveryDeadLettered,
  validateWatcherStarted,
  validateWatcherHeartbeat,
  validateWatcherCheckpointAdvanced,
  validateWatcherFailed,
  validateWatcherStopped,
  validateSurfaceEnabled,
  validateSurfaceDisabled,
  validateSurfaceAccountConnected,
  validateSurfaceAccountDegraded,
  validateSurfaceCapabilityChanged,
} from './contracts/automation-route.ts';

import {
  validateTurnStarted,
  validateTurnStreaming,
  validateTurnCompleted,
  validateTurnFailed,
  validateTurnCancelled,
  validateToolReceived,
  validateToolSucceeded,
  validateToolFailed,
} from './contracts/turn-tool.ts';
import {
  validateAgentSpawning,
  validateAgentCompleted,
  validateAgentFailed,
  validateMcpConnected,
  validateMcpDisconnected,
  validateMcpReconnecting,
} from './contracts/agent-mcp.ts';
import {
  validatePluginLoaded,
  validatePluginFailed,
  validateAutomationJobCreated,
  validateAutomationJobUpdated,
  validateAutomationJobEnabled,
  validateAutomationJobDisabled,
  validateAutomationRunQueued,
  validateAutomationRunStarted,
  validateAutomationRunCompleted,
  validateAutomationRunFailed,
  validateAutomationRunCancelled,
  validateAutomationScheduleError,
  validateAutomationJobAutoDisabled,
  validateRouteBindingCreated,
  validateRouteBindingUpdated,
  validateRouteBindingResolved,
  validateRouteReplyTargetCaptured,
  validateRouteBindingFailed,
  validateControlPlaneClientConnected,
  validateControlPlaneClientDisconnected,
  validateControlPlaneSubscriptionCreated,
  validateControlPlaneSubscriptionDropped,
  validateControlPlaneAuthGranted,
  validateControlPlaneAuthRejected,
  validateDeliveryQueued,
  validateDeliveryStarted,
  validateDeliverySucceeded,
  validateDeliveryFailed,
  validateDeliveryDeadLettered,
  validateWatcherStarted,
  validateWatcherHeartbeat,
  validateWatcherCheckpointAdvanced,
  validateWatcherFailed,
  validateWatcherStopped,
  validateSurfaceEnabled,
  validateSurfaceDisabled,
  validateSurfaceAccountConnected,
  validateSurfaceAccountDegraded,
  validateSurfaceCapabilityChanged,
} from './contracts/automation-route.ts';

const EVENT_VALIDATORS: Record<string, (v: unknown) => import('./contracts/shared.ts').ContractResult> = {
  TURN_STARTED: validateTurnStarted,
  TURN_STREAMING: validateTurnStreaming,
  TURN_COMPLETED: validateTurnCompleted,
  TURN_FAILED: validateTurnFailed,
  TURN_CANCELLED: validateTurnCancelled,
  TOOL_RECEIVED: validateToolReceived,
  TOOL_SUCCEEDED: validateToolSucceeded,
  TOOL_FAILED: validateToolFailed,
  AGENT_SPAWNING: validateAgentSpawning,
  AGENT_COMPLETED: validateAgentCompleted,
  AGENT_FAILED: validateAgentFailed,
  MCP_CONNECTED: validateMcpConnected,
  MCP_DISCONNECTED: validateMcpDisconnected,
  MCP_RECONNECTING: validateMcpReconnecting,
  PLUGIN_LOADED: validatePluginLoaded,
  PLUGIN_FAILED: validatePluginFailed,
  AUTOMATION_JOB_CREATED: validateAutomationJobCreated,
  AUTOMATION_JOB_UPDATED: validateAutomationJobUpdated,
  AUTOMATION_JOB_ENABLED: validateAutomationJobEnabled,
  AUTOMATION_JOB_DISABLED: validateAutomationJobDisabled,
  AUTOMATION_RUN_QUEUED: validateAutomationRunQueued,
  AUTOMATION_RUN_STARTED: validateAutomationRunStarted,
  AUTOMATION_RUN_COMPLETED: validateAutomationRunCompleted,
  AUTOMATION_RUN_FAILED: validateAutomationRunFailed,
  AUTOMATION_RUN_CANCELLED: validateAutomationRunCancelled,
  AUTOMATION_SCHEDULE_ERROR: validateAutomationScheduleError,
  AUTOMATION_JOB_AUTO_DISABLED: validateAutomationJobAutoDisabled,
  ROUTE_BINDING_CREATED: validateRouteBindingCreated,
  ROUTE_BINDING_UPDATED: validateRouteBindingUpdated,
  ROUTE_BINDING_RESOLVED: validateRouteBindingResolved,
  ROUTE_REPLY_TARGET_CAPTURED: validateRouteReplyTargetCaptured,
  ROUTE_BINDING_FAILED: validateRouteBindingFailed,
  CONTROL_PLANE_CLIENT_CONNECTED: validateControlPlaneClientConnected,
  CONTROL_PLANE_CLIENT_DISCONNECTED: validateControlPlaneClientDisconnected,
  CONTROL_PLANE_SUBSCRIPTION_CREATED: validateControlPlaneSubscriptionCreated,
  CONTROL_PLANE_SUBSCRIPTION_DROPPED: validateControlPlaneSubscriptionDropped,
  CONTROL_PLANE_AUTH_GRANTED: validateControlPlaneAuthGranted,
  CONTROL_PLANE_AUTH_REJECTED: validateControlPlaneAuthRejected,
  DELIVERY_QUEUED: validateDeliveryQueued,
  DELIVERY_STARTED: validateDeliveryStarted,
  DELIVERY_SUCCEEDED: validateDeliverySucceeded,
  DELIVERY_FAILED: validateDeliveryFailed,
  DELIVERY_DEAD_LETTERED: validateDeliveryDeadLettered,
  WATCHER_STARTED: validateWatcherStarted,
  WATCHER_HEARTBEAT: validateWatcherHeartbeat,
  WATCHER_CHECKPOINT_ADVANCED: validateWatcherCheckpointAdvanced,
  WATCHER_FAILED: validateWatcherFailed,
  WATCHER_STOPPED: validateWatcherStopped,
  SURFACE_ENABLED: validateSurfaceEnabled,
  SURFACE_DISABLED: validateSurfaceDisabled,
  SURFACE_ACCOUNT_CONNECTED: validateSurfaceAccountConnected,
  SURFACE_ACCOUNT_DEGRADED: validateSurfaceAccountDegraded,
  SURFACE_CAPABILITY_CHANGED: validateSurfaceCapabilityChanged,
};

export function validateEvent(event: unknown): import('./contracts/shared.ts').ContractResult {
  if (!isObject(event)) return { valid: false, violations: ['event must be an object'] };
  const type = event['type'];
  if (!isString(type)) return { valid: false, violations: ['event.type must be a string'] };
  const validator = EVENT_VALIDATORS[type];
  if (!validator) return { valid: false, violations: [`unknown event type: '${type}'`] };
  return validator(event);
}

export function isKnownEventType(type: unknown): type is string {
  return isString(type) && type in EVENT_VALIDATORS;
}

export function registeredEventTypes(): readonly string[] {
  return Object.keys(EVENT_VALIDATORS);
}
