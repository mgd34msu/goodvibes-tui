/**
 * embedded-service-factories.ts — the factories startExternalServices uses to
 * construct the interactive session's embedded DaemonServer + HttpListener
 * (extracted from bootstrap.ts for file-size hygiene).
 *
 * The embedded DaemonServer suppresses the facade's internal auto-updater:
 * that loop compares the sdk package's version — not this binary's — against
 * this repo's releases, so inside the interactive session it would find an
 * "update" hourly and exit the user's process on "restart". Clients update at
 * launch (cli/launch-auto-update.ts); the embedded daemon runs no update loop
 * at all. See daemon/lifecycle.ts.
 */
import { DaemonServer, HttpListener } from '@pellux/goodvibes-sdk/platform/daemon';
import type { ClusterCoordinator } from '@pellux/goodvibes-sdk/platform/cluster';
import { createSafeHostServeFactory } from '../daemon/safe-serve.ts';
import type { startExternalServices } from '@/runtime/index.ts';

export type ExternalServiceFactories = NonNullable<Parameters<typeof startExternalServices>[4]>;

/**
 * `clusterCoordinator` is threaded through explicitly rather than read off the
 * runtimeServices the SDK hands the factory: that object is typed by the SDK,
 * which has no field for a coordinator this product composed. Passing it here
 * keeps the ONE-coordinator-per-process rule enforceable by the type checker.
 */
export function createEmbeddedServiceFactories(
  sharedDaemonToken: string,
  clusterCoordinator: ClusterCoordinator,
): ExternalServiceFactories {
  return {
    sharedDaemonToken,
    createDaemonServer: (bus, userAuth, runtimeServices) => {
      // No updateArtifact: the embedded daemon keeps updates host-managed (the
      // TUI client updates itself), so the facade runs no self-update loop.
      const daemonServer = new DaemonServer({
        runtimeBus: bus,
        userAuth,
        runtimeServices,
        serveFactory: createSafeHostServeFactory('Embedded daemon'),
        // The SAME coordinator the inbox poller registered with. Letting the
        // facade compose its own would put two election nodes in one process,
        // and whichever lost would silence consumers the other owns.
        clusterCoordinator,
      });
      return daemonServer;
    },
    createHttpListener: (dispatcher, userAuth, configManager) => new HttpListener({
      hookDispatcher: dispatcher,
      userAuth,
      configManager,
      serveFactory: createSafeHostServeFactory('Embedded HTTP listener'),
    }),
  };
}
