import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.ts';
import {
  ARTIFACT_ATTACHMENT_SCHEMA,
  GENERIC_LIST_SCHEMA,
  JSON_OBJECT_SCHEMA,
  JSON_VALUE_SCHEMA,
  METADATA_SCHEMA,
  STRING_LIST_SCHEMA,
  enumSchema,
  nullableSchema,
  recordSchema,
} from './operator-contract-schemas-shared.ts';
export * from './operator-contract-schemas-domains.ts';
export * from './operator-contract-schemas-remote.ts';

const CONTROL_PLANE_MESSAGE_LEVEL_SCHEMA = enumSchema(['info', 'success', 'warn', 'error']);
const TASK_KIND_SCHEMA = enumSchema(['exec', 'agent', 'acp', 'scheduler', 'daemon', 'mcp', 'plugin', 'integration']);
const TASK_STATUS_SCHEMA = enumSchema(['queued', 'running', 'blocked', 'completed', 'failed', 'cancelled']);
const APPROVAL_STATUS_SCHEMA = enumSchema(['pending', 'claimed', 'approved', 'denied', 'cancelled', 'expired']);
const PROVIDER_AUTH_MODE_SCHEMA = enumSchema(['api-key', 'oauth', 'anonymous', 'none']);
const PROVIDER_AUTH_ROUTE_SCHEMA = enumSchema(['api-key', 'subscription', 'service-oauth', 'unconfigured']);
const PROVIDER_AUTH_FRESHNESS_SCHEMA = enumSchema(['healthy', 'expiring', 'expired', 'pending', 'unconfigured']);
const MEMORY_EMBEDDING_STATE_SCHEMA = enumSchema(['healthy', 'degraded', 'disabled', 'unconfigured']);
const NETWORK_HEALTH_SCHEMA = enumSchema(['healthy', 'degraded']);

const CONTROL_PLANE_SERVER_CONFIG_SCHEMA = objectSchema({
  enabled: BOOLEAN_SCHEMA,
  host: STRING_SCHEMA,
  port: NUMBER_SCHEMA,
  baseUrl: STRING_SCHEMA,
  streamingMode: enumSchema(['sse', 'websocket', 'both']),
  sessionTtlMs: NUMBER_SCHEMA,
}, ['enabled', 'host', 'port', 'streamingMode', 'sessionTtlMs']);

export const CONTROL_PLANE_CLIENT_DESCRIPTOR_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  label: STRING_SCHEMA,
  connectedAt: NUMBER_SCHEMA,
  lastSeenAt: NUMBER_SCHEMA,
  userId: STRING_SCHEMA,
}, ['id', 'surface', 'label', 'connectedAt', 'lastSeenAt']);

export const CONTROL_PLANE_SURFACE_MESSAGE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  title: STRING_SCHEMA,
  body: STRING_SCHEMA,
  level: CONTROL_PLANE_MESSAGE_LEVEL_SCHEMA,
  routeId: STRING_SCHEMA,
  surfaceId: STRING_SCHEMA,
  clientId: STRING_SCHEMA,
  attachments: arraySchema(ARTIFACT_ATTACHMENT_SCHEMA),
  metadata: METADATA_SCHEMA,
}, ['id', 'surface', 'createdAt', 'title', 'body']);

const CONTROL_PLANE_RECENT_EVENT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  event: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  payload: JSON_OBJECT_SCHEMA,
}, ['id', 'event', 'createdAt', 'payload']);

export const CONTROL_PLANE_SNAPSHOT_SCHEMA = objectSchema({
  server: CONTROL_PLANE_SERVER_CONFIG_SCHEMA,
  totals: objectSchema({
    clients: NUMBER_SCHEMA,
    activeClients: NUMBER_SCHEMA,
    surfaceMessages: NUMBER_SCHEMA,
    recentEvents: NUMBER_SCHEMA,
    requests: NUMBER_SCHEMA,
    errors: NUMBER_SCHEMA,
  }, ['clients', 'activeClients', 'surfaceMessages', 'recentEvents', 'requests', 'errors']),
  clients: arraySchema(CONTROL_PLANE_CLIENT_DESCRIPTOR_SCHEMA),
  messages: arraySchema(CONTROL_PLANE_SURFACE_MESSAGE_SCHEMA),
  recentEvents: arraySchema(CONTROL_PLANE_RECENT_EVENT_SCHEMA),
}, ['server', 'totals', 'clients', 'messages', 'recentEvents']);

export const REVIEW_SNAPSHOT_SCHEMA = objectSchema({
  apiFamilies: STRING_LIST_SCHEMA,
  routes: STRING_LIST_SCHEMA,
  sessions: NUMBER_SCHEMA,
  tasks: NUMBER_SCHEMA,
  pendingApprovals: NUMBER_SCHEMA,
  remoteContracts: NUMBER_SCHEMA,
  panels: NUMBER_SCHEMA,
}, ['apiFamilies', 'routes', 'sessions', 'tasks', 'pendingApprovals', 'remoteContracts', 'panels']);

export const SHARED_SESSION_PARTICIPANT_SCHEMA = objectSchema({
  surfaceKind: STRING_SCHEMA,
  surfaceId: STRING_SCHEMA,
  externalId: STRING_SCHEMA,
  userId: STRING_SCHEMA,
  displayName: STRING_SCHEMA,
  routeId: STRING_SCHEMA,
  lastSeenAt: NUMBER_SCHEMA,
}, ['surfaceKind', 'surfaceId', 'lastSeenAt']);

export const SHARED_SESSION_MESSAGE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  role: enumSchema(['user', 'assistant', 'system']),
  body: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  surfaceKind: STRING_SCHEMA,
  surfaceId: STRING_SCHEMA,
  routeId: STRING_SCHEMA,
  agentId: STRING_SCHEMA,
  userId: STRING_SCHEMA,
  displayName: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'sessionId', 'role', 'body', 'createdAt', 'metadata']);

export const SHARED_SESSION_RECORD_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  title: STRING_SCHEMA,
  status: enumSchema(['active', 'closed']),
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  lastMessageAt: NUMBER_SCHEMA,
  closedAt: NUMBER_SCHEMA,
  messageCount: NUMBER_SCHEMA,
  routeIds: STRING_LIST_SCHEMA,
  surfaceKinds: STRING_LIST_SCHEMA,
  participants: arraySchema(SHARED_SESSION_PARTICIPANT_SCHEMA),
  activeAgentId: STRING_SCHEMA,
  lastAgentId: STRING_SCHEMA,
  lastError: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'title', 'status', 'createdAt', 'updatedAt', 'messageCount', 'routeIds', 'surfaceKinds', 'participants', 'metadata']);

export const SESSION_SNAPSHOT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  title: STRING_SCHEMA,
  status: STRING_SCHEMA,
  recoveryState: STRING_SCHEMA,
  projectRoot: STRING_SCHEMA,
  isResumed: BOOLEAN_SCHEMA,
  resumedFromId: STRING_SCHEMA,
  compactionState: STRING_SCHEMA,
  lastCompactedAt: NUMBER_SCHEMA,
  lineage: STRING_LIST_SCHEMA,
}, ['id', 'title', 'status', 'recoveryState', 'projectRoot', 'isResumed', 'compactionState', 'lineage']);

export const SESSION_BROKER_SNAPSHOT_SCHEMA = objectSchema({
  totals: objectSchema({
    sessions: NUMBER_SCHEMA,
    active: NUMBER_SCHEMA,
    closed: NUMBER_SCHEMA,
  }, ['sessions', 'active', 'closed']),
  sessions: arraySchema(SHARED_SESSION_RECORD_SCHEMA),
}, ['totals', 'sessions']);

export const SHARED_SESSION_WITH_MESSAGES_SCHEMA = objectSchema({
  session: SHARED_SESSION_RECORD_SCHEMA,
  messages: arraySchema(SHARED_SESSION_MESSAGE_SCHEMA),
}, ['session', 'messages']);

export const SHARED_SESSION_CREATE_OUTPUT_SCHEMA = objectSchema({
  session: SHARED_SESSION_RECORD_SCHEMA,
}, ['session']);

export const SHARED_SESSION_MESSAGE_CREATE_OUTPUT_SCHEMA = objectSchema({
  session: nullableSchema(SHARED_SESSION_RECORD_SCHEMA),
  message: SHARED_SESSION_MESSAGE_SCHEMA,
  mode: STRING_SCHEMA,
  agentId: nullableSchema(STRING_SCHEMA),
}, ['session', 'message', 'mode', 'agentId']);

const TASK_RETRY_POLICY_SCHEMA = objectSchema({
  maxAttempts: NUMBER_SCHEMA,
  currentAttempt: NUMBER_SCHEMA,
  delayMs: NUMBER_SCHEMA,
  backoff: enumSchema(['fixed', 'exponential']),
  retryOn: arraySchema(enumSchema(['network', 'timeout', 'transient', 'tool_error'])),
}, ['maxAttempts', 'currentAttempt', 'delayMs', 'backoff', 'retryOn']);

export const RUNTIME_TASK_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: TASK_KIND_SCHEMA,
  title: STRING_SCHEMA,
  description: STRING_SCHEMA,
  status: TASK_STATUS_SCHEMA,
  owner: STRING_SCHEMA,
  cancellable: BOOLEAN_SCHEMA,
  parentTaskId: STRING_SCHEMA,
  childTaskIds: STRING_LIST_SCHEMA,
  queuedAt: NUMBER_SCHEMA,
  startedAt: NUMBER_SCHEMA,
  endedAt: NUMBER_SCHEMA,
  retryPolicy: TASK_RETRY_POLICY_SCHEMA,
  retryDelayMs: NUMBER_SCHEMA,
  retryAt: NUMBER_SCHEMA,
  exitCode: NUMBER_SCHEMA,
  error: STRING_SCHEMA,
  result: JSON_VALUE_SCHEMA,
  correlationId: STRING_SCHEMA,
  turnId: STRING_SCHEMA,
}, ['id', 'kind', 'title', 'status', 'owner', 'cancellable', 'childTaskIds', 'queuedAt']);

export const TASK_SNAPSHOT_SCHEMA = objectSchema({
  queued: NUMBER_SCHEMA,
  running: NUMBER_SCHEMA,
  blocked: NUMBER_SCHEMA,
  totals: objectSchema({
    created: NUMBER_SCHEMA,
    completed: NUMBER_SCHEMA,
    failed: NUMBER_SCHEMA,
    cancelled: NUMBER_SCHEMA,
  }, ['created', 'completed', 'failed', 'cancelled']),
  tasks: arraySchema(objectSchema({
    id: STRING_SCHEMA,
    kind: TASK_KIND_SCHEMA,
    title: STRING_SCHEMA,
    status: TASK_STATUS_SCHEMA,
    owner: STRING_SCHEMA,
    parentTaskId: STRING_SCHEMA,
    queuedAt: NUMBER_SCHEMA,
    startedAt: NUMBER_SCHEMA,
    endedAt: NUMBER_SCHEMA,
    error: STRING_SCHEMA,
  }, ['id', 'kind', 'title', 'status', 'owner', 'queuedAt'])),
}, ['queued', 'running', 'blocked', 'totals', 'tasks']);

export const TASK_CREATE_INPUT_SCHEMA = objectSchema({
  task: STRING_SCHEMA,
  model: STRING_SCHEMA,
  tools: STRING_LIST_SCHEMA,
  provider: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  routeId: STRING_SCHEMA,
  surfaceKind: STRING_SCHEMA,
  surfaceId: STRING_SCHEMA,
  externalId: STRING_SCHEMA,
  threadId: STRING_SCHEMA,
  userId: STRING_SCHEMA,
  displayName: STRING_SCHEMA,
  title: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['task'], { additionalProperties: true });

export const TASK_CREATE_OUTPUT_SCHEMA = objectSchema({
  acknowledged: BOOLEAN_SCHEMA,
  mode: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  agentId: nullableSchema(STRING_SCHEMA),
  status: STRING_SCHEMA,
  task: STRING_SCHEMA,
  model: nullableSchema(STRING_SCHEMA),
  tools: STRING_LIST_SCHEMA,
}, ['acknowledged'], { additionalProperties: true });

export const TASK_OUTPUT_SCHEMA = objectSchema({
  task: RUNTIME_TASK_SCHEMA,
}, ['task']);

export const TASK_ACTION_OUTPUT_SCHEMA = objectSchema({
  retried: BOOLEAN_SCHEMA,
  task: RUNTIME_TASK_SCHEMA,
  agentId: STRING_SCHEMA,
}, ['task'], { additionalProperties: true });

export const TASK_STATUS_OUTPUT_SCHEMA = objectSchema({
  agentId: STRING_SCHEMA,
  task: STRING_SCHEMA,
  status: STRING_SCHEMA,
  model: nullableSchema(STRING_SCHEMA),
  tools: STRING_LIST_SCHEMA,
  durationMs: NUMBER_SCHEMA,
  toolCallCount: NUMBER_SCHEMA,
  progress: nullableSchema(STRING_SCHEMA),
  error: nullableSchema(STRING_SCHEMA),
}, ['agentId', 'task', 'status', 'model', 'tools', 'durationMs', 'toolCallCount', 'progress', 'error']);

const SHARED_APPROVAL_AUDIT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  action: enumSchema(['created', 'claimed', 'approved', 'denied', 'cancelled', 'expired', 'updated']),
  actor: STRING_SCHEMA,
  actorSurface: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  note: STRING_SCHEMA,
}, ['id', 'action', 'actor', 'createdAt']);

const SHARED_APPROVAL_DECISION_SCHEMA = objectSchema({
  approved: BOOLEAN_SCHEMA,
  remember: BOOLEAN_SCHEMA,
}, ['approved'], { additionalProperties: true });

export const SHARED_APPROVAL_RECORD_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  callId: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  routeId: STRING_SCHEMA,
  status: APPROVAL_STATUS_SCHEMA,
  request: JSON_OBJECT_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  claimedBy: STRING_SCHEMA,
  claimedAt: NUMBER_SCHEMA,
  resolvedAt: NUMBER_SCHEMA,
  resolvedBy: STRING_SCHEMA,
  decision: SHARED_APPROVAL_DECISION_SCHEMA,
  metadata: METADATA_SCHEMA,
  audit: arraySchema(SHARED_APPROVAL_AUDIT_SCHEMA),
}, ['id', 'callId', 'status', 'request', 'createdAt', 'updatedAt', 'metadata', 'audit']);

export const APPROVAL_SNAPSHOT_SCHEMA = objectSchema({
  awaitingDecision: BOOLEAN_SCHEMA,
  mode: STRING_SCHEMA,
  lastDecision: JSON_OBJECT_SCHEMA,
  approvalCount: NUMBER_SCHEMA,
  denialCount: NUMBER_SCHEMA,
  cachedChecks: NUMBER_SCHEMA,
  totalChecks: NUMBER_SCHEMA,
  approvals: arraySchema(SHARED_APPROVAL_RECORD_SCHEMA),
}, ['awaitingDecision', 'mode', 'approvalCount', 'denialCount', 'cachedChecks', 'totalChecks', 'approvals'], { additionalProperties: true });

export const APPROVAL_ACTION_INPUT_SCHEMA = objectSchema({
  approvalId: STRING_SCHEMA,
  note: STRING_SCHEMA,
  remember: BOOLEAN_SCHEMA,
}, ['approvalId'], { additionalProperties: true });

export const APPROVAL_ACTION_OUTPUT_SCHEMA = objectSchema({
  approval: SHARED_APPROVAL_RECORD_SCHEMA,
}, ['approval']);

const PROVIDER_USAGE_COST_SCHEMA = objectSchema({
  source: enumSchema(['catalog', 'provider', 'none']),
  currency: STRING_SCHEMA,
  inputPerMillionTokens: NUMBER_SCHEMA,
  outputPerMillionTokens: NUMBER_SCHEMA,
  detail: STRING_SCHEMA,
}, ['source'], { additionalProperties: true });

const PROVIDER_AUTH_ROUTE_DESCRIPTOR_SCHEMA = objectSchema({
  route: STRING_SCHEMA,
  label: STRING_SCHEMA,
  configured: BOOLEAN_SCHEMA,
  usable: BOOLEAN_SCHEMA,
  freshness: STRING_SCHEMA,
  detail: STRING_SCHEMA,
  envVars: STRING_LIST_SCHEMA,
  secretKeys: STRING_LIST_SCHEMA,
  serviceNames: STRING_LIST_SCHEMA,
  providerId: STRING_SCHEMA,
  repairHints: STRING_LIST_SCHEMA,
}, ['route', 'label', 'configured'], { additionalProperties: true });

const PROVIDER_RUNTIME_METADATA_SCHEMA = objectSchema({
  auth: objectSchema({
    mode: PROVIDER_AUTH_MODE_SCHEMA,
    configured: BOOLEAN_SCHEMA,
    detail: STRING_SCHEMA,
    envVars: STRING_LIST_SCHEMA,
    routes: arraySchema(PROVIDER_AUTH_ROUTE_DESCRIPTOR_SCHEMA),
  }, ['mode', 'configured'], { additionalProperties: true }),
  models: objectSchema({
    defaultModel: STRING_SCHEMA,
    models: STRING_LIST_SCHEMA,
    embeddingModel: STRING_SCHEMA,
    embeddingDimensions: NUMBER_SCHEMA,
    aliases: STRING_LIST_SCHEMA,
    suppressedModels: STRING_LIST_SCHEMA,
  }, ['models'], { additionalProperties: true }),
  usage: objectSchema({
    streaming: BOOLEAN_SCHEMA,
    toolCalling: BOOLEAN_SCHEMA,
    parallelTools: BOOLEAN_SCHEMA,
    promptCaching: BOOLEAN_SCHEMA,
    cost: PROVIDER_USAGE_COST_SCHEMA,
    notes: STRING_LIST_SCHEMA,
  }, ['streaming', 'toolCalling', 'parallelTools'], { additionalProperties: true }),
  policy: objectSchema({
    local: BOOLEAN_SCHEMA,
    dataRetention: STRING_SCHEMA,
    streamProtocol: STRING_SCHEMA,
    reasoningMode: STRING_SCHEMA,
    supportedReasoningEfforts: STRING_LIST_SCHEMA,
    cacheStrategy: STRING_SCHEMA,
    notes: STRING_LIST_SCHEMA,
  }, [], { additionalProperties: true }),
  notes: STRING_LIST_SCHEMA,
}, [], { additionalProperties: true });

const PROVIDER_MODEL_SNAPSHOT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  registryKey: STRING_SCHEMA,
  displayName: STRING_SCHEMA,
  selectable: BOOLEAN_SCHEMA,
  contextWindow: NUMBER_SCHEMA,
  tier: STRING_SCHEMA,
  pricing: objectSchema({
    inputPerMillionTokens: NUMBER_SCHEMA,
    outputPerMillionTokens: NUMBER_SCHEMA,
    currency: enumSchema(['USD']),
  }, ['inputPerMillionTokens', 'outputPerMillionTokens', 'currency']),
}, ['id', 'registryKey', 'displayName', 'selectable', 'contextWindow'], { additionalProperties: true });

export const PROVIDER_RUNTIME_SNAPSHOT_SCHEMA = objectSchema({
  providerId: STRING_SCHEMA,
  active: BOOLEAN_SCHEMA,
  modelCount: NUMBER_SCHEMA,
  runtime: PROVIDER_RUNTIME_METADATA_SCHEMA,
  models: arraySchema(PROVIDER_MODEL_SNAPSHOT_SCHEMA),
}, ['providerId', 'active', 'modelCount', 'runtime', 'models']);

export const PROVIDER_USAGE_SNAPSHOT_SCHEMA = objectSchema({
  providerId: STRING_SCHEMA,
  active: BOOLEAN_SCHEMA,
  currentModelId: STRING_SCHEMA,
  pricingSource: enumSchema(['catalog', 'provider', 'none']),
  models: arraySchema(PROVIDER_MODEL_SNAPSHOT_SCHEMA),
  usage: objectSchema({
    streaming: BOOLEAN_SCHEMA,
    toolCalling: BOOLEAN_SCHEMA,
    parallelTools: BOOLEAN_SCHEMA,
    promptCaching: BOOLEAN_SCHEMA,
    cost: PROVIDER_USAGE_COST_SCHEMA,
    notes: STRING_LIST_SCHEMA,
  }, ['streaming', 'toolCalling', 'parallelTools'], { additionalProperties: true }),
}, ['providerId', 'active', 'pricingSource', 'models', 'usage'], { additionalProperties: true });

const PROVIDER_USAGE_WINDOW_SCHEMA = objectSchema({
  label: STRING_SCHEMA,
  detail: STRING_SCHEMA,
}, ['label', 'detail']);

const PROVIDER_ROUTE_RECORD_SCHEMA = objectSchema({
  route: PROVIDER_AUTH_ROUTE_SCHEMA,
  usable: BOOLEAN_SCHEMA,
  freshness: PROVIDER_AUTH_FRESHNESS_SCHEMA,
  detail: STRING_SCHEMA,
  issues: STRING_LIST_SCHEMA,
}, ['route', 'usable', 'freshness', 'detail', 'issues']);

const PROVIDER_ACCOUNT_RECORD_SCHEMA = objectSchema({
  providerId: STRING_SCHEMA,
  active: BOOLEAN_SCHEMA,
  modelCount: NUMBER_SCHEMA,
  configured: BOOLEAN_SCHEMA,
  oauthReady: BOOLEAN_SCHEMA,
  pendingLogin: BOOLEAN_SCHEMA,
  availableRoutes: arraySchema(PROVIDER_AUTH_ROUTE_SCHEMA),
  preferredRoute: PROVIDER_AUTH_ROUTE_SCHEMA,
  activeRoute: PROVIDER_AUTH_ROUTE_SCHEMA,
  activeRouteReason: STRING_SCHEMA,
  authFreshness: PROVIDER_AUTH_FRESHNESS_SCHEMA,
  fallbackRoute: PROVIDER_AUTH_ROUTE_SCHEMA,
  fallbackRisk: STRING_SCHEMA,
  expiresAt: NUMBER_SCHEMA,
  tokenType: STRING_SCHEMA,
  notes: STRING_LIST_SCHEMA,
  usageWindows: arraySchema(PROVIDER_USAGE_WINDOW_SCHEMA),
  issues: STRING_LIST_SCHEMA,
  recommendedActions: STRING_LIST_SCHEMA,
  routeRecords: arraySchema(PROVIDER_ROUTE_RECORD_SCHEMA),
}, ['providerId', 'active', 'modelCount', 'configured', 'oauthReady', 'pendingLogin', 'availableRoutes', 'preferredRoute', 'activeRoute', 'activeRouteReason', 'authFreshness', 'notes', 'usageWindows', 'issues', 'recommendedActions', 'routeRecords'], { additionalProperties: true });

export const PROVIDER_ACCOUNT_SNAPSHOT_SCHEMA = objectSchema({
  capturedAt: NUMBER_SCHEMA,
  providers: arraySchema(PROVIDER_ACCOUNT_RECORD_SCHEMA),
  configuredCount: NUMBER_SCHEMA,
  issueCount: NUMBER_SCHEMA,
}, ['capturedAt', 'providers', 'configuredCount', 'issueCount']);

export const HEALTH_SNAPSHOT_SCHEMA = objectSchema({
  overall: NETWORK_HEALTH_SCHEMA,
  degradedDomains: STRING_LIST_SCHEMA,
  providerProblems: STRING_LIST_SCHEMA,
  mcpProblems: objectSchema({
    degraded: STRING_LIST_SCHEMA,
    quarantined: STRING_LIST_SCHEMA,
  }, ['degraded', 'quarantined']),
  integrationProblems: GENERIC_LIST_SCHEMA,
  network: objectSchema({
    controlPlane: JSON_OBJECT_SCHEMA,
    httpListener: JSON_OBJECT_SCHEMA,
    outbound: JSON_OBJECT_SCHEMA,
  }, ['controlPlane', 'httpListener', 'outbound']),
}, ['overall', 'degradedDomains', 'providerProblems', 'mcpProblems', 'integrationProblems'], { additionalProperties: true });

export const SETTINGS_SNAPSHOT_SCHEMA = objectSchema({
  available: BOOLEAN_SCHEMA,
  reason: STRING_SCHEMA,
  liveKeyCount: NUMBER_SCHEMA,
  profileCount: NUMBER_SCHEMA,
  managedLockCount: NUMBER_SCHEMA,
  resolvedCounts: recordSchema(NUMBER_SCHEMA),
  conflicts: GENERIC_LIST_SCHEMA,
  recentFailures: GENERIC_LIST_SCHEMA,
  stagedManagedBundle: JSON_OBJECT_SCHEMA,
  rollbackHistory: GENERIC_LIST_SCHEMA,
}, [], { additionalProperties: true });

export const CONTINUITY_SNAPSHOT_SCHEMA = objectSchema({
  sessionId: STRING_SCHEMA,
  status: STRING_SCHEMA,
  recoveryState: STRING_SCHEMA,
  lastSessionPointer: JSON_OBJECT_SCHEMA,
  recoveryFilePresent: BOOLEAN_SCHEMA,
  recoveryFile: nullableSchema(JSON_OBJECT_SCHEMA),
}, ['sessionId', 'status', 'recoveryState', 'lastSessionPointer', 'recoveryFilePresent', 'recoveryFile']);

export const WORKTREE_SNAPSHOT_SCHEMA = objectSchema({
  summary: JSON_OBJECT_SCHEMA,
  records: GENERIC_LIST_SCHEMA,
}, ['summary', 'records']);

export const INTELLIGENCE_SNAPSHOT_SCHEMA = objectSchema({
  diagnosticsStatus: STRING_SCHEMA,
  symbolSearchStatus: STRING_SCHEMA,
  completionsStatus: STRING_SCHEMA,
  hoverStatus: STRING_SCHEMA,
  errorCount: NUMBER_SCHEMA,
  warningCount: NUMBER_SCHEMA,
  totalRequests: NUMBER_SCHEMA,
  avgLatencyMs: NUMBER_SCHEMA,
}, ['diagnosticsStatus', 'symbolSearchStatus', 'completionsStatus', 'hoverStatus', 'errorCount', 'warningCount', 'totalRequests', 'avgLatencyMs']);

const MEMORY_EMBEDDING_PROVIDER_STATUS_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  state: MEMORY_EMBEDDING_STATE_SCHEMA,
  dimensions: NUMBER_SCHEMA,
  configured: BOOLEAN_SCHEMA,
  deterministic: BOOLEAN_SCHEMA,
  detail: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'label', 'state', 'dimensions', 'configured', 'metadata'], { additionalProperties: true });

const MEMORY_EMBEDDING_DOCTOR_REPORT_SCHEMA = objectSchema({
  activeProviderId: STRING_SCHEMA,
  providers: arraySchema(MEMORY_EMBEDDING_PROVIDER_STATUS_SCHEMA),
  asyncProviders: STRING_LIST_SCHEMA,
  syncProviders: STRING_LIST_SCHEMA,
  warnings: STRING_LIST_SCHEMA,
}, ['activeProviderId', 'providers', 'asyncProviders', 'syncProviders', 'warnings']);

export const MEMORY_VECTOR_STATS_SCHEMA = objectSchema({
  backend: enumSchema(['sqlite-vec']),
  enabled: BOOLEAN_SCHEMA,
  available: BOOLEAN_SCHEMA,
  path: STRING_SCHEMA,
  dimensions: NUMBER_SCHEMA,
  indexedRecords: NUMBER_SCHEMA,
  embeddingProviderId: STRING_SCHEMA,
  embeddingProviderLabel: STRING_SCHEMA,
  error: STRING_SCHEMA,
}, ['backend', 'enabled', 'available', 'path', 'dimensions', 'indexedRecords', 'embeddingProviderId', 'embeddingProviderLabel'], { additionalProperties: true });

export const MEMORY_DOCTOR_REPORT_SCHEMA = objectSchema({
  vector: MEMORY_VECTOR_STATS_SCHEMA,
  embeddings: MEMORY_EMBEDDING_DOCTOR_REPORT_SCHEMA,
  checkedAt: NUMBER_SCHEMA,
}, ['vector', 'embeddings', 'checkedAt']);
