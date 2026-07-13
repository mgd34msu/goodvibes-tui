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
import { createSafeHostServeFactory } from '../daemon/safe-serve.ts';
import { suppressVersionBlindFacadeAutoUpdater } from '../daemon/lifecycle.ts';
import type { startExternalServices } from '@/runtime/index.ts';

export type ExternalServiceFactories = NonNullable<Parameters<typeof startExternalServices>[4]>;

export function createEmbeddedServiceFactories(sharedDaemonToken: string): ExternalServiceFactories {
  return {
    sharedDaemonToken,
    createDaemonServer: (bus, userAuth, runtimeServices) => {
      const daemonServer = new DaemonServer({
        runtimeBus: bus,
        userAuth,
        runtimeServices,
        serveFactory: createSafeHostServeFactory('Embedded daemon'),
      });
      suppressVersionBlindFacadeAutoUpdater(daemonServer);
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
