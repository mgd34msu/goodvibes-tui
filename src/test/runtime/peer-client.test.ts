import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createPeerClient } from '@/runtime/index.ts';
import { getTestAgentManager, getTestRuntimeServices, resetTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

describe('PeerClient', () => {
  beforeEach(() => {
    resetTestRuntimeServices();
  });

  afterEach(() => {
    getTestAgentManager().clear();
  });

  test('groups pairing, peer, work, and runner domains over in-process runtime services', async () => {
    const services = getTestRuntimeServices();
    services.distributedRuntime.pairRequests.clear();
    services.distributedRuntime.peers.clear();
    services.distributedRuntime.work.clear();
    services.distributedRuntime.audit.length = 0;
    services.distributedRuntime.waiters.clear();
    services.distributedRuntime.loaded = true;
    services.remoteRunnerRegistry.clear();
    const client = createPeerClient({
      runtimeStore: services.runtimeStore,
      distributedRuntime: services.distributedRuntime,
      remoteRunnerRegistry: services.remoteRunnerRegistry,
      remoteSupervisor: services.remoteSupervisor,
    });

    const requested = await client.pairing.request({
      peerKind: 'node',
      label: 'builder node',
      requestedId: 'peer-client-node',
      requestedBy: 'operator',
      capabilities: ['invoke'],
      commands: ['build'],
    });
    expect(requested.request.status).toBe('pending');
    expect(client.pairing.listRequests()).toHaveLength(1);

    const approved = await client.pairing.approve(requested.request.id, { actor: 'operator', note: 'approved' });
    expect(approved?.request.status).toBe('approved');

    const verified = await client.pairing.verify(requested.request.id, requested.challenge, {
      remoteAddress: '10.0.0.20',
    });
    expect(verified?.peer.status).toBe('connected');
    expect(verified?.token.value).toContain('gvrt_');

    const auth = await client.peers.authenticateToken(verified!.token.value, '10.0.0.21');
    expect(auth?.peer.id).toBe(verified!.peer.id);

    const rotated = await client.peers.rotateToken(verified!.peer.id, { actor: 'operator', label: 'replacement' });
    expect(rotated?.token.value).toContain('gvrt_');
    services.runtimeStore.setState((state) => ({
      ...state,
      acp: {
        ...state.acp,
        activeConnectionIds: [verified!.peer.id],
        connections: new Map([
          [verified!.peer.id, {
            agentId: verified!.peer.id,
            label: verified!.peer.label,
            transportState: 'connected',
            connectedAt: Date.now(),
            completing: false,
            messageCount: 2,
            errorCount: 0,
            taskId: 'peer-client-task',
          }],
        ]),
      },
    }));
    expect(client.peers.list()).toHaveLength(1);
    expect(client.peers.get(verified!.peer.id)?.status).toBe('connected');
    expect(client.getSnapshot().pairing.total).toBe(1);
    expect(client.getSnapshot().peers).toHaveLength(1);
    expect(client.getSnapshot().supervisor.sessions.some((session) => session.runnerId === verified!.peer.id)).toBe(true);
  });

  test('surfaces runner contracts, artifacts, and peer work actions', async () => {
    const services = getTestRuntimeServices();
    services.distributedRuntime.pairRequests.clear();
    services.distributedRuntime.peers.clear();
    services.distributedRuntime.work.clear();
    services.distributedRuntime.audit.length = 0;
    services.distributedRuntime.waiters.clear();
    services.distributedRuntime.loaded = true;
    services.remoteRunnerRegistry.clear();
    const client = createPeerClient({
      runtimeStore: services.runtimeStore,
      distributedRuntime: services.distributedRuntime,
      remoteRunnerRegistry: services.remoteRunnerRegistry,
      remoteSupervisor: services.remoteSupervisor,
    });

    const agent = getTestAgentManager().spawn({
      mode: 'spawn',
      task: 'peer-client artifact capture',
      template: 'engineer',
      tools: ['read', 'write'],
      dangerously_disable_wrfc: true,
    });
    agent.status = 'completed';
    agent.fullOutput = 'peer client artifact captured';
    agent.completedAt = Date.now();

    const contract = client.runners.upsertContractForAgent(agent.id);
    expect(contract?.runnerId).toBe(agent.id);

    const artifact = client.runners.captureArtifactForRunner(agent.id);
    expect(artifact?.runnerId).toBe(agent.id);
    expect(client.runners.listContracts().some((entry) => entry.runnerId === agent.id)).toBe(true);
    expect(client.runners.listArtifacts().some((entry) => entry.runnerId === agent.id)).toBe(true);
    expect(client.runners.buildReviewSummary(artifact!.id)).toContain('Remote Artifact');

    const peer = await client.pairing.request({
      peerKind: 'device',
      label: 'peer-client device',
      requestedId: 'peer-client-device',
    });
    await client.pairing.approve(peer.request.id, { actor: 'operator' });
    const verified = await client.pairing.verify(peer.request.id, peer.challenge, {
      remoteAddress: '10.0.0.30',
    });
    expect(verified).not.toBeNull();

    const queued = await client.work.enqueue({
      peerId: verified!.peer.id,
      command: 'sync-status',
      actor: 'operator',
      sessionId: 'session-peer-client',
      approvalId: 'approval-peer-client',
    });
    expect(queued.status).toBe('queued');

    const auth = await client.peers.authenticateToken(verified!.token.value);
    expect(auth).not.toBeNull();
    const claimed = await client.work.claim(auth!, { maxItems: 1, leaseMs: 15_000 });
    expect(claimed).toHaveLength(1);
    const completed = await client.work.complete(auth!, claimed[0]!.id, {
      result: { ok: true },
    });
    expect(completed?.status).toBe('completed');
    expect(client.work.list(10, verified!.peer.id).some((item) => item.status === 'completed')).toBe(true);
    expect(client.getSnapshot().work.length).toBeGreaterThan(0);
    expect(client.getSnapshot().nodeHostContract.basePath).toBe('/api/remote');
  });
});
