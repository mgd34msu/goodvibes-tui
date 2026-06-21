/**
 * Host implementation of the daemon-sdk `DistributedRuntimeRouteService` (17
 * methods). The SDK ships NO docker/ssh/cloud backend, so the host owns it:
 *
 *  - `invokePeer` executes against the host's own remote backends through the
 *    `RemoteDispatcher` (docker / ssh / cloud-terminal / local-process). This is
 *    the only method that performs real command execution.
 *  - The 16 peer / pairing / work-queue methods are backed by the SDK's
 *    `DistributedRuntimeManager` (constructed by the surface), which owns peer
 *    records, pairing challenges, token rotation, and the work queue.
 *
 * The SDK injects this instance into `DaemonRemoteRouteContext.distributedRuntime`
 * so the published `remote.peers.*` HTTP routes dispatch to it. No catalog
 * descriptor or schema is authored here.
 */
import { operations } from '@pellux/goodvibes-sdk/platform/runtime';
import type {
  DistributedRuntimeRouteService,
  RemotePeerAuth,
} from '../contracts.ts';
import { RemoteDispatcher } from './dispatcher.ts';
import type { DispatchPayload } from './backends/index.ts';

type DistributedRuntimeManager = operations.DistributedRuntimeManager;
type DistributedPeerAuth = operations.DistributedPeerAuth;

/** Coerce an injected `RemotePeerAuth` (typed `unknown` by the SDK) to the manager's auth shape. */
function asPeerAuth(auth: RemotePeerAuth): DistributedPeerAuth {
  return auth as DistributedPeerAuth;
}

/** Narrow an arbitrary route-supplied input bag to a typed manager input. */
function asInput<T>(input: Record<string, unknown>): T {
  return input as unknown as T;
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readPrincipal(input: Record<string, unknown>): string {
  const actor = input.actor ?? input.principalId ?? input.queuedBy;
  return typeof actor === 'string' && actor.length > 0 ? actor : 'remote';
}

function readPayload(input: Record<string, unknown>): DispatchPayload | undefined {
  const payload = input.payload;
  if (payload && typeof payload === 'object') {
    return payload as DispatchPayload;
  }
  return undefined;
}

export class HostDistributedRuntime implements DistributedRuntimeRouteService {
  private readonly manager: DistributedRuntimeManager;
  private readonly dispatcher: RemoteDispatcher;

  constructor(manager: DistributedRuntimeManager, dispatcher: RemoteDispatcher) {
    this.manager = manager;
    this.dispatcher = dispatcher;
  }

  // --- Pairing -------------------------------------------------------------

  listPairRequests(): unknown {
    return this.manager.listPairRequests();
  }

  requestPairing(input: Record<string, unknown>): Promise<unknown> {
    return this.manager.requestPairing(
      asInput<Parameters<DistributedRuntimeManager['requestPairing']>[0]>(input),
    );
  }

  approvePairRequest(requestId: string, input: Record<string, unknown>): Promise<unknown | null> {
    return this.manager.approvePairRequest(
      requestId,
      asInput<Parameters<DistributedRuntimeManager['approvePairRequest']>[1]>(input),
    );
  }

  rejectPairRequest(requestId: string, input: Record<string, unknown>): Promise<unknown | null> {
    return this.manager.rejectPairRequest(
      requestId,
      asInput<Parameters<DistributedRuntimeManager['rejectPairRequest']>[1]>(input),
    );
  }

  verifyPairRequest(
    requestId: string,
    challenge: string,
    input: Record<string, unknown>,
  ): Promise<unknown | null> {
    return this.manager.verifyPairRequest(
      requestId,
      challenge,
      asInput<Parameters<DistributedRuntimeManager['verifyPairRequest']>[2]>(input),
    );
  }

  // --- Peer management -----------------------------------------------------

  listPeers(): unknown {
    return this.manager.listPeers();
  }

  rotatePeerToken(peerId: string, input: Record<string, unknown>): Promise<unknown | null> {
    return this.manager.rotatePeerToken(
      peerId,
      asInput<Parameters<DistributedRuntimeManager['rotatePeerToken']>[1]>(input),
    );
  }

  revokePeerToken(peerId: string, input: Record<string, unknown>): Promise<unknown | null> {
    return this.manager.revokePeerToken(
      peerId,
      asInput<Parameters<DistributedRuntimeManager['revokePeerToken']>[1]>(input),
    );
  }

  disconnectPeer(peerId: string, input: Record<string, unknown>): Promise<unknown | null> {
    return this.manager.disconnectPeer(
      peerId,
      asInput<Parameters<DistributedRuntimeManager['disconnectPeer']>[1]>(input),
    );
  }

  getNodeHostContract(): unknown {
    return this.manager.getNodeHostContract();
  }

  // --- Peer-authenticated heartbeat + work claim ---------------------------

  heartbeatPeer(auth: RemotePeerAuth, input: Record<string, unknown>): Promise<unknown> {
    return this.manager.heartbeatPeer(
      asPeerAuth(auth),
      asInput<Parameters<DistributedRuntimeManager['heartbeatPeer']>[1]>(input),
    );
  }

  claimWork(auth: RemotePeerAuth, input: Record<string, unknown>): Promise<unknown> {
    return this.manager.claimWork(
      asPeerAuth(auth),
      asInput<Parameters<DistributedRuntimeManager['claimWork']>[1]>(input),
    );
  }

  completeWork(
    auth: RemotePeerAuth,
    workId: string,
    input: Record<string, unknown>,
  ): Promise<unknown | null> {
    return this.manager.completeWork(
      asPeerAuth(auth),
      workId,
      asInput<Parameters<DistributedRuntimeManager['completeWork']>[2]>(input),
    );
  }

  // --- Work queue ----------------------------------------------------------

  listWork(): unknown {
    return this.manager.listWork();
  }

  cancelWork(workId: string, input: Record<string, unknown>): Promise<unknown | null> {
    return this.manager.cancelWork(
      workId,
      asInput<Parameters<DistributedRuntimeManager['cancelWork']>[1]>(input),
    );
  }

  // --- Command execution (host-owned backends) -----------------------------

  /**
   * Execute a command on a registered peer through the host backends. Unlike the
   * manager's enqueue-only `invokePeer`, this performs real docker/ssh/cloud/
   * local-process execution and returns a receipt with a full-stdout digest.
   */
  async invokePeer(input: Record<string, unknown>): Promise<unknown> {
    const payload = readPayload(input);
    return this.dispatcher.dispatch({
      peerId: readString(input, 'peerId'),
      command: readString(input, 'command'),
      principalId: readPrincipal(input),
      async: input.async === true,
      ...(payload !== undefined ? { payload } : {}),
    });
  }
}
