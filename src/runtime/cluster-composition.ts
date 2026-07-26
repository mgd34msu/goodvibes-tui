/**
 * cluster-composition.ts — this daemon's seat in the LAN leader election.
 *
 * When the same goodvibes install runs more than once on one network — a
 * laptop and a desktop, or two processes on one machine — every copy
 * independently reads the shared inbox, so one message is picked up twice and
 * answered twice. The SDK's cluster coordinator elects exactly one node to be
 * responsible for inbound consumption; everything else stays warm and silent.
 *
 * This file exists because the goodvibes-tui daemon does NOT get that for free
 * from the SDK facade. The facade gates the consumers IT owns (Telegram
 * ingress, the ntfy/Slack/Discord provider runtime), but this repository
 * composes an inbound consumer of its own — the Slack/Discord/email inbox
 * poller in daemon/handlers/inbox — and the facade knows nothing about it.
 * A fix that only landed in the facade would leave the poller double-reading
 * on exactly the machine this product runs on.
 *
 * So this composition builds the ONE coordinator for the process, registers
 * the inbox poller with it, and hands the same instance to the DaemonServer
 * (via `DaemonConfig.clusterCoordinator`) so the SDK's consumers ride the same
 * leadership rather than holding a second, competing election.
 *
 * What leadership does NOT gate, here or anywhere: outbound delivery,
 * sessions, the control plane, the HTTP listener, the UI. A standby node is a
 * complete goodvibes daemon that simply is not the one reading the inbox.
 */
import {
  ClusterCoordinator,
  readClusterSettings,
  type ClusterConsumerGate,
} from '@pellux/goodvibes-sdk/platform/cluster';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ShellPathService } from '@/runtime/index.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import { VERSION } from '../version.ts';

/** What an inbound poller must expose to be placed under leadership. */
export interface GatedPollerControl {
  /** Begin polling. Must not resolve until polling has actually begun. */
  start(): Promise<void>;
  /** Stop polling. Must not resolve until no further poll can run. */
  stop(): Promise<void>;
}

/**
 * Build the process's single coordinator.
 *
 * Constructing it is inert: no socket is opened and no state is written until
 * `start()` runs, so composing a runtime in a test never joins a network.
 *
 * The version is THIS BINARY's version, not the SDK package's — the same
 * distinction daemon/cli.ts already makes for the self-update artifact. It is
 * the first ranking tier, so getting it wrong would let a stale build hold the
 * role through an update.
 */
export function createClusterComposition(options: {
  readonly configManager: ConfigManager;
  readonly shellPaths: ShellPathService;
}): ClusterCoordinator {
  return new ClusterCoordinator({
    settings: readClusterSettings(options.configManager),
    version: VERSION,
    // Surface-scoped, alongside this surface's other durable state: the node
    // identity is per-surface and must not leak across surface roots.
    stateDirectory: options.shellPaths.resolveProjectPath(GOODVIBES_TUI_SURFACE_ROOT, 'cluster'),
    logger,
  });
}

/**
 * The inbox poller as a leadership gate.
 *
 * No replay cursor is threaded in, and that is deliberate rather than an
 * omission: the inbox keeps a persisted per-provider cursor of its own
 * (InboxCursorStore), so a node taking the role over resumes from where the
 * previous one committed. ntfy needs an explicit `since=` because it has no
 * server-side per-subscriber cursor; this poller does not.
 */
export function inboxPollerGate(control: GatedPollerControl): ClusterConsumerGate {
  return {
    id: 'inbox-poller',
    start: async () => {
      await control.start();
    },
    stop: async () => {
      await control.stop();
    },
  };
}
