import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDirectTransportServices } from '@pellux/goodvibes-sdk/platform/runtime/foundation-services';
import {
  createDirectClientTransport,
  createDirectTransport,
  createDirectTransportFromServices,
  createRuntimeDirectTransport,
} from '@pellux/goodvibes-sdk/platform/runtime/transports/direct';
import { createOperatorClient } from '@pellux/goodvibes-sdk/platform/runtime/operator-client';
import { createPeerClient } from '@pellux/goodvibes-sdk/platform/runtime/peer-client';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';

async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 500, intervalMs = 5): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined && value !== null) return value;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for value');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('DirectTransport', () => {
  beforeEach(() => {
    resetTestRuntimeServices();
  });

  afterEach(() => {
    resetTestRuntimeServices();
  });

  test('exposes operator and peer clients over one in-process transport', async () => {
    const runtimeServices = getTestRuntimeServices();
    runtimeServices.distributedRuntime.pairRequests.clear();
    runtimeServices.distributedRuntime.peers.clear();
    runtimeServices.distributedRuntime.work.clear();
    runtimeServices.distributedRuntime.audit.length = 0;
    runtimeServices.distributedRuntime.waiters.clear();
    runtimeServices.distributedRuntime.loaded = true;
    runtimeServices.remoteRunnerRegistry.clear();

    const transport = createRuntimeDirectTransport(runtimeServices);

    const session = await transport.operator.sessions.ensureSession({
      sessionId: 'direct-transport-session',
      title: 'Direct Transport Session',
      participant: {
        surfaceKind: 'tui',
        surfaceId: 'direct-shell',
        lastSeenAt: 123,
      },
    });

    const approvalPromise = transport.operator.approvals.request({
      request: {
        callId: 'direct-call',
        tool: 'edit',
        args: { path: 'src/direct.ts' },
        category: 'write',
        analysis: {
          classification: 'write',
          riskLevel: 'medium',
          summary: 'Direct transport approval',
          reasons: ['The transport should preserve local operator semantics.'],
          target: 'src/direct.ts',
          targetKind: 'path',
        },
      },
      sessionId: session.id,
      metadata: { origin: 'direct-transport-test' },
    });

    const approval = await waitFor(() => transport.operator.approvals.list()[0]);
    await transport.operator.approvals.approve(approval.id, 'tester', 'tui', 'approved in transport test');
    await expect(approvalPromise).resolves.toEqual({ approved: true });

    const pair = await transport.peer.pairing.request({
      peerKind: 'node',
      label: 'direct transport peer',
      requestedId: 'direct-transport-peer',
      requestedBy: 'operator',
      capabilities: ['invoke'],
      commands: ['sync'],
    });
    await transport.peer.pairing.approve(pair.request.id, { actor: 'tester', note: 'approved' });
    const verified = await transport.peer.pairing.verify(pair.request.id, pair.challenge, { remoteAddress: '10.0.0.50' });

    expect(transport.kind).toBe('direct');
    expect(transport.getOperatorClient()).toBe(transport.operator);
    expect(transport.getPeerClient()).toBe(transport.peer);

    const snapshot = await transport.snapshot();
    expect(snapshot.kind).toBe('direct');
    expect(snapshot.operator.controlPlane.sessions).toHaveLength(1);
    expect(snapshot.operator.controlPlane.approvals).toHaveLength(1);
    expect(snapshot.operator.sessions).toHaveLength(1);
    expect(snapshot.operator.currentSession).toEqual(transport.operator.sessions.current());
    expect(snapshot.operator.providers.providerIds).toEqual(transport.operator.providers.listIds());
    expect(snapshot.peer.pairing.total).toBe(1);
    expect(snapshot.peer.peers.some((peer) => peer.id === verified?.peer.id)).toBe(true);
    expect(snapshot.peer.nodeHostContract.basePath).toBe('/api/remote');
  });

  test('can be created from the narrowed foundation seam', async () => {
    const runtimeServices = getTestRuntimeServices();
    const services = createDirectTransportServices(runtimeServices);

    const transport = createDirectTransportFromServices(services);
    const legacy = createDirectTransport(runtimeServices);
    const runtimeExplicit = createRuntimeDirectTransport(runtimeServices);

    expect(transport.kind).toBe('direct');
    expect(Object.keys(transport.operator).sort()).toEqual(Object.keys(legacy.operator).sort());
    expect(Object.keys(transport.peer).sort()).toEqual(Object.keys(legacy.peer).sort());
    expect(Object.keys(runtimeExplicit.operator).sort()).toEqual(Object.keys(legacy.operator).sort());
    expect(Object.keys(runtimeExplicit.peer).sort()).toEqual(Object.keys(legacy.peer).sort());

    const session = await transport.operator.sessions.ensureSession({
      sessionId: 'direct-transport-from-services',
      title: 'Direct Transport From Services',
    });

    expect(transport.operator.sessions.get(session.id)?.title).toBe('Direct Transport From Services');
  });

  test('exposes a generic direct client adapter for SDK extraction surfaces', () => {
    const runtimeServices = getTestRuntimeServices();
    const services = createDirectTransportServices(runtimeServices);
    const operator = createOperatorClient(services.operator);
    const peer = createPeerClient(services.peer);

    const transport = createDirectClientTransport(operator, peer);

    expect(transport.kind).toBe('direct');
    expect(transport.getOperatorClient()).toBe(operator);
    expect(transport.getPeerClient()).toBe(peer);
  });
});
