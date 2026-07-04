import { MODAL_TONES } from './modal-theme.ts';
import type { ModalConfig, ModalSection } from '../../renderer/modal-factory.ts';
import type { BoundModalSurface, ModalAction } from './modal-surface.ts';
import { encodeConnectionPayload, generateQrMatrix, renderQrToString } from '@pellux/goodvibes-sdk/platform/pairing';

// ---------------------------------------------------------------------------
// QR Code → 'pairing' modal (W6 WO-B). Mirrors src/panels/qr-panel.ts
// (QrPanel), constructed there as
//   new QrPanel(connectionInfo, regenerate, copyToClipboard, controlPlaneReadModel, localUserAuthManager)
// The panel's core content — connection URL/token/username(/password) plus a
// scannable QR block — is read/navigate only. `regenerateToken` is dropped
// from this modal's deps entirely: it is a destructive mutation (it
// invalidates any live companion session) that the panel itself gated behind
// an in-panel confirm prompt (QrPanel.confirmRegenerate / ConfirmState). The
// charter rule (modal-surface.ts) is explicit that a confirm/approval must
// never be folded into a modal, so regenerate routes out to a command instead
// of being callable here at all (see the `regenerate` action below).
// `localUserAuthManager` (used by the panel only to decide whether to show
// that confirm) is dropped for the same reason — this modal never needs to
// know whether a companion session is live, because it never performs the
// regenerate itself.
// ---------------------------------------------------------------------------

/** Minimal structural mirror of `QrPanelConnectionInfo` (src/panels/qr-panel.ts). */
export interface PairingModalConnectionInfo {
  readonly url: string;
  readonly token: string;
  readonly username: string;
  readonly password?: string;
  readonly version?: string;
  readonly surface?: string;
}

/** Minimal structural mirror of `UiControlPlaneSnapshot` (src/runtime/ui-read-models.ts) — only the field this modal reads. */
export interface PairingModalControlPlaneSnapshot {
  readonly activeClientIds: readonly string[];
}

/** Minimal structural mirror of `UiReadModel<T>` (src/runtime/ui-read-models.ts). */
export interface PairingModalReadModel<T> {
  getSnapshot(): T;
}

export interface PairingModalDeps {
  readonly connectionInfo: PairingModalConnectionInfo;
  readonly controlPlaneReadModel?: PairingModalReadModel<PairingModalControlPlaneSnapshot>;
  readonly copyToClipboard?: (text: string) => void;
}

// Fixed-width placeholder — deliberately NOT derived from the real secret's
// length (mirrors QrPanel.SECRET_MASK), so masking doesn't leak length.
const SECRET_MASK = '••••••••••••';

/**
 * QR Code → modal. `connectionInfo` is a snapshot captured at bind time (like
 * the panel's constructor argument) rather than a live getter — refresh() is
 * a no-op because there is nothing this surface owns to reload; regenerating
 * the token happens entirely outside the modal (see `regenerate` below), so
 * this surface has no way to observe a regenerated token without being
 * re-bound. Flagged in the work-order report as a known limitation.
 */
export function bindPairingModal(deps: PairingModalDeps): BoundModalSurface {
  let revealed = false;

  const buildConfig = (): ModalConfig => {
    const { url, token, username, password } = deps.connectionInfo;
    const displayToken = revealed ? token : SECRET_MASK;
    const displayPassword = password !== undefined ? (revealed ? password : SECRET_MASK) : undefined;

    const sections: ModalSection[] = [];
    sections.push({ type: 'text', content: 'Scan with the GoodVibes companion app to pair this session.', style: { dim: true } });
    sections.push({ type: 'separator' });
    sections.push({ type: 'text', content: `URL       ${url}` });
    sections.push({ type: 'text', content: `Token     ${displayToken}`, style: { fg: MODAL_TONES.reasoning } });
    sections.push({ type: 'text', content: `Username  ${username}` });
    if (displayPassword !== undefined) {
      sections.push({ type: 'text', content: `Password  ${displayPassword}` });
    }
    if (deps.controlPlaneReadModel) {
      const connected = deps.controlPlaneReadModel.getSnapshot().activeClientIds.length;
      sections.push({
        type: 'text',
        content: `Companions connected: ${connected}`,
        style: connected > 0 ? { fg: MODAL_TONES.good } : { dim: true },
      });
    }
    sections.push({ type: 'separator' });

    // ASCII QR block — same payload shape as QrPanel.render(), rendered as a
    // preformatted Unicode half-block string (renderQrToString) rather than
    // the panel's cell-by-cell Line[] renderer, since ModalSection only
    // carries plain text content. Sized at `width: 88` below to comfortably
    // fit this fixture's payload without the modal's word-wrap splitting a
    // block row; a much longer live token/URL can still grow the QR past
    // that width and wrap mid-row at render time — a known cosmetic
    // limitation, not a data-correctness one.
    const payload = encodeConnectionPayload({
      url,
      token,
      username,
      ...(password !== undefined ? { password } : {}),
      version: deps.connectionInfo.version ?? '0.0.0',
      surface: deps.connectionInfo.surface ?? 'tui',
    });
    const matrix = generateQrMatrix(payload);
    sections.push({ type: 'text', content: renderQrToString(matrix), style: { fg: MODAL_TONES.qrDark, bg: MODAL_TONES.qrLight } });

    return {
      title: 'Companion Pairing',
      width: 88,
      sections,
      hints: [
        revealed ? 'v hide token' : 'v reveal token',
        ...(deps.copyToClipboard ? ['c copy token'] : []),
        'r regenerate token',
      ],
    };
  };

  const toggleReveal: ModalAction = () => {
    revealed = !revealed;
    return { kind: 'none' };
  };

  const copyToken: ModalAction = () => {
    if (!deps.copyToClipboard) return { kind: 'print', text: 'Clipboard not available.' };
    deps.copyToClipboard(deps.connectionInfo.token);
    return { kind: 'print', text: 'Token copied to clipboard.' };
  };

  // Regeneration invalidates any live companion session and the panel gated
  // it behind a confirm prompt — never modal-ized (charter rule). This routes
  // to a command instead. NOTE (gap, flagged in the report): as of this
  // change src/input/commands/qrcode-runtime.ts only registers `/qrcode`
  // (open the panel/modal); it has no `regenerate` subcommand yet. Adding one
  // — including wherever it should surface its own live-session confirm — is
  // out of scope here (command runtimes are off-limits for this work order).
  const regenerate: ModalAction = () => ({ kind: 'runCommand', command: '/qrcode regenerate' });

  return {
    name: 'pairing',
    title: 'Companion Pairing',
    refresh: () => {},
    buildConfig,
    rowIds: () => [],
    actions: {
      toggleReveal,
      copyToken,
      regenerate,
      refresh: () => ({ kind: 'refresh' }),
    },
  };
}

/**
 * Deterministic golden fixture: a frozen connectionInfo literal (no real
 * token/QR generation call — encodeConnectionPayload/generateQrMatrix are
 * pure functions of this literal, so the rendered QR block is byte-stable)
 * and a frozen control-plane snapshot.
 */
export function pairingModalGoldenSurface(): BoundModalSurface {
  const connectionInfo: PairingModalConnectionInfo = {
    url: 'http://192.168.1.50:3141',
    token: 'golden-token-0123456789abcdef',
    username: 'golden-user',
    password: 'golden-pass',
    version: '0.0.0',
    surface: 'tui',
  };
  const controlPlaneReadModel: PairingModalReadModel<PairingModalControlPlaneSnapshot> = {
    getSnapshot: () => ({ activeClientIds: ['golden-client-1'] }),
  };
  const surface = bindPairingModal({ connectionInfo, controlPlaneReadModel, copyToClipboard: () => {} });
  surface.refresh();
  return surface;
}
