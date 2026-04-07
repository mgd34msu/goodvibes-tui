/**
 * Tests for renderBookmarkModal.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { BookmarkModal } from '../../input/bookmark-modal.ts';
import { getBookmarkManager } from '../../bookmarks/manager.ts';
import { renderBookmarkModal } from '../../renderer/bookmark-modal.ts';
import { lineToString, linesToText } from '../setup.ts';

const W = 120;

function seedBookmarks(count: number): void {
  const bm = getBookmarkManager();
  bm.clear();
  for (let i = 0; i < count; i++) {
    bm.toggle(`key_${i}`, `block_label_${i}`);
  }
}

describe('renderBookmarkModal', () => {
  let modal: BookmarkModal;

  beforeEach(() => {
    getBookmarkManager().clear();
    modal = new BookmarkModal();
  });

  test('returns an array of Lines', () => {
    modal.open();
    const lines = renderBookmarkModal(modal, W);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('each line has correct terminal width', () => {
    modal.open();
    const lines = renderBookmarkModal(modal, W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('title bar contains "Bookmarks"', () => {
    modal.open();
    const lines = renderBookmarkModal(modal, W);
    const titleLine = lineToString(lines[0]);
    expect(titleLine).toContain('Bookmarks');
  });

  test('footer contains navigation hints', () => {
    modal.open();
    const lines = renderBookmarkModal(modal, W);
    const footerLine = lineToString(lines[lines.length - 1]);
    expect(footerLine).toContain('Navigate');
    expect(footerLine).toContain('Esc');
  });

  test('renders bookmark entries in list', () => {
    seedBookmarks(3);
    modal.open();
    const lines = renderBookmarkModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('key_0');
    expect(texts).toContain('key_1');
  });

  test('shows selection indicator on selected item', () => {
    seedBookmarks(3);
    modal.open();
    const lines = renderBookmarkModal(modal, W);
    const hasArrow = lines.some(line => line.some(cell => cell.char === '>'));
    expect(hasArrow).toBe(true);
  });

  test('renders empty state when no bookmarks', () => {
    modal.open();
    const lines = renderBookmarkModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('No bookmarks');
  });

  test('shows scroll counter in title when bookmarks present', () => {
    seedBookmarks(5);
    modal.open();
    const lines = renderBookmarkModal(modal, W);
    const titleLine = lineToString(lines[0]);
    expect(titleLine).toContain('1/5');
  });

  test('lines are correct at narrow terminal width', () => {
    seedBookmarks(2);
    modal.open();
    const narrowW = 60;
    const lines = renderBookmarkModal(modal, narrowW);
    for (const line of lines) {
      expect(line.length).toBe(narrowW);
    }
  });

  test('footer hints include Enter, d, o actions', () => {
    modal.open();
    const lines = renderBookmarkModal(modal, W);
    const footerLine = lineToString(lines[lines.length - 1]);
    expect(footerLine).toContain('Enter');
    expect(footerLine).toContain('Remove');
  });
});
