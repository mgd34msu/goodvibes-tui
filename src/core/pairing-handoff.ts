/**
 * pairing-handoff.ts — the one place a TUI pairing producer mints a link.
 *
 * Every producer (the `gv pair` CLI block, the pairing modal QR, the /qrcode
 * flow) routes through mintPairingHandoff, which mints a fresh per-device token
 * and encodes the SDK's canonical `#pair=<token>` deep link — the exact shape
 * the web app consumes, byte-for-byte the same as the `pairing.handoff.create`
 * gateway verb's handler (mint + buildPairingHandoffLink). No producer encodes a
 * raw JSON connection blob any more: a camera scan of the QR opens the web app
 * already carrying the one-time token, so the device lands signed in.
 *
 * The token rides in the URL fragment, never the query, so it is never sent to a
 * server (no access-log / Referer exposure). The offer set rides alongside so a
 * bundle-aware surface can present the notifications/relay/passkey steps.
 */
import {
  buildPairingHandoffFragment,
  buildPairingHandoffLink,
  describeOriginPosture,
  type MintedPairingToken,
  type OriginPosture,
  type PairingHandoffOfferKind,
} from '@pellux/goodvibes-sdk/platform/pairing';

/** The token-minting surface a handoff needs — satisfied by the SDK's PairingTokenManager. */
export interface PairingTokenMinter {
  mint(input: { readonly name: string }): MintedPairingToken;
}

export interface PairingHandoff {
  readonly token: MintedPairingToken;
  readonly offers: readonly PairingHandoffOfferKind[];
  /** `#pair=<token>` (with an `offers=` key when offers are present). */
  readonly fragment: string;
  /** `<webOrigin>/#pair=<token>` — present only when a web origin is known. */
  readonly deepLink?: string | undefined;
  /**
   * The honest TLS/capability posture of the web origin the deep link opens —
   * the same field the `pairing.handoff.create` gateway verb carries (both
   * computed by the SDK's describeOriginPosture). Present only when a web origin
   * is known; a surface renders its one honest LAN line and its labeled
   * capability list from here, never from a locally-authored string.
   */
  readonly posture?: OriginPosture | undefined;
}

export interface MintPairingHandoffInput {
  readonly pairingTokens: PairingTokenMinter;
  /** The device/token name shown to the user and stored on the token; editable later. */
  readonly name: string;
  readonly offers: readonly PairingHandoffOfferKind[];
  /** The web-app origin the deep link points at; absent ⇒ fragment-only. */
  readonly webOrigin?: string | undefined;
}

/**
 * A default name for a freshly-minted pairing token when the user did not supply
 * one. Names are shown and editable later in the device management surface, so a
 * date-stamped default is enough to tell two devices apart at a glance.
 */
export function defaultPairingTokenName(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  return `paired device (${stamp})`;
}

export function mintPairingHandoff(input: MintPairingHandoffInput): PairingHandoff {
  const token = input.pairingTokens.mint({ name: input.name });
  const fragment = buildPairingHandoffFragment({ token: token.token, offers: input.offers });
  const deepLink = input.webOrigin
    ? buildPairingHandoffLink({ webOrigin: input.webOrigin, token: token.token, offers: input.offers })
    : undefined;
  // The posture is described from the SAME web origin the deep link opens — the
  // identical computation the gateway verb performs — so a locally-minted handoff
  // carries the same honest posture as one minted over the wire.
  const posture = input.webOrigin ? describeOriginPosture(input.webOrigin) : undefined;
  return { token, offers: input.offers, fragment, ...(deepLink ? { deepLink } : {}), ...(posture ? { posture } : {}) };
}

/** The link content a QR should encode: the full deep link when known, else the fragment. */
export function pairingQrContent(handoff: PairingHandoff): string {
  return handoff.deepLink ?? handoff.fragment;
}

export interface PairingOfferAvailability {
  /** Whether the rendezvous relay is configured ⇒ the relay offer is presentable. */
  readonly relayEnabled: boolean;
  /** Whether a step-up (passkey) ceremony is wired ⇒ the passkey offer is presentable. */
  readonly stepUpAvailable: boolean;
}

/**
 * The offers this daemon can satisfy right now, in canonical order. Notifications
 * are always available (browser push needs no server-side prerequisite beyond
 * the VAPID key the daemon mints on demand); relay and passkey are gated.
 */
export function availablePairingOffers(availability: PairingOfferAvailability): PairingHandoffOfferKind[] {
  const offers: PairingHandoffOfferKind[] = ['notifications'];
  if (availability.relayEnabled) offers.push('relay');
  if (availability.stepUpAvailable) offers.push('passkey');
  return offers;
}
