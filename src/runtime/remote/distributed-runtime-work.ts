import { randomUUID } from 'node:crypto';
import type { AutomationRunTelemetry } from '../../automation/runs.ts';
import type {
  DistributedPendingWork,
  DistributedPeerRecord,
  DistributedRuntimeManagerState,
  DistributedWorkPriority,
  DistributedWorkType,
  StoredPeerRecord,
} from './distributed-runtime-types.ts';
import {
  buildAudit,
  sanitizePeer,
  sortWork,
  summarizeValue,
} from './distributed-runtime-utils.ts';
import {
  persistDistributedRuntime,
  pruneAndPersistDistributedRuntime,
  publishDistributedRuntimeEvent,
  recordDistributedRuntimeAudit,
  resolveDistributedRuntimeWaiters,
  startDistributedRuntime,
  waitForDistributedWork,
} from './distributed-runtime-store.ts';

export async function enqueueDistributedWork(
  state: DistributedRuntimeManagerState,
  input: {
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
  },
): Promise<DistributedPendingWork> {
  await startDistributedRuntime(state);
  const peer = state.peers.get(input.peerId);
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
  state.work.set(work.id, work);
  recordDistributedRuntimeAudit(state, buildAudit('work-queued', input.actor ?? 'operator', {
    peerId: peer.id,
    workId: work.id,
    note: `${work.command} -> ${peer.label}`,
  }));
  await bridgeQueuedDistributedWork(state, peer, work);
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-work-queued', {
    peer: sanitizePeer(peer),
    work,
  });
  return work;
}

export async function invokeDistributedPeer(
  state: DistributedRuntimeManagerState,
  input: {
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
  },
): Promise<{ work: DistributedPendingWork; completed: boolean }> {
  const work = await enqueueDistributedWork(state, {
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
  const settled = await waitForDistributedWork(state, work.id, input.waitMs);
  return {
    work: settled ?? work,
    completed: Boolean(settled && settled.status !== 'queued' && settled.status !== 'claimed'),
  };
}

export async function claimDistributedWork(
  state: DistributedRuntimeManagerState,
  auth: { readonly peer: DistributedPeerRecord; readonly token: { readonly id: string } },
  input: {
    readonly maxItems?: number;
    readonly leaseMs?: number;
  } = {},
): Promise<DistributedPendingWork[]> {
  await startDistributedRuntime(state);
  const peer = state.peers.get(auth.peer.id);
  if (!peer) return [];
  const maxItems = Math.min(10, Math.max(1, Math.trunc(input.maxItems ?? 4)));
  const leaseMs = Math.max(5_000, Math.trunc(input.leaseMs ?? 45_000));
  const queued = sortWork(state.work.values())
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
    state.work.set(item.id, next);
    claimed.push(next);
    recordDistributedRuntimeAudit(state, buildAudit('work-claimed', peer.id, {
      peerId: peer.id,
      workId: item.id,
      note: item.command,
    }));
  }
  await pruneAndPersistDistributedRuntime(state);
  if (claimed.length > 0) {
    publishDistributedRuntimeEvent(state, 'remote-work-claimed', {
      peer: sanitizePeer(state.peers.get(peer.id)!),
      workIds: claimed.map((item) => item.id),
    });
  }
  return claimed;
}

export async function completeDistributedWork(
  state: DistributedRuntimeManagerState,
  auth: { readonly peer: DistributedPeerRecord; readonly token: { readonly id: string } },
  workId: string,
  input: {
    readonly status?: 'completed' | 'failed' | 'cancelled';
    readonly result?: unknown;
    readonly error?: string;
    readonly telemetry?: AutomationRunTelemetry;
    readonly metadata?: Record<string, unknown>;
  } = {},
): Promise<DistributedPendingWork | null> {
  await startDistributedRuntime(state);
  const current = state.work.get(workId);
  if (!current || current.peerId !== auth.peer.id) return null;
  if (current.claimTokenId && current.claimTokenId !== auth.token.id) return null;
  const status = input.status ?? (input.error ? 'failed' : 'completed');
  const updated: DistributedPendingWork = {
    ...current,
    status,
    result: input.result,
    error: input.error,
    telemetry: input.telemetry as DistributedPendingWork['telemetry'],
    completedAt: Date.now(),
    updatedAt: Date.now(),
    leaseExpiresAt: undefined,
    metadata: {
      ...current.metadata,
      ...(input.metadata ?? {}),
    },
  };
  state.work.set(workId, updated);
  const peer = state.peers.get(auth.peer.id);
  if (peer) {
    state.peers.set(peer.id, {
      ...peer,
      status: 'connected',
      lastSeenAt: Date.now(),
      lastConnectedAt: Date.now(),
    });
  }
  const actor = auth.peer.id;
  recordDistributedRuntimeAudit(state, buildAudit(
    status === 'completed' ? 'work-completed' : status === 'failed' ? 'work-failed' : 'work-cancelled',
    actor,
    {
      peerId: auth.peer.id,
      workId,
      note: status === 'completed' ? summarizeValue(input.result) || 'no result' : (input.error ?? status),
    },
  ));
  await bridgeCompletedDistributedWork(
    state,
    state.peers.get(auth.peer.id) ?? ensurePlaceholderPeer(state, auth.peer.id, current.peerKind),
    updated,
  );
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-work-settled', {
    peer: sanitizePeer(state.peers.get(auth.peer.id)!),
    work: updated,
  });
  resolveDistributedRuntimeWaiters(state, updated);
  return updated;
}

export async function cancelDistributedWork(
  state: DistributedRuntimeManagerState,
  workId: string,
  input: {
    readonly actor?: string;
    readonly reason?: string;
  } = {},
): Promise<DistributedPendingWork | null> {
  await startDistributedRuntime(state);
  const current = state.work.get(workId);
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
  state.work.set(workId, updated);
  recordDistributedRuntimeAudit(state, buildAudit('work-cancelled', input.actor ?? 'operator', {
    peerId: updated.peerId,
    workId,
    note: updated.error,
  }));
  await bridgeCompletedDistributedWork(
    state,
    state.peers.get(updated.peerId) ?? ensurePlaceholderPeer(state, updated.peerId, updated.peerKind),
    updated,
  );
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-work-cancelled', updated);
  resolveDistributedRuntimeWaiters(state, updated);
  return updated;
}

async function bridgeQueuedDistributedWork(
  state: DistributedRuntimeManagerState,
  peer: DistributedPeerRecord,
  work: DistributedPendingWork,
): Promise<void> {
  if (work.sessionId && state.sessionBridge) {
    await state.sessionBridge.appendSystemMessage(
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

async function bridgeCompletedDistributedWork(
  state: DistributedRuntimeManagerState,
  peer: DistributedPeerRecord,
  work: DistributedPendingWork,
): Promise<void> {
  const statusLabel = work.status === 'completed'
    ? 'completed'
    : work.status === 'failed'
      ? 'failed'
      : 'cancelled';
  const summary = work.status === 'completed'
    ? summarizeValue(work.result) || 'no result'
    : (work.error ?? statusLabel);

  if (work.sessionId && state.sessionBridge) {
    await state.sessionBridge.appendSystemMessage(
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

  if (work.approvalId && state.approvalBridge) {
    await state.approvalBridge.recordRemoteUpdate(work.approvalId, {
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

  if (work.automationRunId && state.automationBridge) {
    await state.automationBridge.recordExternalRunResult(work.automationRunId, {
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

function ensurePlaceholderPeer(
  state: DistributedRuntimeManagerState,
  peerId: string,
  kind: DistributedPeerRecord['kind'],
): StoredPeerRecord {
  const existing = state.peers.get(peerId);
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
  state.peers.set(peer.id, peer);
  return peer;
}
