import { MODAL_TONES } from './modal-theme.ts';
import { infoRow } from './modal-surface-helpers.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import { encodeConnectionPayload, generateQrMatrix, renderQrToString } from '@pellux/goodvibes-sdk/platform/pairing';

// ---------------------------------------------------------------------------
// QR Code → 'pairing' config-modal surface (group-B port). Connection
// URL/token/username(/password) plus a scannable QR block — read/navigate only.
// Token regeneration is a destructive mutation (it invalidates any live
// companion session) that the panel gated behind an in-panel confirm; per
// charter that confirm is never folded into a modal, so regenerate routes to a
// command instead. `getConnectionInfo` is a lazy thunk (loaded once on first
// buildView, cached) so a missing daemon home degrades honestly rather than
// throwing at modal-registration time.
//
// the regenerate action now dispatches the real `/qrcode regenerate`
// verb (which rotates the shared operator-token store) and, once it resolves,
// RE-PULLS the lazy connection-info thunk so the modal shows the rotated token +
// QR in place without being re-opened. `confirm: true` keeps the two-press
// guard so a stray keystroke never rotates a live companion's token.
// ---------------------------------------------------------------------------

export interface PairingModalConnectionInfo {
  readonly url: string;
  readonly token: string;
  readonly username: string;
  readonly password?: string;
  readonly version?: string;
  readonly surface?: string;
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
  readonly title = 'Companion Pairing';
  private info: PairingModalConnectionInfo | null | undefined = undefined;
  private revealed = false;
  private requestRender: () => void = () => {};

  constructor(private readonly deps: PairingModalDeps) {}

  readonly actions = [
    { key: 'v', id: 'toggleReveal', label: 'reveal token' },
    { key: 'c', id: 'copyToken', label: 'copy token', enabledFor: () => Boolean(this.deps.copyToClipboard) },
    { key: 'r', id: 'regenerate', label: 'regenerate token', confirm: true },
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
      return { title: 'Companion Pairing', degraded: 'Companion pairing is unavailable — the daemon connection info could not be resolved for this session.', tabs: [{ id: 'pairing', label: 'Pairing', rows: [] }] };
    }
    const { url, token, username, password } = info;
    const displayToken = this.revealed ? token : SECRET_MASK;
    const displayPassword = password !== undefined ? (this.revealed ? password : SECRET_MASK) : undefined;

    const rows: ConfigModalRow[] = [];
    rows.push(infoRow('intro', 'Scan with the GoodVibes companion app to pair this session.', { dim: true }));
    rows.push(infoRow('url', `URL       ${url}`));
    rows.push(infoRow('token', `Token     ${displayToken}`, { fg: MODAL_TONES.reasoning }));
    rows.push(infoRow('username', `Username  ${username}`));
    if (displayPassword !== undefined) rows.push(infoRow('password', `Password  ${displayPassword}`));
    if (this.deps.controlPlaneReadModel) {
      const connected = this.deps.controlPlaneReadModel.getSnapshot().activeClientIds.length;
      rows.push(infoRow('companions', `Companions connected: ${connected}`, connected > 0 ? { fg: MODAL_TONES.good } : { dim: true }));
    }

    // ASCII QR block — same payload shape as QrPanel.render(); the multi-line
    // preformatted string is split into one non-selectable row per block row.
    const payload = encodeConnectionPayload({
      url, token, username,
      ...(password !== undefined ? { password } : {}),
      version: info.version ?? '0.0.0',
      surface: info.surface ?? 'tui',
    });
    const qr = renderQrToString(generateQrMatrix(payload));
    qr.split('\n').forEach((line, i) => rows.push(infoRow(`qr:${i}`, line, { fg: MODAL_TONES.qrDark, bg: MODAL_TONES.qrLight })));

    return {
      title: 'Companion Pairing',
      tabs: [{ id: 'pairing', label: 'Pairing', rows, hints: [this.revealed ? 'v hide token' : 'v reveal token'] }],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    const info = this.ensureInfo();
    if (id === 'toggleReveal') { this.revealed = !this.revealed; this.requestRender(); return; }
    if (id === 'copyToken') {
      if (!this.deps.copyToClipboard || !info) { ctx.print('Clipboard not available.'); return; }
      this.deps.copyToClipboard(info.token);
      ctx.print('Token copied to clipboard.');
      return;
    }
    if (id === 'regenerate') {
      const dispatched = ctx.executeCommand?.('qrcode', ['regenerate']);
      if (!dispatched) {
        ctx.setStatus('Token rotation is unavailable in this runtime.');
        return;
      }
      ctx.setStatus('Rotating pairing token…');
      void dispatched
        .then((ok) => {
          if (ok === false) { ctx.setStatus('Token rotation did not complete.'); return; }
          // Re-pull the lazy connection-info thunk: /qrcode regenerate rewrote
          // the shared token store, so a fresh getConnectionInfo() reflects the
          // rotated token + QR. ensureInfo caches on first build — clear it.
          this.info = undefined;
          this.revealed = false;
          this.ensureInfo();
          this.requestRender();
          ctx.setStatus('Pairing token rotated — new token and QR loaded.');
        })
        .catch(() => { ctx.setStatus('Token rotation failed.'); });
    }
  }
}

export function createPairingModalSurface(deps: PairingModalDeps): ConfigModalSurface {
  return new PairingModalSurface(deps);
}

/**
 * Deterministic golden fixture: a frozen connectionInfo literal (no real
 * token/QR generation call — encodeConnectionPayload/generateQrMatrix are pure
 * functions of this literal) and a frozen control-plane snapshot.
 */
export function pairingModalGoldenSurface(): ConfigModalSurface {
  const connectionInfo: PairingModalConnectionInfo = {
    url: 'http://192.168.1.50:3141', token: 'golden-token-0123456789abcdef', username: 'golden-user', password: 'golden-pass', version: '0.0.0', surface: 'tui',
  };
  return createPairingModalSurface({
    getConnectionInfo: () => connectionInfo,
    controlPlaneReadModel: { getSnapshot: () => ({ activeClientIds: ['golden-client-1'] }) },
    copyToClipboard: () => {},
  });
}
