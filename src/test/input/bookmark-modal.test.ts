/**
 * Tests for BookmarkModal state class.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { BookmarkModal } from '../../input/bookmark-modal.ts';
import { createTestManagers } from '../helpers/test-managers.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let bookmarkManager = createTestManagers().bookmarkManager;

function seedBookmarks(count: number): void {
  const bm = bookmarkManager;
  for (let i = 0; i < count; i++) {
    bm.toggle(`key_${i}`, `label_${i}`);
  }
}

// ---------------------------------------------------------------------------
// BookmarkModal
// ---------------------------------------------------------------------------

describe('BookmarkModal', () => {
  let modal: BookmarkModal;

  beforeEach(() => {
    bookmarkManager = createTestManagers().bookmarkManager;
    bookmarkManager.clear();
    modal = new BookmarkModal(bookmarkManager);
  });

  describe('open()', () => {
    test('sets active to true', () => {
      modal.open();
      expect(modal.active).toBe(true);
    });

    test('loads entries from bookmark manager', () => {
      seedBookmarks(3);
      modal.open();
      expect(modal.entries.length).toBe(3);
    });

    test('resets selectedIndex and scrollOffset', () => {
      seedBookmarks(3);
      modal.open();
      modal.moveDown();
      modal.open();
      expect(modal.selectedIndex).toBe(0);
      expect(modal.scrollOffset).toBe(0);
    });

    test('entries are empty when no bookmarks', () => {
      modal.open();
      expect(modal.entries).toHaveLength(0);
    });
  });

  describe('close()', () => {
    test('sets active to false', () => {
      modal.open();
      modal.close();
      expect(modal.active).toBe(false);
    });
  });

  describe('moveUp() / moveDown()', () => {
    test('moveDown increments selectedIndex', () => {
      seedBookmarks(3);
      modal.open();
      modal.moveDown();
      expect(modal.selectedIndex).toBe(1);
    });

    test('moveDown wraps around', () => {
      seedBookmarks(2);
      modal.open();
      modal.moveDown();
      modal.moveDown();
      expect(modal.selectedIndex).toBe(0);
    });

    test('moveUp wraps to last', () => {
      seedBookmarks(3);
      modal.open();
      modal.moveUp();
      expect(modal.selectedIndex).toBe(2);
    });

    test('no-op when no entries', () => {
      modal.moveDown();
      modal.moveUp();
      expect(modal.selectedIndex).toBe(0);
    });
  });

  describe('getSelected()', () => {
    test('returns null when no entries', () => {
      expect(modal.getSelected()).toBeNull();
    });

    test('returns first entry after open', () => {
      seedBookmarks(2);
      modal.open();
      const sel = modal.getSelected();
      expect(sel).not.toBeNull();
      expect(sel!.key).toBe('key_0');
    });

    test('returns correct entry after navigation', () => {
      seedBookmarks(3);
      modal.open();
      modal.moveDown();
      const sel = modal.getSelected();
      expect(sel!.key).toBe('key_1');
    });
  });

  describe('removeSelected()', () => {
    test('removes the selected entry', () => {
      seedBookmarks(3);
      modal.open();
      const removed = modal.removeSelected();
      expect(removed).not.toBeNull();
      expect(removed!.key).toBe('key_0');
      expect(modal.entries.length).toBe(2);
    });

    test('returns null when no entries', () => {
      modal.open();
      expect(modal.removeSelected()).toBeNull();
    });

    test('clamps selectedIndex after removal', () => {
      seedBookmarks(2);
      modal.open();
      modal.moveDown(); // selectedIndex = 1
      modal.removeSelected();
      // After removing last entry, index should clamp to 0
      expect(modal.selectedIndex).toBe(0);
    });

    test('updates entries after removal', () => {
      seedBookmarks(3);
      modal.open();
      modal.removeSelected();
      // Refresh: open again to see updated list from manager
      const remaining = modal.entries;
      expect(remaining.every(e => e.key !== 'key_0')).toBe(true);
    });
  });

  describe('scroll clamping', () => {
    test('scrollOffset follows selectedIndex when it exceeds VISIBLE_ROWS', () => {
      const count = BookmarkModal.VISIBLE_ROWS + 3;
      seedBookmarks(count);
      modal.open();
      // Move down past visible rows
      for (let i = 0; i < BookmarkModal.VISIBLE_ROWS; i++) {
        modal.moveDown();
      }
      expect(modal.scrollOffset).toBeGreaterThan(0);
    });

    test('scrollOffset goes back to 0 when scrolling back up', () => {
      const count = BookmarkModal.VISIBLE_ROWS + 3;
      seedBookmarks(count);
      modal.open();
      for (let i = 0; i < BookmarkModal.VISIBLE_ROWS + 2; i++) {
        modal.moveDown();
      }
      // One more moveDown wraps from the last index back to 0
      const remaining = count - (BookmarkModal.VISIBLE_ROWS + 2);
      for (let i = 0; i < remaining; i++) {
        modal.moveDown();
      }
      expect(modal.selectedIndex).toBe(0);
      expect(modal.scrollOffset).toBe(0);
    });
  });
});
