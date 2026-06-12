// ---------------------------------------------------------------------------
// KillRing — emacs/readline-compatible kill ring implementation.
//
// The ring holds up to MAX_ENTRIES text strings. Kill commands push to the
// head. Yank pastes from the current yank pointer (default: head). Yank-pop
// rotates the pointer one step further into the ring without adding a new
// entry. Consecutive yank-pops cycle through all ring entries.
//
// Word-boundary helpers are co-located here because they are used by both
// kill-word-back (Ctrl+W) and kill-word-forward (Alt+D).
// ---------------------------------------------------------------------------

export const KILL_RING_MAX = 32;

/**
 * KillRing — bounded circular ring of killed text segments.
 *
 * All public mutation methods are pure-functional helpers at module level;
 * this class owns the mutable state so the handler can hold a single ref.
 */
export class KillRing {
  private entries: string[] = [];
  /** Index into `entries` for the next yank. -1 means the ring is empty. */
  private yankPointer = -1;
  /** Whether the last edit action was a yank (enables yank-pop). */
  public lastActionWasYank = false;

  /**
   * Push a text segment onto the head of the ring.
   * Trims the ring to MAX_ENTRIES. Resets the yank pointer to 0 (head).
   * Empty strings are silently ignored.
   */
  push(text: string): void {
    if (!text) return;
    this.entries.unshift(text);
    if (this.entries.length > KILL_RING_MAX) {
      this.entries.length = KILL_RING_MAX;
    }
    this.yankPointer = 0;
    this.lastActionWasYank = false;
  }

  /**
   * Yank — return the entry at the current yank pointer.
   * Returns '' if the ring is empty.
   * Sets lastActionWasYank so a subsequent yank-pop is valid.
   */
  yank(): string {
    if (this.entries.length === 0) return '';
    this.yankPointer = Math.max(0, Math.min(this.yankPointer, this.entries.length - 1));
    this.lastActionWasYank = true;
    return this.entries[this.yankPointer] ?? '';
  }

  /**
   * YankPop — advance the yank pointer by one step (wrapping) and return the
   * new entry. Only valid after a yank; if the ring has <=1 entry, returns the
   * same string. Returns '' if the ring is empty.
   */
  yankPop(): string {
    if (this.entries.length === 0) return '';
    this.yankPointer = (this.yankPointer + 1) % this.entries.length;
    this.lastActionWasYank = true;
    return this.entries[this.yankPointer] ?? '';
  }

  /** True when there is at least one entry in the ring. */
  get hasEntries(): boolean {
    return this.entries.length > 0;
  }

  /** Current ring contents (newest first). Read-only snapshot for tests. */
  getEntries(): readonly string[] {
    return this.entries;
  }

  /** Reset yank state when the user makes a non-yank edit. */
  clearYankState(): void {
    this.lastActionWasYank = false;
  }
}

// ---------------------------------------------------------------------------
// Word boundary helpers
// ---------------------------------------------------------------------------

/**
 * isWordChar — true when the character is a "word" character.
 * Word = letter (Unicode), digit, or underscore. This is the emacs/readline
 * word boundary definition used for Alt+B, Alt+F, Ctrl+W, Alt+D.
 */
function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch);
}

/**
 * wordBoundaryBack — find the start of the word that the cursor is in, or the
 * start of the previous word if the cursor is at a non-word character.
 *
 * Emacs Alt+B semantics:
 *   - Skip non-word chars backward
 *   - Skip word chars backward
 *   - Return resulting position
 *
 * Returns the new cursor position (>= 0).
 */
export function wordBoundaryBack(text: string, pos: number): number {
  let p = pos;
  // Skip non-word chars first (move past punctuation/spaces)
  while (p > 0 && !isWordChar(text[p - 1]!)) p--;
  // Then skip word chars (the word body)
  while (p > 0 && isWordChar(text[p - 1]!)) p--;
  return p;
}

/**
 * wordBoundaryForward — find the position just past the end of the next word.
 *
 * Emacs Alt+F semantics:
 *   - Skip non-word chars forward
 *   - Skip word chars forward
 *   - Return resulting position
 *
 * Returns the new cursor position (<= text.length).
 */
export function wordBoundaryForward(text: string, pos: number): number {
  let p = pos;
  const len = text.length;
  // Skip non-word chars first
  while (p < len && !isWordChar(text[p]!)) p++;
  // Then skip word chars
  while (p < len && isWordChar(text[p]!)) p++;
  return p;
}
