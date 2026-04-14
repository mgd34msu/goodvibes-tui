import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.ts';
import {
  JSON_OBJECT_SCHEMA,
  JSON_RECORD_SCHEMA,
  JSON_VALUE_SCHEMA,
  STRING_LIST_SCHEMA,
  enumSchema,
  nullableSchema,
  recordSchema,
} from './operator-contract-schemas-shared.ts';

const ERROR_CATEGORY_SCHEMA = enumSchema([
  'authentication',
  'authorization',
  'billing',
  'rate_limit',
  'timeout',
  'network',
  'bad_request',
  'not_found',
  'permission',
  'tool',
  'config',
  'protocol',
  'service',
  'internal',
  'unknown',
]);

const ERROR_SOURCE_SCHEMA = enumSchema([
  'provider',
  'tool',
  'transport',
  'config',
  'permission',
  'runtime',
  'render',
  'acp',
  'unknown',
]);

const AUTHENTICATED_PRINCIPAL_KIND_SCHEMA = enumSchema(['user', 'bot', 'service', 'token']);

export const CONTROL_AUTH_CURRENT_MODE_SCHEMA = enumSchema(['anonymous', 'invalid', 'session', 'shared-token']);
export const TELEMETRY_VIEW_SCHEMA = enumSchema(['safe', 'raw']);
export const TELEMETRY_SEVERITY_SCHEMA = enumSchema(['debug', 'info', 'warn', 'error']);

export const CONTROL_AUTH_CURRENT_RESPONSE_SCHEMA = objectSchema({
  authenticated: BOOLEAN_SCHEMA,
  authMode: CONTROL_AUTH_CURRENT_MODE_SCHEMA,
  tokenPresent: BOOLEAN_SCHEMA,
  authorizationHeaderPresent: BOOLEAN_SCHEMA,
  sessionCookiePresent: BOOLEAN_SCHEMA,
  principalId: nullableSchema(STRING_SCHEMA),
  principalKind: nullableSchema(AUTHENTICATED_PRINCIPAL_KIND_SCHEMA),
  admin: BOOLEAN_SCHEMA,
  scopes: STRING_LIST_SCHEMA,
  roles: STRING_LIST_SCHEMA,
}, [
  'authenticated',
  'authMode',
  'tokenPresent',
  'authorizationHeaderPresent',
  'sessionCookiePresent',
  'principalId',
  'principalKind',
  'admin',
  'scopes',
  'roles',
]);

export const TELEMETRY_FILTER_INPUT_SCHEMA = objectSchema({
  limit: NUMBER_SCHEMA,
  since: NUMBER_SCHEMA,
  until: NUMBER_SCHEMA,
  domains: STRING_SCHEMA,
  types: STRING_SCHEMA,
  severity: TELEMETRY_SEVERITY_SCHEMA,
  traceId: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  turnId: STRING_SCHEMA,
  agentId: STRING_SCHEMA,
  taskId: STRING_SCHEMA,
  cursor: STRING_SCHEMA,
  view: TELEMETRY_VIEW_SCHEMA,
});

export const TELEMETRY_NORMALIZED_ERROR_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  message: STRING_SCHEMA,
  summary: STRING_SCHEMA,
  hint: STRING_SCHEMA,
  code: STRING_SCHEMA,
  category: ERROR_CATEGORY_SCHEMA,
  source: ERROR_SOURCE_SCHEMA,
  recoverable: BOOLEAN_SCHEMA,
  statusCode: NUMBER_SCHEMA,
  provider: STRING_SCHEMA,
  operation: STRING_SCHEMA,
  phase: STRING_SCHEMA,
  requestId: STRING_SCHEMA,
  providerCode: STRING_SCHEMA,
  providerType: STRING_SCHEMA,
  retryAfterMs: NUMBER_SCHEMA,
}, ['name', 'message', 'summary', 'category', 'source', 'recoverable']);

export const TELEMETRY_RECORD_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  domain: STRING_SCHEMA,
  type: STRING_SCHEMA,
  timestamp: NUMBER_SCHEMA,
  severity: TELEMETRY_SEVERITY_SCHEMA,
  traceId: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  turnId: STRING_SCHEMA,
  agentId: STRING_SCHEMA,
  taskId: STRING_SCHEMA,
  source: STRING_SCHEMA,
  message: STRING_SCHEMA,
  payload: JSON_VALUE_SCHEMA,
  attributes: JSON_RECORD_SCHEMA,
  error: TELEMETRY_NORMALIZED_ERROR_SCHEMA,
}, [
  'id',
  'domain',
  'type',
  'timestamp',
  'severity',
  'traceId',
  'sessionId',
  'source',
  'message',
  'payload',
  'attributes',
]);

export const TELEMETRY_PAGE_INFO_SCHEMA = objectSchema({
  limit: NUMBER_SCHEMA,
  returned: NUMBER_SCHEMA,
  hasMore: BOOLEAN_SCHEMA,
  cursor: STRING_SCHEMA,
  nextCursor: STRING_SCHEMA,
}, ['limit', 'returned', 'hasMore']);

const TELEMETRY_CAPABILITIES_SCHEMA = objectSchema({
  signals: objectSchema({
    events: BOOLEAN_SCHEMA,
    errors: BOOLEAN_SCHEMA,
    metrics: BOOLEAN_SCHEMA,
    traces: BOOLEAN_SCHEMA,
  }, ['events', 'errors', 'metrics', 'traces']),
  encodings: objectSchema({
    json: BOOLEAN_SCHEMA,
    sse: BOOLEAN_SCHEMA,
    otlpJson: objectSchema({
      traces: BOOLEAN_SCHEMA,
      metrics: BOOLEAN_SCHEMA,
      logs: BOOLEAN_SCHEMA,
    }, ['traces', 'metrics', 'logs']),
  }, ['json', 'sse', 'otlpJson']),
}, ['signals', 'encodings']);

const TELEMETRY_TRACE_CONTEXT_SCHEMA = objectSchema({
  traceId: STRING_SCHEMA,
  rootSpanId: STRING_SCHEMA,
  exportActive: BOOLEAN_SCHEMA,
  endpoint: STRING_SCHEMA,
}, ['traceId', 'rootSpanId', 'exportActive']);

const TELEMETRY_RUNTIME_SNAPSHOT_SCHEMA = objectSchema({
  sessionId: STRING_SCHEMA,
  sessionStatus: STRING_SCHEMA,
  traceContext: TELEMETRY_TRACE_CONTEXT_SCHEMA,
  sessionCorrelationId: STRING_SCHEMA,
  currentTurnCorrelationId: STRING_SCHEMA,
  dbAvailable: BOOLEAN_SCHEMA,
  dbPath: STRING_SCHEMA,
  tasks: objectSchema({
    total: NUMBER_SCHEMA,
    queued: NUMBER_SCHEMA,
    running: NUMBER_SCHEMA,
    blocked: NUMBER_SCHEMA,
  }, ['total', 'queued', 'running', 'blocked']),
  agents: objectSchema({
    total: NUMBER_SCHEMA,
    active: NUMBER_SCHEMA,
  }, ['total', 'active']),
  approvals: objectSchema({
    pending: NUMBER_SCHEMA,
  }, ['pending']),
}, ['sessionId', 'sessionStatus', 'sessionCorrelationId', 'dbAvailable', 'tasks', 'agents', 'approvals']);

const TELEMETRY_SESSION_METRICS_SCHEMA = objectSchema({
  turns: NUMBER_SCHEMA,
  toolCalls: NUMBER_SCHEMA,
  toolErrors: NUMBER_SCHEMA,
  agentsSpawned: NUMBER_SCHEMA,
  inputTokens: NUMBER_SCHEMA,
  outputTokens: NUMBER_SCHEMA,
  cacheReadTokens: NUMBER_SCHEMA,
  permissionPrompts: NUMBER_SCHEMA,
  permissionDenials: NUMBER_SCHEMA,
  errors: NUMBER_SCHEMA,
  warnings: NUMBER_SCHEMA,
}, [
  'turns',
  'toolCalls',
  'toolErrors',
  'agentsSpawned',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'permissionPrompts',
  'permissionDenials',
  'errors',
  'warnings',
]);

const TELEMETRY_AGGREGATES_SCHEMA = objectSchema({
  totalEvents: NUMBER_SCHEMA,
  totalErrors: NUMBER_SCHEMA,
  totalWarnings: NUMBER_SCHEMA,
  totalSpans: NUMBER_SCHEMA,
  byDomain: recordSchema(NUMBER_SCHEMA),
  byEventType: recordSchema(NUMBER_SCHEMA),
  errorsByCategory: recordSchema(NUMBER_SCHEMA),
}, ['totalEvents', 'totalErrors', 'totalWarnings', 'totalSpans', 'byDomain', 'byEventType', 'errorsByCategory']);

const SPAN_CONTEXT_SCHEMA = objectSchema({
  traceId: STRING_SCHEMA,
  spanId: STRING_SCHEMA,
  isValid: BOOLEAN_SCHEMA,
}, ['traceId', 'spanId', 'isValid']);

const SPAN_EVENT_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  timestamp: NUMBER_SCHEMA,
  attributes: JSON_RECORD_SCHEMA,
}, ['name', 'timestamp']);

const SPAN_STATUS_SCHEMA = objectSchema({
  code: NUMBER_SCHEMA,
  message: STRING_SCHEMA,
}, ['code']);

export const TELEMETRY_READABLE_SPAN_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  kind: NUMBER_SCHEMA,
  spanContext: SPAN_CONTEXT_SCHEMA,
  parentSpanId: STRING_SCHEMA,
  startTimeMs: NUMBER_SCHEMA,
  endTimeMs: NUMBER_SCHEMA,
  durationMs: NUMBER_SCHEMA,
  attributes: JSON_RECORD_SCHEMA,
  events: arraySchema(SPAN_EVENT_SCHEMA),
  status: SPAN_STATUS_SCHEMA,
  instrumentationScope: STRING_SCHEMA,
}, [
  'name',
  'kind',
  'spanContext',
  'startTimeMs',
  'endTimeMs',
  'durationMs',
  'attributes',
  'events',
  'status',
  'instrumentationScope',
]);

function telemetryListResponseSchema(itemSchema: Record<string, unknown>): Record<string, unknown> {
  return objectSchema({
    version: NUMBER_SCHEMA,
    view: TELEMETRY_VIEW_SCHEMA,
    rawAccessible: BOOLEAN_SCHEMA,
    items: arraySchema(itemSchema),
    pageInfo: TELEMETRY_PAGE_INFO_SCHEMA,
  }, ['version', 'view', 'rawAccessible', 'items', 'pageInfo']);
}

export const TELEMETRY_RECORD_LIST_RESPONSE_SCHEMA = telemetryListResponseSchema(TELEMETRY_RECORD_SCHEMA);
export const TELEMETRY_SPAN_LIST_RESPONSE_SCHEMA = telemetryListResponseSchema(TELEMETRY_READABLE_SPAN_SCHEMA);

export const TELEMETRY_STREAM_READY_SCHEMA = objectSchema({
  version: NUMBER_SCHEMA,
  capabilities: TELEMETRY_CAPABILITIES_SCHEMA,
  view: TELEMETRY_VIEW_SCHEMA,
  rawAccessible: BOOLEAN_SCHEMA,
  resumedFrom: STRING_SCHEMA,
}, ['version', 'capabilities', 'view', 'rawAccessible']);

export const TELEMETRY_SNAPSHOT_SCHEMA = objectSchema({
  version: NUMBER_SCHEMA,
  view: TELEMETRY_VIEW_SCHEMA,
  rawAccessible: BOOLEAN_SCHEMA,
  generatedAt: NUMBER_SCHEMA,
  service: objectSchema({
    name: STRING_SCHEMA,
    version: STRING_SCHEMA,
  }, ['name', 'version']),
  capabilities: TELEMETRY_CAPABILITIES_SCHEMA,
  runtime: TELEMETRY_RUNTIME_SNAPSHOT_SCHEMA,
  sessionMetrics: TELEMETRY_SESSION_METRICS_SCHEMA,
  aggregates: TELEMETRY_AGGREGATES_SCHEMA,
  recent: objectSchema({
    events: TELEMETRY_RECORD_LIST_RESPONSE_SCHEMA,
    errors: TELEMETRY_RECORD_LIST_RESPONSE_SCHEMA,
    spans: TELEMETRY_SPAN_LIST_RESPONSE_SCHEMA,
  }, ['events', 'errors', 'spans']),
}, [
  'version',
  'view',
  'rawAccessible',
  'generatedAt',
  'service',
  'capabilities',
  'runtime',
  'sessionMetrics',
  'aggregates',
  'recent',
]);

export const TELEMETRY_METRICS_SNAPSHOT_SCHEMA = objectSchema({
  version: NUMBER_SCHEMA,
  view: TELEMETRY_VIEW_SCHEMA,
  rawAccessible: BOOLEAN_SCHEMA,
  generatedAt: NUMBER_SCHEMA,
  runtime: TELEMETRY_RUNTIME_SNAPSHOT_SCHEMA,
  sessionMetrics: TELEMETRY_SESSION_METRICS_SCHEMA,
  aggregates: TELEMETRY_AGGREGATES_SCHEMA,
}, ['version', 'view', 'rawAccessible', 'generatedAt', 'runtime', 'sessionMetrics', 'aggregates']);

export const OTLP_TRACE_DOCUMENT_SCHEMA = objectSchema({
  resourceSpans: arraySchema(JSON_OBJECT_SCHEMA),
}, ['resourceSpans']);

export const OTLP_LOG_DOCUMENT_SCHEMA = objectSchema({
  resourceLogs: arraySchema(JSON_OBJECT_SCHEMA),
}, ['resourceLogs']);

export const OTLP_METRIC_DOCUMENT_SCHEMA = objectSchema({
  resourceMetrics: arraySchema(JSON_OBJECT_SCHEMA),
}, ['resourceMetrics']);
