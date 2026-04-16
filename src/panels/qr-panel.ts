import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import {
  buildPanelLine,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import { renderQrMatrix, generateQrMatrix } from '../renderer/qr-renderer.ts';
import { encodeConnectionPayload } from '@pellux/goodvibes-sdk/platform/pairing/index';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  url: '#38bdf8',
  token: '#a78bfa',
  hint: '#64748b',
  qrFg: '#000000',
  qrBg: '#ffffff',
} as const;

/**
 * Connection info passed to the QR panel.
 * Populated at construction; updated when the token is regenerated.
 */
export interface QrPanelConnectionInfo {
  /** Full connection URL (e.g. http://localhost:3141) */
  readonly url: string;
  /** Auth token (will be truncated for display) */
  readonly token: string;
  /** Username associated with the companion session */
  readonly username: string;
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
  private lastStatus = '';

  public constructor(
    connectionInfo: QrPanelConnectionInfo,
    regenerateToken?: RegenerateTokenFn,
    copyToClipboard?: CopyToClipboardFn,
  ) {
    super('qr-code', 'QR Code', 'Q', 'session');
    this.connectionInfo = connectionInfo;
    this.regenerateToken = regenerateToken;
    this.copyToClipboard = copyToClipboard;
  }

  public handleInput(key: string): boolean {
    if (key === 'r') {
      if (this.regenerateToken) {
        this.connectionInfo = this.regenerateToken();
        this.lastStatus = 'Token regenerated.';
      } else {
        this.lastStatus = 'Regeneration not available.';
      }
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

    const { url, token, username } = this.connectionInfo;
    const tokenDisplay = token.length > 20 ? `${token.slice(0, 20)}…` : token;

    // ── Connection info header ─────────────────────────────────────────────
    lines.push(createEmptyLine(width));
    lines.push(
      buildPanelLine(width, [
        [' URL      ', C.label],
        [url.slice(0, Math.max(0, width - 12)), C.url],
      ]),
    );
    lines.push(
      buildPanelLine(width, [
        [' Token    ', C.label],
        [tokenDisplay, C.token],
      ]),
    );
    lines.push(
      buildPanelLine(width, [
        [' Username ', C.label],
        [username.slice(0, Math.max(0, width - 12)), C.value],
      ]),
    );
    lines.push(createEmptyLine(width));

    // ── QR code ────────────────────────────────────────────────────────────
    const payload = encodeConnectionPayload({
      url: this.connectionInfo.url,
      token: this.connectionInfo.token,
      username: this.connectionInfo.username,
      version: this.connectionInfo.version ?? '0.0.0',
      surface: this.connectionInfo.surface ?? 'tui',
    });
    const matrix = generateQrMatrix(payload);
    const qrLines = renderQrMatrix(matrix.modules, width, { fg: C.qrFg, bg: C.qrBg });
    for (const qrLine of qrLines) {
      lines.push(qrLine);
    }

    lines.push(createEmptyLine(width));

    // ── Status message (ephemeral) ─────────────────────────────────────────
    if (this.lastStatus) {
      lines.push(
        buildPanelLine(width, [
          [` ${this.lastStatus} `, C.hint],
        ]),
      );
    }

    // ── Hints ──────────────────────────────────────────────────────────────
    const hintsLine = buildPanelLine(width, [
      [' r ', C.hint],
      ['regenerate  ', C.dim],
      [' c ', C.hint],
      ['copy token', C.dim],
    ]);

    // Push hints at the bottom if we have room, otherwise append after QR
    const remaining = height - lines.length;
    if (remaining > 2) {
      // Fill with empty lines to push hints toward bottom
      const fillCount = Math.max(0, remaining - 2);
      for (let i = 0; i < fillCount; i++) {
        lines.push(createEmptyLine(width));
      }
    }
    lines.push(hintsLine);

    return lines;
  }
}
