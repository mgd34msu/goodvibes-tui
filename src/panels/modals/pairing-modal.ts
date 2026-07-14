import { MODAL_TONES } from './modal-theme.ts';
import { infoRow } from './modal-surface-helpers.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import { generateQrMatrix, renderQrToString, type PairingHandoffOfferKind } from '@pellux/goodvibes-sdk/platform/pairing';
import { formatPairingOffers, PAIRING_HTTP_LAN_POSTURE } from '../../core/pairing-offers.ts';

// ---------------------------------------------------------------------------
// Device Pairing config-modal surface. Shows the web-app origin, the per-device
// token's name, a masked token/deep-link pair, the offer set with plain-language
// consequences, and a scannable QR of the `#pair=<token>` deep link — a camera
// scan opens the web app already signed in. No raw JSON connection blob is ever
// encoded.
//
// `getConnectionInfo` is a lazy thunk (loaded once on first buildView, cached):
// each modal open mints its OWN named per-device token, so a missing pairing
// service degrades honestly to an "unavailable" state instead of throwing at
// registration time. "new device token" clears the cache and re-pulls to mint a
// fresh token + QR in place — non-destructive now, because a freshly minted
// token no longer rotates a shared secret out from under a live device; old
// tokens stay valid until explicitly revoked in the settings device surface.
// ---------------------------------------------------------------------------

export interface PairingModalConnectionInfo {
  /** The web-app origin the deep link opens (e.g. http://workshop.local:3141). */
  readonly url: string;
  /** The one-time pairing secret (masked unless revealed). */
  readonly token: string;
  /** The per-device token's editable name. */
  readonly tokenName: string;
  /** The `#pair=<token>` deep link the QR encodes — opens the web app signed in. */
  readonly deepLink: string;
  /** The offer set this pairing carries (each declinable in the web app). */
  readonly offers: readonly PairingHandoffOfferKind[];
  /** True when the link is plain http on the LAN ⇒ show the honest posture line. */
  readonly httpOnLan: boolean;
}
export interface PairingModalControlPlaneSnapshot { readonly activeClientIds: readonly string[]; }
export interface PairingModalReadModel<T> { getSnapshot(): T; }

export interface PairingModalDeps {
  /** Lazy connection-info provider — returns null when the daemon/companion
   *  token cannot be resolved (honest degraded state instead of a throw). */
  readonly getConnectionInfo: () => PairingModalConnectionInfo | null;
  readonly controlPlaneReadModel?: PairingModalReadModel<PairingModalControlPlaneSnapshot>;
  readonly copyToClipboard?: (text: string) => void;
}

// Fixed-width placeholder — deliberately NOT derived from the real secret's
// length (mirrors QrPanel.SECRET_MASK), so masking doesn't leak length.
const SECRET_MASK = '••••••••••••';

class PairingModalSurface implements ConfigModalSurface {
  readonly name = 'pairing-modal';
  readonly title = 'Device Pairing';
  private info: PairingModalConnectionInfo | null | undefined = undefined;
  private revealed = false;
  private requestRender: () => void = () => {};

  constructor(private readonly deps: PairingModalDeps) {}

  readonly actions = [
    { key: 'v', id: 'toggleReveal', label: 'reveal token' },
    { key: 'c', id: 'copyLink', label: 'copy link', enabledFor: () => Boolean(this.deps.copyToClipboard) },
    { key: 'r', id: 'newToken', label: 'new device token' },
  ];

  onOpen(requestRender: () => void): void { this.requestRender = requestRender; }

  private ensureInfo(): PairingModalConnectionInfo | null {
    if (this.info === undefined) {
      try { this.info = this.deps.getConnectionInfo(); } catch { this.info = null; }
    }
    return this.info;
  }

  buildView(): ConfigModalView {
    const info = this.ensureInfo();
    if (!info) {
      return { title: 'Device Pairing', degraded: 'Device pairing is unavailable — the pairing token service could not be resolved for this session.', tabs: [{ id: 'pairing', label: 'Pairing', rows: [] }] };
    }
    const { url, token, tokenName, deepLink, offers, httpOnLan } = info;
    const displayToken = this.revealed ? token : SECRET_MASK;
    // The deep link carries the one-time token, so it is masked with the token.
    const displayLink = this.revealed ? deepLink : SECRET_MASK;

    const rows: ConfigModalRow[] = [];
    rows.push(infoRow('intro', 'Scan with the GoodVibes web app to pair this device — it opens already signed in.', { dim: true }));
    rows.push(infoRow('url', `Web app   ${url}`));
    rows.push(infoRow('name', `Device    ${tokenName}`));
    rows.push(infoRow('token', `Token     ${displayToken}`, { fg: MODAL_TONES.reasoning }));
    rows.push(infoRow('link', `Link      ${displayLink}`, { dim: true }));
    if (this.deps.controlPlaneReadModel) {
      const connected = this.deps.controlPlaneReadModel.getSnapshot().activeClientIds.length;
      rows.push(infoRow('companions', `Devices connected: ${connected}`, connected > 0 ? { fg: MODAL_TONES.good } : { dim: true }));
    }

    // The offer set carried by this pairing — each named with its plain-language
    // consequence, each declinable in the web app.
    if (offers.length > 0) {
      rows.push(infoRow('offers-h', 'Offers (each declinable when you pair):', { dim: true }));
      formatPairingOffers(offers).forEach((line, i) => rows.push(infoRow(`offer:${i}`, line)));
    }
    // One honest posture line when the link is plain http on the LAN.
    if (httpOnLan) rows.push(infoRow('posture', PAIRING_HTTP_LAN_POSTURE, { fg: MODAL_TONES.reasoning }));

    // ASCII QR of the deep link — a camera scan opens the web app already
    // carrying the one-time token. No raw JSON blob is ever encoded. The
    // multi-line preformatted string is split into one non-selectable row per row.
    const qr = renderQrToString(generateQrMatrix(deepLink));
    qr.split('\n').forEach((line, i) => rows.push(infoRow(`qr:${i}`, line, { fg: MODAL_TONES.qrDark, bg: MODAL_TONES.qrLight })));

    return {
      title: 'Device Pairing',
      tabs: [{ id: 'pairing', label: 'Pairing', rows, hints: [this.revealed ? 'v hide token' : 'v reveal token'] }],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    const info = this.ensureInfo();
    if (id === 'toggleReveal') { this.revealed = !this.revealed; this.requestRender(); return; }
    if (id === 'copyLink') {
      if (!this.deps.copyToClipboard || !info) { ctx.print('Clipboard not available.'); return; }
      this.deps.copyToClipboard(info.deepLink);
      ctx.print('Pairing link copied to clipboard.');
      return;
    }
    if (id === 'newToken') {
      // Each open mints its own named token; "new device token" just re-pulls the
      // thunk to mint a fresh one + QR in place. Non-destructive: the prior token
      // stays valid until it is revoked in /settings → security → devices.
      this.info = undefined;
      this.revealed = false;
      this.ensureInfo();
      this.requestRender();
      ctx.setStatus('Minted a fresh device token and QR. Revoke old ones in /settings → security → devices.');
      return;
    }
  }
}

export function createPairingModalSurface(deps: PairingModalDeps): ConfigModalSurface {
  return new PairingModalSurface(deps);
}

/**
 * Deterministic golden fixture: a frozen connectionInfo literal (the QR renders
 * purely from its deepLink via generateQrMatrix) and a frozen control-plane
 * snapshot.
 */
export function pairingModalGoldenSurface(): ConfigModalSurface {
  const connectionInfo: PairingModalConnectionInfo = {
    url: 'http://workshop.local:3141',
    token: 'golden-token-0123456789abcdef',
    tokenName: 'golden device',
    deepLink: 'http://workshop.local:3141/#pair=golden-token-0123456789abcdef&offers=notifications~relay~passkey',
    offers: ['notifications', 'relay', 'passkey'],
    httpOnLan: true,
  };
  return createPairingModalSurface({
    getConnectionInfo: () => connectionInfo,
    controlPlaneReadModel: { getSnapshot: () => ({ activeClientIds: ['golden-client-1'] }) },
    copyToClipboard: () => {},
  });
}
