import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AutomationRunTelemetry } from '../../automation/runs.ts';
import type {
  DistributedPendingWork,
  DistributedRuntimeAuditRecord,
  DistributedRuntimePairRequest,
  DistributedPeerRecord,
  DistributedPeerTokenRecord,
  DistributedWorkPriority,
  DistributedWorkType,
  StoredPairRequest,
  StoredPeerRecord,
  StoredPeerTokenRecord,
} from './distributed-runtime-types.ts';

const PRIORITY_SCORE: Record<DistributedWorkPriority, number> = {
  high: 3,
  normal: 2,
  default: 1,
};

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function matchesSecret(secret: string, expectedHash: string): boolean {
  const candidate = Buffer.from(hashSecret(secret), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function randomSecret(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString('base64url')}`;
}

export function fingerprint(secret: string): string {
  return secret.length <= 10 ? secret : `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

export function coerceStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
}

export function summarizeValue(value: unknown, max = 280): string {
  const raw = typeof value === 'string'
    ? value
    : value === undefined
      ? ''
      : JSON.stringify(value);
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

export function sortPairRequests<T extends { readonly updatedAt: number; readonly id: string }>(records: Iterable<T>): T[] {
  return [...records].sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
}

export function sortPeers<T extends {
  readonly id: string;
  readonly pairedAt: number;
  readonly verifiedAt?: number;
  readonly lastSeenAt?: number;
}>(records: Iterable<T>): T[] {
  return [...records].sort((a, b) => (b.lastSeenAt ?? b.verifiedAt ?? b.pairedAt) - (a.lastSeenAt ?? a.verifiedAt ?? a.pairedAt) || a.id.localeCompare(b.id));
}

export function sortWork<T extends DistributedPendingWork>(records: Iterable<T>): T[] {
  return [...records].sort((a, b) => {
    const statusDelta = Number(b.status === 'queued') - Number(a.status === 'queued');
    if (statusDelta !== 0) return statusDelta;
    const priorityDelta = PRIORITY_SCORE[b.priority] - PRIORITY_SCORE[a.priority];
    if (priorityDelta !== 0) return priorityDelta;
    return (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id);
  });
}

export function sanitizePairRequest(request: StoredPairRequest): DistributedRuntimePairRequest {
  return {
    id: request.id,
    peerKind: request.peerKind,
    requestedId: request.requestedId,
    label: request.label,
    platform: request.platform,
    deviceFamily: request.deviceFamily,
    version: request.version,
    clientMode: request.clientMode,
    capabilities: request.capabilities,
    commands: request.commands,
    requestedBy: request.requestedBy,
    status: request.status,
    challengePreview: request.challengePreview,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    approvedAt: request.approvedAt,
    verifiedAt: request.verifiedAt,
    rejectedAt: request.rejectedAt,
    expiresAt: request.expiresAt,
    peerId: request.peerId,
    remoteAddress: request.remoteAddress,
    metadata: request.metadata,
  };
}

export function sanitizePeer(peer: StoredPeerRecord): DistributedPeerRecord {
  return {
    ...peer,
    tokens: peer.tokens.map((token) => ({
      id: token.id,
      label: token.label,
      scopes: token.scopes,
      issuedAt: token.issuedAt,
      lastUsedAt: token.lastUsedAt,
      rotatedAt: token.rotatedAt,
      revokedAt: token.revokedAt,
      fingerprint: token.fingerprint,
    })),
  };
}

export function sanitizeToken(token: StoredPeerTokenRecord): DistributedPeerTokenRecord {
  return {
    id: token.id,
    label: token.label,
    scopes: token.scopes,
    issuedAt: token.issuedAt,
    lastUsedAt: token.lastUsedAt,
    rotatedAt: token.rotatedAt,
    revokedAt: token.revokedAt,
    fingerprint: token.fingerprint,
  };
}

export function buildAudit(
  action: DistributedRuntimeAuditRecord['action'],
  actor: string,
  input: {
    readonly peerId?: string;
    readonly requestId?: string;
    readonly workId?: string;
    readonly note?: string;
    readonly metadata?: Record<string, unknown>;
  } = {},
): DistributedRuntimeAuditRecord {
  return {
    id: `drt-audit-${randomUUID().slice(0, 8)}`,
    action,
    actor,
    createdAt: Date.now(),
    ...(input.peerId ? { peerId: input.peerId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.workId ? { workId: input.workId } : {}),
    ...(input.note ? { note: input.note } : {}),
    metadata: input.metadata ?? {},
  };
}

export function normalizePairRequest(record: unknown): StoredPairRequest | null {
  if (!record || typeof record !== 'object') return null;
  const candidate = record as Partial<StoredPairRequest>;
  if (typeof candidate.id !== 'string' || typeof candidate.peerKind !== 'string' || typeof candidate.label !== 'string') return null;
  return {
    id: candidate.id,
    peerKind: candidate.peerKind === 'device' ? 'device' : 'node',
    requestedId: typeof candidate.requestedId === 'string' ? candidate.requestedId : candidate.id,
    label: candidate.label,
    platform: typeof candidate.platform === 'string' ? candidate.platform : undefined,
    deviceFamily: typeof candidate.deviceFamily === 'string' ? candidate.deviceFamily : undefined,
    version: typeof candidate.version === 'string' ? candidate.version : undefined,
    clientMode: typeof candidate.clientMode === 'string' ? candidate.clientMode : undefined,
    capabilities: coerceStringArray(candidate.capabilities),
    commands: coerceStringArray(candidate.commands),
    requestedBy: candidate.requestedBy === 'operator' ? 'operator' : 'remote',
    status: candidate.status === 'approved' || candidate.status === 'verified' || candidate.status === 'rejected' || candidate.status === 'expired'
      ? candidate.status
      : 'pending',
    challengePreview: typeof candidate.challengePreview === 'string' ? candidate.challengePreview : 'unknown',
    challengeHash: typeof candidate.challengeHash === 'string' ? candidate.challengeHash : '',
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
    approvedAt: typeof candidate.approvedAt === 'number' ? candidate.approvedAt : undefined,
    verifiedAt: typeof candidate.verifiedAt === 'number' ? candidate.verifiedAt : undefined,
    rejectedAt: typeof candidate.rejectedAt === 'number' ? candidate.rejectedAt : undefined,
    expiresAt: typeof candidate.expiresAt === 'number' ? candidate.expiresAt : Date.now() + 10 * 60_000,
    peerId: typeof candidate.peerId === 'string' ? candidate.peerId : undefined,
    remoteAddress: typeof candidate.remoteAddress === 'string' ? candidate.remoteAddress : undefined,
    metadata: typeof candidate.metadata === 'object' && candidate.metadata !== null ? candidate.metadata as Record<string, unknown> : {},
  };
}

export function normalizeToken(record: unknown): StoredPeerTokenRecord | null {
  if (!record || typeof record !== 'object') return null;
  const candidate = record as Partial<StoredPeerTokenRecord>;
  if (typeof candidate.id !== 'string' || typeof candidate.secretHash !== 'string') return null;
  return {
    id: candidate.id,
    label: typeof candidate.label === 'string' ? candidate.label : 'access-token',
    scopes: coerceStringArray(candidate.scopes),
    issuedAt: typeof candidate.issuedAt === 'number' ? candidate.issuedAt : Date.now(),
    lastUsedAt: typeof candidate.lastUsedAt === 'number' ? candidate.lastUsedAt : undefined,
    rotatedAt: typeof candidate.rotatedAt === 'number' ? candidate.rotatedAt : undefined,
    revokedAt: typeof candidate.revokedAt === 'number' ? candidate.revokedAt : undefined,
    fingerprint: typeof candidate.fingerprint === 'string' ? candidate.fingerprint : 'unknown',
    secretHash: candidate.secretHash,
  };
}

export function normalizePeer(record: unknown): StoredPeerRecord | null {
  if (!record || typeof record !== 'object') return null;
  const candidate = record as Partial<StoredPeerRecord>;
  if (typeof candidate.id !== 'string' || typeof candidate.kind !== 'string' || typeof candidate.label !== 'string') return null;
  return {
    id: candidate.id,
    kind: candidate.kind === 'device' ? 'device' : 'node',
    label: candidate.label,
    requestedId: typeof candidate.requestedId === 'string' ? candidate.requestedId : candidate.id,
    platform: typeof candidate.platform === 'string' ? candidate.platform : undefined,
    deviceFamily: typeof candidate.deviceFamily === 'string' ? candidate.deviceFamily : undefined,
    version: typeof candidate.version === 'string' ? candidate.version : undefined,
    clientMode: typeof candidate.clientMode === 'string' ? candidate.clientMode : undefined,
    capabilities: coerceStringArray(candidate.capabilities),
    commands: coerceStringArray(candidate.commands),
    permissions: typeof candidate.permissions === 'object' && candidate.permissions !== null ? candidate.permissions as Record<string, boolean> : undefined,
    status: candidate.status === 'connected' || candidate.status === 'idle' || candidate.status === 'disconnected' || candidate.status === 'revoked'
      ? candidate.status
      : 'paired',
    pairedAt: typeof candidate.pairedAt === 'number' ? candidate.pairedAt : Date.now(),
    verifiedAt: typeof candidate.verifiedAt === 'number' ? candidate.verifiedAt : undefined,
    lastSeenAt: typeof candidate.lastSeenAt === 'number' ? candidate.lastSeenAt : undefined,
    lastConnectedAt: typeof candidate.lastConnectedAt === 'number' ? candidate.lastConnectedAt : undefined,
    lastDisconnectedAt: typeof candidate.lastDisconnectedAt === 'number' ? candidate.lastDisconnectedAt : undefined,
    lastRemoteAddress: typeof candidate.lastRemoteAddress === 'string' ? candidate.lastRemoteAddress : undefined,
    activeTokenId: typeof candidate.activeTokenId === 'string' ? candidate.activeTokenId : undefined,
    tokens: Array.isArray(candidate.tokens) ? candidate.tokens.map(normalizeToken).filter((token): token is StoredPeerTokenRecord => token !== null) : [],
    metadata: typeof candidate.metadata === 'object' && candidate.metadata !== null ? candidate.metadata as Record<string, unknown> : {},
  };
}

export function normalizeWork(record: unknown): DistributedPendingWork | null {
  if (!record || typeof record !== 'object') return null;
  const candidate = record as Partial<DistributedPendingWork>;
  if (typeof candidate.id !== 'string' || typeof candidate.peerId !== 'string' || typeof candidate.command !== 'string') return null;
  return {
    id: candidate.id,
    peerId: candidate.peerId,
    peerKind: candidate.peerKind === 'device' ? 'device' : 'node',
    type: candidate.type === 'status.request'
      || candidate.type === 'location.request'
      || candidate.type === 'session.message'
      || candidate.type === 'automation.run'
      ? candidate.type
      : 'invoke',
    command: candidate.command,
    priority: candidate.priority === 'high' || candidate.priority === 'default' ? candidate.priority : 'normal',
    status: candidate.status === 'claimed'
      || candidate.status === 'completed'
      || candidate.status === 'failed'
      || candidate.status === 'cancelled'
      || candidate.status === 'expired'
      ? candidate.status
      : 'queued',
    payload: candidate.payload,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
    queuedBy: typeof candidate.queuedBy === 'string' ? candidate.queuedBy : 'unknown',
    claimedAt: typeof candidate.claimedAt === 'number' ? candidate.claimedAt : undefined,
    claimTokenId: typeof candidate.claimTokenId === 'string' ? candidate.claimTokenId : undefined,
    leaseExpiresAt: typeof candidate.leaseExpiresAt === 'number' ? candidate.leaseExpiresAt : undefined,
    completedAt: typeof candidate.completedAt === 'number' ? candidate.completedAt : undefined,
    timeoutMs: typeof candidate.timeoutMs === 'number' ? candidate.timeoutMs : undefined,
    sessionId: typeof candidate.sessionId === 'string' ? candidate.sessionId : undefined,
    routeId: typeof candidate.routeId === 'string' ? candidate.routeId : undefined,
    automationRunId: typeof candidate.automationRunId === 'string' ? candidate.automationRunId : undefined,
    automationJobId: typeof candidate.automationJobId === 'string' ? candidate.automationJobId : undefined,
    approvalId: typeof candidate.approvalId === 'string' ? candidate.approvalId : undefined,
    result: candidate.result,
    error: typeof candidate.error === 'string' ? candidate.error : undefined,
    telemetry: normalizeAutomationTelemetry(candidate.telemetry),
    metadata: typeof candidate.metadata === 'object' && candidate.metadata !== null ? candidate.metadata as Record<string, unknown> : {},
  };
}

export function normalizeAutomationTelemetry(record: unknown): AutomationRunTelemetry | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const candidate = record as Partial<AutomationRunTelemetry>;
  const usage = candidate.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  return {
    usage: {
      inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
      outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
      cacheReadTokens: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0,
      cacheWriteTokens: typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0,
      ...(typeof usage.reasoningTokens === 'number' ? { reasoningTokens: usage.reasoningTokens } : {}),
    },
    ...(typeof candidate.llmCallCount === 'number' ? { llmCallCount: candidate.llmCallCount } : {}),
    ...(typeof candidate.toolCallCount === 'number' ? { toolCallCount: candidate.toolCallCount } : {}),
    ...(typeof candidate.turnCount === 'number' ? { turnCount: candidate.turnCount } : {}),
    ...(typeof candidate.modelId === 'string' ? { modelId: candidate.modelId } : {}),
    ...(typeof candidate.providerId === 'string' ? { providerId: candidate.providerId } : {}),
    ...(typeof candidate.reasoningSummaryPresent === 'boolean' ? { reasoningSummaryPresent: candidate.reasoningSummaryPresent } : {}),
    ...(candidate.source === 'local-agent' || candidate.source === 'shared-session' || candidate.source === 'remote-node' || candidate.source === 'remote-device'
      ? { source: candidate.source }
      : {}),
  };
}

export function normalizeAudit(record: unknown): DistributedRuntimeAuditRecord | null {
  if (!record || typeof record !== 'object') return null;
  const candidate = record as Partial<DistributedRuntimeAuditRecord>;
  if (typeof candidate.id !== 'string' || typeof candidate.action !== 'string' || typeof candidate.actor !== 'string') return null;
  return {
    id: candidate.id,
    action: candidate.action as DistributedRuntimeAuditRecord['action'],
    actor: candidate.actor,
    peerId: typeof candidate.peerId === 'string' ? candidate.peerId : undefined,
    requestId: typeof candidate.requestId === 'string' ? candidate.requestId : undefined,
    workId: typeof candidate.workId === 'string' ? candidate.workId : undefined,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    note: typeof candidate.note === 'string' ? candidate.note : undefined,
    metadata: typeof candidate.metadata === 'object' && candidate.metadata !== null ? candidate.metadata as Record<string, unknown> : {},
  };
}
