import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.ts';
import {
  ARTIFACT_ATTACHMENT_SCHEMA,
  JSON_VALUE_SCHEMA,
  METADATA_SCHEMA,
  STRING_LIST_SCHEMA,
  enumSchema,
  nullableSchema,
  recordSchema,
} from './operator-contract-schemas-shared.ts';

const CONTROL_PLANE_MESSAGE_LEVEL_SCHEMA = enumSchema(['info', 'success', 'warn', 'error']);

const CONTROL_PLANE_SERVER_CONFIG_SCHEMA = objectSchema({
  enabled: BOOLEAN_SCHEMA,
  host: STRING_SCHEMA,
  port: NUMBER_SCHEMA,
  baseUrl: STRING_SCHEMA,
  streamingMode: enumSchema(['sse', 'websocket', 'both']),
  sessionTtlMs: NUMBER_SCHEMA,
}, ['enabled', 'host', 'port', 'streamingMode', 'sessionTtlMs']);

export const CONTROL_AUTH_LOGIN_REQUEST_SCHEMA = objectSchema({
  username: STRING_SCHEMA,
  password: STRING_SCHEMA,
}, ['username', 'password']);

export const CONTROL_AUTH_LOGIN_RESPONSE_SCHEMA = objectSchema({
  authenticated: BOOLEAN_SCHEMA,
  token: STRING_SCHEMA,
  username: STRING_SCHEMA,
  expiresAt: NUMBER_SCHEMA,
}, ['authenticated', 'token', 'username', 'expiresAt']);

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
  payload: JSON_VALUE_SCHEMA,
}, ['id', 'event', 'createdAt', 'payload']);

const SETTINGS_FAILURE_SCHEMA = objectSchema({
  surface: STRING_SCHEMA,
  message: STRING_SCHEMA,
  timestamp: NUMBER_SCHEMA,
}, ['surface', 'message', 'timestamp']);

const SETTINGS_CONFLICT_SCHEMA = objectSchema({
  key: STRING_SCHEMA,
  localValue: JSON_VALUE_SCHEMA,
  incomingValue: JSON_VALUE_SCHEMA,
  source: enumSchema(['synced']),
  path: STRING_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
}, ['key', 'localValue', 'incomingValue', 'source', 'path', 'updatedAt']);

const SETTINGS_ROLLBACK_RECORD_SCHEMA = objectSchema({
  token: STRING_SCHEMA,
  profileName: STRING_SCHEMA,
  path: STRING_SCHEMA,
  appliedAt: NUMBER_SCHEMA,
  restoredKeys: STRING_LIST_SCHEMA,
  previousValues: recordSchema(JSON_VALUE_SCHEMA),
}, ['token', 'profileName', 'path', 'appliedAt', 'restoredKeys', 'previousValues']);

const SETTINGS_BUNDLE_CHANGE_SCHEMA = objectSchema({
  key: STRING_SCHEMA,
  previousValue: JSON_VALUE_SCHEMA,
  nextValue: JSON_VALUE_SCHEMA,
  changed: BOOLEAN_SCHEMA,
  locked: BOOLEAN_SCHEMA,
  source: STRING_SCHEMA,
  reason: STRING_SCHEMA,
}, ['key', 'previousValue', 'nextValue', 'changed', 'locked', 'source', 'reason']);

const STAGED_MANAGED_BUNDLE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  profileName: STRING_SCHEMA,
  path: STRING_SCHEMA,
  importedAt: NUMBER_SCHEMA,
  changeCount: NUMBER_SCHEMA,
  risk: enumSchema(['low', 'medium', 'high']),
  changes: arraySchema(SETTINGS_BUNDLE_CHANGE_SCHEMA),
}, ['id', 'profileName', 'path', 'importedAt', 'changeCount', 'risk', 'changes']);

const SETTINGS_SNAPSHOT_UNAVAILABLE_SCHEMA = objectSchema({
  available: BOOLEAN_SCHEMA,
  reason: STRING_SCHEMA,
}, ['available', 'reason']);

const SETTINGS_SNAPSHOT_AVAILABLE_SCHEMA = objectSchema({
  available: BOOLEAN_SCHEMA,
  liveKeyCount: NUMBER_SCHEMA,
  profileCount: NUMBER_SCHEMA,
  managedLockCount: NUMBER_SCHEMA,
  resolvedCounts: recordSchema(NUMBER_SCHEMA),
  conflicts: arraySchema(SETTINGS_CONFLICT_SCHEMA),
  recentFailures: arraySchema(SETTINGS_FAILURE_SCHEMA),
  stagedManagedBundle: STAGED_MANAGED_BUNDLE_SCHEMA,
  rollbackHistory: arraySchema(SETTINGS_ROLLBACK_RECORD_SCHEMA),
}, ['available', 'liveKeyCount', 'profileCount', 'managedLockCount', 'resolvedCounts', 'conflicts', 'recentFailures', 'rollbackHistory']);

export const SETTINGS_SNAPSHOT_SCHEMA: Record<string, unknown> = {
  anyOf: [SETTINGS_SNAPSHOT_UNAVAILABLE_SCHEMA, SETTINGS_SNAPSHOT_AVAILABLE_SCHEMA],
};

const SESSION_RETURN_CONTEXT_SCHEMA = objectSchema({
  activityLabel: STRING_SCHEMA,
  statusLabel: STRING_SCHEMA,
  lastUserPrompt: STRING_SCHEMA,
  lastAssistantReply: STRING_SCHEMA,
  pendingApprovals: NUMBER_SCHEMA,
  toolCallCount: NUMBER_SCHEMA,
  toolResultCount: NUMBER_SCHEMA,
  assistantTurnCount: NUMBER_SCHEMA,
  userTurnCount: NUMBER_SCHEMA,
  lastRole: STRING_SCHEMA,
  activeTasks: NUMBER_SCHEMA,
  blockedTasks: NUMBER_SCHEMA,
  remoteContracts: NUMBER_SCHEMA,
  remoteRunners: STRING_LIST_SCHEMA,
  worktreeCount: NUMBER_SCHEMA,
  worktreePaths: STRING_LIST_SCHEMA,
  openPanels: STRING_LIST_SCHEMA,
  lines: STRING_LIST_SCHEMA,
  assistedNarrative: STRING_SCHEMA,
}, ['activityLabel', 'statusLabel', 'pendingApprovals', 'toolCallCount', 'toolResultCount', 'assistantTurnCount', 'userTurnCount', 'lines']);

const RECOVERY_FILE_SCHEMA = objectSchema({
  title: STRING_SCHEMA,
  timestamp: NUMBER_SCHEMA,
  sessionId: STRING_SCHEMA,
  returnContext: SESSION_RETURN_CONTEXT_SCHEMA,
}, ['title', 'timestamp', 'sessionId']);

export const CONTINUITY_SNAPSHOT_SCHEMA = objectSchema({
  sessionId: STRING_SCHEMA,
  status: STRING_SCHEMA,
  recoveryState: STRING_SCHEMA,
  lastSessionPointer: nullableSchema(STRING_SCHEMA),
  recoveryFilePresent: BOOLEAN_SCHEMA,
  recoveryFile: nullableSchema(RECOVERY_FILE_SCHEMA),
}, ['sessionId', 'status', 'recoveryState', 'lastSessionPointer', 'recoveryFilePresent', 'recoveryFile']);

const WORKTREE_META_SCHEMA = objectSchema({
  path: STRING_SCHEMA,
  kind: enumSchema(['agent', 'orchestrator', 'manual']),
  state: enumSchema(['active', 'paused', 'kept', 'discard', 'cleanup-pending']),
  ownerId: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  taskId: STRING_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
}, ['path', 'kind', 'state', 'updatedAt']);

const WORKTREE_SUMMARY_SCHEMA = objectSchema({
  total: NUMBER_SCHEMA,
  active: NUMBER_SCHEMA,
  paused: NUMBER_SCHEMA,
  kept: NUMBER_SCHEMA,
  discard: NUMBER_SCHEMA,
  cleanupPending: NUMBER_SCHEMA,
  sessionAttached: NUMBER_SCHEMA,
  taskAttached: NUMBER_SCHEMA,
  agentOwned: NUMBER_SCHEMA,
  orchestratorOwned: NUMBER_SCHEMA,
  manualOwned: NUMBER_SCHEMA,
}, ['total', 'active', 'paused', 'kept', 'discard', 'cleanupPending', 'sessionAttached', 'taskAttached', 'agentOwned', 'orchestratorOwned', 'manualOwned']);

export const WORKTREE_SNAPSHOT_SCHEMA = objectSchema({
  summary: WORKTREE_SUMMARY_SCHEMA,
  records: arraySchema(WORKTREE_META_SCHEMA),
}, ['summary', 'records']);

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
