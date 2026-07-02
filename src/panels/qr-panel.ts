import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import {
  buildKeyboardHints,
  buildPanelLine,
  buildPanelTitle,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
} from './polish.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { renderQrMatrix, generateQrMatrix } from '../renderer/qr-renderer.ts';
import { encodeConnectionPayload } from '@pellux/goodvibes-sdk/platform/pairing';
import type { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import type { UiControlPlaneSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';

// Fixed-width placeholder — deliberately NOT derived from the real secret's
// length, so masking doesn't leak how long the token/password is.
const SECRET_MASK = '••••••••••••';

// Domain accents only; base chrome (header/headerBg/label/info) comes from
// DEFAULT_PANEL_PALETTE. qrFg/qrBg stay pure black/white — scanner contrast
// requirements override theming.
const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  token: '#a78bfa',
  qrFg:  '#000000',
  qrBg:  '#ffffff',
} as const);

/**
 * Connection info passed to the QR panel.
 * Populated at construction; updated when the token is regenerated.
 */
export interface QrPanelConnectionInfo {
  /** Full connection URL (e.g. http://192.168.1.x:3141) */
  readonly url: string;
  /** Auth token */
  readonly token: string;
  /** Username associated with the companion session */
  readonly username: string;
  /** Bootstrap password for companion authentication */
  readonly password?: string;
  /** SDK/surface version (defaults to '0.0.0' if omitted) */
  readonly version?: string;
  /** Surface identifier (defaults to 'tui' if omitted) */
  readonly surface?: string;
}

/**
 * Callback used by the panel to regenerate the companion token.
 * Returns updated connection info.
 */
export type RegenerateTokenFn = () => QrPanelConnectionInfo;

/**
 * Callback used by the panel to copy text to the clipboard.
 */
export type CopyToClipboardFn = (text: string) => void;

/**
 * QrPanel - displays a QR code for companion app pairing.
 *
 * Shows connection URL, truncated token, and username above the QR code.
 * Supports `r` to regenerate the token and `c` to copy the token.
 *
 * QR matrix generation uses the SDK's `generateQrMatrix` via `encodeConnectionPayload`.
 */
export class QrPanel extends BasePanel {
  private connectionInfo: QrPanelConnectionInfo;
  private readonly regenerateToken: RegenerateTokenFn | undefined;
  private readonly copyToClipboard: CopyToClipboardFn | undefined;
  private readonly controlPlaneReadModel: UiReadModel<UiControlPlaneSnapshot> | undefined;
  private readonly localUserAuthManager: Pick<UserAuthManager, 'inspect'> | undefined;
  private readonly unsub: (() => void) | null;
  private lastStatus = '';
  /** v toggles whether the token/password render in the clear. */
  private revealed = false;
  /** Set when r is pressed while a companion session is live — confirmed with y/Enter, cancelled with n/Esc. */
  private confirmRegenerate: ConfirmState<null> | null = null;

  public constructor(
    connectionInfo: QrPanelConnectionInfo,
    regenerateToken?: RegenerateTokenFn,
    copyToClipboard?: CopyToClipboardFn,
    controlPlaneReadModel?: UiReadModel<UiControlPlaneSnapshot>,
    localUserAuthManager?: Pick<UserAuthManager, 'inspect'>,
  ) {
    super('qr-code', 'QR Code', 'Q', 'session');
    this.connectionInfo = connectionInfo;
    this.regenerateToken = regenerateToken;
    this.copyToClipboard = copyToClipboard;
    this.controlPlaneReadModel = controlPlaneReadModel;
    this.localUserAuthManager = localUserAuthManager;
    this.unsub = controlPlaneReadModel ? controlPlaneReadModel.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  private hasLiveCompanionSession(): boolean {
    return (this.localUserAuthManager?.inspect().sessionCount ?? 0) > 0;
  }

  private doRegenerate(): void {
    if (!this.regenerateToken) return;
    this.connectionInfo = this.regenerateToken();
    this.lastStatus = 'Token regenerated.';
    this.markDirty();
  }

  public handleInput(key: string): boolean {
    if (this.confirmRegenerate) {
      const result = handleConfirmInput(this.confirmRegenerate, key);
      if (result === 'confirmed') {
        this.confirmRegenerate = null;
        this.doRegenerate();
        return true;
      }
      if (result === 'cancelled') {
        this.confirmRegenerate = null;
        this.lastStatus = 'Regeneration cancelled.';
        this.markDirty();
        return true;
      }
      return true; // absorbed
    }
    if (key === 'r') {
      if (!this.regenerateToken) {
        this.lastStatus = 'Regeneration not available.';
        this.markDirty();
        return true;
      }
      if (this.hasLiveCompanionSession()) {
        this.confirmRegenerate = {
          subject: null,
          label: 'pairing token — a companion session is live and will be disconnected',
          verb: 'Regenerate',
        };
        this.markDirty();
        return true;
      }
      this.doRegenerate();
      return true;
    }
    if (key === 'v') {
      this.revealed = !this.revealed;
      this.markDirty();
      return true;
    }
    if (key === 'c') {
      if (this.copyToClipboard) {
        this.copyToClipboard(this.connectionInfo.token);
        this.lastStatus = 'Token copied to clipboard.';
      } else {
        this.lastStatus = 'Clipboard not available.';
      }
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const lines: Line[] = [];

    const { url, token, username, password } = this.connectionInfo;
    const valueWidth = Math.max(0, width - 12);
    const displayToken = this.revealed ? token : SECRET_MASK;
    const displayPassword = password !== undefined ? (this.revealed ? password : SECRET_MASK) : undefined;

    // ── Title + purpose: tell the operator exactly what this code is for ────
    lines.push(buildPanelTitle(width, 'Companion Pairing', C));
    lines.push(
      buildPanelLine(width, [
        [' Scan with the GoodVibes companion app to pair this session.', C.label],
      ]),
    );

    // ── Connection info header ─────────────────────────────────────────────
    // Token and (if present) bootstrap password are masked by default — they
    // are credentials, not display text — and only render in the clear while
    // `revealed` is toggled on via v.
    lines.push(createEmptyLine(width));
    lines.push(
      buildPanelLine(width, [
        [' URL      ', C.label],
        [truncateDisplay(url, valueWidth), C.info],
      ]),
    );
    lines.push(
      buildPanelLine(width, [
        [' Token    ', C.label],
        [truncateDisplay(displayToken, valueWidth), C.token],
      ]),
    );
    lines.push(
      buildPanelLine(width, [
        [' Username ', C.label],
        [truncateDisplay(username, valueWidth), C.value],
      ]),
    );
    if (displayPassword !== undefined) {
      lines.push(
        buildPanelLine(width, [
          [' Password ', C.label],
          [truncateDisplay(displayPassword, valueWidth), C.value],
        ]),
      );
    }

    // ── Connected companions ──────────────────────────────────────────────
    if (this.controlPlaneReadModel) {
      const connected = this.controlPlaneReadModel.getSnapshot().activeClientIds.length;
      lines.push(
        buildPanelLine(width, [
          [' Companions ', C.label],
          [`connected: ${connected}`, connected > 0 ? C.good : C.dim],
        ]),
      );
    }
    lines.push(createEmptyLine(width));

    // ── QR code ────────────────────────────────────────────────────────────
    const payload = encodeConnectionPayload({
      url: this.connectionInfo.url,
      token: this.connectionInfo.token,
      username: this.connectionInfo.username,
      ...(this.connectionInfo.password !== undefined ? { password: this.connectionInfo.password } : {}),
      version: this.connectionInfo.version ?? '0.0.0',
      surface: this.connectionInfo.surface ?? 'tui',
    });
    const matrix = generateQrMatrix(payload);
    const qrLines = renderQrMatrix(matrix.modules, width, { fg: C.qrFg, bg: C.qrBg });
    for (const qrLine of qrLines) {
      lines.push(qrLine);
    }

    lines.push(createEmptyLine(width));

    // ── Footer: confirm overlay (regenerate while a companion is live) takes
    // priority over the ephemeral status message ──────────────────────────
    const footerLines: Line[] = [];
    if (this.confirmRegenerate) {
      footerLines.push(...renderConfirmLines(width, this.confirmRegenerate));
    } else if (this.lastStatus) {
      footerLines.push(
        buildPanelLine(width, [
          [` ${this.lastStatus} `, C.label],
        ]),
      );
    }

    // ── Hints ── only advertise actions that are actually wired ─────────────
    const hints: Array<{ keys: string; label: string }> = [];
    if (this.regenerateToken) hints.push({ keys: 'r', label: 'regenerate token' });
    if (this.copyToClipboard) hints.push({ keys: 'c', label: 'copy token' });
    hints.push({ keys: 'v', label: this.revealed ? 'hide token' : 'reveal token' });
    const hintsLine = hints.length > 0
      ? buildKeyboardHints(width, hints, C)
      : buildPanelLine(width, [[' Pairing is read-only in this surface.', C.dim]]);
    footerLines.push(hintsLine);

    // Push the footer at the bottom if we have room, otherwise append it
    // directly after the QR code.
    const remaining = height - lines.length - footerLines.length;
    if (remaining > 0) {
      for (let i = 0; i < remaining; i++) lines.push(createEmptyLine(width));
    }
    lines.push(...footerLines);

    // Clamp to the exact requested height — the QR matrix's row count is
    // driven by payload size, not by `height`, so it can legitimately
    // overflow a small pane; never hand back more (or fewer) lines than asked.
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
