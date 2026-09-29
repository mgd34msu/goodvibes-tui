/**
 * overlay-filter.ts, the always-live search row state for the help and
 * keyboard-shortcuts overlays. Their visibility and scroll offsets are plain
 * handler fields copied through the feed context; the query lives in these
 * long-lived objects instead, shared by reference between the input route
 * (which types into it) and the renderer (which filters with it and records
 * how far the list can scroll, so ↓ never runs past the end).
 */

export class OverlayFilter {
  /** Typed filter text. */
  public query = '';
  /** Largest useful scroll offset for the current query, recorded by the renderer. */
  public maxScroll = 0;

  clear(): void {
    this.query = '';
    this.maxScroll = 0;
  }
}

/** One filter per overlay. */
export class OverlayFilters {
  public readonly help = new OverlayFilter();
  public readonly shortcuts = new OverlayFilter();
}
