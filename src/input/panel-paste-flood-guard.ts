// ---------------------------------------------------------------------------
// panel-paste-flood-guard.ts — DEBT-5 item 5.
//
// A terminal WITHOUT bracketed paste delivers a pasted block as a burst of
// discrete 1-char 'text' tokens (isPasteToken stays false for every one of
// them, since that flag only fires for a single token whose value.length > 1
// — see handler-feed-routes.ts's own Invariant B doc). Before this guard,
// each such character became a real panel hotkey on a focused non-capturing
// panel (K arms kill, etc.) once it reached handlePanelFocusToken's per-char
// dispatch loop.
//
// This is a RATE guard: more than PANEL_PASTE_FLOOD_THRESHOLD qualifying
// tokens within the trailing PANEL_PASTE_FLOOD_WINDOW_MS, evaluated with a
// real sliding window (old timestamps age out of `timestamps` every call).
// It is deliberately NOT the retired per-feed char-SUM burst heuristic this
// same input layer already tore out once (see panel-focus-burst.test.ts's
// header doc): that old guard summed one feed()'s character count with no
// timing signal at all, so two ordinary nav keystrokes landing in a single
// feed() — a real, common case, not an edge case — were misread as a burst
// and focus was silently flipped to the composer. This guard:
//   - never touches focus (panelFocused is untouched by trackPanelPasteFloodGuard
//     and by its caller);
//   - is keyed on WALL-CLOCK TIMING, not a per-feed token count, so it
//     doesn't care how many tokens land in one feed() call, only how fast
//     they arrive relative to each other;
//   - is sticky once tripped (only a quiet gap — no qualifying token for a
//     full window — clears it) so it doesn't flap dispatch on/off as the
//     count oscillates near the threshold mid-flood.
//
// ~8 keys/120ms is far beyond sustained human typing (a fast typist peaks
// well under that inter-key rate over any real span) but is exactly the
// shape an unbracketed paste replay takes. It also keeps the pre-existing
// Invariant B regression tests (2 keys in one feed(), no timing control at
// all) far under threshold while catching a real flood within its first ~9
// characters.
// ---------------------------------------------------------------------------

export const PANEL_PASTE_FLOOD_WINDOW_MS = 120;
export const PANEL_PASTE_FLOOD_THRESHOLD = 8;

/**
 * Guard state — a single persistent instance lives on the caller's
 * long-lived context (handler-feed.ts's InputFeedContext, mirroring how that
 * object already owns `nextPasteId`/`mouseDownRow`/etc.) and is MUTATED IN
 * PLACE by trackPanelPasteFloodGuard below, never replaced — so callers never
 * need to thread a return value back into their own state (unlike
 * `panelFocused`, which handlePanelFocusToken returns because it is NOT a
 * mutable outparam).
 */
export interface PanelBurstGuardState {
  timestamps: readonly number[];
  suspended: boolean;
  hintShown: boolean;
}

export interface PanelBurstGuardResult {
  /** False while suspended — the caller must drop this token, not dispatch it. */
  readonly dispatch: boolean;
  /** True exactly once per burst: the call that just tripped suspension. */
  readonly showHintNow: boolean;
}

/** Advance `guard` (mutated in place) by one qualifying token at time `now` (ms). */
export function trackPanelPasteFloodGuard(guard: PanelBurstGuardState, now: number): PanelBurstGuardResult {
  const lastAt = guard.timestamps.length > 0 ? guard.timestamps[guard.timestamps.length - 1]! : -Infinity;
  const isQuietGap = now - lastAt > PANEL_PASTE_FLOOD_WINDOW_MS;
  if (isQuietGap && guard.suspended) {
    // A silence at least as long as the window means whatever burst was
    // happening has ended — un-suspend so a LATER burst gets its own fresh
    // count and its own one-shot hint.
    guard.suspended = false;
    guard.hintShown = false;
  }
  guard.timestamps = isQuietGap
    ? [now]
    : [...guard.timestamps.filter((t) => t > now - PANEL_PASTE_FLOOD_WINDOW_MS), now];
  if (guard.timestamps.length > PANEL_PASTE_FLOOD_THRESHOLD) {
    guard.suspended = true;
  }
  let showHintNow = false;
  if (guard.suspended && !guard.hintShown) {
    guard.hintShown = true;
    showHintNow = true;
  }
  return { dispatch: !guard.suspended, showHintNow };
}
