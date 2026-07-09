/**
 * gateway-verbs.ts — attach handlers for every ws-only gateway verb group.
 *
 * The GatewayMethodCatalog's builtin DESCRIPTORS make fleet.* (including the
 * archive verbs), checkpoints.*, sessions.search, and push.* appear in the
 * contract, but a descriptor without an attached handler answers
 * 501 "Gateway method is not invokable" over both websocket and HTTP invoke.
 * createRuntimeServices never called the SDK's registration entry point, so
 * every daemon build this package ever vendored shipped exactly that 501 for
 * the whole ws-only family (found by the companion app against the 1.13.0
 * daemon). This module is the named home for the attachment — mirroring the
 * SDK runtime's own composition root (goodvibes-sdk
 * platform/runtime/services.ts) — and
 * src/test/daemon/gateway-ws-only-invokable.test.ts gates that every ws-only
 * verb stays descriptor-present AND handler-attached, with live invokes of
 * fleet.snapshot / fleet.archived.list.
 */
import {
  registerGatewayVerbGroups,
  type GatewayMethodCatalog,
  type GatewayVerbGroupDeps,
} from '@pellux/goodvibes-sdk/platform/control-plane';
import {
  createProcessRegistry,
  withFleetArchive,
  type ArchivableProcessRegistry,
  type ProcessRegistryDeps,
} from '@pellux/goodvibes-sdk/platform/runtime/fleet';

export function attachWsOnlyGatewayVerbHandlers(
  gatewayMethods: GatewayMethodCatalog,
  deps: GatewayVerbGroupDeps,
): void {
  registerGatewayVerbGroups(gatewayMethods, deps);
}

/**
 * One shared process registry aggregating the runtime's managers — the Fleet
 * panel (panels/fleet-read-model.ts) is its first consumer. Constructed once
 * (not per-consumer) so the coalesced tick and the agent-activity side-table
 * are shared, not duplicated. Archive-aware: finished agent/swarm subtrees
 * can be moved out of the live fleet view into a session-scoped archive (see
 * the SDK's fleet/archive.ts).
 */
export function createArchivableFleetRegistry(deps: ProcessRegistryDeps): ArchivableProcessRegistry {
  return withFleetArchive(createProcessRegistry(deps));
}
