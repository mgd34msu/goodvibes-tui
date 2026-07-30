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
import type { ClusterCoordinator, ClusterGroupVerbSurface } from '@pellux/goodvibes-sdk/platform/cluster';
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
  clusterGroupVerbs: ClusterGroupVerbSurface,
  daemonStateDirectory: string,
): ExternalServiceFactories {
  return {
    sharedDaemonToken,
    // `--daemon-home` names the daemon's own STATE directory — the one holding
    // operator-tokens.json, auth-users.json and daemon-settings.json — which is
    // `<home>/.goodvibes/daemon`, not the user home above it. Every reader in
    // this repository resolves it that way (config/goodvibes-home.ts,
    // cli/service-posture.ts, runtime/bootstrap.ts), but the published SDK's
    // detached-daemon spawn puts the USER HOME behind that flag as the FIRST
    // argument, so a daemon this surface spawns filed its identity a level
    // above where the client that spawned it then looked for the token.
    //
    // Appending the flag again is what closes it without waiting for the SDK:
    // cli/parser.ts is last-wins for --daemon-home, and daemon/cli.ts applies
    // the parsed flag over GOODVIBES_DAEMON_HOME before resolving either root.
    // The SDK's own fix (sdk commit d1336a2b) puts the state directory behind
    // the first flag too; delete this line at the next re-pin, when the
    // duplicate becomes redundant rather than load-bearing.
    daemonLaunchArgs: ['--daemon-home', daemonStateDirectory],
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
        // The `cluster` verbs (/api/cluster/*), so the CLI and the TUI command
        // reach one implementation whether the daemon is embedded or standalone.
        clusterGroupVerbs,
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
