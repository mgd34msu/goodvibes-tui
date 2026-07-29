/**
 * composition.ts — the smallest set of services that can put a message on a
 * channel, built from the daemon's own tier.
 *
 * ## Why not `createRuntimeServices`
 *
 * The daemon's full runtime graph starts a LAN scan, a cluster coordinator, an
 * inbox poller, a fleet tick, a memory governor and a config watch. Composing
 * it to send one message would build a second, competing set of that state on a
 * machine that is already running a daemon — the same reason `cluster …` is
 * intercepted before any runtime is constructed (see src/daemon/cli.ts). This
 * builds only the five objects `ChannelDeliveryRouter` needs and starts no
 * timers, binds no sockets and joins no election, so it is safe to run beside a
 * live daemon.
 *
 * ## Why it does not talk to the running daemon over HTTP either
 *
 * That was tried before this command existed: the control-plane API answers
 * `401 AUTH_REQUIRED` to the operator token as stored on disk. More importantly
 * an HTTP-backed send would only work while a daemon is up, and the case this
 * command is for — telling the owner that something has stopped — is exactly
 * when it may not be.
 *
 * ## Where the credentials come from
 *
 * `surfaces.*` is a daemon-owned config prefix, so `ConfigManager` overlays
 * `<home>/.goodvibes/daemon/settings.json` LAST and a bot token stored there is
 * visible here. `SecretsManager` gets the same `daemonHome` the daemon itself
 * resolves, so a `goodvibes://secrets/...` reference in one of those keys
 * resolves against the daemon's store rather than a client silo. Getting that
 * second half wrong is what produced `Missing Telegram bot token` from a
 * machine whose token was present and correct.
 */

import { ChannelDeliveryRouter } from '@pellux/goodvibes-sdk/platform/channels';
import { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts';
import { ConfigManager, ServiceRegistry, SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { createShellPathService } from '@/runtime/index.ts';
import { SecretsManager } from '../../config/secrets.ts';
import type { SendDeliver } from './command.ts';

export interface SendStackRoots {
  readonly workingDirectory: string;
  /** The GoodVibes tree root — the directory `.goodvibes/` sits under. */
  readonly homeDirectory: string;
  /** The daemon's own state root, holding the daemon-scoped secret stores. */
  readonly daemonHomeDirectory: string;
}

export interface SendStack {
  readonly configManager: ConfigManager;
  readonly deliver: SendDeliver;
}

/**
 * Build the delivery stack for one CLI send.
 *
 * `secretsManager` is passed to `ChannelDeliveryRouter` because the router
 * REQUIRES it and refuses to construct without it. That requirement is the fix
 * for a real defect: while the parameter was optional, two shipped composition
 * roots (goodvibes-tui and goodvibes-agent) omitted it, still type-checked,
 * still delivered on every surface whose credential happens to sit in config or
 * the environment, and failed only on the surfaces that use a secret reference
 * — at send time, as `Missing Telegram bot token`. This composition root does
 * not repeat that.
 */
export function createSendStack(roots: SendStackRoots): SendStack {
  const configManager = new ConfigManager({
    workingDir: roots.workingDirectory,
    homeDir: roots.homeDirectory,
    surfaceRoot: 'tui',
  });
  const shellPaths = createShellPathService({
    workingDirectory: roots.workingDirectory,
    homeDirectory: roots.homeDirectory,
  });
  const secretsManager = new SecretsManager({
    projectRoot: roots.workingDirectory,
    globalHome: roots.homeDirectory,
    // Threaded, never defaulted: a daemon told to run out of an isolated tree
    // must not read the real home's credential store, and neither must this.
    daemonHome: roots.daemonHomeDirectory,
    configManager,
  });
  const serviceRegistry = new ServiceRegistry(shellPaths.resolveProjectPath('tui', 'services.json'), {
    secretsManager,
    subscriptionManager: new SubscriptionManager(shellPaths.resolveUserPath('tui', 'subscriptions.json')),
  });
  const router = new ChannelDeliveryRouter({
    configManager,
    secretsManager,
    serviceRegistry,
    artifactStore: new ArtifactStore({ configManager }),
  });
  return {
    configManager,
    deliver: (request) => router.deliver(request),
  };
}
