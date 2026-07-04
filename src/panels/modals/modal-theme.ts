import { resolveUiTones } from '../../renderer/theme.ts';

// ---------------------------------------------------------------------------
// Semantic tone tokens for the W6.1 group-B config modals.
//
// Derived entirely from the chrome token set (resolveUiTones) so the builders
// carry NO raw hex color literals (architecture: no-raw-hex-literal-growth).
// Mode is fixed to 'dark' — the single read path the whole renderer uses until
// the terminal-bg-probe lands (see renderer/modal-factory.ts, which resolves
// the same way).
// ---------------------------------------------------------------------------

const T = resolveUiTones('dark');

export const MODAL_TONES = {
  /** Informational / accent (blue). */
  info: T.state.info,
  /** Positive / healthy (green). */
  good: T.state.good,
  /** Caution (amber). */
  warn: T.state.warn,
  /** Error / danger (red). */
  bad: T.state.bad,
  /** Reasoning / secondary accent (purple). */
  reasoning: T.state.reasoning,
  /** Muted secondary text. */
  muted: T.fg.muted,
  /** Dim tertiary text. */
  dim: T.fg.dim,
  /** Primary (near-white) text. */
  primary: T.fg.primary,
  /** QR module foreground — high-contrast dark, not pure black. */
  qrDark: T.fg.inverse,
  /** QR field background — high-contrast light, not pure white. */
  qrLight: T.fg.primary,
} as const;
