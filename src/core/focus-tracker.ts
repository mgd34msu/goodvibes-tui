/**
 * focus-tracker — tracks whether the terminal window currently has OS-level
 * input focus, using the terminal focus-reporting protocol (DECSET ?1004h,
 * enabled at terminal setup in main.ts). The SDK's InputTokenizer already
 * parses the resulting `\x1b[I` (focus-in) / `\x1b[O` (focus-out) sequences
 * into `{ type: 'focus', action }` tokens (platform/core/tokenizer.ts); this
 * module is the single place those tokens land (consumed in
 * src/input/handler-feed.ts's feedInputTokens()).
 *
 * Honest degradation: a terminal that does not implement focus reporting
 * (or a multiplexer that swallows the sequences) never sends focus tokens.
 * In that case `isFocused()` stays `null` forever — "unknown", never a
 * guessed `true`/`false`. Callers that gate a user-facing behavior on focus
 * (e.g. the unfocused-alert notifiers in this directory) must treat `null`
 * the same as "not focused" per the fallback rule: alerts fire when the
 * terminal is definitely unfocused OR when focus state was never observed.
 */
export class FocusTracker {
  private focused: boolean | null = null;

  /** True/false once at least one focus token has arrived; null if none ever has. */
  isFocused(): boolean | null {
    return this.focused;
  }

  /** Called from the input pipeline on every focus token. */
  setFocused(value: boolean): void {
    this.focused = value;
  }

  /**
   * The alert-gating rule shared by every unfocused-alert notifier: fire
   * when the terminal is known to be unfocused, or when focus was never
   * observed (honest fallback — never silently suppress on an unknown
   * terminal). Only `isFocused() === true` (a real, observed focus-in with
   * no observed focus-out since) suppresses an alert.
   */
  shouldAlertWhenUnfocused(): boolean {
    return this.focused !== true;
  }
}
