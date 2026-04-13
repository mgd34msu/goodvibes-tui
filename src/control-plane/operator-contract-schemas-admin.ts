import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.ts';
import {
  CONFIG_CATEGORY_SNAPSHOT_SCHEMA,
  JSON_VALUE_SCHEMA,
  METADATA_SCHEMA,
  STRING_LIST_SCHEMA,
  enumSchema,
} from './operator-contract-schemas-shared.ts';

export const LOCAL_AUTH_USER_SCHEMA = objectSchema({
  username: STRING_SCHEMA,
  roles: STRING_LIST_SCHEMA,
}, ['username', 'roles']);

const LOCAL_AUTH_SESSION_SCHEMA = objectSchema({
  token: STRING_SCHEMA,
  username: STRING_SCHEMA,
  expiresAt: NUMBER_SCHEMA,
}, ['token', 'username', 'expiresAt']);

export const LOCAL_AUTH_STATUS_SCHEMA = objectSchema({
  userStorePath: STRING_SCHEMA,
  bootstrapCredentialPath: STRING_SCHEMA,
  bootstrapCredentialPresent: BOOLEAN_SCHEMA,
  userCount: NUMBER_SCHEMA,
  sessionCount: NUMBER_SCHEMA,
  users: arraySchema(LOCAL_AUTH_USER_SCHEMA),
  sessions: arraySchema(LOCAL_AUTH_SESSION_SCHEMA),
}, ['userStorePath', 'bootstrapCredentialPath', 'bootstrapCredentialPresent', 'userCount', 'sessionCount', 'users', 'sessions']);

export const LOCAL_AUTH_DELETE_OUTPUT_SCHEMA = objectSchema({
  deleted: BOOLEAN_SCHEMA,
}, ['deleted']);

export const LOCAL_AUTH_ROTATE_PASSWORD_OUTPUT_SCHEMA = objectSchema({
  rotated: BOOLEAN_SCHEMA,
}, ['rotated']);

export const LOCAL_AUTH_SESSION_REVOKE_OUTPUT_SCHEMA = objectSchema({
  revoked: BOOLEAN_SCHEMA,
}, ['revoked']);

export const LOCAL_AUTH_BOOTSTRAP_DELETE_OUTPUT_SCHEMA = objectSchema({
  removed: BOOLEAN_SCHEMA,
}, ['removed']);

export const PANEL_OPEN_OUTPUT_SCHEMA = objectSchema({
  opened: BOOLEAN_SCHEMA,
  id: STRING_SCHEMA,
  pane: { type: 'string', enum: ['top', 'bottom'] },
}, ['opened', 'id', 'pane']);

export const PANEL_SNAPSHOT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  name: STRING_SCHEMA,
  category: STRING_SCHEMA,
  description: STRING_SCHEMA,
  open: BOOLEAN_SCHEMA,
}, ['id', 'name', 'category', 'description', 'open']);

export const CONFIG_SNAPSHOT_SCHEMA = objectSchema({
  danger: CONFIG_CATEGORY_SNAPSHOT_SCHEMA,
  controlPlane: CONFIG_CATEGORY_SNAPSHOT_SCHEMA,
  web: CONFIG_CATEGORY_SNAPSHOT_SCHEMA,
  network: CONFIG_CATEGORY_SNAPSHOT_SCHEMA,
  service: CONFIG_CATEGORY_SNAPSHOT_SCHEMA,
  providers: CONFIG_CATEGORY_SNAPSHOT_SCHEMA,
  ui: CONFIG_CATEGORY_SNAPSHOT_SCHEMA,
  channels: CONFIG_CATEGORY_SNAPSHOT_SCHEMA,
  watchers: CONFIG_CATEGORY_SNAPSHOT_SCHEMA,
  memory: CONFIG_CATEGORY_SNAPSHOT_SCHEMA,
}, [], { additionalProperties: true });

export const SURFACE_RECORD_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  label: STRING_SCHEMA,
  enabled: BOOLEAN_SCHEMA,
  state: STRING_SCHEMA,
  configuredAt: NUMBER_SCHEMA,
  lastSeenAt: NUMBER_SCHEMA,
  defaultRouteId: STRING_SCHEMA,
  accountId: STRING_SCHEMA,
  capabilities: STRING_LIST_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'kind', 'label', 'enabled', 'state', 'configuredAt', 'capabilities', 'metadata']);

export const CONFIG_SET_OUTPUT_SCHEMA = objectSchema({
  success: BOOLEAN_SCHEMA,
  key: STRING_SCHEMA,
  value: JSON_VALUE_SCHEMA,
}, ['success', 'key'], { additionalProperties: true });

const AUTOMATION_JOB_STATUS_SCHEMA = enumSchema(['enabled', 'paused', 'error', 'archived']);
const AUTOMATION_RUN_STATUS_SCHEMA = enumSchema(['queued', 'running', 'completed', 'failed', 'cancelled']);
const AUTOMATION_RUN_TRIGGER_SCHEMA = enumSchema([
  'scheduled',
  'manual',
  'catch_up',
  'webhook',
  'surface',
  'watcher',
  'migration',
]);
const AUTOMATION_SURFACE_KIND_SCHEMA = enumSchema([
  'tui',
  'web',
  'slack',
  'discord',
  'ntfy',
  'webhook',
  'telegram',
  'google-chat',
  'signal',
  'whatsapp',
  'imessage',
  'msteams',
  'bluebubbles',
  'mattermost',
  'matrix',
  'service',
]);
const AUTOMATION_ROUTE_KIND_SCHEMA = enumSchema(['session', 'thread', 'channel', 'message']);
const AUTOMATION_SOURCE_KIND_SCHEMA = enumSchema([
  'schedule',
  'manual',
  'hook',
  'webhook',
  'surface',
  'watcher',
  'migration',
]);
const AUTOMATION_EXECUTION_KIND_SCHEMA = enumSchema(['isolated', 'current', 'pinned', 'background', 'main']);
const AUTOMATION_EXECUTION_TARGET_KIND_SCHEMA = enumSchema([
  'isolated',
  'current',
  'pinned',
  'background',
  'main',
  'session',
  'route',
]);
const AUTOMATION_DELIVERY_MODE_SCHEMA = enumSchema(['none', 'webhook', 'surface', 'integration', 'link']);
const AUTOMATION_FAILURE_ACTION_SCHEMA = enumSchema(['retry', 'cooldown', 'disable', 'dead_letter']);
const AUTOMATION_RETRY_STRATEGY_SCHEMA = enumSchema(['fixed', 'linear', 'exponential']);
const PROVIDER_SELECTION_SCHEMA = enumSchema(['inherit-current', 'concrete', 'synthetic']);
const UNRESOLVED_MODEL_POLICY_SCHEMA = enumSchema(['fallback-to-current', 'fail']);
const PROVIDER_FAILURE_POLICY_SCHEMA = enumSchema(['ordered-fallbacks', 'fail']);
const AUTOMATION_EXECUTION_MODE_SCHEMA = enumSchema(['spawn', 'shared-session', 'continued-live', 'background']);
const AUTOMATION_SESSION_POLICY_SCHEMA = enumSchema(['create-or-bind', 'continue-existing', 'require-existing']);
const AUTOMATION_THREAD_POLICY_SCHEMA = enumSchema(['preserve', 'replace', 'detached']);
const AUTOMATION_DELIVERY_GUARANTEE_SCHEMA = enumSchema(['best-effort', 'at-least-once']);
const EXECUTION_RISK_CLASS_SCHEMA = enumSchema(['safe', 'elevated', 'dangerous']);
const EXECUTION_NETWORK_POLICY_SCHEMA = enumSchema(['inherit', 'allow', 'deny', 'scoped']);
const EXECUTION_FILESYSTEM_POLICY_SCHEMA = enumSchema(['inherit', 'workspace-write', 'read-only', 'isolated']);
const AUTOMATION_REASONING_EFFORT_SCHEMA = enumSchema(['instant', 'low', 'medium', 'high']);
const AUTOMATION_WAKE_MODE_SCHEMA = enumSchema(['next-heartbeat', 'now']);
const AUTOMATION_SANDBOX_MODE_SCHEMA = enumSchema(['inherit', 'isolate', 'off']);
const AUTOMATION_EXTERNAL_CONTENT_SOURCE_KIND_SCHEMA = enumSchema([
  'gmail',
  'email',
  'webhook',
  'api',
  'browser',
  'channel_metadata',
  'web_search',
  'web_fetch',
  'slack',
  'discord',
  'ntfy',
  'unknown',
]);
const INBOUND_TLS_MODE_SCHEMA = enumSchema(['off', 'proxy', 'direct']);
const INBOUND_TLS_SCHEME_SCHEMA = enumSchema(['http', 'https']);
const OUTBOUND_TRUST_MODE_SCHEMA = enumSchema(['bundled', 'bundled+custom', 'custom']);
const OUTBOUND_CA_STRATEGY_SCHEMA = enumSchema(['bun-default', 'bundled+custom', 'custom']);

const AUTOMATION_AT_SCHEDULE_SCHEMA = objectSchema({
  kind: enumSchema(['at']),
  at: NUMBER_SCHEMA,
}, ['kind', 'at']);

const AUTOMATION_EVERY_SCHEDULE_SCHEMA = objectSchema({
  kind: enumSchema(['every']),
  intervalMs: NUMBER_SCHEMA,
  anchorAt: NUMBER_SCHEMA,
}, ['kind', 'intervalMs']);

const AUTOMATION_CRON_SCHEDULE_SCHEMA = objectSchema({
  kind: enumSchema(['cron']),
  expression: STRING_SCHEMA,
  timezone: STRING_SCHEMA,
  staggerMs: NUMBER_SCHEMA,
}, ['kind', 'expression']);

export const AUTOMATION_SCHEDULE_SCHEMA: Record<string, unknown> = {
  anyOf: [
    AUTOMATION_AT_SCHEDULE_SCHEMA,
    AUTOMATION_EVERY_SCHEDULE_SCHEMA,
    AUTOMATION_CRON_SCHEDULE_SCHEMA,
  ],
};

const AUTOMATION_ROUTING_POLICY_SCHEMA = objectSchema({
  providerSelection: PROVIDER_SELECTION_SCHEMA,
  unresolvedModelPolicy: UNRESOLVED_MODEL_POLICY_SCHEMA,
  providerFailurePolicy: PROVIDER_FAILURE_POLICY_SCHEMA,
  fallbackModels: STRING_LIST_SCHEMA,
}, [], { additionalProperties: false });

export const AUTOMATION_EXECUTION_INTENT_SCHEMA = objectSchema({
  mode: AUTOMATION_EXECUTION_MODE_SCHEMA,
  targetKind: AUTOMATION_EXECUTION_TARGET_KIND_SCHEMA,
}, ['mode', 'targetKind']);

export const AUTOMATION_RUNTIME_EXECUTION_INTENT_SCHEMA = objectSchema({
  riskClass: EXECUTION_RISK_CLASS_SCHEMA,
  requiresApproval: BOOLEAN_SCHEMA,
  networkPolicy: EXECUTION_NETWORK_POLICY_SCHEMA,
  filesystemPolicy: EXECUTION_FILESYSTEM_POLICY_SCHEMA,
}, [], { additionalProperties: false });

export const AUTOMATION_SESSION_TARGET_SCHEMA = objectSchema({
  kind: AUTOMATION_EXECUTION_TARGET_KIND_SCHEMA,
  sessionId: STRING_SCHEMA,
  routeId: STRING_SCHEMA,
  threadId: STRING_SCHEMA,
  channelId: STRING_SCHEMA,
  surfaceKind: AUTOMATION_SURFACE_KIND_SCHEMA,
  pinnedSessionId: STRING_SCHEMA,
  preserveThread: BOOLEAN_SCHEMA,
  createIfMissing: BOOLEAN_SCHEMA,
}, ['kind'], { additionalProperties: false });

const AUTOMATION_EXTERNAL_CONTENT_SOURCE_OBJECT_SCHEMA = objectSchema({
  kind: STRING_SCHEMA,
  id: STRING_SCHEMA,
  url: STRING_SCHEMA,
  routeId: STRING_SCHEMA,
  surfaceKind: AUTOMATION_SURFACE_KIND_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['kind'], { additionalProperties: false });

const AUTOMATION_EXTERNAL_CONTENT_SOURCE_SCHEMA: Record<string, unknown> = {
  anyOf: [
    AUTOMATION_EXTERNAL_CONTENT_SOURCE_KIND_SCHEMA,
    AUTOMATION_EXTERNAL_CONTENT_SOURCE_OBJECT_SCHEMA,
  ],
};

export const AUTOMATION_EXECUTION_POLICY_SCHEMA = objectSchema({
  prompt: STRING_SCHEMA,
  template: STRING_SCHEMA,
  target: AUTOMATION_SESSION_TARGET_SCHEMA,
  modelProvider: STRING_SCHEMA,
  modelId: STRING_SCHEMA,
  fallbackModels: STRING_LIST_SCHEMA,
  routing: AUTOMATION_ROUTING_POLICY_SCHEMA,
  executionIntent: AUTOMATION_RUNTIME_EXECUTION_INTENT_SCHEMA,
  reasoningEffort: AUTOMATION_REASONING_EFFORT_SCHEMA,
  thinking: STRING_SCHEMA,
  wakeMode: AUTOMATION_WAKE_MODE_SCHEMA,
  timeoutMs: NUMBER_SCHEMA,
  maxAttempts: NUMBER_SCHEMA,
  toolAllowlist: STRING_LIST_SCHEMA,
  autoApprove: BOOLEAN_SCHEMA,
  sandboxMode: AUTOMATION_SANDBOX_MODE_SCHEMA,
  allowUnsafeExternalContent: BOOLEAN_SCHEMA,
  externalContentSource: AUTOMATION_EXTERNAL_CONTENT_SOURCE_SCHEMA,
  lightContext: BOOLEAN_SCHEMA,
}, ['target'], { additionalProperties: false });

export const AUTOMATION_DELIVERY_TARGET_SCHEMA = objectSchema({
  kind: AUTOMATION_DELIVERY_MODE_SCHEMA,
  surfaceKind: AUTOMATION_SURFACE_KIND_SCHEMA,
  address: STRING_SCHEMA,
  routeId: STRING_SCHEMA,
  label: STRING_SCHEMA,
}, ['kind'], { additionalProperties: false });

export const AUTOMATION_DELIVERY_POLICY_SCHEMA = objectSchema({
  mode: AUTOMATION_DELIVERY_MODE_SCHEMA,
  targets: arraySchema(AUTOMATION_DELIVERY_TARGET_SCHEMA),
  fallbackTargets: arraySchema(AUTOMATION_DELIVERY_TARGET_SCHEMA),
  includeSummary: BOOLEAN_SCHEMA,
  includeTranscript: BOOLEAN_SCHEMA,
  includeLinks: BOOLEAN_SCHEMA,
  replyToRouteId: STRING_SCHEMA,
}, ['mode', 'targets', 'fallbackTargets', 'includeSummary', 'includeTranscript', 'includeLinks'], { additionalProperties: false });

const AUTOMATION_RETRY_POLICY_SCHEMA = objectSchema({
  maxAttempts: NUMBER_SCHEMA,
  delayMs: NUMBER_SCHEMA,
  strategy: AUTOMATION_RETRY_STRATEGY_SCHEMA,
  maxDelayMs: NUMBER_SCHEMA,
  jitterMs: NUMBER_SCHEMA,
}, ['maxAttempts', 'delayMs', 'strategy'], { additionalProperties: false });

export const AUTOMATION_FAILURE_POLICY_SCHEMA = objectSchema({
  action: AUTOMATION_FAILURE_ACTION_SCHEMA,
  maxConsecutiveFailures: NUMBER_SCHEMA,
  cooldownMs: NUMBER_SCHEMA,
  retryPolicy: AUTOMATION_RETRY_POLICY_SCHEMA,
  deadLetterRouteId: STRING_SCHEMA,
  disableAfterFailures: BOOLEAN_SCHEMA,
  notifyRouteId: STRING_SCHEMA,
}, ['action', 'maxConsecutiveFailures', 'cooldownMs', 'retryPolicy'], { additionalProperties: false });

export const AUTOMATION_SOURCE_RECORD_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: AUTOMATION_SOURCE_KIND_SCHEMA,
  label: STRING_SCHEMA,
  surfaceKind: AUTOMATION_SURFACE_KIND_SCHEMA,
  routeId: STRING_SCHEMA,
  enabled: BOOLEAN_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  lastSeenAt: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'kind', 'label', 'enabled', 'createdAt', 'updatedAt', 'metadata'], { additionalProperties: true });

const ROUTE_BINDING_BASE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: AUTOMATION_ROUTE_KIND_SCHEMA,
  surfaceKind: AUTOMATION_SURFACE_KIND_SCHEMA,
  surfaceId: STRING_SCHEMA,
  externalId: STRING_SCHEMA,
  sessionPolicy: AUTOMATION_SESSION_POLICY_SCHEMA,
  threadPolicy: AUTOMATION_THREAD_POLICY_SCHEMA,
  deliveryGuarantee: AUTOMATION_DELIVERY_GUARANTEE_SCHEMA,
  threadId: STRING_SCHEMA,
  channelId: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  jobId: STRING_SCHEMA,
  runId: STRING_SCHEMA,
  title: STRING_SCHEMA,
  lastSeenAt: NUMBER_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'kind', 'surfaceKind', 'surfaceId', 'externalId', 'lastSeenAt', 'createdAt', 'updatedAt', 'metadata'], { additionalProperties: true });

const AUTOMATION_RUN_USAGE_SUMMARY_SCHEMA = objectSchema({
  inputTokens: NUMBER_SCHEMA,
  outputTokens: NUMBER_SCHEMA,
  cacheReadTokens: NUMBER_SCHEMA,
  cacheWriteTokens: NUMBER_SCHEMA,
  reasoningTokens: NUMBER_SCHEMA,
}, ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'], { additionalProperties: false });

const DELIVERY_ATTEMPT_STATUS_SCHEMA = enumSchema(['pending', 'sending', 'sent', 'failed', 'dead_lettered']);
const AUTOMATION_RUN_TELEMETRY_SOURCE_SCHEMA = enumSchema([
  'local-agent',
  'shared-session',
  'remote-node',
  'remote-device',
]);

export const AUTOMATION_RUN_TELEMETRY_SCHEMA = objectSchema({
  usage: AUTOMATION_RUN_USAGE_SUMMARY_SCHEMA,
  llmCallCount: NUMBER_SCHEMA,
  toolCallCount: NUMBER_SCHEMA,
  turnCount: NUMBER_SCHEMA,
  modelId: STRING_SCHEMA,
  providerId: STRING_SCHEMA,
  reasoningSummaryPresent: BOOLEAN_SCHEMA,
  source: AUTOMATION_RUN_TELEMETRY_SOURCE_SCHEMA,
}, ['usage'], { additionalProperties: true });

export const AUTOMATION_JOB_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  name: STRING_SCHEMA,
  description: STRING_SCHEMA,
  labels: STRING_LIST_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  status: AUTOMATION_JOB_STATUS_SCHEMA,
  enabled: BOOLEAN_SCHEMA,
  schedule: AUTOMATION_SCHEDULE_SCHEMA,
  execution: AUTOMATION_EXECUTION_POLICY_SCHEMA,
  delivery: AUTOMATION_DELIVERY_POLICY_SCHEMA,
  failure: AUTOMATION_FAILURE_POLICY_SCHEMA,
  source: AUTOMATION_SOURCE_RECORD_SCHEMA,
  nextRunAt: NUMBER_SCHEMA,
  lastRunAt: NUMBER_SCHEMA,
  lastRunId: STRING_SCHEMA,
  runCount: NUMBER_SCHEMA,
  successCount: NUMBER_SCHEMA,
  failureCount: NUMBER_SCHEMA,
  pausedReason: STRING_SCHEMA,
  deleteAfterRun: BOOLEAN_SCHEMA,
  archivedAt: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'name', 'labels', 'createdAt', 'updatedAt', 'status', 'enabled', 'schedule', 'execution', 'delivery', 'failure', 'source', 'runCount', 'successCount', 'failureCount', 'deleteAfterRun'], { additionalProperties: true });

const DELIVERY_ATTEMPT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  runId: STRING_SCHEMA,
  jobId: STRING_SCHEMA,
  target: AUTOMATION_DELIVERY_TARGET_SCHEMA,
  status: DELIVERY_ATTEMPT_STATUS_SCHEMA,
  startedAt: NUMBER_SCHEMA,
  endedAt: NUMBER_SCHEMA,
  error: STRING_SCHEMA,
  responseId: STRING_SCHEMA,
}, ['id', 'runId', 'jobId', 'target', 'status'], { additionalProperties: true });

export const AUTOMATION_RUN_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  jobId: STRING_SCHEMA,
  labels: STRING_LIST_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  status: AUTOMATION_RUN_STATUS_SCHEMA,
  agentId: STRING_SCHEMA,
  triggeredBy: AUTOMATION_SOURCE_RECORD_SCHEMA,
  target: AUTOMATION_SESSION_TARGET_SCHEMA,
  execution: AUTOMATION_EXECUTION_POLICY_SCHEMA,
  scheduleKind: enumSchema(['at', 'every', 'cron']),
  queuedAt: NUMBER_SCHEMA,
  startedAt: NUMBER_SCHEMA,
  endedAt: NUMBER_SCHEMA,
  durationMs: NUMBER_SCHEMA,
  forceRun: BOOLEAN_SCHEMA,
  dueRun: BOOLEAN_SCHEMA,
  attempt: NUMBER_SCHEMA,
  sessionId: STRING_SCHEMA,
  routeId: STRING_SCHEMA,
  route: ROUTE_BINDING_BASE_SCHEMA,
  continuationMode: AUTOMATION_EXECUTION_MODE_SCHEMA,
  executionIntent: AUTOMATION_EXECUTION_INTENT_SCHEMA,
  deliveryIds: STRING_LIST_SCHEMA,
  deliveryAttempts: arraySchema(DELIVERY_ATTEMPT_SCHEMA),
  modelId: STRING_SCHEMA,
  providerId: STRING_SCHEMA,
  telemetry: AUTOMATION_RUN_TELEMETRY_SCHEMA,
  result: JSON_VALUE_SCHEMA,
  error: STRING_SCHEMA,
  cancelledReason: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'jobId', 'labels', 'createdAt', 'updatedAt', 'status', 'triggeredBy', 'target', 'execution', 'queuedAt', 'forceRun', 'dueRun', 'attempt', 'deliveryIds'], { additionalProperties: true });

export const AUTOMATION_INTEGRATION_SNAPSHOT_SCHEMA = objectSchema({
  totals: objectSchema({
    jobs: NUMBER_SCHEMA,
    enabled: NUMBER_SCHEMA,
    paused: NUMBER_SCHEMA,
    runs: NUMBER_SCHEMA,
  }, ['jobs', 'enabled', 'paused', 'runs']),
  jobs: arraySchema(objectSchema({
    id: STRING_SCHEMA,
    name: STRING_SCHEMA,
    enabled: BOOLEAN_SCHEMA,
    status: AUTOMATION_JOB_STATUS_SCHEMA,
    schedule: AUTOMATION_SCHEDULE_SCHEMA,
    nextRunAt: NUMBER_SCHEMA,
    lastRunAt: NUMBER_SCHEMA,
    runCount: NUMBER_SCHEMA,
    failureCount: NUMBER_SCHEMA,
  }, ['id', 'name', 'enabled', 'status', 'schedule', 'runCount', 'failureCount'], { additionalProperties: true })),
  recentRuns: arraySchema(objectSchema({
    id: STRING_SCHEMA,
    jobId: STRING_SCHEMA,
    status: STRING_SCHEMA,
    trigger: STRING_SCHEMA,
    queuedAt: NUMBER_SCHEMA,
    startedAt: NUMBER_SCHEMA,
    endedAt: NUMBER_SCHEMA,
    agentId: STRING_SCHEMA,
    error: STRING_SCHEMA,
  }, ['id', 'jobId', 'status', 'trigger', 'queuedAt'], { additionalProperties: true })),
}, ['totals', 'jobs', 'recentRuns']);

export const AUTOMATION_JOBS_OUTPUT_SCHEMA = objectSchema({
  jobs: arraySchema(AUTOMATION_JOB_SCHEMA),
}, ['jobs']);

export const AUTOMATION_RUNS_OUTPUT_SCHEMA = objectSchema({
  runs: arraySchema(AUTOMATION_RUN_SCHEMA),
}, ['runs']);

export const AUTOMATION_RUN_DETAIL_OUTPUT_SCHEMA = objectSchema({
  run: AUTOMATION_RUN_SCHEMA,
  deliveries: arraySchema(DELIVERY_ATTEMPT_SCHEMA),
}, ['run', 'deliveries']);

export const AUTOMATION_RUN_TRIGGER_OUTPUT_SCHEMA = objectSchema({
  jobId: STRING_SCHEMA,
  runId: STRING_SCHEMA,
  agentId: STRING_SCHEMA,
  status: STRING_SCHEMA,
}, ['jobId', 'runId', 'status'], { additionalProperties: true });

export const AUTOMATION_RUN_ACTION_OUTPUT_SCHEMA = objectSchema({
  run: AUTOMATION_RUN_SCHEMA,
}, ['run']);

export const AUTOMATION_HEARTBEAT_WAKE_SCHEMA = objectSchema({
  jobId: STRING_SCHEMA,
  jobName: STRING_SCHEMA,
  trigger: AUTOMATION_RUN_TRIGGER_SCHEMA,
  dueRun: BOOLEAN_SCHEMA,
  attempt: NUMBER_SCHEMA,
  queuedAt: NUMBER_SCHEMA,
  reason: STRING_SCHEMA,
}, ['jobId', 'jobName', 'trigger', 'dueRun', 'attempt', 'queuedAt', 'reason']);

export const AUTOMATION_HEARTBEAT_RESULT_SCHEMA = objectSchema({
  processed: arraySchema(AUTOMATION_RUN_SCHEMA),
  failed: arraySchema(objectSchema({
    jobId: STRING_SCHEMA,
    error: STRING_SCHEMA,
  }, ['jobId', 'error'])),
  pending: arraySchema(AUTOMATION_HEARTBEAT_WAKE_SCHEMA),
  checkedAt: NUMBER_SCHEMA,
}, ['processed', 'failed', 'pending', 'checkedAt']);

export const LEGACY_SCHEDULES_OUTPUT_SCHEMA = objectSchema({
  jobs: arraySchema(AUTOMATION_JOB_SCHEMA),
  runs: arraySchema(AUTOMATION_RUN_SCHEMA),
}, ['jobs', 'runs']);

export const DELIVERY_SNAPSHOT_SCHEMA = objectSchema({
  totals: objectSchema({
    queued: NUMBER_SCHEMA,
    started: NUMBER_SCHEMA,
    succeeded: NUMBER_SCHEMA,
    failed: NUMBER_SCHEMA,
    deadLettered: NUMBER_SCHEMA,
  }, ['queued', 'started', 'succeeded', 'failed', 'deadLettered']),
  attempts: arraySchema(DELIVERY_ATTEMPT_SCHEMA),
}, ['totals', 'attempts']);

export const DELIVERY_OUTPUT_SCHEMA = objectSchema({
  delivery: DELIVERY_ATTEMPT_SCHEMA,
}, ['delivery']);

export const ROUTE_BINDING_SCHEMA = ROUTE_BINDING_BASE_SCHEMA;

export const ROUTE_SNAPSHOT_SCHEMA = objectSchema({
  totalBindings: NUMBER_SCHEMA,
  activeBindings: NUMBER_SCHEMA,
  recentBindings: NUMBER_SCHEMA,
  bindings: arraySchema(ROUTE_BINDING_SCHEMA),
}, ['totalBindings', 'activeBindings', 'recentBindings', 'bindings']);

const WATCHER_SOURCE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  label: STRING_SCHEMA,
  enabled: BOOLEAN_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'kind', 'label', 'enabled', 'createdAt', 'updatedAt', 'metadata'], { additionalProperties: true });

export const WATCHER_RECORD_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  label: STRING_SCHEMA,
  state: STRING_SCHEMA,
  source: WATCHER_SOURCE_SCHEMA,
  intervalMs: NUMBER_SCHEMA,
  lastHeartbeatAt: NUMBER_SCHEMA,
  sourceLagMs: NUMBER_SCHEMA,
  sourceStatus: STRING_SCHEMA,
  degradedReason: STRING_SCHEMA,
  lastCheckpoint: STRING_SCHEMA,
  lastError: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'kind', 'label', 'state', 'source', 'metadata'], { additionalProperties: true });

export const WATCHER_LIST_OUTPUT_SCHEMA = objectSchema({
  watchers: arraySchema(WATCHER_RECORD_SCHEMA),
}, ['watchers']);

export const REMOVE_WITH_ID_OUTPUT_SCHEMA = objectSchema({
  removed: BOOLEAN_SCHEMA,
  id: STRING_SCHEMA,
}, ['removed'], { additionalProperties: true });

const INBOUND_TLS_KEY_PERMISSIONS_SCHEMA = objectSchema({
  available: BOOLEAN_SCHEMA,
  safe: BOOLEAN_SCHEMA,
  mode: STRING_SCHEMA,
}, ['available'], { additionalProperties: false });

const INBOUND_TLS_SNAPSHOT_SCHEMA = objectSchema({
  surface: enumSchema(['controlPlane', 'httpListener']),
  host: STRING_SCHEMA,
  port: NUMBER_SCHEMA,
  mode: INBOUND_TLS_MODE_SCHEMA,
  scheme: INBOUND_TLS_SCHEME_SCHEMA,
  trustProxy: BOOLEAN_SCHEMA,
  certFile: STRING_SCHEMA,
  keyFile: STRING_SCHEMA,
  usingDefaultPaths: BOOLEAN_SCHEMA,
  ready: BOOLEAN_SCHEMA,
  errors: STRING_LIST_SCHEMA,
  keyPermissions: INBOUND_TLS_KEY_PERMISSIONS_SCHEMA,
}, ['surface', 'host', 'port', 'mode', 'scheme', 'trustProxy', 'usingDefaultPaths', 'ready', 'errors'], { additionalProperties: false });

const OUTBOUND_TLS_SNAPSHOT_SCHEMA = objectSchema({
  mode: OUTBOUND_TRUST_MODE_SCHEMA,
  allowInsecureLocalhost: BOOLEAN_SCHEMA,
  customCaFile: STRING_SCHEMA,
  customCaDir: STRING_SCHEMA,
  customCaEntryCount: NUMBER_SCHEMA,
  effectiveCaStrategy: OUTBOUND_CA_STRATEGY_SCHEMA,
  errors: STRING_LIST_SCHEMA,
}, ['mode', 'allowInsecureLocalhost', 'customCaEntryCount', 'effectiveCaStrategy', 'errors'], { additionalProperties: false });

const SERVICE_NETWORK_SCHEMA = objectSchema({
  controlPlane: INBOUND_TLS_SNAPSHOT_SCHEMA,
  httpListener: INBOUND_TLS_SNAPSHOT_SCHEMA,
  outbound: OUTBOUND_TLS_SNAPSHOT_SCHEMA,
}, ['controlPlane', 'httpListener', 'outbound'], { additionalProperties: false });

export const SERVICE_STATUS_SCHEMA = objectSchema({
  platform: STRING_SCHEMA,
  path: STRING_SCHEMA,
  installed: BOOLEAN_SCHEMA,
  autostart: BOOLEAN_SCHEMA,
  running: BOOLEAN_SCHEMA,
  pid: NUMBER_SCHEMA,
  logPath: STRING_SCHEMA,
  commandPreview: STRING_SCHEMA,
  contents: STRING_SCHEMA,
  suggestedCommands: STRING_LIST_SCHEMA,
  lastAction: STRING_SCHEMA,
  actionError: STRING_SCHEMA,
  network: SERVICE_NETWORK_SCHEMA,
}, ['platform', 'path', 'installed', 'autostart', 'running', 'commandPreview', 'suggestedCommands'], { additionalProperties: true });
