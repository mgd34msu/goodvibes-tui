/**
 * pairing-offers.ts — plain-language copy for the pairing offer set and the one
 * honest LAN-posture line.
 *
 * Each offer names, in plain terms, what accepting it does and what declining it
 * costs — no security jargon, just the concrete consequence. Every offer is
 * independently declinable; a pairing without any accepted offer still pairs the
 * device (it just signs in with none of the extras).
 */
import type { PairingHandoffOfferKind } from '@pellux/goodvibes-sdk/platform/pairing';

export interface PairingOfferCopy {
  readonly title: string;
  /** One plain-language line: what accepting does, and what declining leaves you with. */
  readonly consequence: string;
}

export const PAIRING_OFFER_COPY: Record<PairingHandoffOfferKind, PairingOfferCopy> = {
  notifications: {
    title: 'Notifications',
    consequence: 'This device gets a push when an agent needs your input or a run finishes. Decline and it pairs without push.',
  },
  relay: {
    title: 'Relay',
    consequence: 'Reach this daemon from off the LAN through the rendezvous relay, which sees only ciphertext and connection metadata. Decline to stay LAN-only.',
  },
  passkey: {
    title: 'Passkey',
    consequence: 'Register a passkey on this device to confirm sensitive actions with a tap. Decline and sensitive actions ask another way.',
  },
};

/** The offer set as `label — consequence` lines, in the given order. */
export function formatPairingOffers(offers: readonly PairingHandoffOfferKind[]): string[] {
  return offers.map((kind) => {
    const copy = PAIRING_OFFER_COPY[kind];
    return `  ${copy.title} — ${copy.consequence}`;
  });
}

/**
 * The single honest line shown when the pairing link is http on the LAN: the
 * one-time token travels in the clear, so pair on a trusted network and re-pair
 * if it may have leaked. Kept to one line by charter.
 */
export const PAIRING_HTTP_LAN_POSTURE =
  'This link is plain http on your LAN: the one-time token is readable by anyone who intercepts it on this network. Pair on a network you trust, and re-scan to mint a new token if it may have leaked.';
