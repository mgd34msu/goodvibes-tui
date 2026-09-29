/**
 * Tests for renderBookmarkModal (modal surface kit) and its always-live
 * search row routing.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { BookmarkModal } from '../../input/bookmark-modal.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import { renderBookmarkModal } from '../../renderer/bookmark-modal.ts';
import { handleBookmarkModalToken } from '../../input/handler-modal-routes.ts';
import { activeTokens } from '../../renderer/theme.ts';
import { layerText, layerTextBlock } from '../helpers/surface-frame.ts';

const W = 120;
const H = 30;
const bookmarkManager = createTestManagers().bookmarkManager;

function seedBookmarks(count: number): void {
  bookmarkManager.clear();
  for (let i = 0; i < count; i++) {
    bookmarkManager.toggle(`key_${i}`, `block_label_${i}`);
  }
}

describe('renderBookmarkModal', () => {
  let modal: BookmarkModal;

  beforeEach(() => {
    bookmarkManager.clear();
    modal = new BookmarkModal(bookmarkManager);
  });

  test('draws a kit modal inside the screen: caps, title, no box frame', () => {
    modal.open();
    const layer = renderBookmarkModal(modal, W, H);
    expect(layer.x).toBeGreaterThanOrEqual(0);
    expect(layer.x + layer.lines[0]!.length).toBeLessThanOrEqual(W);
    expect(layer.y + layer.lines.length).toBeLessThanOrEqual(H);
    const rows = layerText(layer);
    expect(rows[0]).toMatch(/^▄+$/);
    expect(rows[rows.length - 1]).toMatch(/^▀+$/);
    expect(rows[2]).toContain('Bookmarks');
    expect(layerTextBlock(layer)).not.toMatch(/[┌┐└┘│]/);
  });

  test('keycap hints: move, jump, open file, remove', () => {
    modal.open();
    const text = layerTextBlock(renderBookmarkModal(modal, W, H));
    expect(text).toContain('↑↓  move');
    expect(text).toContain('⏎  jump');
    expect(text).toContain('o  open file');
    expect(text).toContain('d  remove');
  });

  test('renders bookmark entries with their keys and the selected row as the gradient', () => {
    seedBookmarks(3);
    modal.open();
    const layer = renderBookmarkModal(modal, W, H);
    const text = layerTextBlock(layer);
    expect(text).toContain('block_label_0');
    expect(text).toContain('key_1');
    const ink = activeTokens().selectedListItemText;
    const selected = layer.lines.findIndex((line) => line.some((c) => c.fg === ink && c.bold && c.char.trim() !== ''));
    expect(layerText(layer)[selected]).toContain('block_label_0');
  });

  test('renders the empty state when there are no bookmarks', () => {
    modal.open();
    expect(layerTextBlock(renderBookmarkModal(modal, W, H))).toContain('No bookmarks yet');
  });

  test('shows the selected position in the title', () => {
    seedBookmarks(5);
    modal.open();
    expect(layerText(renderBookmarkModal(modal, W, H))[2]).toContain('1/5');
  });

  test('the search row filters by key and label and reports a truthful count', () => {
    seedBookmarks(12);
    modal.open();
    modal.setQuery('label_1');
    const text = layerTextBlock(renderBookmarkModal(modal, W, H));
    expect(text).toContain('label_1▏');
    expect(text).toContain('3 of 12'); // block_label_1, _10, _11
    expect(text).not.toContain('block_label_2');
  });

  test('narrow screens take the full width minus one column per side', () => {
    seedBookmarks(2);
    modal.open();
    const layer = renderBookmarkModal(modal, 60, 24);
    expect(layer.x).toBe(1);
    expect(layer.lines[0]!.length).toBe(58);
  });
});

describe('handleBookmarkModalToken (always-live search row)', () => {
  function state(modal: BookmarkModal, escapes: { n: number }) {
    return { bookmarkModal: modal, requestRender: () => {}, handleEscape: () => { escapes.n++; modal.close(); } };
  }

  test('d removes while the query is empty; once typing, d is a character', () => {
    seedBookmarks(3);
    const modal = new BookmarkModal(bookmarkManager);
    modal.open();
    const escapes = { n: 0 };
    handleBookmarkModalToken(state(modal, escapes), { type: 'text', value: 'd' } as never);
    expect(modal.entries.length).toBe(2);
    handleBookmarkModalToken(state(modal, escapes), { type: 'text', value: 'k' } as never);
    handleBookmarkModalToken(state(modal, escapes), { type: 'text', value: 'd' } as never);
    expect(modal.query).toBe('kd');
    expect(modal.entries.length).toBe(2);
    handleBookmarkModalToken(state(modal, escapes), { type: 'key', logicalName: 'backspace' } as never);
    expect(modal.query).toBe('k');
  });

  test('Esc closes in one press, whatever the query holds', () => {
    seedBookmarks(3);
    const modal = new BookmarkModal(bookmarkManager);
    modal.open();
    const escapes = { n: 0 };
    handleBookmarkModalToken(state(modal, escapes), { type: 'text', value: 'label' } as never);
    handleBookmarkModalToken(state(modal, escapes), { type: 'key', logicalName: 'escape' } as never);
    expect(escapes.n).toBe(1);
    expect(modal.active).toBe(false);
  });
});
