/**
 * disposal-wiring.ts
 *
 * Teardown for every poller this surface's runtime graph starts.
 *
 * The mechanics — the ordered, best-effort, idempotent scope and the
 * all-required owner list — live in the SDK (`platform/runtime/disposal`), so
 * this surface and the SDK's own composition root cannot drift into two
 * different ideas of what "stop the graph" means. What lives here is only the
 * mapping from this fork's assembled graph onto that list.
 *
 * It is a separate module because `runtime/services.ts` sits against the repo's
 * 800-line source cap (check-architecture.ts) with no room for the wiring.
 *
 * Ownership note, and the reason any of this exists: this surface builds the
 * graph and hands the SAME object to `DaemonServer`. The SDK facade disposes
 * only a graph it constructed itself, so it deliberately leaves this one alone
 * — nothing upstream will ever stop these pollers. The shutdown paths in
 * daemon/cli.ts, main.ts's teardown registry and the one-shot CLI commands are
 * the only things that can.
 *
 * The owner type below is declared structurally rather than imported from
 * services.ts: that module imports this one, and a type-only edge is still a
 * cycle to the architecture check.
 */

import {
  createDisposalScope,
  registerRuntimePollers,
  type DisposalRegistry,
  type RuntimePollerOwners,
} from '@pellux/goodvibes-sdk/platform/runtime/disposal';

/** Re-exported so the composition root reaches the whole seam through one import. */
export { createDisposalScope };

/** The assembled graph, narrowed to the poller owners it exposes as fields. */
export interface SurfaceRuntimePollerOwners extends Omit<RuntimePollerOwners, 'stopConfigWatch'> {
  /** Fork-only: the repeating crash-residue sweep (durability-services.ts). */
  readonly stopDurabilityHousekeeping: () => void;
  /**
   * Fork-only: the wake-word recovery sweep and a pending boot provision
   * (voice-setup-services.ts). Started only when an entrypoint opted into boot
   * provisioning, and a no-op otherwise — but it is on this list unconditionally,
   * because "the graph did not start it this time" is not a reason for the
   * teardown path to have no way to stop it.
   */
  readonly stopWakeHousekeeping: () => void;
  /**
   * Fork-only: the daemon handler surfaces (daemon-handler-composition.ts).
   *
   * `unregister()` detaches the gateway handlers AND stops the two pollers this
   * product's inbox surface owns — the retention sweep inside `InboxCursorStore`
   * and the per-provider `InboundPoller` intervals. The SDK does not know either
   * exists, so if this surface does not stop them nothing does.
   */
  readonly daemonHandlers: { readonly unregister: () => void };
}

/**
 * The poller owners this fork holds that are NOT reachable from the assembled
 * graph — handles the factory keeps as locals.
 */
export interface RuntimeDisposalExtras {
  /** Handle returned by `ConfigManager.watchConfigFiles()` (durability-services.ts). */
  readonly stopConfigWatch: () => void;
}

/**
 * Register the stop call for every poller the graph started.
 *
 * `services` is the fully-assembled graph, which already exposes each poller
 * owner as a field — so a poller whose owner reaches the public surface is
 * wired by name rather than by threading another local out of the factory.
 */
export function registerSurfaceRuntimePollers(
  registry: DisposalRegistry,
  services: SurfaceRuntimePollerOwners,
  extras: RuntimeDisposalExtras,
): void {
  registerRuntimePollers(registry, { ...services, stopConfigWatch: extras.stopConfigWatch });
  registry.add('durability housekeeping', services.stopDurabilityHousekeeping);
  registry.add('wake-word housekeeping', services.stopWakeHousekeeping);
  // Registered LAST so it tears down FIRST (the scope unwinds in reverse), which
  // is the order daemon/cli.ts already used by hand: release the handler surfaces
  // — closing the inbox store and stopping its poll timers — before the pollers
  // the rest of the graph owns. Being on this list is what makes a plain
  // `dispose()` total: every shutdown path (daemon/cli.ts, main.ts's teardown
  // registry, the one-shot CLI commands) now stops these two, not just the one
  // that remembered to call `unregister()` itself.
  registry.add('daemon handler surfaces', () => services.daemonHandlers.unregister());
}
