/**
 * Remote handler surface — the host backend for `remote.peers.*`.
 *
 * `remote.peers.invoke` is NOT a catalog method: the SDK publishes it as an HTTP
 * route and injects a `DistributedRuntimeRouteService` (the host's
 * `HostDistributedRuntime`) into `DaemonRemoteRouteContext.distributedRuntime`.
 * This module wires that service together:
 *
 *   - a `PeerRegistry` (peer-registry.sqlite; credential fields are
 *     goodvibes://secrets/ refs, embedded secrets rejected),
 *   - a `RemoteDispatcher` routing by backendKind to the docker/ssh/
 *     cloud-terminal/local-process backends,
 *   - the SDK `DistributedRuntimeManager` (store: tui/remote/distributed-runtime.json)
 *     backing the 16 peer/pairing/work methods,
 *   - the `HostDistributedRuntime` service implementing the 17-method contract.
 *
 * The returned registration is plugged into the foundation
 * `DaemonHandlerSurfaceProviders.registerRemote` and surfaced on
 * `DaemonHandlerSurfaces.remoteSurface` + `.remoteDispatch`. Stores init lazily
 * (peer registry init is backgrounded) so wiring stays synchronous.
 */
import { join } from 'node:path';
import { operations } from '@pellux/goodvibes-sdk/platform/runtime';
import type { HandlerContext } from '../context.ts';
import type {
  RemoteSurfaceRegistration,
  RemoteInvokeAdapter,
} from '../index.ts';
import { PeerRegistry } from './peer-registry.ts';
import { RemoteDispatcher, type RemoteWorkEnqueuer } from './dispatcher.ts';
import { HostDistributedRuntime } from './service.ts';

type DistributedRuntimeManager = operations.DistributedRuntimeManager;

const DISTRIBUTED_RUNTIME_STORE = join('tui', 'remote', 'distributed-runtime.json');

export interface RegisterRemoteSurfaceOptions {
  /**
   * Inject the distributed runtime manager (integration may construct it in
   * services.ts so other runtime bridges can attach to the same instance). When
   * omitted, the surface builds its own manager rooted under the project's
   * .goodvibes directory.
   */
  readonly manager?: DistributedRuntimeManager;
}

/**
 * Build the remote surface. Returns the teardown, the host
 * `DistributedRuntimeRouteService` the SDK facade injects, and the
 * `remote.peers.invoke` dispatch adapter.
 */
export function registerRemoteSurface(
  ctx: HandlerContext,
  options?: RegisterRemoteSurfaceOptions,
): RemoteSurfaceRegistration {
  const registry = new PeerRegistry(ctx.workingDirectory);

  const manager =
    options?.manager
    ?? new operations.DistributedRuntimeManager(
      join(ctx.workingDirectory, '.goodvibes', DISTRIBUTED_RUNTIME_STORE),
    );

  // Adapt the SDK manager's work queue to the dispatcher's enqueue hook so a
  // production `remote.peers.invoke {async:true}` creates a work item visible
  // in remote.work.list and returns its id (instead of running synchronously).
  const workEnqueuer: RemoteWorkEnqueuer = {
    enqueue: async (item) => {
      // item.backendKind is intentionally NOT forwarded: the SDK enqueueWork
      // contract has no backendKind parameter, and the work runner re-resolves
      // the backend from the live peer record at claim time (so a peer that is
      // re-registered onto a different backend before the work runs is honored).
      const work = await manager.enqueueWork({
        peerId: item.peerId,
        command: item.command,
        actor: item.queuedBy,
        ...(item.payload !== undefined ? { payload: item.payload } : {}),
      });
      return { workId: work.id };
    },
  };

  const dispatcher = new RemoteDispatcher({
    registry,
    credentials: ctx.credentials,
    logger: ctx.logger,
    homeDirectory: ctx.homeDirectory,
    workEnqueuer,
  });

  const service = new HostDistributedRuntime(manager, dispatcher);

  // Initialize persistent state lazily in the background so surface
  // construction stays synchronous and never blocks daemon bootstrap.
  void registry.init().catch((error) => {
    ctx.logger.error('remote peer registry init failed', { error });
  });
  if (!options?.manager) {
    void manager.start().catch((error) => {
      ctx.logger.error('distributed runtime manager start failed', { error });
    });
  }

  const dispatch: RemoteInvokeAdapter = {
    invoke: (input: Record<string, unknown>) => service.invokePeer(input),
  };

  const unregister = (): void => {
    registry.close();
    // Best-effort, fire-and-forget sweep of ephemeral key/credential material
    // (ssh-keys/, cloud-creds/) so no secret-bearing file outlives the surface.
    // Kept off the synchronous teardown path; failures are swallowed inside.
    void dispatcher.teardown().catch((error) => {
      ctx.logger.error('remote backend teardown failed', { error });
    });
  };

  return { unregister, service, dispatch };
}
