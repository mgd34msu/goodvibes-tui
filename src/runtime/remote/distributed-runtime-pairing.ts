import { randomUUID } from 'node:crypto';
import type {
  DistributedPeerAuth,
  DistributedPeerKind,
  DistributedPeerRecord,
  DistributedPeerTokenRecord,
  DistributedRuntimeManagerState,
  DistributedRuntimePairRequest,
  StoredPairRequest,
  StoredPeerRecord,
  StoredPeerTokenRecord,
} from './distributed-runtime-types.ts';
import {
  buildAudit,
  fingerprint,
  hashSecret,
  matchesSecret,
  randomSecret,
  sanitizePairRequest,
  sanitizePeer,
  sanitizeToken,
} from './distributed-runtime-utils.ts';
import {
  expireDistributedPairRequests,
  persistDistributedRuntime,
  pruneAndPersistDistributedRuntime,
  publishDistributedRuntimeEvent,
  recordDistributedRuntimeAudit,
  startDistributedRuntime,
} from './distributed-runtime-store.ts';

export async function requestDistributedPairing(
  state: DistributedRuntimeManagerState,
  input: {
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
  },
): Promise<{ request: DistributedRuntimePairRequest; challenge: string }> {
  await startDistributedRuntime(state);
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
    expiresAt: now + Math.max(30_000, Math.trunc(input.ttlMs ?? 10 * 60_000)),
    remoteAddress: input.remoteAddress,
    metadata: input.metadata ?? {},
  };
  state.pairRequests.set(request.id, request);
  recordDistributedRuntimeAudit(state, buildAudit('pair-requested', input.requestedBy ?? 'remote', {
    requestId: request.id,
    note: `${request.peerKind}:${request.label}`,
    metadata: request.metadata,
  }));
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-pair-requested', sanitizePairRequest(request));
  return { request: sanitizePairRequest(request), challenge };
}

export async function approveDistributedPairRequest(
  state: DistributedRuntimeManagerState,
  requestId: string,
  input: {
    readonly actor?: string;
    readonly note?: string;
    readonly label?: string;
    readonly metadata?: Record<string, unknown>;
  } = {},
): Promise<{ request: DistributedRuntimePairRequest; peer: DistributedPeerRecord } | null> {
  await startDistributedRuntime(state);
  const request = state.pairRequests.get(requestId);
  if (!request) return null;
  expireDistributedPairRequests(state);
  if (request.status !== 'pending' && request.status !== 'approved') {
    return { request: sanitizePairRequest(request), peer: sanitizePeer(ensurePeerFromRequest(state, request, input.label, input.metadata)) };
  }
  const peer = ensurePeerFromRequest(state, request, input.label, input.metadata);
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
  state.pairRequests.set(requestId, updated);
  recordDistributedRuntimeAudit(state, buildAudit('pair-approved', input.actor ?? 'operator', {
    requestId,
    peerId: peer.id,
    note: input.note ?? peer.label,
  }));
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-pair-approved', {
    request: sanitizePairRequest(updated),
    peer: sanitizePeer(peer),
  });
  return { request: sanitizePairRequest(updated), peer: sanitizePeer(peer) };
}

export async function rejectDistributedPairRequest(
  state: DistributedRuntimeManagerState,
  requestId: string,
  input: {
    readonly actor?: string;
    readonly note?: string;
  } = {},
): Promise<DistributedRuntimePairRequest | null> {
  await startDistributedRuntime(state);
  const request = state.pairRequests.get(requestId);
  if (!request) return null;
  const updated: StoredPairRequest = {
    ...request,
    status: 'rejected',
    rejectedAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.pairRequests.set(requestId, updated);
  recordDistributedRuntimeAudit(state, buildAudit('pair-rejected', input.actor ?? 'operator', {
    requestId,
    note: input.note ?? updated.label,
  }));
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-pair-rejected', sanitizePairRequest(updated));
  return sanitizePairRequest(updated);
}

export async function verifyDistributedPairRequest(
  state: DistributedRuntimeManagerState,
  requestId: string,
  challenge: string,
  input: {
    readonly remoteAddress?: string;
    readonly metadata?: Record<string, unknown>;
  } = {},
): Promise<{ peer: DistributedPeerRecord; token: DistributedPeerTokenRecord & { value: string } } | null> {
  await startDistributedRuntime(state);
  expireDistributedPairRequests(state);
  const request = state.pairRequests.get(requestId);
  if (!request) return null;
  if (request.status !== 'approved') return null;
  if (!matchesSecret(challenge, request.challengeHash)) return null;
  const peer = ensurePeerFromRequest(state, request, undefined, input.metadata);
  const issued = issueToken(state, peer.id, 'pair-verified-token');
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
  state.pairRequests.set(requestId, verifiedRequest);
  const connectedPeer = updatePeerConnectionState(state, peer.id, 'connected', {
    remoteAddress: input.remoteAddress,
  }) ?? peer;
  recordDistributedRuntimeAudit(state, buildAudit('pair-verified', 'remote-peer', {
    requestId,
    peerId: peer.id,
    note: connectedPeer.label,
  }));
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-pair-verified', {
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

export async function rotateDistributedPeerToken(
  state: DistributedRuntimeManagerState,
  peerId: string,
  input: {
    readonly actor?: string;
    readonly label?: string;
    readonly scopes?: readonly string[];
  } = {},
): Promise<{ peer: DistributedPeerRecord; token: DistributedPeerTokenRecord & { value: string } } | null> {
  await startDistributedRuntime(state);
  const peer = state.peers.get(peerId);
  if (!peer) return null;
  const issued = issueToken(state, peerId, input.label ?? 'rotated-access-token', input.scopes);
  recordDistributedRuntimeAudit(state, buildAudit('token-rotated', input.actor ?? 'operator', {
    peerId,
    note: issued.token.label,
  }));
  await pruneAndPersistDistributedRuntime(state);
  const updatedPeer = state.peers.get(peerId)!;
  publishDistributedRuntimeEvent(state, 'remote-token-rotated', {
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

export async function revokeDistributedPeerToken(
  state: DistributedRuntimeManagerState,
  peerId: string,
  input: {
    readonly actor?: string;
    readonly tokenId?: string;
    readonly note?: string;
  } = {},
): Promise<DistributedPeerRecord | null> {
  await startDistributedRuntime(state);
  const peer = state.peers.get(peerId);
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
  state.peers.set(peerId, updated);
  recordDistributedRuntimeAudit(state, buildAudit('token-revoked', input.actor ?? 'operator', {
    peerId,
    note: input.note ?? input.tokenId ?? updated.label,
  }));
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-token-revoked', { peer: sanitizePeer(updated), tokenId: input.tokenId ?? null });
  return sanitizePeer(updated);
}

export async function disconnectDistributedPeer(
  state: DistributedRuntimeManagerState,
  peerId: string,
  input: {
    readonly actor?: string;
    readonly note?: string;
    readonly requeueClaimedWork?: boolean;
  } = {},
): Promise<DistributedPeerRecord | null> {
  await startDistributedRuntime(state);
  const peer = updatePeerConnectionState(state, peerId, 'disconnected');
  if (!peer) return null;
  if (input.requeueClaimedWork !== false) {
    for (const item of state.work.values()) {
      if (item.peerId !== peerId || item.status !== 'claimed') continue;
      state.work.set(item.id, {
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
  recordDistributedRuntimeAudit(state, buildAudit('peer-disconnected', input.actor ?? 'operator', {
    peerId,
    note: input.note ?? peer.label,
  }));
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-peer-disconnected', sanitizePeer(peer));
  return sanitizePeer(peer);
}

export async function authenticateDistributedPeerToken(
  state: DistributedRuntimeManagerState,
  tokenValue: string,
  remoteAddress?: string,
): Promise<DistributedPeerAuth | null> {
  await startDistributedRuntime(state);
  if (!tokenValue.trim()) return null;
  for (const peer of state.peers.values()) {
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
      state.peers.set(peer.id, updatedPeer);
      await persistDistributedRuntime(state);
      return {
        peer: sanitizePeer(updatedPeer),
        token: updatedToken,
      };
    }
  }
  return null;
}

export async function heartbeatDistributedPeer(
  state: DistributedRuntimeManagerState,
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
  await startDistributedRuntime(state);
  const peer = state.peers.get(auth.peer.id);
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
  state.peers.set(peer.id, updated);
  recordDistributedRuntimeAudit(state, buildAudit('peer-connected', peer.id, {
    peerId: peer.id,
    note: updated.label,
  }));
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-peer-heartbeat', sanitizePeer(updated));
  return sanitizePeer(updated);
}

function ensurePeerFromRequest(
  state: DistributedRuntimeManagerState,
  request: StoredPairRequest,
  labelOverride?: string,
  metadata?: Record<string, unknown>,
): StoredPeerRecord {
  const existing = request.peerId ? state.peers.get(request.peerId) : [...state.peers.values()].find((peer) => peer.requestedId === request.requestedId);
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
    state.peers.set(existing.id, merged);
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
  state.peers.set(peer.id, peer);
  return peer;
}

function ensurePlaceholderPeer(state: DistributedRuntimeManagerState, peerId: string, kind: DistributedPeerKind): StoredPeerRecord {
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

function issueToken(
  state: DistributedRuntimeManagerState,
  peerId: string,
  label: string,
  scopes: readonly string[] = ['remote:pull', 'remote:complete', 'remote:heartbeat'],
): { token: StoredPeerTokenRecord; value: string } {
  const peer = state.peers.get(peerId);
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
  state.peers.set(peerId, {
    ...peer,
    status: peer.status === 'revoked' ? 'paired' : peer.status,
    verifiedAt: issuedAt,
    activeTokenId: token.id,
    tokens: nextTokens,
  });
  return { token, value };
}

function updatePeerConnectionState(
  state: DistributedRuntimeManagerState,
  peerId: string,
  status: 'connected' | 'disconnected',
  input: {
    readonly remoteAddress?: string;
  } = {},
): StoredPeerRecord | null {
  const peer = state.peers.get(peerId);
  if (!peer) return null;
  const now = Date.now();
  const updated: StoredPeerRecord = {
    ...peer,
    status,
    lastSeenAt: now,
    ...(status === 'connected' ? { lastConnectedAt: now } : { lastDisconnectedAt: now }),
    ...(input.remoteAddress ? { lastRemoteAddress: input.remoteAddress } : {}),
  };
  state.peers.set(peerId, updated);
  return updated;
}
