import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.ts';
import {
  GENERIC_LIST_SCHEMA,
  JSON_OBJECT_SCHEMA,
  JSON_VALUE_SCHEMA,
  METADATA_SCHEMA,
  STRING_LIST_SCHEMA,
  recordSchema,
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
  danger: JSON_OBJECT_SCHEMA,
  controlPlane: JSON_OBJECT_SCHEMA,
  web: JSON_OBJECT_SCHEMA,
  network: JSON_OBJECT_SCHEMA,
  service: JSON_OBJECT_SCHEMA,
  providers: JSON_OBJECT_SCHEMA,
  ui: JSON_OBJECT_SCHEMA,
  channels: JSON_OBJECT_SCHEMA,
  watchers: JSON_OBJECT_SCHEMA,
  memory: JSON_OBJECT_SCHEMA,
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

export const AUTOMATION_JOB_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  name: STRING_SCHEMA,
  description: STRING_SCHEMA,
  labels: STRING_LIST_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  status: STRING_SCHEMA,
  enabled: BOOLEAN_SCHEMA,
  schedule: JSON_OBJECT_SCHEMA,
  execution: JSON_OBJECT_SCHEMA,
  delivery: JSON_OBJECT_SCHEMA,
  failure: JSON_OBJECT_SCHEMA,
  source: JSON_OBJECT_SCHEMA,
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

const AUTOMATION_RUN_TELEMETRY_SCHEMA = objectSchema({
  usage: JSON_OBJECT_SCHEMA,
  llmCallCount: NUMBER_SCHEMA,
  toolCallCount: NUMBER_SCHEMA,
  turnCount: NUMBER_SCHEMA,
  modelId: STRING_SCHEMA,
  providerId: STRING_SCHEMA,
  reasoningSummaryPresent: BOOLEAN_SCHEMA,
  source: STRING_SCHEMA,
}, ['usage'], { additionalProperties: true });

export const AUTOMATION_RUN_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  jobId: STRING_SCHEMA,
  labels: STRING_LIST_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  status: STRING_SCHEMA,
  agentId: STRING_SCHEMA,
  triggeredBy: JSON_OBJECT_SCHEMA,
  target: JSON_OBJECT_SCHEMA,
  execution: JSON_OBJECT_SCHEMA,
  scheduleKind: STRING_SCHEMA,
  queuedAt: NUMBER_SCHEMA,
  startedAt: NUMBER_SCHEMA,
  endedAt: NUMBER_SCHEMA,
  durationMs: NUMBER_SCHEMA,
  forceRun: BOOLEAN_SCHEMA,
  dueRun: BOOLEAN_SCHEMA,
  attempt: NUMBER_SCHEMA,
  sessionId: STRING_SCHEMA,
  routeId: STRING_SCHEMA,
  route: JSON_OBJECT_SCHEMA,
  continuationMode: STRING_SCHEMA,
  executionIntent: JSON_OBJECT_SCHEMA,
  deliveryIds: STRING_LIST_SCHEMA,
  deliveryAttempts: GENERIC_LIST_SCHEMA,
  modelId: STRING_SCHEMA,
  providerId: STRING_SCHEMA,
  telemetry: AUTOMATION_RUN_TELEMETRY_SCHEMA,
  result: JSON_OBJECT_SCHEMA,
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
    status: STRING_SCHEMA,
    schedule: JSON_OBJECT_SCHEMA,
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
  deliveries: GENERIC_LIST_SCHEMA,
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

export const AUTOMATION_HEARTBEAT_RESULT_SCHEMA = objectSchema({
  processed: arraySchema(AUTOMATION_RUN_SCHEMA),
  failed: arraySchema(objectSchema({
    jobId: STRING_SCHEMA,
    error: STRING_SCHEMA,
  }, ['jobId', 'error'])),
  pending: GENERIC_LIST_SCHEMA,
  checkedAt: NUMBER_SCHEMA,
}, ['processed', 'failed', 'pending', 'checkedAt']);

export const LEGACY_SCHEDULES_OUTPUT_SCHEMA = objectSchema({
  jobs: arraySchema(AUTOMATION_JOB_SCHEMA),
  runs: arraySchema(AUTOMATION_RUN_SCHEMA),
}, ['jobs', 'runs']);

const DELIVERY_ATTEMPT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  runId: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  target: STRING_SCHEMA,
  status: STRING_SCHEMA,
  queuedAt: NUMBER_SCHEMA,
  startedAt: NUMBER_SCHEMA,
  endedAt: NUMBER_SCHEMA,
  error: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'status'], { additionalProperties: true });

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

export const ROUTE_BINDING_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  surfaceKind: STRING_SCHEMA,
  surfaceId: STRING_SCHEMA,
  externalId: STRING_SCHEMA,
  sessionPolicy: STRING_SCHEMA,
  threadPolicy: STRING_SCHEMA,
  deliveryGuarantee: STRING_SCHEMA,
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
  network: objectSchema({
    controlPlane: JSON_OBJECT_SCHEMA,
    httpListener: JSON_OBJECT_SCHEMA,
    outbound: JSON_OBJECT_SCHEMA,
  }, [], { additionalProperties: true }),
}, ['platform', 'path', 'installed', 'autostart', 'running', 'commandPreview', 'suggestedCommands'], { additionalProperties: true });
