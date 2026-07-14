/**
 * pairing-offers.ts — plain-language copy for the pairing offer set, the one
 * honest LAN-posture line, and the labeled browser-capability list.
 *
 * Each offer names, in plain terms, what accepting it does and what declining it
 * costs — no security jargon, just the concrete consequence. Every offer is
 * independently declinable; a pairing without any accepted offer still pairs the
 * device (it just signs in with none of the extras).
 *
 * The one honest LAN line and the per-capability availability both come from the
 * SDK posture (describeOriginPosture / the `posture` field on a handoff), so
 * every surface renders the SAME truth: the exact LAN_PLAIN_HTTP_NOTICE wording
 * only when the posture carries it, and each browser-gated capability labeled
 * with whether the paired device gets it (and why not, when it does not).
 */
import type {
  BrowserGatedCapability,
  OriginPosture,
  PairingHandoffOfferKind,
} from '@pellux/goodvibes-sdk/platform/pairing';

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
 * Plain-language label for each browser-gated capability the posture reports —
 * what the paired device would actually get, named without jargon.
 */
export const POSTURE_CAPABILITY_LABEL: Record<BrowserGatedCapability, string> = {
  'service-worker': 'Offline app (installable / background sync)',
  push: 'Push notifications',
  microphone: 'Voice input (microphone)',
};

/**
 * The one honest LAN line to render, or null. This is the SDK posture's own
 * `notice` field verbatim (LAN_PLAIN_HTTP_NOTICE) — present ONLY for the
 * plain-http-on-LAN posture, absent (and so never a nag) everywhere else.
 */
export function pairingPostureNotice(posture: OriginPosture | undefined): string | null {
  return posture?.notice ?? null;
}

/**
 * The labeled capability list from the posture: each browser-gated capability as
 * a `Label — available` / `Label — <reason>` line, so the pairing surface lists
 * what the paired device will get instead of hiding a dead button. Empty when no
 * posture is known.
 */
export function formatPostureCapabilities(posture: OriginPosture | undefined): string[] {
  if (!posture) return [];
  return posture.capabilities.map((cap) => {
    const label = POSTURE_CAPABILITY_LABEL[cap.capability as BrowserGatedCapability] ?? cap.capability;
    const status = cap.available ? 'available' : (cap.reason ?? 'unavailable');
    return `  ${label} — ${status}`;
  });
}
