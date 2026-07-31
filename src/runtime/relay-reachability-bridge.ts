/**
 * relay-reachability-bridge.ts — what this terminal can honestly say about the
 * outbound relay's live state.
 *
 * The relay is a DAEMON capability. The reachability controller is composed
 * inside the SDK's `DaemonServer` (platform/daemon/facade.ts,
 * `getRelayReachability()`), gated on `relay.enabled` plus the `relay-connect`
 * feature flag, and the process holding that controller is the one that
 * registers with the relay and can mint a pairing payload for it.
 *
 * This terminal is a client. It never constructs a `DaemonServer`, so it holds
 * no controller of its own, and it has no handle to the adopted daemon's — the
 * control plane exposes no verb for one. The operator contract's `relay`
 * category carries the two step-up ceremony verbs (`stepup.challenge.mint`,
 * `stepup.credential.register`) and nothing that reports registration state or
 * mints a pairing payload, so there is no wire call to make.
 *
 * Hence `'unavailable'`, and deliberately NOT `'disabled'`. `'disabled'` is a
 * real relay state meaning the owner turned it off; reporting it for a relay
 * this terminal cannot see would tell an operator whose daemon IS registered
 * that their relay is off. What is true is narrower and worth saying plainly:
 * the state exists, it lives in the daemon, and this surface cannot read it.
 *
 * The accessors keep their shape rather than collapsing into the call sites,
 * because the shape is what a relay-state verb would fill in: the day the
 * daemon serves one, the call is made here and `/relay` renders a live state
 * with nothing else changing.
 */

import type { RelayRegistrationStatus } from '@pellux/goodvibes-daemon-sdk';
import type { RelayPairingPayload } from '@pellux/goodvibes-transport-core/relay';

/**
 * What `/relay` can be told: the daemon-side registration states, plus
 * `'disabled'` for a relay that is off, plus `'unavailable'` for one whose
 * state is real but not readable from here.
 */
export type RelayReadableStatus = RelayRegistrationStatus | 'disabled' | 'unavailable';

/** A minted pairing payload, in both the structured and the scannable form. */
export interface RelayPairingMint {
  readonly payload: RelayPairingPayload;
  readonly encoded: string;
}

export interface RelayReadAccessors {
  relayStatus(): RelayReadableStatus;
  mintRelayPairing(): Promise<RelayPairingMint | null>;
}

/**
 * The one sentence explaining an `'unavailable'` relay state, and a pairing
 * payload this terminal cannot mint. Stated once so `/relay status` and
 * `/relay pair` cannot drift into two different explanations of one fact.
 */
export const RELAY_STATE_NOT_READABLE_HERE =
  'The daemon holds the relay connection and the control plane exposes no verb for its state, '
  + 'so this terminal cannot read it — ask the machine running the daemon.';

/** The two relay accessors, spread into `externalServices` from bootstrap.ts. */
export const relayReadAccessors: RelayReadAccessors = {
  relayStatus: () => 'unavailable',
  mintRelayPairing: async () => null,
};
