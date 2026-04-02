/**
 * Event schema contracts — v3 Section 21.6.
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
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'PLUGIN_LOADED') return fail(`type must be 'PLUGIN_LOADED', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['pluginName'])) violations.push('pluginName must be a string');
  if (!isString(v['version'])) violations.push('version must be a string');
  if (!isNumber(v['toolCount'])) violations.push('toolCount must be a number');
  return violations.length ? { valid: false, violations } : OK;
}

/**
 * Validate a PLUGIN_FAILED event payload.
 *
 * @param v - Candidate event object.
 */
export function validatePluginFailed(v: unknown): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== 'PLUGIN_FAILED') return fail(`type must be 'PLUGIN_FAILED', got ${String(v['type'])}`);
  const violations: string[] = [];
  if (!isString(v['pluginName'])) violations.push('pluginName must be a string');
  if (!isString(v['error'])) violations.push('error must be a string');
  return violations.length ? { valid: false, violations } : OK;
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
