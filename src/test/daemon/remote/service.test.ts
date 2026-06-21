import { describe, expect, it } from 'bun:test';
import { HostDistributedRuntime } from '../../../daemon/handlers/remote/service.ts';
import type { RemoteDispatcher, DispatchRequest } from '../../../daemon/handlers/remote/dispatcher.ts';

interface Call {
  method: string;
  args: unknown[];
}

/** A structural stand-in for DistributedRuntimeManager that records every call. */
function makeFakeManager(): { calls: Call[]; manager: ConstructorParameters<typeof HostDistributedRuntime>[0] } {
  const calls: Call[] = [];
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return { method, args } as unknown;
  };
  const fake = {
    listPairRequests: record('listPairRequests'),
    requestPairing: record('requestPairing'),
    approvePairRequest: record('approvePairRequest'),
    rejectPairRequest: record('rejectPairRequest'),
    verifyPairRequest: record('verifyPairRequest'),
    listPeers: record('listPeers'),
    rotatePeerToken: record('rotatePeerToken'),
    revokePeerToken: record('revokePeerToken'),
    disconnectPeer: record('disconnectPeer'),
    getNodeHostContract: record('getNodeHostContract'),
    heartbeatPeer: record('heartbeatPeer'),
    claimWork: record('claimWork'),
    completeWork: record('completeWork'),
    listWork: record('listWork'),
    cancelWork: record('cancelWork'),
  };
  return { calls, manager: fake as unknown as ConstructorParameters<typeof HostDistributedRuntime>[0] };
}

function makeFakeDispatcher(): { requests: DispatchRequest[]; dispatcher: RemoteDispatcher } {
  const requests: DispatchRequest[] = [];
  const fake = {
    dispatch: async (request: DispatchRequest) => {
      requests.push(request);
      return { peerId: request.peerId, backendKind: 'ssh', completed: true, stdout: '', stderr: '', stdoutDigest: '0' };
    },
  };
  return { requests, dispatcher: fake as unknown as RemoteDispatcher };
}

describe('HostDistributedRuntime', () => {
  it('delegates the 16 peer/pairing/work methods to the manager', async () => {
    const { calls, manager } = makeFakeManager();
    const { dispatcher } = makeFakeDispatcher();
    const service = new HostDistributedRuntime(manager, dispatcher);

    service.listPairRequests();
    service.listPeers();
    service.listWork();
    service.getNodeHostContract();
    await service.requestPairing({ label: 'x' });
    await service.approvePairRequest('req-1', { actor: 'admin' });
    await service.rejectPairRequest('req-1', {});
    await service.verifyPairRequest('req-1', 'challenge-token', {});
    await service.rotatePeerToken('peer-1', {});
    await service.revokePeerToken('peer-1', {});
    await service.disconnectPeer('peer-1', {});
    await service.heartbeatPeer({ peerId: 'peer-1' }, {});
    await service.claimWork({ peerId: 'peer-1' }, {});
    await service.completeWork({ peerId: 'peer-1' }, 'work-1', {});
    await service.cancelWork('work-1', {});

    const methods = calls.map((c) => c.method);
    expect(methods).toEqual([
      'listPairRequests', 'listPeers', 'listWork', 'getNodeHostContract',
      'requestPairing', 'approvePairRequest', 'rejectPairRequest', 'verifyPairRequest',
      'rotatePeerToken', 'revokePeerToken', 'disconnectPeer',
      'heartbeatPeer', 'claimWork', 'completeWork', 'cancelWork',
    ]);
  });

  it('forwards positional ids and challenge to the manager', async () => {
    const { calls, manager } = makeFakeManager();
    const { dispatcher } = makeFakeDispatcher();
    const service = new HostDistributedRuntime(manager, dispatcher);
    await service.verifyPairRequest('req-9', 'the-challenge', { remoteAddress: '10.0.0.2' });
    const call = calls.find((c) => c.method === 'verifyPairRequest');
    expect(call?.args[0]).toBe('req-9');
    expect(call?.args[1]).toBe('the-challenge');
  });

  it('routes invokePeer to the dispatcher, extracting peerId/command/payload/principal/async', async () => {
    const { manager } = makeFakeManager();
    const { requests, dispatcher } = makeFakeDispatcher();
    const service = new HostDistributedRuntime(manager, dispatcher);

    await service.invokePeer({
      peerId: 'peer-1',
      command: 'uptime',
      payload: { args: ['-p'] },
      actor: 'operator-jane',
      async: true,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      peerId: 'peer-1',
      command: 'uptime',
      principalId: 'operator-jane',
      async: true,
      payload: { args: ['-p'] },
    });
  });

  it('defaults principalId to "remote" and async to false when absent', async () => {
    const { manager } = makeFakeManager();
    const { requests, dispatcher } = makeFakeDispatcher();
    const service = new HostDistributedRuntime(manager, dispatcher);
    await service.invokePeer({ peerId: 'p', command: 'ls' });
    expect(requests[0]).toMatchObject({ principalId: 'remote', async: false });
    expect(requests[0]?.payload).toBeUndefined();
  });
});
