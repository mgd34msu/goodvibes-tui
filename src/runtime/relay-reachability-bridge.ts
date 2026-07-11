/**
 * relay-reachability-bridge.ts — reads the LIVE outbound-relay reachability
 * state off the running embedded/standalone DaemonServer.
 *
 * The SDK's `DaemonServer` composes and owns a `RelayReachability` controller
 * internally (gated by `relay.enabled` + the `relay-connect` feature flag) and
 * exposes it via `getRelayReachability(): RelayReachability | null` — but that
 * accessor is not on the narrow `DaemonService` interface `HostServicesHandle`
 * types its `daemonServer` field with (see
 * `@pellux/goodvibes-sdk/platform/runtime/bootstrap-services`), so the field
 * needs a defensive structural check before use — same pattern
 * `waitForConfigDrivenRestarts` in bootstrap.ts already uses for
 * `waitForRestart`. `platform/relay` itself has no public export subpath
 * (daemon-internal), so the RelayReachability shape is described locally as a
 * minimal structural type rather than imported by name.
 */

import type { RelayRegistrationStatus } from '@pellux/goodvibes-daemon-sdk';
import { encodeRelayPairingString, type RelayPairingPayload } from '@pellux/goodvibes-transport-core/relay';

/** Structural subset of the SDK's `RelayReachability` this bridge needs. */
interface RelayReachabilityLike {
  readonly status: RelayRegistrationStatus | 'disabled';
  mintPairing(): Promise<RelayPairingPayload | null>;
}

/** Structural subset of a live daemon that may expose relay reachability. */
interface RelayCapableDaemonService {
  getRelayReachability?(): RelayReachabilityLike | null;
}

function getRelay(daemonServer: unknown): RelayReachabilityLike | null {
  const candidate = daemonServer as RelayCapableDaemonService | null;
  if (!candidate || typeof candidate.getRelayReachability !== 'function') return null;
  return candidate.getRelayReachability() ?? null;
}

/** Two live-relay accessors, spread into `externalServices` from bootstrap.ts. */
export function buildRelayExternalServiceMethods(getDaemonServer: () => unknown): {
  relayStatus(): RelayRegistrationStatus | 'disabled';
  mintRelayPairing(): Promise<{ readonly payload: RelayPairingPayload; readonly encoded: string } | null>;
} {
  return {
    relayStatus: () => getRelay(getDaemonServer())?.status ?? 'disabled',
    mintRelayPairing: async () => {
      const relay = getRelay(getDaemonServer());
      if (!relay) return null;
      const payload = await relay.mintPairing();
      if (!payload) return null;
      return { payload, encoded: encodeRelayPairingString(payload) };
    },
  };
}
