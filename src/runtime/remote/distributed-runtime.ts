import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { PersistentStore } from '../../state/persistent-store.ts';
import { ControlPlaneGateway } from '../../control-plane/gateway.ts';
import type { AutomationRunTelemetry } from '../../automation/runs.ts';

export type DistributedPeerKind = 'node' | 'device';
export type DistributedPairRequestStatus = 'pending' | 'approved' | 'verified' | 'rejected' | 'expired';
export type DistributedPeerStatus = 'paired' | 'connected' | 'idle' | 'disconnected' | 'revoked';
export type DistributedWorkPriority = 'default' | 'normal' | 'high';
export type DistributedWorkStatus = 'queued' | 'claimed' | 'completed' | 'failed' | 'cancelled' | 'expired';
export type DistributedWorkType = 'invoke' | 'status.request' | 'location.request' | 'session.message' | 'automation.run';

export interface DistributedSessionBridge {
  appendSystemMessage(sessionId: string, body: string, metadata?: Record<string, unknown>): Promise<unknown>;
}

export interface DistributedApprovalBridge {
  recordRemoteUpdate(
    approvalId: string,
    input: {
      readonly actor: string;
      readonly actorSurface?: string;
      readonly note?: string;
      readonly metadata?: Record<string, unknown>;
    },
  ): Promise<unknown>;
}

export interface DistributedAutomationBridge {
  recordExternalRunResult(
    runId: string,
    input: {
      readonly status: 'completed' | 'failed' | 'cancelled';
      readonly result?: unknown;
      readonly error?: string;
      readonly telemetry?: AutomationRunTelemetry;
      readonly metadata?: Record<string, unknown>;
    },
  ): Promise<unknown>;
}

export interface DistributedRuntimePairRequest {
  readonly id: string;
  readonly peerKind: DistributedPeerKind;
  readonly requestedId: string;
  readonly label: string;
  readonly platform?: string;
  readonly deviceFamily?: string;
  readonly version?: string;
  readonly clientMode?: string;
  readonly capabilities: readonly string[];
  readonly commands: readonly string[];
  readonly requestedBy: 'remote' | 'operator';
  readonly status: DistributedPairRequestStatus;
  readonly challengePreview: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly approvedAt?: number;
  readonly verifiedAt?: number;
  readonly rejectedAt?: number;
  readonly expiresAt: number;
  readonly peerId?: string;
  readonly remoteAddress?: string;
  readonly metadata: Record<string, unknown>;
}

export interface DistributedPeerTokenRecord {
  readonly id: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly issuedAt: number;
  readonly lastUsedAt?: number;
  readonly rotatedAt?: number;
  readonly revokedAt?: number;
  readonly fingerprint: string;
}

export interface DistributedPeerRecord {
  readonly id: string;
  readonly kind: DistributedPeerKind;
  readonly label: string;
  readonly requestedId: string;
  readonly platform?: string;
  readonly deviceFamily?: string;
  readonly version?: string;
  readonly clientMode?: string;
  readonly capabilities: readonly string[];
  readonly commands: readonly string[];
  readonly permissions?: Record<string, boolean>;
  readonly status: DistributedPeerStatus;
  readonly pairedAt: number;
  readonly verifiedAt?: number;
  readonly lastSeenAt?: number;
  readonly lastConnectedAt?: number;
  readonly lastDisconnectedAt?: number;
  readonly lastRemoteAddress?: string;
  readonly activeTokenId?: string;
  readonly tokens: readonly DistributedPeerTokenRecord[];
  readonly metadata: Record<string, unknown>;
}

export interface DistributedPendingWork {
  readonly id: string;
  readonly peerId: string;
  readonly peerKind: DistributedPeerKind;
  readonly type: DistributedWorkType;
  readonly command: string;
  readonly priority: DistributedWorkPriority;
  readonly status: DistributedWorkStatus;
  readonly payload?: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly queuedBy: string;
  readonly claimedAt?: number;
  readonly claimTokenId?: string;
  readonly leaseExpiresAt?: number;
  readonly completedAt?: number;
  readonly timeoutMs?: number;
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly automationRunId?: string;
  readonly automationJobId?: string;
  readonly approvalId?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly telemetry?: AutomationRunTelemetry;
  readonly metadata: Record<string, unknown>;
}

export interface DistributedRuntimeAuditRecord {
  readonly id: string;
  readonly action:
    | 'pair-requested'
    | 'pair-approved'
    | 'pair-rejected'
    | 'pair-verified'
    | 'pair-expired'
    | 'token-rotated'
    | 'token-revoked'
    | 'peer-connected'
    | 'peer-disconnected'
    | 'work-queued'
    | 'work-claimed'
    | 'work-completed'
    | 'work-failed'
    | 'work-cancelled'
    | 'work-expired';
  readonly actor: string;
  readonly peerId?: string;
  readonly requestId?: string;
  readonly workId?: string;
  readonly createdAt: number;
  readonly note?: string;
  readonly metadata: Record<string, unknown>;
}

interface StoredPairRequest extends DistributedRuntimePairRequest {
  readonly challengeHash: string;
}

interface StoredPeerTokenRecord extends DistributedPeerTokenRecord {
  readonly secretHash: string;
}

interface StoredPeerRecord extends Omit<DistributedPeerRecord, 'tokens'> {
  readonly tokens: readonly StoredPeerTokenRecord[];
}

export interface DistributedRuntimeSnapshotStore extends Record<string, unknown> {
  readonly pairRequests: readonly StoredPairRequest[];
  readonly peers: readonly StoredPeerRecord[];
  readonly work: readonly DistributedPendingWork[];
  readonly audit: readonly DistributedRuntimeAuditRecord[];
}

interface DistributedRuntimeWaiter {
  readonly resolve: (work: DistributedPendingWork | null) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

export interface DistributedPeerAuth {
  readonly peer: DistributedPeerRecord;
  readonly token: DistributedPeerTokenRecord;
}

export interface DistributedNodeHostContract {
  readonly schemaVersion: 1;
  readonly transport: 'http-json';
  readonly basePath: '/api/remote';
  readonly peerKinds: readonly DistributedPeerKind[];
  readonly workTypes: readonly DistributedWorkType[];
  readonly scopes: readonly string[];
  readonly recommendedHeartbeatMs: number;
  readonly recommendedWorkPullMs: number;
  readonly endpoints: readonly {
    readonly id: string;
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly auth: 'none' | 'bearer-peer-token' | 'bearer-operator-token';
    readonly description: string;
    readonly requiredScope?: string;
  }[];
  readonly workCompletionStatuses: readonly DistributedWorkStatus[];
  readonly metadata: Record<string, unknown>;
}

const STORE_PATH = join(process.cwd(), '.goodvibes', 'tui', 'remote', 'distributed-runtime.json');
const DEFAULT_PAIR_TTL_MS = 10 * 60_000;
const DEFAULT_CLAIM_LEASE_MS = 45_000;
const MAX_AUDIT = 500;
const MAX_WORK_HISTORY = 500;
const MAX_PAIR_REQUESTS = 250;
const PRIORITY_SCORE: Record<DistributedWorkPriority, number> = {
  high: 3,
  normal: 2,
  default: 1,
};

export function getDistributedNodeHostContract(): DistributedNodeHostContract {
  return {
    schemaVersion: 1,
    transport: 'http-json',
    basePath: '/api/remote',
    peerKinds: ['node', 'device'],
    workTypes: ['invoke', 'status.request', 'location.request', 'session.message', 'automation.run'],
    scopes: ['remote:heartbeat', 'remote:pull', 'remote:complete'],
    recommendedHeartbeatMs: 30_000,
    recommendedWorkPullMs: 2_000,
    endpoints: [
      {
        id: 'pair.request',
        method: 'POST',
        path: '/api/remote/pair/request',
        auth: 'none',
        description: 'Create a pending pair request and receive a challenge for operator approval.',
      },
      {
        id: 'pair.verify',
        method: 'POST',
        path: '/api/remote/pair/verify',
        auth: 'none',
        description: 'Exchange an approved pair request and challenge for a scoped peer token.',
      },
      {
        id: 'peer.heartbeat',
        method: 'POST',
        path: '/api/remote/heartbeat',
        auth: 'bearer-peer-token',
        requiredScope: 'remote:heartbeat',
        description: 'Report peer liveness, capability, command, version, and client-mode metadata.',
      },
      {
        id: 'work.pull',
        method: 'POST',
        path: '/api/remote/work/pull',
        auth: 'bearer-peer-token',
        requiredScope: 'remote:pull',
        description: 'Claim queued work for the authenticated peer.',
      },
      {
        id: 'work.complete',
        method: 'POST',
        path: '/api/remote/work/{workId}/complete',
        auth: 'bearer-peer-token',
        requiredScope: 'remote:complete',
        description: 'Complete, fail, or cancel a claimed work item.',
      },
      {
        id: 'operator.snapshot',
        method: 'GET',
        path: '/api/remote',
        auth: 'bearer-operator-token',
        description: 'Inspect distributed runtime pair requests, peers, work, and audit state.',
      },
    ],
    workCompletionStatuses: ['completed', 'failed', 'cancelled'],
    metadata: {
      note: 'Node/device hosts are external processes. GoodVibes owns the pair/token/work protocol and can be controlled from web, channel, or daemon clients.',
    },
  };
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function matchesSecret(secret: string, expectedHash: string): boolean {
  const candidate = Buffer.from(hashSecret(secret), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

function randomSecret(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString('base64url')}`;
}

function fingerprint(secret: string): string {
  return secret.length <= 10 ? secret : `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

function coerceStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
}

function summarizeValue(value: unknown, max = 280): string {
  const raw = typeof value === 'string'
    ? value
    : value === undefined
      ? ''
      : JSON.stringify(value);
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function sortPairRequests<T extends { readonly updatedAt: number; readonly id: string }>(records: Iterable<T>): T[] {
  return [...records].sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
}

function sortPeers<T extends {
  readonly id: string;
  readonly pairedAt: number;
  readonly verifiedAt?: number;
  readonly lastSeenAt?: number;
}>(records: Iterable<T>): T[] {
  return [...records].sort((a, b) => (b.lastSeenAt ?? b.verifiedAt ?? b.pairedAt) - (a.lastSeenAt ?? a.verifiedAt ?? a.pairedAt) || a.id.localeCompare(b.id));
}

function sortWork<T extends DistributedPendingWork>(records: Iterable<T>): T[] {
  return [...records].sort((a, b) => {
    const statusDelta = Number(b.status === 'queued') - Number(a.status === 'queued');
    if (statusDelta !== 0) return statusDelta;
    const priorityDelta = PRIORITY_SCORE[b.priority] - PRIORITY_SCORE[a.priority];
    if (priorityDelta !== 0) return priorityDelta;
    return (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id);
  });
}

function sanitizePairRequest(request: StoredPairRequest): DistributedRuntimePairRequest {
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

function sanitizePeer(peer: StoredPeerRecord): DistributedPeerRecord {
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

function sanitizeToken(token: StoredPeerTokenRecord): DistributedPeerTokenRecord {
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

function buildAudit(
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

function normalizePairRequest(record: unknown): StoredPairRequest | null {
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
    expiresAt: typeof candidate.expiresAt === 'number' ? candidate.expiresAt : Date.now() + DEFAULT_PAIR_TTL_MS,
    peerId: typeof candidate.peerId === 'string' ? candidate.peerId : undefined,
    remoteAddress: typeof candidate.remoteAddress === 'string' ? candidate.remoteAddress : undefined,
    metadata: typeof candidate.metadata === 'object' && candidate.metadata !== null ? candidate.metadata as Record<string, unknown> : {},
  };
}

function normalizeToken(record: unknown): StoredPeerTokenRecord | null {
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

function normalizePeer(record: unknown): StoredPeerRecord | null {
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

function normalizeWork(record: unknown): DistributedPendingWork | null {
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

function normalizeAutomationTelemetry(record: unknown): AutomationRunTelemetry | undefined {
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

function normalizeAudit(record: unknown): DistributedRuntimeAuditRecord | null {
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

export class DistributedRuntimeManager {
  private static instance: DistributedRuntimeManager | null = null;

  private readonly store: PersistentStore<DistributedRuntimeSnapshotStore>;
  private readonly pairRequests = new Map<string, StoredPairRequest>();
  private readonly peers = new Map<string, StoredPeerRecord>();
  private readonly work = new Map<string, DistributedPendingWork>();
  private readonly audit: DistributedRuntimeAuditRecord[] = [];
  private readonly waiters = new Map<string, DistributedRuntimeWaiter[]>();
  private sessionBridge: DistributedSessionBridge | null = null;
  private approvalBridge: DistributedApprovalBridge | null = null;
  private automationBridge: DistributedAutomationBridge | null = null;
  private loaded = false;

  constructor(store?: PersistentStore<DistributedRuntimeSnapshotStore>) {
    this.store = store ?? new PersistentStore<DistributedRuntimeSnapshotStore>(STORE_PATH);
  }

  static getInstance(): DistributedRuntimeManager {
    if (!DistributedRuntimeManager.instance) {
      DistributedRuntimeManager.instance = new DistributedRuntimeManager();
    }
    return DistributedRuntimeManager.instance;
  }

  static resetInstance(): void {
    DistributedRuntimeManager.instance = null;
  }

  attachRuntime(input: {
    readonly sessionBridge?: DistributedSessionBridge | null;
    readonly approvalBridge?: DistributedApprovalBridge | null;
    readonly automationBridge?: DistributedAutomationBridge | null;
  }): void {
    if (input.sessionBridge) this.sessionBridge = input.sessionBridge;
    if (input.approvalBridge) this.approvalBridge = input.approvalBridge;
    if (input.automationBridge) this.automationBridge = input.automationBridge;
  }

  async start(): Promise<void> {
    if (this.loaded) return;
    const snapshot = await this.store.load();
    this.pairRequests.clear();
    this.peers.clear();
    this.work.clear();
    this.audit.length = 0;
    for (const request of snapshot?.pairRequests ?? []) {
      const normalized = normalizePairRequest(request);
      if (normalized) this.pairRequests.set(normalized.id, normalized);
    }
    for (const peer of snapshot?.peers ?? []) {
      const normalized = normalizePeer(peer);
      if (normalized) this.peers.set(normalized.id, normalized);
    }
    for (const item of snapshot?.work ?? []) {
      const normalized = normalizeWork(item);
      if (normalized) this.work.set(normalized.id, normalized);
    }
    for (const record of snapshot?.audit ?? []) {
      const normalized = normalizeAudit(record);
      if (normalized) this.audit.push(normalized);
    }
    this.loaded = true;
    await this.pruneAndPersist();
  }

  listPairRequests(limit = 100): DistributedRuntimePairRequest[] {
    this.expirePairRequests();
    return sortPairRequests(this.pairRequests.values()).slice(0, Math.max(1, limit)).map(sanitizePairRequest);
  }

  listPeers(kind?: DistributedPeerKind, limit = 200): DistributedPeerRecord[] {
    return sortPeers(this.peers.values())
      .filter((peer) => !kind || peer.kind === kind)
      .slice(0, Math.max(1, limit))
      .map(sanitizePeer);
  }

  listWork(limit = 200, peerId?: string): DistributedPendingWork[] {
    this.requeueExpiredClaims();
    return sortWork(this.work.values())
      .filter((item) => !peerId || item.peerId === peerId)
      .slice(0, Math.max(1, limit));
  }

  listAudit(limit = 100): DistributedRuntimeAuditRecord[] {
    return this.audit.slice(0, Math.max(1, limit));
  }

  getSnapshot(): Record<string, unknown> {
    this.expirePairRequests();
    this.requeueExpiredClaims();
    const peers = this.listPeers(undefined, 500);
    const work = this.listWork(500);
    return {
      capturedAt: Date.now(),
      pairRequests: {
        total: this.pairRequests.size,
        pending: [...this.pairRequests.values()].filter((request) => request.status === 'pending').length,
        approved: [...this.pairRequests.values()].filter((request) => request.status === 'approved').length,
        entries: this.listPairRequests(100),
      },
      peers: {
        total: peers.length,
        connected: peers.filter((peer) => peer.status === 'connected').length,
        nodes: peers.filter((peer) => peer.kind === 'node').length,
        devices: peers.filter((peer) => peer.kind === 'device').length,
        entries: peers,
      },
      work: {
        total: work.length,
        queued: work.filter((item) => item.status === 'queued').length,
        claimed: work.filter((item) => item.status === 'claimed').length,
        completed: work.filter((item) => item.status === 'completed').length,
        failed: work.filter((item) => item.status === 'failed').length,
        cancelled: work.filter((item) => item.status === 'cancelled').length,
        entries: work.slice(0, 100),
      },
      audit: this.listAudit(100),
    };
  }

  getNodeHostContract(): DistributedNodeHostContract {
    return getDistributedNodeHostContract();
  }

  async requestPairing(input: {
    readonly peerKind: DistributedPeerKind;
    readonly requestedId?: string;
    readonly label: string;
    readonly platform?: string;
    readonly deviceFamily?: string;
    readonly version?: string;
    readonly clientMode?: string;
    readonly capabilities?: readonly string[];
    readonly commands?: readonly string[];
    readonly metadata?: Record<string, unknown>;
    readonly requestedBy?: 'remote' | 'operator';
    readonly remoteAddress?: string;
    readonly ttlMs?: number;
  }): Promise<{ request: DistributedRuntimePairRequest; challenge: string }> {
    await this.start();
    const now = Date.now();
    const challenge = randomSecret('gvpair');
    const request: StoredPairRequest = {
      id: `pair-${randomUUID().slice(0, 8)}`,
      peerKind: input.peerKind,
      requestedId: input.requestedId?.trim() || `${input.peerKind}-${randomUUID().slice(0, 8)}`,
      label: input.label.trim() || `${input.peerKind} peer`,
      platform: input.platform,
      deviceFamily: input.deviceFamily,
      version: input.version,
      clientMode: input.clientMode,
      capabilities: [...(input.capabilities ?? [])],
      commands: [...(input.commands ?? [])],
      requestedBy: input.requestedBy ?? 'remote',
      status: 'pending',
      challengePreview: fingerprint(challenge),
      challengeHash: hashSecret(challenge),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + Math.max(30_000, Math.trunc(input.ttlMs ?? DEFAULT_PAIR_TTL_MS)),
      remoteAddress: input.remoteAddress,
      metadata: input.metadata ?? {},
    };
    this.pairRequests.set(request.id, request);
    this.recordAudit(buildAudit('pair-requested', input.requestedBy ?? 'remote', {
      requestId: request.id,
      note: `${request.peerKind}:${request.label}`,
      metadata: request.metadata,
    }));
    await this.pruneAndPersist();
    this.publishEvent('remote-pair-requested', sanitizePairRequest(request));
    return { request: sanitizePairRequest(request), challenge };
  }

  async approvePairRequest(
    requestId: string,
    input: {
      readonly actor?: string;
      readonly note?: string;
      readonly label?: string;
      readonly metadata?: Record<string, unknown>;
    } = {},
  ): Promise<{ request: DistributedRuntimePairRequest; peer: DistributedPeerRecord } | null> {
    await this.start();
    const request = this.pairRequests.get(requestId);
    if (!request) return null;
    this.expirePairRequests();
    if (request.status !== 'pending' && request.status !== 'approved') {
      return { request: sanitizePairRequest(request), peer: sanitizePeer(this.ensurePeerFromRequest(request, input.label, input.metadata)) };
    }
    const peer = this.ensurePeerFromRequest(request, input.label, input.metadata);
    const updated: StoredPairRequest = {
      ...request,
      status: 'approved',
      approvedAt: Date.now(),
      updatedAt: Date.now(),
      peerId: peer.id,
      metadata: {
        ...request.metadata,
        ...(input.metadata ?? {}),
      },
    };
    this.pairRequests.set(requestId, updated);
    this.recordAudit(buildAudit('pair-approved', input.actor ?? 'operator', {
      requestId,
      peerId: peer.id,
      note: input.note ?? peer.label,
    }));
    await this.pruneAndPersist();
    this.publishEvent('remote-pair-approved', {
      request: sanitizePairRequest(updated),
      peer: sanitizePeer(peer),
    });
    return { request: sanitizePairRequest(updated), peer: sanitizePeer(peer) };
  }

  async rejectPairRequest(
    requestId: string,
    input: {
      readonly actor?: string;
      readonly note?: string;
    } = {},
  ): Promise<DistributedRuntimePairRequest | null> {
    await this.start();
    const request = this.pairRequests.get(requestId);
    if (!request) return null;
    const updated: StoredPairRequest = {
      ...request,
      status: 'rejected',
      rejectedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.pairRequests.set(requestId, updated);
    this.recordAudit(buildAudit('pair-rejected', input.actor ?? 'operator', {
      requestId,
      note: input.note ?? updated.label,
    }));
    await this.pruneAndPersist();
    this.publishEvent('remote-pair-rejected', sanitizePairRequest(updated));
    return sanitizePairRequest(updated);
  }

  async verifyPairRequest(
    requestId: string,
    challenge: string,
    input: {
      readonly remoteAddress?: string;
      readonly metadata?: Record<string, unknown>;
    } = {},
  ): Promise<{ peer: DistributedPeerRecord; token: DistributedPeerTokenRecord & { value: string } } | null> {
    await this.start();
    this.expirePairRequests();
    const request = this.pairRequests.get(requestId);
    if (!request) return null;
    if (request.status !== 'approved') return null;
    if (!matchesSecret(challenge, request.challengeHash)) return null;
    const peer = this.ensurePeerFromRequest(request, undefined, input.metadata);
    const issued = this.issueToken(peer.id, 'pair-verified-token');
    const verifiedRequest: StoredPairRequest = {
      ...request,
      status: 'verified',
      verifiedAt: Date.now(),
      updatedAt: Date.now(),
      peerId: peer.id,
      remoteAddress: input.remoteAddress ?? request.remoteAddress,
      metadata: {
        ...request.metadata,
        ...(input.metadata ?? {}),
      },
    };
    this.pairRequests.set(requestId, verifiedRequest);
    const connectedPeer = this.updatePeerConnectionState(peer.id, 'connected', {
      remoteAddress: input.remoteAddress,
    }) ?? peer;
    this.recordAudit(buildAudit('pair-verified', 'remote-peer', {
      requestId,
      peerId: peer.id,
      note: connectedPeer.label,
    }));
    await this.pruneAndPersist();
    this.publishEvent('remote-pair-verified', {
      request: sanitizePairRequest(verifiedRequest),
      peer: sanitizePeer(connectedPeer),
    });
    return {
      peer: sanitizePeer(connectedPeer),
      token: {
        ...sanitizeToken(issued.token),
        value: issued.value,
      },
    };
  }

  async rotatePeerToken(
    peerId: string,
    input: {
      readonly actor?: string;
      readonly label?: string;
      readonly scopes?: readonly string[];
    } = {},
  ): Promise<{ peer: DistributedPeerRecord; token: DistributedPeerTokenRecord & { value: string } } | null> {
    await this.start();
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    const issued = this.issueToken(peerId, input.label ?? 'rotated-access-token', input.scopes);
    this.recordAudit(buildAudit('token-rotated', input.actor ?? 'operator', {
      peerId,
      note: issued.token.label,
    }));
    await this.pruneAndPersist();
    const updatedPeer = this.peers.get(peerId)!;
    this.publishEvent('remote-token-rotated', {
      peer: sanitizePeer(updatedPeer),
      tokenId: issued.token.id,
    });
    return {
      peer: sanitizePeer(updatedPeer),
      token: {
        ...sanitizeToken(issued.token),
        value: issued.value,
      },
    };
  }

  async revokePeerToken(
    peerId: string,
    input: {
      readonly actor?: string;
      readonly tokenId?: string;
      readonly note?: string;
    } = {},
  ): Promise<DistributedPeerRecord | null> {
    await this.start();
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    const now = Date.now();
    let changed = false;
    const nextTokens = peer.tokens.map((token) => {
      if (input.tokenId && token.id !== input.tokenId) return token;
      if (token.revokedAt) return token;
      changed = true;
      return {
        ...token,
        revokedAt: now,
      };
    });
    if (!changed) return sanitizePeer(peer);
    const activeToken = nextTokens.find((token) => !token.revokedAt && token.id !== input.tokenId) ?? null;
    const updated: StoredPeerRecord = {
      ...peer,
      status: activeToken ? peer.status : 'revoked',
      activeTokenId: activeToken?.id,
      tokens: nextTokens,
    };
    this.peers.set(peerId, updated);
    this.recordAudit(buildAudit('token-revoked', input.actor ?? 'operator', {
      peerId,
      note: input.note ?? input.tokenId ?? updated.label,
    }));
    await this.pruneAndPersist();
    this.publishEvent('remote-token-revoked', { peer: sanitizePeer(updated), tokenId: input.tokenId ?? null });
    return sanitizePeer(updated);
  }

  async disconnectPeer(
    peerId: string,
    input: {
      readonly actor?: string;
      readonly note?: string;
      readonly requeueClaimedWork?: boolean;
    } = {},
  ): Promise<DistributedPeerRecord | null> {
    await this.start();
    const peer = this.updatePeerConnectionState(peerId, 'disconnected');
    if (!peer) return null;
    if (input.requeueClaimedWork !== false) {
      for (const item of this.work.values()) {
        if (item.peerId !== peerId || item.status !== 'claimed') continue;
        this.work.set(item.id, {
          ...item,
          status: 'queued',
          claimTokenId: undefined,
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          updatedAt: Date.now(),
          metadata: {
            ...item.metadata,
            requeuedReason: input.note ?? 'peer-disconnected',
          },
        });
      }
    }
    this.recordAudit(buildAudit('peer-disconnected', input.actor ?? 'operator', {
      peerId,
      note: input.note ?? peer.label,
    }));
    await this.pruneAndPersist();
    this.publishEvent('remote-peer-disconnected', sanitizePeer(peer));
    return sanitizePeer(peer);
  }

  async enqueueWork(input: {
    readonly peerId: string;
    readonly type?: DistributedWorkType;
    readonly command: string;
    readonly payload?: unknown;
    readonly priority?: DistributedWorkPriority;
    readonly actor?: string;
    readonly timeoutMs?: number;
    readonly sessionId?: string;
    readonly routeId?: string;
    readonly automationRunId?: string;
    readonly automationJobId?: string;
    readonly approvalId?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<DistributedPendingWork> {
    await this.start();
    this.requeueExpiredClaims();
    const peer = this.peers.get(input.peerId);
    if (!peer) throw new Error(`Unknown distributed peer: ${input.peerId}`);
    const now = Date.now();
    const work: DistributedPendingWork = {
      id: `rwork-${randomUUID().slice(0, 8)}`,
      peerId: peer.id,
      peerKind: peer.kind,
      type: input.type ?? 'invoke',
      command: input.command.trim() || 'invoke',
      priority: input.priority ?? 'normal',
      status: 'queued',
      payload: input.payload,
      createdAt: now,
      updatedAt: now,
      queuedBy: input.actor ?? 'operator',
      timeoutMs: input.timeoutMs,
      sessionId: input.sessionId,
      routeId: input.routeId,
      automationRunId: input.automationRunId,
      automationJobId: input.automationJobId,
      approvalId: input.approvalId,
      metadata: input.metadata ?? {},
    };
    this.work.set(work.id, work);
    this.recordAudit(buildAudit('work-queued', input.actor ?? 'operator', {
      peerId: peer.id,
      workId: work.id,
      note: `${work.command} -> ${peer.label}`,
    }));
    await this.bridgeQueuedWork(peer, work);
    await this.pruneAndPersist();
    this.publishEvent('remote-work-queued', {
      peer: sanitizePeer(peer),
      work,
    });
    return work;
  }

  async invokePeer(input: {
    readonly peerId: string;
    readonly command: string;
    readonly payload?: unknown;
    readonly priority?: DistributedWorkPriority;
    readonly actor?: string;
    readonly waitMs?: number;
    readonly timeoutMs?: number;
    readonly sessionId?: string;
    readonly routeId?: string;
    readonly automationRunId?: string;
    readonly automationJobId?: string;
    readonly approvalId?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<{ work: DistributedPendingWork; completed: boolean }> {
    const work = await this.enqueueWork({
      peerId: input.peerId,
      command: input.command,
      payload: input.payload,
      priority: input.priority,
      actor: input.actor,
      timeoutMs: input.timeoutMs,
      sessionId: input.sessionId,
      routeId: input.routeId,
      automationRunId: input.automationRunId,
      automationJobId: input.automationJobId,
      approvalId: input.approvalId,
      metadata: input.metadata,
    });
    if (!input.waitMs || input.waitMs <= 0) {
      return { work, completed: false };
    }
    const settled = await this.waitForWork(work.id, input.waitMs);
    return {
      work: settled ?? work,
      completed: Boolean(settled && settled.status !== 'queued' && settled.status !== 'claimed'),
    };
  }

  async authenticatePeerToken(tokenValue: string, remoteAddress?: string): Promise<DistributedPeerAuth | null> {
    await this.start();
    if (!tokenValue.trim()) return null;
    for (const peer of this.peers.values()) {
      for (const token of peer.tokens) {
        if (token.revokedAt) continue;
        if (!matchesSecret(tokenValue, token.secretHash)) continue;
        const now = Date.now();
        const updatedToken: StoredPeerTokenRecord = {
          ...token,
          lastUsedAt: now,
        };
        const updatedPeer: StoredPeerRecord = {
          ...peer,
          status: 'connected',
          lastSeenAt: now,
          lastConnectedAt: now,
          lastRemoteAddress: remoteAddress ?? peer.lastRemoteAddress,
          activeTokenId: updatedToken.id,
          tokens: peer.tokens.map((entry) => entry.id === updatedToken.id ? updatedToken : entry),
        };
        this.peers.set(peer.id, updatedPeer);
        await this.persist();
        return {
          peer: sanitizePeer(updatedPeer),
          token: updatedToken,
        };
      }
    }
    return null;
  }

  async heartbeatPeer(
    auth: DistributedPeerAuth,
    input: {
      readonly remoteAddress?: string;
      readonly capabilities?: readonly string[];
      readonly commands?: readonly string[];
      readonly version?: string;
      readonly clientMode?: string;
      readonly metadata?: Record<string, unknown>;
    } = {},
  ): Promise<DistributedPeerRecord> {
    await this.start();
    const peer = this.peers.get(auth.peer.id);
    if (!peer) throw new Error(`Unknown distributed peer: ${auth.peer.id}`);
    const updated: StoredPeerRecord = {
      ...peer,
      status: 'connected',
      lastSeenAt: Date.now(),
      lastConnectedAt: Date.now(),
      lastRemoteAddress: input.remoteAddress ?? peer.lastRemoteAddress,
      capabilities: input.capabilities ? [...input.capabilities] : peer.capabilities,
      commands: input.commands ? [...input.commands] : peer.commands,
      version: input.version ?? peer.version,
      clientMode: input.clientMode ?? peer.clientMode,
      metadata: {
        ...peer.metadata,
        ...(input.metadata ?? {}),
      },
    };
    this.peers.set(peer.id, updated);
    this.recordAudit(buildAudit('peer-connected', peer.id, {
      peerId: peer.id,
      note: updated.label,
    }));
    await this.pruneAndPersist();
    this.publishEvent('remote-peer-heartbeat', sanitizePeer(updated));
    return sanitizePeer(updated);
  }

  async claimWork(
    auth: DistributedPeerAuth,
    input: {
      readonly maxItems?: number;
      readonly leaseMs?: number;
    } = {},
  ): Promise<DistributedPendingWork[]> {
    await this.start();
    this.requeueExpiredClaims();
    const peer = this.peers.get(auth.peer.id);
    if (!peer) return [];
    const maxItems = Math.min(10, Math.max(1, Math.trunc(input.maxItems ?? 4)));
    const leaseMs = Math.max(5_000, Math.trunc(input.leaseMs ?? DEFAULT_CLAIM_LEASE_MS));
    const queued = sortWork(this.work.values())
      .filter((item) => item.peerId === peer.id && item.status === 'queued')
      .slice(0, maxItems);
    const now = Date.now();
    const claimed: DistributedPendingWork[] = [];
    for (const item of queued) {
      const next: DistributedPendingWork = {
        ...item,
        status: 'claimed',
        claimTokenId: auth.token.id,
        claimedAt: now,
        leaseExpiresAt: now + leaseMs,
        updatedAt: now,
      };
      this.work.set(item.id, next);
      claimed.push(next);
      this.recordAudit(buildAudit('work-claimed', peer.id, {
        peerId: peer.id,
        workId: item.id,
        note: item.command,
      }));
    }
    this.updatePeerConnectionState(peer.id, 'connected');
    await this.pruneAndPersist();
    if (claimed.length > 0) {
      this.publishEvent('remote-work-claimed', {
        peer: sanitizePeer(this.peers.get(peer.id)!),
        workIds: claimed.map((item) => item.id),
      });
    }
    return claimed;
  }

  async completeWork(
    auth: DistributedPeerAuth,
    workId: string,
    input: {
      readonly status?: 'completed' | 'failed' | 'cancelled';
      readonly result?: unknown;
      readonly error?: string;
      readonly telemetry?: AutomationRunTelemetry;
      readonly metadata?: Record<string, unknown>;
    } = {},
  ): Promise<DistributedPendingWork | null> {
    await this.start();
    const current = this.work.get(workId);
    if (!current || current.peerId !== auth.peer.id) return null;
    if (current.claimTokenId && current.claimTokenId !== auth.token.id) return null;
    const status = input.status ?? (input.error ? 'failed' : 'completed');
    const updated: DistributedPendingWork = {
      ...current,
      status,
      result: input.result,
      error: input.error,
      telemetry: input.telemetry,
      completedAt: Date.now(),
      updatedAt: Date.now(),
      leaseExpiresAt: undefined,
      metadata: {
        ...current.metadata,
        ...(input.metadata ?? {}),
      },
    };
    this.work.set(workId, updated);
    this.updatePeerConnectionState(auth.peer.id, 'connected');
    const actor = auth.peer.id;
    this.recordAudit(buildAudit(
      status === 'completed' ? 'work-completed' : status === 'failed' ? 'work-failed' : 'work-cancelled',
      actor,
      {
        peerId: auth.peer.id,
        workId,
        note: status === 'completed' ? summarizeValue(input.result) : (input.error ?? status),
      },
    ));
    await this.bridgeCompletedWork(this.peers.get(auth.peer.id)!, updated);
    await this.pruneAndPersist();
    this.publishEvent('remote-work-settled', {
      peer: sanitizePeer(this.peers.get(auth.peer.id)!),
      work: updated,
    });
    this.resolveWaiters(updated);
    return updated;
  }

  async cancelWork(
    workId: string,
    input: {
      readonly actor?: string;
      readonly reason?: string;
    } = {},
  ): Promise<DistributedPendingWork | null> {
    await this.start();
    const current = this.work.get(workId);
    if (!current) return null;
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
      return current;
    }
    const updated: DistributedPendingWork = {
      ...current,
      status: 'cancelled',
      error: input.reason ?? current.error ?? 'operator-cancelled',
      completedAt: Date.now(),
      updatedAt: Date.now(),
      leaseExpiresAt: undefined,
    };
    this.work.set(workId, updated);
    this.recordAudit(buildAudit('work-cancelled', input.actor ?? 'operator', {
      peerId: updated.peerId,
      workId,
      note: updated.error,
    }));
    await this.bridgeCompletedWork(this.peers.get(updated.peerId) ?? this.ensurePlaceholderPeer(updated.peerId, updated.peerKind), updated);
    await this.pruneAndPersist();
    this.publishEvent('remote-work-cancelled', updated);
    this.resolveWaiters(updated);
    return updated;
  }

  private ensurePeerFromRequest(
    request: StoredPairRequest,
    labelOverride?: string,
    metadata?: Record<string, unknown>,
  ): StoredPeerRecord {
    const existing = request.peerId ? this.peers.get(request.peerId) : [...this.peers.values()].find((peer) => peer.requestedId === request.requestedId);
    if (existing) {
      const merged: StoredPeerRecord = {
        ...existing,
        label: labelOverride?.trim() || existing.label,
        platform: request.platform ?? existing.platform,
        deviceFamily: request.deviceFamily ?? existing.deviceFamily,
        version: request.version ?? existing.version,
        clientMode: request.clientMode ?? existing.clientMode,
        capabilities: request.capabilities.length > 0 ? request.capabilities : existing.capabilities,
        commands: request.commands.length > 0 ? request.commands : existing.commands,
        metadata: {
          ...existing.metadata,
          ...request.metadata,
          ...(metadata ?? {}),
        },
      };
      this.peers.set(existing.id, merged);
      return merged;
    }
    const peer: StoredPeerRecord = {
      id: `${request.peerKind}-${randomUUID().slice(0, 8)}`,
      kind: request.peerKind,
      label: labelOverride?.trim() || request.label,
      requestedId: request.requestedId,
      platform: request.platform,
      deviceFamily: request.deviceFamily,
      version: request.version,
      clientMode: request.clientMode,
      capabilities: request.capabilities,
      commands: request.commands,
      permissions: undefined,
      status: 'paired',
      pairedAt: Date.now(),
      verifiedAt: undefined,
      lastSeenAt: undefined,
      lastConnectedAt: undefined,
      lastDisconnectedAt: undefined,
      lastRemoteAddress: request.remoteAddress,
      activeTokenId: undefined,
      tokens: [],
      metadata: {
        ...request.metadata,
        ...(metadata ?? {}),
      },
    };
    this.peers.set(peer.id, peer);
    return peer;
  }

  private ensurePlaceholderPeer(peerId: string, kind: DistributedPeerKind): StoredPeerRecord {
    const existing = this.peers.get(peerId);
    if (existing) return existing;
    const peer: StoredPeerRecord = {
      id: peerId,
      kind,
      label: peerId,
      requestedId: peerId,
      capabilities: [],
      commands: [],
      permissions: undefined,
      status: 'idle',
      pairedAt: Date.now(),
      tokens: [],
      metadata: {},
    };
    this.peers.set(peer.id, peer);
    return peer;
  }

  private issueToken(
    peerId: string,
    label: string,
    scopes: readonly string[] = ['remote:pull', 'remote:complete', 'remote:heartbeat'],
  ): { token: StoredPeerTokenRecord; value: string } {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error(`Unknown distributed peer: ${peerId}`);
    const value = randomSecret('gvrt');
    const issuedAt = Date.now();
    const token: StoredPeerTokenRecord = {
      id: `dtoken-${randomUUID().slice(0, 8)}`,
      label,
      scopes: [...scopes],
      issuedAt,
      lastUsedAt: undefined,
      rotatedAt: issuedAt,
      revokedAt: undefined,
      fingerprint: fingerprint(value),
      secretHash: hashSecret(value),
    };
    const nextTokens = peer.tokens.map((entry) => entry.revokedAt ? entry : { ...entry, revokedAt: issuedAt });
    nextTokens.push(token);
    this.peers.set(peerId, {
      ...peer,
      status: peer.status === 'revoked' ? 'paired' : peer.status,
      verifiedAt: issuedAt,
      activeTokenId: token.id,
      tokens: nextTokens,
    });
    return { token, value };
  }

  private updatePeerConnectionState(
    peerId: string,
    status: 'connected' | 'disconnected',
    input: {
      readonly remoteAddress?: string;
    } = {},
  ): StoredPeerRecord | null {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    const now = Date.now();
    const updated: StoredPeerRecord = {
      ...peer,
      status,
      lastSeenAt: now,
      ...(status === 'connected' ? { lastConnectedAt: now } : { lastDisconnectedAt: now }),
      ...(input.remoteAddress ? { lastRemoteAddress: input.remoteAddress } : {}),
    };
    this.peers.set(peerId, updated);
    return updated;
  }

  private expirePairRequests(now = Date.now()): void {
    let changed = false;
    for (const [requestId, request] of this.pairRequests.entries()) {
      if (request.status === 'pending' || request.status === 'approved') {
        if (request.expiresAt <= now) {
          this.pairRequests.set(requestId, {
            ...request,
            status: 'expired',
            updatedAt: now,
          });
          this.recordAudit(buildAudit('pair-expired', 'distributed-runtime', {
            requestId,
            note: request.label,
          }));
          changed = true;
        }
      }
    }
    if (changed) {
      void this.persist();
    }
  }

  private requeueExpiredClaims(now = Date.now()): void {
    let changed = false;
    for (const [workId, item] of this.work.entries()) {
      if (item.status !== 'claimed') continue;
      if (!item.leaseExpiresAt || item.leaseExpiresAt > now) continue;
      this.work.set(workId, {
        ...item,
        status: 'queued',
        claimTokenId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
        metadata: {
          ...item.metadata,
          lastLeaseExpiryAt: now,
        },
      });
      this.recordAudit(buildAudit('work-expired', 'distributed-runtime', {
        peerId: item.peerId,
        workId,
        note: item.command,
      }));
      this.updatePeerConnectionState(item.peerId, 'disconnected');
      changed = true;
    }
    if (changed) {
      void this.persist();
    }
  }

  private async bridgeQueuedWork(peer: StoredPeerRecord, work: DistributedPendingWork): Promise<void> {
    if (work.sessionId && this.sessionBridge) {
      await this.sessionBridge.appendSystemMessage(
        work.sessionId,
        `Queued remote ${peer.kind} work on ${peer.label}: ${work.command}`,
        {
          remotePeerId: peer.id,
          remotePeerKind: peer.kind,
          remoteWorkId: work.id,
          remoteWorkStatus: work.status,
          automationRunId: work.automationRunId,
          approvalId: work.approvalId,
        },
      );
    }
  }

  private async bridgeCompletedWork(peer: StoredPeerRecord, work: DistributedPendingWork): Promise<void> {
    const statusLabel = work.status === 'completed'
      ? 'completed'
      : work.status === 'failed'
        ? 'failed'
        : 'cancelled';
    const summary = work.status === 'completed'
      ? summarizeValue(work.result) || 'no result'
      : (work.error ?? statusLabel);

    if (work.sessionId && this.sessionBridge) {
      await this.sessionBridge.appendSystemMessage(
        work.sessionId,
        `Remote ${peer.kind} ${peer.label} ${statusLabel}: ${work.command}${summary ? `\n${summary}` : ''}`,
        {
          remotePeerId: peer.id,
          remotePeerKind: peer.kind,
          remoteWorkId: work.id,
          remoteWorkStatus: work.status,
          automationRunId: work.automationRunId,
          approvalId: work.approvalId,
        },
      );
    }

    if (work.approvalId && this.approvalBridge) {
      await this.approvalBridge.recordRemoteUpdate(work.approvalId, {
        actor: peer.id,
        actorSurface: 'service',
        note: `Remote ${peer.kind} ${peer.label} ${statusLabel}: ${work.command}`,
        metadata: {
          remotePeerId: peer.id,
          remoteWorkId: work.id,
          remoteWorkStatus: work.status,
        },
      });
    }

    if (work.automationRunId && this.automationBridge) {
      await this.automationBridge.recordExternalRunResult(work.automationRunId, {
        status: work.status === 'completed' ? 'completed' : work.status === 'failed' ? 'failed' : 'cancelled',
        result: work.result,
        error: work.error,
        telemetry: work.telemetry,
        metadata: {
          remotePeerId: peer.id,
          remoteWorkId: work.id,
          remotePeerKind: peer.kind,
        },
      });
    }
  }

  private async waitForWork(workId: string, timeoutMs: number): Promise<DistributedPendingWork | null> {
    const existing = this.work.get(workId);
    if (existing && existing.status !== 'queued' && existing.status !== 'claimed') {
      return existing;
    }
    return await new Promise<DistributedPendingWork | null>((resolve) => {
      const timer = setTimeout(() => {
        this.removeWaiter(workId, resolve);
        resolve(null);
      }, timeoutMs);
      const bucket = this.waiters.get(workId) ?? [];
      bucket.push({ resolve, timer });
      this.waiters.set(workId, bucket);
    });
  }

  private resolveWaiters(work: DistributedPendingWork): void {
    const bucket = this.waiters.get(work.id);
    if (!bucket) return;
    this.waiters.delete(work.id);
    for (const waiter of bucket) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(work);
    }
  }

  private removeWaiter(workId: string, resolve: DistributedRuntimeWaiter['resolve']): void {
    const bucket = this.waiters.get(workId);
    if (!bucket) return;
    const next = bucket.filter((waiter) => waiter.resolve !== resolve);
    if (next.length === 0) this.waiters.delete(workId);
    else this.waiters.set(workId, next);
  }

  private publishEvent(event: string, payload: unknown): void {
    ControlPlaneGateway.getActive()?.publishEvent(event, payload);
  }

  private recordAudit(record: DistributedRuntimeAuditRecord): void {
    this.audit.unshift(record);
    if (this.audit.length > MAX_AUDIT) {
      this.audit.length = MAX_AUDIT;
    }
  }

  private async pruneAndPersist(): Promise<void> {
    this.expirePairRequests();
    this.requeueExpiredClaims();
    const pairRequests = sortPairRequests(this.pairRequests.values());
    for (const request of pairRequests.slice(MAX_PAIR_REQUESTS)) {
      this.pairRequests.delete(request.id);
    }
    const work = sortWork(this.work.values());
    const keep = new Set(
      work
        .filter((item) => item.status === 'queued' || item.status === 'claimed')
        .concat(work.filter((item) => item.status !== 'queued' && item.status !== 'claimed').slice(0, MAX_WORK_HISTORY))
        .map((item) => item.id),
    );
    for (const workId of [...this.work.keys()]) {
      if (!keep.has(workId)) this.work.delete(workId);
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.store.persist({
      pairRequests: [...this.pairRequests.values()],
      peers: [...this.peers.values()],
      work: [...this.work.values()],
      audit: [...this.audit],
    });
  }
}

export function getDistributedRuntimeManager(): DistributedRuntimeManager {
  return DistributedRuntimeManager.getInstance();
}

export function resetDistributedRuntimeManagerForTesting(): void {
  DistributedRuntimeManager.resetInstance();
}
