import { MODAL_TONES } from './modal-theme.ts';
import { infoRow } from './modal-surface-helpers.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import { describeOriginPosture, generateQrMatrix, renderQrToString, type OriginPosture, type PairingHandoffOfferKind } from '@pellux/goodvibes-sdk/platform/pairing';
import { formatPairingOffers, formatPostureCapabilities, pairingPostureNotice } from '../../core/pairing-offers.ts';

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
  /**
   * The honest TLS/capability posture of the web origin the deep link opens
   * (the SDK's describeOriginPosture / the handoff's `posture` field). The one
   * honest LAN line and the labeled capability list both render from here — never
   * from a locally-authored string. Absent when no web origin is known.
   */
  readonly posture?: OriginPosture | undefined;
}
export interface PairingModalControlPlaneSnapshot { readonly activeClientIds: readonly string[]; }
export interface PairingModalReadModel<T> { getSnapshot(): T; }

/** tailscale.get shape — the daemon's honest tailscale detection (quiet when absent). */
export interface PairingTailscaleStatus {
  readonly available: boolean;
  readonly loggedIn: boolean;
  readonly magicDnsName?: string | undefined;
  readonly httpsUrl?: string | undefined;
  readonly detail: string;
  readonly lastServe?: PairingTailscaleServeReceipt | undefined;
}
/** tailscale.serve.run receipt — the one-action serve result rendered verbatim. */
export interface PairingTailscaleServeReceipt {
  readonly at: number;
  readonly command: string;
  readonly ok: boolean;
  readonly url?: string | undefined;
  readonly detail: string;
}

export interface PairingModalDeps {
  /** Lazy connection-info provider — returns null when the daemon/companion
   *  token cannot be resolved (honest degraded state instead of a throw). */
  readonly getConnectionInfo: () => PairingModalConnectionInfo | null;
  readonly controlPlaneReadModel?: PairingModalReadModel<PairingModalControlPlaneSnapshot>;
  readonly copyToClipboard?: (text: string) => void;
  /**
   * Probe tailscale (tailscale.get) once on open. Absent dep, a null result, or
   * `available:false` all keep the tailscale affordance QUIET — never a nag.
   * Present + available ⇒ the surface offers the one-action serve.
   */
  readonly probeTailscale?: () => Promise<PairingTailscaleStatus | null>;
  /**
   * Run tailscale.serve.run (behind the standard confirm) and return its receipt.
   * Wired only when probeTailscale is; the resulting https MagicDNS URL and the
   * receipt render in place.
   */
  readonly runTailscaleServe?: () => Promise<PairingTailscaleServeReceipt | null>;
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
  /** tailscale.get result: undefined = not probed yet, null = probed/absent (stays quiet). */
  private tailscale: PairingTailscaleStatus | null | undefined = undefined;
  /** The receipt from a completed serve run, rendered verbatim under the affordance. */
  private serveReceipt: PairingTailscaleServeReceipt | null = null;
  /** True while a serve run is in flight (the action is single-shot). */
  private serving = false;

  constructor(private readonly deps: PairingModalDeps) {}

  readonly actions = [
    { key: 'v', id: 'toggleReveal', label: 'reveal token' },
    { key: 'c', id: 'copyLink', label: 'copy link', enabledFor: () => Boolean(this.deps.copyToClipboard) },
    { key: 'r', id: 'newToken', label: 'new device token' },
    // The one-action serve affordance — offered ONLY when tailscale is detected
    // and not already serving https; a second 't' press (the standard confirm)
    // runs tailscale.serve.run. Absence keeps this key unadvertised and inert.
    {
      key: 't',
      id: 'tailscaleServe',
      label: 'serve over tailscale (https)',
      confirm: true,
      enabledFor: () => this.tailscale?.available === true && !this.serving,
    },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    // Probe tailscale once on open; the affordance stays quiet until (and unless)
    // this resolves to an available status. Failures degrade to quiet absence.
    if (this.deps.probeTailscale && this.tailscale === undefined) {
      this.deps.probeTailscale()
        .then((status) => { this.tailscale = status ?? null; this.requestRender(); })
        .catch(() => { this.tailscale = null; this.requestRender(); });
    }
  }

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
    const { url, token, tokenName, deepLink, offers, posture } = info;
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
    // The labeled browser-capability list — what the paired device actually gets
    // over this origin (and, for a gated one, why not). Rendered from the posture,
    // never hidden behind a dead button.
    const capabilities = formatPostureCapabilities(posture);
    if (capabilities.length > 0) {
      rows.push(infoRow('caps-h', 'This device will get:', { dim: true }));
      capabilities.forEach((line, i) => rows.push(infoRow(`cap:${i}`, line)));
    }
    // The ONE honest LAN line — the SDK posture's own notice (LAN_PLAIN_HTTP_NOTICE),
    // present only for the plain-http-on-LAN posture, never a nag elsewhere.
    const notice = pairingPostureNotice(posture);
    if (notice) rows.push(infoRow('posture', notice, { fg: MODAL_TONES.reasoning }));
    // The tailscale serve affordance — quiet unless tailscale is detected.
    this.appendTailscaleRows(rows);

    // ASCII QR of the deep link — a camera scan opens the web app already
    // carrying the one-time token. No raw JSON blob is ever encoded. The
    // multi-line preformatted string is split into one non-selectable row per row.
    const qr = renderQrToString(generateQrMatrix(deepLink));
    qr.split('\n').forEach((line, i) => rows.push(infoRow(`qr:${i}`, line, { fg: MODAL_TONES.qrDark, bg: MODAL_TONES.qrLight })));

    const hints = [this.revealed ? 'v hide token' : 'v reveal token'];
    if (this.tailscale?.available && !this.serving) hints.push('t serve over tailscale');
    return {
      title: 'Device Pairing',
      tabs: [{ id: 'pairing', label: 'Pairing', rows, hints }],
    };
  }

  /**
   * Append the tailscale section — quiet when tailscale is undetected or
   * unavailable. When detected, the surface names the one-action serve; once a
   * serve has produced (or tailscale already reports) an https MagicDNS URL, that
   * URL and the serve receipt render verbatim so the encrypted path is visible.
   */
  private appendTailscaleRows(rows: ConfigModalRow[]): void {
    const ts = this.tailscale;
    if (!ts || !ts.available) return; // absence stays quiet
    const httpsUrl = this.serveReceipt?.url ?? ts.httpsUrl;
    if (httpsUrl) {
      rows.push(infoRow('ts-h', 'Encrypted access (Tailscale):', { dim: true }));
      rows.push(infoRow('ts-url', `  ${httpsUrl}`, { fg: MODAL_TONES.good }));
    } else {
      rows.push(infoRow('ts-h', 'Tailscale detected — press t to serve this app over https (MagicDNS).', { fg: MODAL_TONES.reasoning }));
    }
    const receipt = this.serveReceipt ?? ts.lastServe;
    if (receipt) {
      rows.push(infoRow('ts-receipt', `  ${receipt.ok ? '✓' : '✗'} ${receipt.detail}`, receipt.ok ? { dim: true } : { fg: MODAL_TONES.warn }));
    } else if (this.serving) {
      rows.push(infoRow('ts-serving', '  Serving over tailscale…', { dim: true }));
    }
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    const info = this.ensureInfo();
    if (id === 'toggleReveal') { this.revealed = !this.revealed; this.requestRender(); return; }
    if (id === 'tailscaleServe') { this.runTailscaleServe(ctx); return; }
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

  /**
   * Run the one-action tailscale serve (tailscale.serve.run) after the standard
   * confirm has fired. The resulting https MagicDNS URL and receipt render in
   * place; a failed run keeps its honest receipt detail rather than a dead row.
   */
  private runTailscaleServe(ctx: ConfigModalActionContext): void {
    if (!this.deps.runTailscaleServe || this.serving) return;
    this.serving = true;
    this.requestRender();
    this.deps.runTailscaleServe()
      .then((receipt) => {
        this.serving = false;
        this.serveReceipt = receipt;
        if (receipt?.ok && receipt.url) ctx.setStatus(`Serving over tailscale: ${receipt.url}`);
        else if (receipt) ctx.setStatus(`Tailscale serve did not complete: ${receipt.detail}`);
        this.requestRender();
      })
      .catch((err: unknown) => {
        this.serving = false;
        this.serveReceipt = { at: Date.now(), command: 'tailscale serve', ok: false, detail: err instanceof Error ? err.message : String(err) };
        ctx.setStatus('Tailscale serve failed.');
        this.requestRender();
      });
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
    posture: describeOriginPosture('http://workshop.local:3141'),
  };
  return createPairingModalSurface({
    getConnectionInfo: () => connectionInfo,
    controlPlaneReadModel: { getSnapshot: () => ({ activeClientIds: ['golden-client-1'] }) },
    copyToClipboard: () => {},
  });
}
