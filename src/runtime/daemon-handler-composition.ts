/**
 * daemon-handler-composition.ts — the daemon's HOST-side handler surfaces.
 *
 * Attaches this repository's handlers to the SDK-auto-registered builtin
 * gateway descriptors (channels.* / email.* / calendar.*) via
 * catalog.register(descriptor, handler, { replace: true }) — the SDK owns
 * every id, descriptor and schema; only the behaviour is ours. The remote
 * surface reuses the SAME DistributedRuntimeManager the SDK facade injects.
 *
 * Split out of services.ts for the 800-line file cap, the same reason
 * channel-composition.ts exists.
 *
 * The one behavioural decision that lives here: the inbox poller is handed to
 * the cluster coordinator instead of being started eagerly. It is this
 * product's own inbound consumer — the SDK facade does not know it exists —
 * so if it is not gated here it is not gated anywhere, and two goodvibes nodes
 * on one network each read the shared inbox and answer the same message twice.
 */
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ClusterCoordinator } from '@pellux/goodvibes-sdk/platform/cluster';
import type { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { SecretsManager } from '@pellux/goodvibes-sdk/platform/config';
import { registerDaemonHandlers, type DaemonHandlerSurfaces } from '../daemon/handlers/index.ts';
import type { HandlerContext, HandlerLogger } from '../daemon/handlers/context.ts';
import { createDaemonCredentialStore } from '../daemon/handlers/credentials.ts';
import { registerRouting } from '../daemon/handlers/routing/index.ts';
import { registerInboxMethods } from '../daemon/handlers/inbox/index.ts';
import { registerTriagedInbox } from '../daemon/handlers/triage/index.ts';
import { registerDraftMethods } from '../daemon/handlers/drafts/index.ts';
import { registerCalendar } from '../daemon/handlers/calendar/index.ts';
import { registerEmailMethods } from '../daemon/handlers/email/index.ts';
import { registerRemoteSurface } from '../daemon/handlers/remote/index.ts';
import { inboxPollerGate } from './cluster-composition.ts';

export interface DaemonHandlerCompositionOptions {
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly secretsManager: SecretsManager;
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly distributedRuntime: NonNullable<Parameters<typeof registerRemoteSurface>[1]>['manager'];
  /**
   * Decides whether THIS node polls the shared inbox. Always supplied by the
   * composition root; the poller is never started outside it.
   */
  readonly clusterCoordinator: ClusterCoordinator;
}

export function createDaemonHandlerComposition(
  options: DaemonHandlerCompositionOptions,
): DaemonHandlerSurfaces {
  const handlerLogger: HandlerLogger = {
    info: (message, meta) => console.info(message, meta ?? ''),
    warn: (message, meta) => console.warn(message, meta ?? ''),
    error: (message, meta) => console.error(message, meta ?? ''),
  };
  const handlerContext: HandlerContext = {
    catalog: options.gatewayMethods,
    credentials: createDaemonCredentialStore(options.secretsManager),
    configManager: options.configManager,
    workingDirectory: options.workingDirectory,
    homeDirectory: options.homeDirectory,
    logger: handlerLogger,
  };
  return registerDaemonHandlers(handlerContext, {
    registerRouting,
    registerInbox: (ctx, routing) =>
      registerTriagedInbox(ctx, (inboxCtx) => registerInboxMethods(inboxCtx, routing, {
        // Hands polling to leadership. The `channels.inbox.list` read stays
        // available on every node — a standby still SERVES the persisted feed,
        // it just does not FETCH into it.
        gatePolling: (control) => options.clusterCoordinator.register(inboxPollerGate(control)),
      })).unregister,
    registerDrafts: (ctx) => registerDraftMethods(ctx),
    registerCalendar,
    registerEmail: (ctx) => registerEmailMethods(ctx),
    registerRemote: (ctx) => registerRemoteSurface(ctx, { manager: options.distributedRuntime }),
  });
}
