/**
 * transcript-scroll.ts, where the main transcript is scrolled to.
 *
 *   top      the first transcript line on screen
 *   locked   parked at the live bottom: each frame follows the tail
 *
 * Scrolling up (the mouse wheel, PageUp, Up past the input history) unlocks
 * it; reaching the bottom again, Esc (handler-modal-stack.ts), or submitting
 * input locks it again. While it is unlocked the back-to-bottom pill shows
 * above the input area (back-to-bottom.ts) and Esc returns to the bottom
 * instead of interrupting the running turn.
 */

export class TranscriptScroll {
  /** The first transcript line on screen. */
  top = 0;
  /** Parked at the live bottom, following the tail. */
  locked = true;
  /** The clamp the last frame computed (overlay- and footer-aware); null before the first frame. */
  private lastMax: number | null = null;

  /** Away from the live bottom: the pill shows and Esc goes back down. */
  get scrolledBack(): boolean {
    return !this.locked;
  }

  /**
   * Scroll by `delta` lines (negative is up). `fallbackMax` is used only
   * before the first frame has computed the real clamp.
   */
  scrollBy(delta: number, fallbackMax: () => number): void {
    const max = this.lastMax ?? fallbackMax();
    this.top = Math.max(0, Math.min(this.top + delta, max));
    this.locked = this.top >= max;
  }

  /** Back to the live bottom: the next frame follows the tail again. */
  toBottom(): void {
    this.locked = true;
  }

  /** Show `line` at the top (a bookmark, a search hit); unlocks unless that is the bottom. */
  jumpTo(line: number, max?: number): void {
    this.locked = false;
    this.top = Math.max(0, max === undefined ? line : Math.min(line, max));
  }

  /** Follow the tail while locked (the stream path). */
  followTail(lineCount: number, viewportHeight: number): void {
    if (!this.locked) return;
    this.top = Math.max(0, lineCount - viewportHeight);
  }

  /**
   * Take the frame's clamp. Unlocked but already at the bottom (a jump that
   * landed there, output that shrank) is the live bottom: lock again.
   * Returns true when that re-lock happened.
   */
  settle(nextTop: number, maxScroll: number): boolean {
    this.top = nextTop;
    this.lastMax = maxScroll;
    if (!this.locked && nextTop >= maxScroll) {
      this.locked = true;
      return true;
    }
    return false;
  }
}
