import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.ts';
import {
  JSON_VALUE_SCHEMA,
  STRING_LIST_SCHEMA,
  METADATA_SCHEMA,
  enumSchema,
  recordSchema,
} from './operator-contract-schemas-shared.ts';
import { AUTOMATION_RUN_TELEMETRY_SCHEMA } from './operator-contract-schemas-admin.ts';
const DISTRIBUTED_PEER_KIND_SCHEMA = enumSchema(['node', 'device']);
const DISTRIBUTED_PEER_STATUS_SCHEMA = enumSchema(['paired', 'connected', 'idle', 'disconnected', 'revoked']);
const DISTRIBUTED_WORK_PRIORITY_SCHEMA = enumSchema(['default', 'normal', 'high']);
const DISTRIBUTED_WORK_STATUS_SCHEMA = enumSchema(['queued', 'claimed', 'completed', 'failed', 'cancelled', 'expired']);
const DISTRIBUTED_WORK_TYPE_SCHEMA = enumSchema(['invoke', 'status.request', 'location.request', 'session.message', 'automation.run']);
const DISTRIBUTED_AUDIT_ACTION_SCHEMA = enumSchema([
  'pair-requested',
  'pair-approved',
  'pair-rejected',
  'pair-verified',
  'pair-expired',
  'token-rotated',
  'token-revoked',
  'peer-connected',
  'peer-disconnected',
  'work-queued',
  'work-claimed',
  'work-completed',
  'work-failed',
  'work-cancelled',
  'work-expired',
]);

const DISTRIBUTED_PAIR_REQUEST_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  peerKind: DISTRIBUTED_PEER_KIND_SCHEMA,
  requestedId: STRING_SCHEMA,
  label: STRING_SCHEMA,
  platform: STRING_SCHEMA,
  deviceFamily: STRING_SCHEMA,
  version: STRING_SCHEMA,
  clientMode: STRING_SCHEMA,
  capabilities: STRING_LIST_SCHEMA,
  commands: STRING_LIST_SCHEMA,
  requestedBy: enumSchema(['remote', 'operator']),
  status: enumSchema(['pending', 'approved', 'verified', 'rejected', 'expired']),
  challengePreview: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  approvedAt: NUMBER_SCHEMA,
  verifiedAt: NUMBER_SCHEMA,
  rejectedAt: NUMBER_SCHEMA,
  expiresAt: NUMBER_SCHEMA,
  peerId: STRING_SCHEMA,
  remoteAddress: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'peerKind', 'requestedId', 'label', 'capabilities', 'commands', 'requestedBy', 'status', 'challengePreview', 'createdAt', 'updatedAt', 'expiresAt', 'metadata'], { additionalProperties: true });

const DISTRIBUTED_PEER_TOKEN_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  scopes: STRING_LIST_SCHEMA,
  issuedAt: NUMBER_SCHEMA,
  lastUsedAt: NUMBER_SCHEMA,
  rotatedAt: NUMBER_SCHEMA,
  revokedAt: NUMBER_SCHEMA,
  fingerprint: STRING_SCHEMA,
}, ['id', 'label', 'scopes', 'issuedAt', 'fingerprint'], { additionalProperties: true });

const DISTRIBUTED_PEER_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: DISTRIBUTED_PEER_KIND_SCHEMA,
  label: STRING_SCHEMA,
  requestedId: STRING_SCHEMA,
  platform: STRING_SCHEMA,
  deviceFamily: STRING_SCHEMA,
  version: STRING_SCHEMA,
  clientMode: STRING_SCHEMA,
  capabilities: STRING_LIST_SCHEMA,
  commands: STRING_LIST_SCHEMA,
  permissions: recordSchema(BOOLEAN_SCHEMA),
  status: DISTRIBUTED_PEER_STATUS_SCHEMA,
  pairedAt: NUMBER_SCHEMA,
  verifiedAt: NUMBER_SCHEMA,
  lastSeenAt: NUMBER_SCHEMA,
  lastConnectedAt: NUMBER_SCHEMA,
  lastDisconnectedAt: NUMBER_SCHEMA,
  lastRemoteAddress: STRING_SCHEMA,
  activeTokenId: STRING_SCHEMA,
  tokens: arraySchema(DISTRIBUTED_PEER_TOKEN_SCHEMA),
  metadata: METADATA_SCHEMA,
}, ['id', 'kind', 'label', 'requestedId', 'capabilities', 'commands', 'status', 'pairedAt', 'tokens', 'metadata'], { additionalProperties: true });

const DISTRIBUTED_PENDING_WORK_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  peerId: STRING_SCHEMA,
  peerKind: DISTRIBUTED_PEER_KIND_SCHEMA,
  type: DISTRIBUTED_WORK_TYPE_SCHEMA,
  command: STRING_SCHEMA,
  priority: DISTRIBUTED_WORK_PRIORITY_SCHEMA,
  status: DISTRIBUTED_WORK_STATUS_SCHEMA,
  payload: JSON_VALUE_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  queuedBy: STRING_SCHEMA,
  claimedAt: NUMBER_SCHEMA,
  claimTokenId: STRING_SCHEMA,
  leaseExpiresAt: NUMBER_SCHEMA,
  completedAt: NUMBER_SCHEMA,
  timeoutMs: NUMBER_SCHEMA,
  sessionId: STRING_SCHEMA,
  routeId: STRING_SCHEMA,
  automationRunId: STRING_SCHEMA,
  automationJobId: STRING_SCHEMA,
  approvalId: STRING_SCHEMA,
  result: JSON_VALUE_SCHEMA,
  error: STRING_SCHEMA,
  telemetry: AUTOMATION_RUN_TELEMETRY_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'peerId', 'peerKind', 'type', 'command', 'priority', 'status', 'createdAt', 'updatedAt', 'queuedBy', 'metadata'], { additionalProperties: true });

const DISTRIBUTED_AUDIT_RECORD_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  action: DISTRIBUTED_AUDIT_ACTION_SCHEMA,
  actor: STRING_SCHEMA,
  peerId: STRING_SCHEMA,
  requestId: STRING_SCHEMA,
  workId: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  note: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'action', 'actor', 'createdAt', 'metadata'], { additionalProperties: true });

const DISTRIBUTED_RUNTIME_SNAPSHOT_SCHEMA = objectSchema({
  pairRequests: arraySchema(DISTRIBUTED_PAIR_REQUEST_SCHEMA),
  peers: arraySchema(DISTRIBUTED_PEER_SCHEMA),
  work: arraySchema(DISTRIBUTED_PENDING_WORK_SCHEMA),
  audit: arraySchema(DISTRIBUTED_AUDIT_RECORD_SCHEMA),
}, ['pairRequests', 'peers', 'work', 'audit']);

const REMOTE_POOL_ENTRY_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  trustClass: STRING_SCHEMA,
  preferredTemplate: STRING_SCHEMA,
  maxRunners: NUMBER_SCHEMA,
  runnerIds: STRING_LIST_SCHEMA,
}, ['id', 'label', 'trustClass', 'preferredTemplate', 'maxRunners', 'runnerIds'], { additionalProperties: true });

const REMOTE_CONTRACT_ENTRY_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  runnerId: STRING_SCHEMA,
  label: STRING_SCHEMA,
  template: STRING_SCHEMA,
  poolId: STRING_SCHEMA,
  taskId: STRING_SCHEMA,
  sourceTransport: STRING_SCHEMA,
  trustClass: STRING_SCHEMA,
  executionProtocol: STRING_SCHEMA,
  reviewMode: STRING_SCHEMA,
  communicationLane: STRING_SCHEMA,
  transportState: STRING_SCHEMA,
  lastError: STRING_SCHEMA,
}, ['id', 'runnerId', 'label', 'template', 'sourceTransport', 'trustClass', 'executionProtocol', 'reviewMode', 'communicationLane', 'transportState'], { additionalProperties: true });

const REMOTE_ARTIFACT_ENTRY_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  runnerId: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  status: STRING_SCHEMA,
  summary: STRING_SCHEMA,
  error: STRING_SCHEMA,
}, ['id', 'runnerId', 'createdAt', 'status', 'summary'], { additionalProperties: true });

const REMOTE_SUPERVISOR_ENTRY_SCHEMA = objectSchema({
  runnerId: STRING_SCHEMA,
  label: STRING_SCHEMA,
  transportState: STRING_SCHEMA,
  heartbeat: STRING_SCHEMA,
  taskId: STRING_SCHEMA,
}, ['runnerId', 'label', 'transportState', 'heartbeat'], { additionalProperties: true });

export const REMOTE_SNAPSHOT_SCHEMA = objectSchema({
  daemon: objectSchema({
    transportState: STRING_SCHEMA,
    isRunning: BOOLEAN_SCHEMA,
    reconnectAttempts: NUMBER_SCHEMA,
    runningJobCount: NUMBER_SCHEMA,
    lastError: STRING_SCHEMA,
  }, ['transportState', 'isRunning', 'reconnectAttempts', 'runningJobCount'], { additionalProperties: true }),
  acp: objectSchema({
    transportState: STRING_SCHEMA,
    activeConnectionIds: STRING_LIST_SCHEMA,
    totalSpawned: NUMBER_SCHEMA,
    totalFailed: NUMBER_SCHEMA,
    lastError: STRING_SCHEMA,
  }, ['transportState', 'activeConnectionIds', 'totalSpawned', 'totalFailed'], { additionalProperties: true }),
  registry: objectSchema({
    pools: NUMBER_SCHEMA,
    contracts: NUMBER_SCHEMA,
    artifacts: NUMBER_SCHEMA,
    poolEntries: arraySchema(REMOTE_POOL_ENTRY_SCHEMA),
    contractEntries: arraySchema(REMOTE_CONTRACT_ENTRY_SCHEMA),
    artifactEntries: arraySchema(REMOTE_ARTIFACT_ENTRY_SCHEMA),
  }, ['pools', 'contracts', 'artifacts', 'poolEntries', 'contractEntries', 'artifactEntries']),
  supervisor: objectSchema({
    sessions: NUMBER_SCHEMA,
    degraded: NUMBER_SCHEMA,
    capturedAt: NUMBER_SCHEMA,
    entries: arraySchema(REMOTE_SUPERVISOR_ENTRY_SCHEMA),
  }, ['sessions', 'degraded', 'capturedAt', 'entries']),
  distributed: DISTRIBUTED_RUNTIME_SNAPSHOT_SCHEMA,
}, ['daemon', 'acp', 'registry', 'supervisor', 'distributed']);

const DISTRIBUTED_NODE_HOST_ENDPOINT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  method: enumSchema(['GET', 'POST']),
  path: STRING_SCHEMA,
  auth: enumSchema(['none', 'bearer-peer-token', 'bearer-operator-token']),
  description: STRING_SCHEMA,
  requiredScope: STRING_SCHEMA,
}, ['id', 'method', 'path', 'auth', 'description'], { additionalProperties: true });

export const DISTRIBUTED_NODE_HOST_CONTRACT_SCHEMA = objectSchema({
  schemaVersion: NUMBER_SCHEMA,
  transport: STRING_SCHEMA,
  basePath: STRING_SCHEMA,
  peerKinds: arraySchema(DISTRIBUTED_PEER_KIND_SCHEMA),
  workTypes: arraySchema(DISTRIBUTED_WORK_TYPE_SCHEMA),
  scopes: STRING_LIST_SCHEMA,
  recommendedHeartbeatMs: NUMBER_SCHEMA,
  recommendedWorkPullMs: NUMBER_SCHEMA,
  endpoints: arraySchema(DISTRIBUTED_NODE_HOST_ENDPOINT_SCHEMA),
  workCompletionStatuses: arraySchema(DISTRIBUTED_WORK_STATUS_SCHEMA),
  metadata: METADATA_SCHEMA,
}, ['schemaVersion', 'transport', 'basePath', 'peerKinds', 'workTypes', 'scopes', 'recommendedHeartbeatMs', 'recommendedWorkPullMs', 'endpoints', 'workCompletionStatuses', 'metadata']);

export const REMOTE_PAIR_REQUEST_ACTION_INPUT_SCHEMA = objectSchema({
  requestId: STRING_SCHEMA,
  note: STRING_SCHEMA,
  label: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['requestId'], { additionalProperties: true });

export const REMOTE_PAIR_APPROVAL_OUTPUT_SCHEMA = objectSchema({
  request: DISTRIBUTED_PAIR_REQUEST_SCHEMA,
  peer: DISTRIBUTED_PEER_SCHEMA,
}, ['request', 'peer']);

export const REMOTE_PAIR_REQUEST_OUTPUT_SCHEMA = objectSchema({
  request: DISTRIBUTED_PAIR_REQUEST_SCHEMA,
}, ['request']);

export const REMOTE_PAIR_REQUESTS_OUTPUT_SCHEMA = objectSchema({
  requests: arraySchema(DISTRIBUTED_PAIR_REQUEST_SCHEMA),
}, ['requests']);

export const REMOTE_PEERS_OUTPUT_SCHEMA = objectSchema({
  peers: arraySchema(DISTRIBUTED_PEER_SCHEMA),
}, ['peers']);

export const REMOTE_WORK_LIST_OUTPUT_SCHEMA = objectSchema({
  work: arraySchema(DISTRIBUTED_PENDING_WORK_SCHEMA),
}, ['work']);

export const REMOTE_PEER_TOKEN_ROTATE_INPUT_SCHEMA = objectSchema({
  peerId: STRING_SCHEMA,
  label: STRING_SCHEMA,
  scopes: STRING_LIST_SCHEMA,
}, ['peerId'], { additionalProperties: true });

export const REMOTE_PEER_TOKEN_ROTATE_OUTPUT_SCHEMA = objectSchema({
  peer: DISTRIBUTED_PEER_SCHEMA,
  token: objectSchema({
    id: STRING_SCHEMA,
    label: STRING_SCHEMA,
    scopes: STRING_LIST_SCHEMA,
    issuedAt: NUMBER_SCHEMA,
    lastUsedAt: NUMBER_SCHEMA,
    rotatedAt: NUMBER_SCHEMA,
    revokedAt: NUMBER_SCHEMA,
    fingerprint: STRING_SCHEMA,
    value: STRING_SCHEMA,
  }, ['id', 'label', 'scopes', 'issuedAt', 'fingerprint', 'value'], { additionalProperties: true }),
}, ['peer', 'token']);

export const REMOTE_PEER_TOKEN_REVOKE_INPUT_SCHEMA = objectSchema({
  peerId: STRING_SCHEMA,
  tokenId: STRING_SCHEMA,
  note: STRING_SCHEMA,
}, ['peerId'], { additionalProperties: true });

export const REMOTE_PEER_DISCONNECT_INPUT_SCHEMA = objectSchema({
  peerId: STRING_SCHEMA,
  note: STRING_SCHEMA,
  requeueClaimedWork: BOOLEAN_SCHEMA,
}, ['peerId'], { additionalProperties: true });

export const REMOTE_PEER_OUTPUT_SCHEMA = objectSchema({
  peer: DISTRIBUTED_PEER_SCHEMA,
}, ['peer']);

export const REMOTE_PEER_INVOKE_INPUT_SCHEMA = objectSchema({
  peerId: STRING_SCHEMA,
  command: STRING_SCHEMA,
  payload: JSON_VALUE_SCHEMA,
  priority: DISTRIBUTED_WORK_PRIORITY_SCHEMA,
  waitMs: NUMBER_SCHEMA,
  timeoutMs: NUMBER_SCHEMA,
  sessionId: STRING_SCHEMA,
  routeId: STRING_SCHEMA,
  automationRunId: STRING_SCHEMA,
  automationJobId: STRING_SCHEMA,
  approvalId: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['peerId', 'command'], { additionalProperties: true });

export const REMOTE_PEER_INVOKE_OUTPUT_SCHEMA = objectSchema({
  work: DISTRIBUTED_PENDING_WORK_SCHEMA,
  completed: BOOLEAN_SCHEMA,
}, ['work', 'completed']);

export const REMOTE_WORK_CANCEL_INPUT_SCHEMA = objectSchema({
  workId: STRING_SCHEMA,
  reason: STRING_SCHEMA,
}, ['workId'], { additionalProperties: true });

export const REMOTE_WORK_OUTPUT_SCHEMA = objectSchema({
  work: DISTRIBUTED_PENDING_WORK_SCHEMA,
}, ['work']);
