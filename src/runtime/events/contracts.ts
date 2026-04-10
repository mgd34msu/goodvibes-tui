/**
 * Event schema contracts for runtime event validation.
 *
 * Provides runtime shape validators for every RuntimeEvent variant.
 * Each validator is a pure predicate that checks required fields and
 * their types without depending on any specific schema library.
 *
 * Design principles:
 * - No imports from schema libs (zod, yup, etc.) — zero dependencies
 * - Each validator receives `unknown` and narrows to the concrete type
 * - Validators are named `is<EventType>` for discoverability
 * - A top-level `validateEvent` dispatcher covers all variants
 */
import {
  AUTOMATION_RUN_OUTCOMES,
  AUTOMATION_SCHEDULE_KINDS,
} from './automation.ts';
import {
  CONTROL_PLANE_CLIENT_KINDS,
  CONTROL_PLANE_PRINCIPAL_KINDS,
  CONTROL_PLANE_TRANSPORT_KINDS,
} from './control-plane.ts';
import { DELIVERY_KINDS } from './deliveries.ts';
import { ROUTE_SURFACE_KINDS, ROUTE_TARGET_KINDS } from './routes.ts';
import { SURFACE_KINDS } from './surfaces.ts';
import { WATCHER_SOURCE_KINDS } from './watchers.ts';

// ── Primitive validators ──────────────────────────────────────────────────────

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number';
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

type FieldKind = 'string' | 'number' | 'boolean' | 'string[]' | 'enum';

interface FieldSpec {
  readonly key: string;
  readonly kind: FieldKind;
  readonly values?: readonly string[];
}

function validateEventFields(type: string, v: unknown, fields: readonly FieldSpec[]): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== type) return fail(`type must be '${type}', got ${String(v['type'])}`);

  const violations: string[] = [];
  for (const field of fields) {
    const value = v[field.key];
    switch (field.kind) {
      case 'string':
        if (!isString(value)) violations.push(`${field.key} must be a string`);
        break;
      case 'number':
        if (!isNumber(value)) violations.push(`${field.key} must be a number`);
        break;
      case 'boolean':
        if (!isBoolean(value)) violations.push(`${field.key} must be a boolean`);
        break;
      case 'string[]':
        if (!Array.isArray(value) || value.some((item) => !isString(item))) {
          violations.push(`${field.key} must be an array of strings`);
        }
        break;
      case 'enum':
        if (!isString(value) || !(field.values ?? []).includes(value)) {
          violations.push(`${field.key} must be one of: ${(field.values ?? []).join(', ')}`);
        }
        break;
    }
  }
  return violations.length ? { valid: false, violations } : OK;
}

// ── Contract result ───────────────────────────────────────────────────────────

/**
 * Result of a contract validation.
 */
export interface ContractResult {
  /** Whether the event satisfies its schema contract. */
  readonly valid: boolean;
  /** Violation messages when valid === false. */
  readonly violations: readonly string[];
}

const OK: ContractResult = { valid: true, violations: [] };

function fail(...messages: string[]): ContractResult {
  return { valid: false, violations: messages };
}

// ── Envelope shape ────────────────────────────────────────────────────────────

/**
 * Expected structure of an event envelope (from events/envelope.ts).
 * Validated as part of top-level dispatch.
 */
export interface EventEnvelopeShape {
  readonly traceId: string;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly source: string;
  readonly event: Record<string, unknown>;
}

/**
 * Validate that a value matches the EventEnvelope shape.
 *
 * @param v - Value to check.
 * @returns ContractResult.
 */
export function validateEnvelope(v: unknown): ContractResult {
  if (!isObject(v)) return fail('envelope must be an object');
  const violations: string[] = [];
  if (!isString(v['traceId'])) violations.push('traceId must be a string');
  if (!isString(v['sessionId'])) violations.push('sessionId must be a string');
  if (!isNumber(v['timestamp'])) violations.push('timestamp must be a number');
  if (!isString(v['source'])) violations.push('source must be a string');
  if (!isObject(v['event'])) violations.push('event must be an object');
  return violations.length ? { valid: false, violations } : OK;
}

// ── Turn event contracts ──────────────────────────────────────────────────────

/**
 * Validate a TURN_STARTED event payload.
 *
 * @param v - Candidate event object.
 */
export function validateTurnStarted(v: unknown): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'TURN_STARTED') return fail(`type must be 'TURN_STARTED', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['turnId'])) violations.push('turnId must be a string');
  if (!isString(v['prompt'])) violations.push('prompt must be a string');
  return violations.length ? { valid: false, violations } : OK;
}

/**
 * Validate a TURN_STREAMING event payload.
 *
 * @param v - Candidate event object.
 */
export function validateTurnStreaming(v: unknown): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'TURN_STREAMING') return fail(`type must be 'TURN_STREAMING', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['turnId'])) violations.push('turnId must be a string');
  if (!isString(v['delta'])) violations.push('delta must be a string');
  if (!isNumber(v['deltaIndex'])) violations.push('deltaIndex must be a number');
  return violations.length ? { valid: false, violations } : OK;
}

/**
 * Validate a TURN_COMPLETED event payload.
 *
 * @param v - Candidate event object.
 */
export function validateTurnCompleted(v: unknown): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'TURN_COMPLETED') return fail(`type must be 'TURN_COMPLETED', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['turnId'])) violations.push('turnId must be a string');
  if (!isNumber(v['durationMs'])) violations.push('durationMs must be a number');
  return violations.length ? { valid: false, violations } : OK;
}

/**
 * Validate a TURN_FAILED event payload.
 *
 * @param v - Candidate event object.
 */
export function validateTurnFailed(v: unknown): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'TURN_FAILED') return fail(`type must be 'TURN_FAILED', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['turnId'])) violations.push('turnId must be a string');
  if (!isString(v['error'])) violations.push('error must be a string');
  return violations.length ? { valid: false, violations } : OK;
}

/**
 * Validate a TURN_CANCELLED event payload.
 *
 * @param v - Candidate event object.
 */
export function validateTurnCancelled(v: unknown): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'TURN_CANCELLED') return fail(`type must be 'TURN_CANCELLED', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['turnId'])) violations.push('turnId must be a string');
  return violations.length ? { valid: false, violations } : OK;
}

// ── Tool event contracts ──────────────────────────────────────────────────────

/**
 * Validate a TOOL_RECEIVED event payload.
 *
 * @param v - Candidate event object.
 */
export function validateToolReceived(v: unknown): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'TOOL_RECEIVED') return fail(`type must be 'TOOL_RECEIVED', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['callId'])) violations.push('callId must be a string');
  if (!isString(v['turnId'])) violations.push('turnId must be a string');
  if (!isString(v['toolName'])) violations.push('toolName must be a string');
  if (!isObject(v['args'])) violations.push('args must be an object');
  return violations.length ? { valid: false, violations } : OK;
}

/**
 * Validate a TOOL_SUCCEEDED event payload.
 *
 * @param v - Candidate event object.
 */
export function validateToolSucceeded(v: unknown): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'TOOL_SUCCEEDED') return fail(`type must be 'TOOL_SUCCEEDED', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['callId'])) violations.push('callId must be a string');
  if (!isString(v['turnId'])) violations.push('turnId must be a string');
  if (!isNumber(v['durationMs'])) violations.push('durationMs must be a number');
  return violations.length ? { valid: false, violations } : OK;
}

/**
 * Validate a TOOL_FAILED event payload.
 *
 * @param v - Candidate event object.
 */
export function validateToolFailed(v: unknown): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'TOOL_FAILED') return fail(`type must be 'TOOL_FAILED', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['callId'])) violations.push('callId must be a string');
  if (!isString(v['turnId'])) violations.push('turnId must be a string');
  if (!isString(v['error'])) violations.push('error must be a string');
  return violations.length ? { valid: false, violations } : OK;
}

// ── Agent event contracts ─────────────────────────────────────────────────────

/**
 * Validate an AGENT_SPAWNING event payload.
 *
 * @param v - Candidate event object.
 */
export function validateAgentSpawning(v: unknown): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'AGENT_SPAWNING') return fail(`type must be 'AGENT_SPAWNING', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['agentId'])) violations.push('agentId must be a string');
  if (!isString(v['role'])) violations.push('role must be a string');
  if (!isString(v['task'])) violations.push('task must be a string');
  return violations.length ? { valid: false, violations } : OK;
}

/**
 * Validate an AGENT_COMPLETED event payload.
 *
 * @param v - Candidate event object.
 */
export function validateAgentCompleted(v: unknown): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'AGENT_COMPLETED') return fail(`type must be 'AGENT_COMPLETED', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['agentId'])) violations.push('agentId must be a string');
  if (!isNumber(v['durationMs'])) violations.push('durationMs must be a number');
  return violations.length ? { valid: false, violations } : OK;
}

/**
 * Validate an AGENT_FAILED event payload.
 *
 * @param v - Candidate event object.
 */
export function validateAgentFailed(v: unknown): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'AGENT_FAILED') return fail(`type must be 'AGENT_FAILED', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['agentId'])) violations.push('agentId must be a string');
  if (!isString(v['error'])) violations.push('error must be a string');
  return violations.length ? { valid: false, violations } : OK;
}

// ── MCP event contracts ───────────────────────────────────────────────────────

/**
 * Validate an MCP_CONNECTED event payload.
 *
 * @param v - Candidate event object.
 */
export function validateMcpConnected(v: unknown): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'MCP_CONNECTED') return fail(`type must be 'MCP_CONNECTED', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['serverId'])) violations.push('serverId must be a string');
  if (!isNumber(v['toolCount'])) violations.push('toolCount must be a number');
  if (!isNumber(v['resourceCount'])) violations.push('resourceCount must be a number');
  return violations.length ? { valid: false, violations } : OK;
}

/**
 * Validate an MCP_DISCONNECTED event payload.
 *
 * @param v - Candidate event object.
 */
export function validateMcpDisconnected(v: unknown): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'MCP_DISCONNECTED') return fail(`type must be 'MCP_DISCONNECTED', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['serverId'])) violations.push('serverId must be a string');
  if (!isBoolean(v['willRetry'])) violations.push('willRetry must be a boolean');
  return violations.length ? { valid: false, violations } : OK;
}

/**
 * Validate an MCP_RECONNECTING event payload.
 *
 * @param v - Candidate event object.
 */
export function validateMcpReconnecting(v: unknown): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'MCP_RECONNECTING') return fail(`type must be 'MCP_RECONNECTING', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['serverId'])) violations.push('serverId must be a string');
  if (!isNumber(v['attempt'])) violations.push('attempt must be a number');
  if (!isNumber(v['maxAttempts'])) violations.push('maxAttempts must be a number');
  return violations.length ? { valid: false, violations } : OK;
}

// ── Plugin event contracts ────────────────────────────────────────────────────

/**
 * Validate a PLUGIN_LOADED event payload.
 *
 * @param v - Candidate event object.
 */
export function validatePluginLoaded(v: unknown): ContractResult {
  return validateEventFields('PLUGIN_LOADED', v, [
    { key: 'pluginName', kind: 'string' },
    { key: 'version', kind: 'string' },
    { key: 'toolCount', kind: 'number' },
  ]);
}

/**
 * Validate a PLUGIN_FAILED event payload.
 *
 * @param v - Candidate event object.
 */
export function validatePluginFailed(v: unknown): ContractResult {
  return validateEventFields('PLUGIN_FAILED', v, [
    { key: 'pluginName', kind: 'string' },
    { key: 'error', kind: 'string' },
  ]);
}

// ── Automation event contracts ───────────────────────────────────────────────

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

// ── Route event contracts ────────────────────────────────────────────────────

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

// ── Control-plane event contracts ────────────────────────────────────────────

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

// ── Delivery event contracts ─────────────────────────────────────────────────

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

// ── Watcher event contracts ──────────────────────────────────────────────────

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

// ── Surface event contracts ──────────────────────────────────────────────────

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

// ── Top-level dispatcher ──────────────────────────────────────────────────────

/**
 * Map of known event type strings to their validator functions.
 * Used by `validateEvent` for dispatching.
 */
const EVENT_VALIDATORS: Record<string, (v: unknown) => ContractResult> = {
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

/**
 * Validate an event against its registered schema contract.
 *
 * If the event type is not registered, the result is marked invalid
 * with an 'unknown event type' violation.
 *
 * @param event - The event to validate (typed as `unknown` for safety).
 * @returns ContractResult.
 */
export function validateEvent(event: unknown): ContractResult {
  if (!isObject(event)) return fail('event must be an object');
  const type = event['type'];
  if (!isString(type)) return fail('event.type must be a string');

  const validator = EVENT_VALIDATORS[type];
  if (!validator) return fail(`unknown event type: '${type}'`);

  return validator(event);
}

/**
 * Returns true if the given value is a known registered event type.
 *
 * @param type - The type string to check.
 */
export function isKnownEventType(type: unknown): type is string {
  return isString(type) && type in EVENT_VALIDATORS;
}

/**
 * Returns the full list of registered event type strings.
 */
export function registeredEventTypes(): readonly string[] {
  return Object.keys(EVENT_VALIDATORS);
}
