import type { PersistentStore } from '../../state/persistent-store.ts';
import type {
  DistributedPendingWork,
  DistributedRuntimeAuditRecord,
  DistributedRuntimeManagerState,
  DistributedRuntimePairRequest,
  DistributedRuntimeSnapshotStore,
  DistributedPeerKind,
  DistributedPeerRecord,
  DistributedRuntimeWaiter,
} from './distributed-runtime-types.ts';
import {
  normalizeAudit,
  normalizePairRequest,
  normalizePeer,
  normalizeWork,
  sanitizePairRequest,
  sanitizePeer,
  sortPairRequests,
  sortPeers,
  sortWork,
} from './distributed-runtime-utils.ts';

const MAX_AUDIT = 500;
const MAX_WORK_HISTORY = 500;
const MAX_PAIR_REQUESTS = 250;

export function attachDistributedRuntime(
  state: DistributedRuntimeManagerState,
  input: {
    readonly sessionBridge?: DistributedRuntimeManagerState['sessionBridge'];
    readonly approvalBridge?: DistributedRuntimeManagerState['approvalBridge'];
    readonly automationBridge?: DistributedRuntimeManagerState['automationBridge'];
    readonly eventPublisher?: DistributedRuntimeManagerState['eventPublisher'];
  },
): void {
  if (input.sessionBridge) state.sessionBridge = input.sessionBridge;
  if (input.approvalBridge) state.approvalBridge = input.approvalBridge;
  if (input.automationBridge) state.automationBridge = input.automationBridge;
  if (input.eventPublisher) state.eventPublisher = input.eventPublisher;
}

export async function startDistributedRuntime(state: DistributedRuntimeManagerState): Promise<void> {
  if (state.loaded) return;
  const snapshot = await state.store.load();
  state.pairRequests.clear();
  state.peers.clear();
  state.work.clear();
  state.audit.length = 0;
  for (const request of snapshot?.pairRequests ?? []) {
    const normalized = normalizePairRequest(request);
    if (normalized) state.pairRequests.set(normalized.id, normalized);
  }
  for (const peer of snapshot?.peers ?? []) {
    const normalized = normalizePeer(peer);
    if (normalized) state.peers.set(normalized.id, normalized);
  }
  for (const item of snapshot?.work ?? []) {
    const normalized = normalizeWork(item);
    if (normalized) state.work.set(normalized.id, normalized);
  }
  for (const record of snapshot?.audit ?? []) {
    const normalized = normalizeAudit(record);
    if (normalized) state.audit.push(normalized);
  }
  state.loaded = true;
  await pruneAndPersistDistributedRuntime(state);
}

export function listDistributedRuntimePairRequests(
  state: DistributedRuntimeManagerState,
  limit = 100,
): DistributedRuntimePairRequest[] {
  expireDistributedPairRequests(state);
  return sortPairRequests(state.pairRequests.values()).slice(0, Math.max(1, limit)).map(sanitizePairRequest);
}

export function listDistributedRuntimePeers(
  state: DistributedRuntimeManagerState,
  kind?: DistributedPeerKind,
  limit = 200,
): DistributedPeerRecord[] {
  return sortPeers(state.peers.values())
    .filter((peer) => !kind || peer.kind === kind)
    .slice(0, Math.max(1, limit))
    .map(sanitizePeer);
}

export function listDistributedRuntimeWork(
  state: DistributedRuntimeManagerState,
  limit = 200,
  peerId?: string,
): DistributedPendingWork[] {
  requeueDistributedExpiredClaims(state);
  return sortWork(state.work.values())
    .filter((item) => !peerId || item.peerId === peerId)
    .slice(0, Math.max(1, limit));
}

export function listDistributedRuntimeAudit(
  state: DistributedRuntimeManagerState,
  limit = 100,
): DistributedRuntimeAuditRecord[] {
  return state.audit.slice(0, Math.max(1, limit));
}

export function getDistributedRuntimeSnapshot(state: DistributedRuntimeManagerState): Record<string, unknown> {
  expireDistributedPairRequests(state);
  requeueDistributedExpiredClaims(state);
  const peers = listDistributedRuntimePeers(state, undefined, 500);
  const work = listDistributedRuntimeWork(state, 500);
  return {
    capturedAt: Date.now(),
    pairRequests: {
      total: state.pairRequests.size,
      pending: [...state.pairRequests.values()].filter((request) => request.status === 'pending').length,
      approved: [...state.pairRequests.values()].filter((request) => request.status === 'approved').length,
      entries: listDistributedRuntimePairRequests(state, 100),
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
    audit: listDistributedRuntimeAudit(state, 100),
  };
}

export function publishDistributedRuntimeEvent(state: DistributedRuntimeManagerState, event: string, payload: unknown): void {
  state.eventPublisher?.(event, payload);
}

export function recordDistributedRuntimeAudit(
  state: DistributedRuntimeManagerState,
  record: DistributedRuntimeAuditRecord,
): void {
  state.audit.unshift(record);
  if (state.audit.length > MAX_AUDIT) {
    state.audit.length = MAX_AUDIT;
  }
}

export function expireDistributedPairRequests(state: DistributedRuntimeManagerState, now = Date.now()): void {
  let changed = false;
  for (const [requestId, request] of state.pairRequests.entries()) {
    if (request.status === 'pending' || request.status === 'approved') {
      if (request.expiresAt <= now) {
        state.pairRequests.set(requestId, {
          ...request,
          status: 'expired',
          updatedAt: now,
        });
        recordDistributedRuntimeAudit(state, {
          id: `drt-audit-${requestId}-${now}`,
          action: 'pair-expired',
          actor: 'distributed-runtime',
          requestId,
          createdAt: now,
          note: request.label,
          metadata: {},
        });
        changed = true;
      }
    }
  }
  if (changed) {
    void persistDistributedRuntime(state);
  }
}

export function requeueDistributedExpiredClaims(state: DistributedRuntimeManagerState, now = Date.now()): void {
  let changed = false;
  for (const [workId, item] of state.work.entries()) {
    if (item.status !== 'claimed') continue;
    if (!item.leaseExpiresAt || item.leaseExpiresAt > now) continue;
    state.work.set(workId, {
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
    recordDistributedRuntimeAudit(state, {
      id: `drt-audit-${workId}-${now}`,
      action: 'work-expired',
      actor: 'distributed-runtime',
      peerId: item.peerId,
      workId,
      createdAt: now,
      note: item.command,
      metadata: {},
    });
    const peer = state.peers.get(item.peerId);
    if (peer) {
      state.peers.set(peer.id, {
        ...peer,
        status: 'disconnected',
        lastSeenAt: now,
        lastDisconnectedAt: now,
      });
    }
    changed = true;
  }
  if (changed) {
    void persistDistributedRuntime(state);
  }
}

export async function waitForDistributedWork(
  state: DistributedRuntimeManagerState,
  workId: string,
  timeoutMs: number,
): Promise<DistributedPendingWork | null> {
  const existing = state.work.get(workId);
  if (existing && existing.status !== 'queued' && existing.status !== 'claimed') {
    return existing;
  }
  return await new Promise<DistributedPendingWork | null>((resolve) => {
    const timer = setTimeout(() => {
      removeDistributedRuntimeWaiter(state, workId, resolve);
      resolve(null);
    }, timeoutMs);
    const bucket = state.waiters.get(workId) ?? [];
    bucket.push({ resolve, timer });
    state.waiters.set(workId, bucket);
  });
}

export function resolveDistributedRuntimeWaiters(state: DistributedRuntimeManagerState, work: DistributedPendingWork): void {
  const bucket = state.waiters.get(work.id);
  if (!bucket) return;
  state.waiters.delete(work.id);
  for (const waiter of bucket) {
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(work);
  }
}

export function removeDistributedRuntimeWaiter(
  state: DistributedRuntimeManagerState,
  workId: string,
  resolve: DistributedRuntimeWaiter['resolve'],
): void {
  const bucket = state.waiters.get(workId);
  if (!bucket) return;
  const next = bucket.filter((waiter) => waiter.resolve !== resolve);
  if (next.length === 0) state.waiters.delete(workId);
  else state.waiters.set(workId, next);
}

export async function pruneAndPersistDistributedRuntime(state: DistributedRuntimeManagerState): Promise<void> {
  expireDistributedPairRequests(state);
  requeueDistributedExpiredClaims(state);
  const pairRequests = sortPairRequests(state.pairRequests.values());
  for (const request of pairRequests.slice(MAX_PAIR_REQUESTS)) {
    state.pairRequests.delete(request.id);
  }
  const work = sortWork(state.work.values());
  const keep = new Set(
    work
      .filter((item) => item.status === 'queued' || item.status === 'claimed')
      .concat(work.filter((item) => item.status !== 'queued' && item.status !== 'claimed').slice(0, MAX_WORK_HISTORY))
      .map((item) => item.id),
  );
  for (const workId of [...state.work.keys()]) {
    if (!keep.has(workId)) state.work.delete(workId);
  }
  await persistDistributedRuntime(state);
}

export async function persistDistributedRuntime(state: DistributedRuntimeManagerState): Promise<void> {
  await state.store.persist({
    pairRequests: [...state.pairRequests.values()],
    peers: [...state.peers.values()],
    work: [...state.work.values()],
    audit: [...state.audit],
  });
}
