import { activeUiTones, registerThemeRefresh } from '../../renderer/theme.ts';

// ---------------------------------------------------------------------------
// Semantic tone tokens for the group-B config modals.
//
// Derived entirely from the chrome token set so the builders carry NO raw hex
// color literals (architecture: no-raw-hex-literal-growth). Rebuilt IN PLACE
// on theme flips via registerThemeRefresh, the group-B surfaces read
// MODAL_TONES by reference at render time, so a dark-pinned module const here
// left them rendering dark accents on light chrome (batch refutation
// finding 2). Mirrors the polish-core/overlay-box/modal-factory pattern.
// ---------------------------------------------------------------------------

function buildModalTones() {
  const T = activeUiTones();
  return {
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
    /** Primary text. */
    primary: T.fg.primary,
    /** QR module foreground, high-contrast, mode-appropriate. */
    qrDark: T.fg.inverse,
    /** QR field background, high-contrast, mode-appropriate. */
    qrLight: T.fg.primary,
  };
}

export const MODAL_TONES: Readonly<ReturnType<typeof buildModalTones>> = buildModalTones();

registerThemeRefresh(() => Object.assign(MODAL_TONES as Record<string, string>, buildModalTones()));
