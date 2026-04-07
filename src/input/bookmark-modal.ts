/**
 * BookmarkModal — state management for the /bookmarks command modal.
 *
 * Lists bookmarks from BookmarkManager and tracks UI state:
 * selected index, scroll offset, and pending action.
 */

import { getBookmarkManager, type BookmarkEntry } from '../bookmarks/manager.ts';

// ---------------------------------------------------------------------------
// BookmarkModal
// ---------------------------------------------------------------------------

export class BookmarkModal {
  public static readonly DEFAULT_VISIBLE_ROWS = 8;
  public static readonly VISIBLE_ROWS = BookmarkModal.DEFAULT_VISIBLE_ROWS;
  public active = false;
  public entries: BookmarkEntry[] = [];
  public selectedIndex = 0;
  /** Scroll offset for the list (number of items scrolled past the top). */
  public scrollOffset = 0;
  /** Max visible list rows. */
  public visibleRows = BookmarkModal.DEFAULT_VISIBLE_ROWS;

  private bookmarkManager!: ReturnType<typeof getBookmarkManager>;
  // Note: bookmarkManager is initialized lazily in open() to pick up any state changes

  /**
   * open - Load current bookmarks and show the modal.
   */
  open(): void {
    this.bookmarkManager = getBookmarkManager();
    this.entries = this.bookmarkManager.list();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.active = true;
  }

  close(): void {
    this.active = false;
  }

  setVisibleRows(rows: number): void {
    this.visibleRows = Math.max(3, rows);
    this._clampScroll();
  }

  moveUp(): void {
    if (this.entries.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.entries.length) % this.entries.length;
    this._clampScroll();
  }

  moveDown(): void {
    if (this.entries.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.entries.length;
    this._clampScroll();
  }

  getSelected(): BookmarkEntry | null {
    return this.entries[this.selectedIndex] ?? null;
  }

  /**
   * removeSelected - Remove the currently selected bookmark and refresh the list.
   * Returns the removed entry, or null if nothing was selected.
   */
  removeSelected(): BookmarkEntry | null {
    const entry = this.getSelected();
    if (!entry) return null;
    this.bookmarkManager.toggle(entry.key); // toggle off = remove
    this.entries = this.bookmarkManager.list();
    // Clamp selectedIndex after removal
    if (this.entries.length === 0) {
      this.selectedIndex = 0;
    } else if (this.selectedIndex >= this.entries.length) {
      this.selectedIndex = this.entries.length - 1;
    }
    this._clampScroll();
    return entry;
  }

  /**
   * openSelectedFile - Load the saved file content for the selected entry.
   * Returns file content string, or null if no saved file exists for the key.
   */
  openSelectedFile(): string | null {
    const entry = this.getSelected();
    if (!entry) return null;
    // Derive the filename from the key (saved as <timestamp>-<label>.txt)
    // We list all saved files and look for one containing the entry key in the name
    const files = this.bookmarkManager.listSavedFiles();
    const match = files.find((f) => {
      const base = f.split('/').pop() ?? '';
      return base.includes(entry.key) ||
        base.includes(entry.label.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 40));
    });
    if (!match) return null;
    const name = match.split('/').pop()!;
    return this.bookmarkManager.loadSavedFile(name);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _clampScroll(): void {
    const visRows = Math.max(3, this.visibleRows);
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + visRows) {
      this.scrollOffset = this.selectedIndex - visRows + 1;
    }
    const maxOffset = Math.max(0, this.entries.length - visRows);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
  }
}
