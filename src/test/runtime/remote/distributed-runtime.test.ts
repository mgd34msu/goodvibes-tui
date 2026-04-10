import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from '../../../state/persistent-store.ts';
import {
  DistributedRuntimeManager,
  type DistributedRuntimeSnapshotStore,
} from '../../../runtime/remote/distributed-runtime.ts';

function createManager() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-distributed-runtime-'));
  const store = new PersistentStore<DistributedRuntimeSnapshotStore>(join(dir, 'distributed-runtime.json'));
  const manager = new DistributedRuntimeManager(store);
  return { dir, manager };
}

async function pairVerifiedPeer(manager: DistributedRuntimeManager) {
  const requested = await manager.requestPairing({
    peerKind: 'node',
    label: 'builder node',
    requestedId: 'node-builder-1',
    platform: 'linux',
    capabilities: ['invoke'],
    commands: ['build'],
  });
  const approved = await manager.approvePairRequest(requested.request.id, { actor: 'operator' });
  expect(approved).not.toBeNull();
  const verified = await manager.verifyPairRequest(requested.request.id, requested.challenge, {
    remoteAddress: '10.0.0.10',
  });
  expect(verified).not.toBeNull();
  return verified!;
}

describe('DistributedRuntimeManager', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    cleanup.length = 0;
  });

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('pairs peers through request, approve, and verify', async () => {
    const { dir, manager } = createManager();
    cleanup.push(dir);

    const requested = await manager.requestPairing({
      peerKind: 'device',
      label: 'Pocket device',
      requestedId: 'device-pocket-1',
      platform: 'ios',
      deviceFamily: 'phone',
      requestedBy: 'remote',
    });
    expect(requested.request.status).toBe('pending');

    const approved = await manager.approvePairRequest(requested.request.id, {
      actor: 'admin',
      note: 'approved for testing',
    });
    expect(approved?.request.status).toBe('approved');
    expect(approved?.peer.kind).toBe('device');

    const verified = await manager.verifyPairRequest(requested.request.id, requested.challenge, {
      remoteAddress: '127.0.0.2',
    });
    expect(verified?.peer.status).toBe('connected');
    expect(verified?.token.value).toContain('gvrt_');
    expect(manager.listPeers().length).toBe(1);
    expect(manager.listPairRequests().find((entry) => entry.id === requested.request.id)?.status).toBe('verified');
  });

  test('rotating and revoking tokens invalidates old remote credentials', async () => {
    const { dir, manager } = createManager();
    cleanup.push(dir);

    const verified = await pairVerifiedPeer(manager);
    const authBefore = await manager.authenticatePeerToken(verified.token.value, '10.0.0.11');
    expect(authBefore?.peer.id).toBe(verified.peer.id);

    const rotated = await manager.rotatePeerToken(verified.peer.id, {
      actor: 'admin',
      label: 'replacement-token',
    });
    expect(rotated?.token.value).toContain('gvrt_');
    expect(await manager.authenticatePeerToken(verified.token.value, '10.0.0.12')).toBeNull();
    expect((await manager.authenticatePeerToken(rotated!.token.value, '10.0.0.13'))?.peer.id).toBe(verified.peer.id);

    await manager.revokePeerToken(verified.peer.id, { actor: 'admin', tokenId: rotated!.token.id });
    expect(await manager.authenticatePeerToken(rotated!.token.value, '10.0.0.14')).toBeNull();
  });

  test('queues, claims, completes, and bridges remote work', async () => {
    const { dir, manager } = createManager();
    cleanup.push(dir);

    const sessionMessages: Array<{ sessionId: string; body: string }> = [];
    const approvalUpdates: Array<{ approvalId: string; note?: string }> = [];
    const automationUpdates: Array<{ runId: string; status: string; telemetry?: Record<string, unknown> }> = [];
    manager.attachRuntime({
      sessionBridge: {
        appendSystemMessage: async (sessionId, body) => {
          sessionMessages.push({ sessionId, body });
          return null;
        },
      },
      approvalBridge: {
        recordRemoteUpdate: async (approvalId, input) => {
          approvalUpdates.push({ approvalId, note: input.note });
          return null;
        },
      },
      automationBridge: {
        recordExternalRunResult: async (runId, input) => {
          automationUpdates.push({
            runId,
            status: input.status,
            ...(input.telemetry ? { telemetry: input.telemetry as unknown as Record<string, unknown> } : {}),
          });
          return null;
        },
      },
    });

    const verified = await pairVerifiedPeer(manager);
    const queued = await manager.enqueueWork({
      peerId: verified.peer.id,
      command: 'build-project',
      actor: 'operator',
      sessionId: 'sess-1',
      automationRunId: 'run-1',
      approvalId: 'approval-1',
      payload: { target: 'release' },
    });
    expect(queued.status).toBe('queued');

    const auth = await manager.authenticatePeerToken(verified.token.value, '10.0.0.20');
    expect(auth).not.toBeNull();
    const claimed = await manager.claimWork(auth!, { maxItems: 1, leaseMs: 30_000 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe('claimed');

    const completed = await manager.completeWork(auth!, claimed[0]!.id, {
      result: { ok: true, summary: 'release build complete' },
      telemetry: {
        usage: {
          inputTokens: 9,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
        },
        llmCallCount: 1,
        turnCount: 1,
      },
    });
    expect(completed?.status).toBe('completed');
    expect(sessionMessages.some((entry) => entry.sessionId === 'sess-1' && entry.body.includes('Queued remote'))).toBe(true);
    expect(sessionMessages.some((entry) => entry.sessionId === 'sess-1' && entry.body.includes('release build complete'))).toBe(true);
    expect(approvalUpdates).toHaveLength(1);
    expect(approvalUpdates[0]?.approvalId).toBe('approval-1');
    expect(approvalUpdates[0]?.note).toContain('completed');
    expect(automationUpdates).toEqual([{
      runId: 'run-1',
      status: 'completed',
      telemetry: {
        usage: {
          inputTokens: 9,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
        },
        llmCallCount: 1,
        turnCount: 1,
      },
    }]);
  });

  test('disconnecting a peer requeues claimed work and allows reconnect claim', async () => {
    const { dir, manager } = createManager();
    cleanup.push(dir);

    const verified = await pairVerifiedPeer(manager);
    const auth = await manager.authenticatePeerToken(verified.token.value, '10.0.0.30');
    expect(auth).not.toBeNull();

    await manager.enqueueWork({
      peerId: verified.peer.id,
      command: 'status-check',
      actor: 'operator',
    });
    const claimed = await manager.claimWork(auth!, { maxItems: 1, leaseMs: 60_000 });
    expect(claimed[0]?.status).toBe('claimed');

    const disconnected = await manager.disconnectPeer(verified.peer.id, {
      actor: 'operator',
      note: 'simulated disconnect',
      requeueClaimedWork: true,
    });
    expect(disconnected?.status).toBe('disconnected');
    expect(manager.listWork(10)[0]?.status).toBe('queued');

    const authAfter = await manager.authenticatePeerToken(verified.token.value, '10.0.0.31');
    expect(authAfter).not.toBeNull();
    await manager.heartbeatPeer(authAfter!, { remoteAddress: '10.0.0.31' });
    const reclaimed = await manager.claimWork(authAfter!, { maxItems: 1 });
    expect(reclaimed[0]?.status).toBe('claimed');
  });
});
