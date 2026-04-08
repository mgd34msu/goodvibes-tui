import { describe, test, expect, beforeEach } from 'bun:test';
import { SelectionModal } from '../../input/selection-modal.ts';
import type { SelectionItem } from '../../input/selection-modal.ts';

const mkItems = (count: number): SelectionItem[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    label: `Item ${i}`,
    detail: `detail-${i}`,
  }));

describe('SelectionModal', () => {
  let modal: SelectionModal;

  beforeEach(() => {
    modal = new SelectionModal();
  });

  // ── open() ─────────────────────────────────────────────────────────────────

  describe('open()', () => {
    test('with preSelectId pre-selects the correct item', () => {
      const items = mkItems(5);
      modal.open('Test', items, { preSelectId: 'item-3' });
      expect(modal.selectedIndex).toBe(3);
      expect(modal.getSelected()?.id).toBe('item-3');
    });

    test('with invalid preSelectId defaults to first item', () => {
      const items = mkItems(3);
      modal.open('Test', items, { preSelectId: 'nonexistent' });
      expect(modal.selectedIndex).toBe(0);
    });

    test('without preSelectId selects first item', () => {
      const items = mkItems(4);
      modal.open('Test', items);
      expect(modal.selectedIndex).toBe(0);
      expect(modal.getSelected()?.id).toBe('item-0');
    });

    test('sets active to true', () => {
      modal.open('Test', mkItems(2));
      expect(modal.active).toBe(true);
    });

    test('sets title', () => {
      modal.open('My Title', mkItems(1));
      expect(modal.title).toBe('My Title');
    });

    test('populates filteredItems', () => {
      const items = mkItems(3);
      modal.open('Test', items);
      expect(modal.filteredItems).toHaveLength(3);
    });

    test('starts with list focus even when search is allowed', () => {
      modal.open('Test', mkItems(2), { allowSearch: true });
      expect(modal.searchFocused).toBe(false);
    });
  });

  // ── close() ────────────────────────────────────────────────────────────────

  describe('close()', () => {
    test('resets all state', () => {
      modal.open('Test', mkItems(3));
      modal.close();
      expect(modal.active).toBe(false);
      expect(modal.title).toBe('');
      expect(modal.query).toBe('');
      expect(modal.items).toHaveLength(0);
      expect(modal.filteredItems).toHaveLength(0);
      expect(modal.selectedIndex).toBe(0);
      expect(modal.customActions.size).toBe(0);
      expect(modal.searchFocused).toBe(false);
    });
  });

  describe('search focus', () => {
    test('can focus and blur search when allowed', () => {
      modal.open('Test', mkItems(3), { allowSearch: true });
      modal.focusSearch();
      expect(modal.searchFocused).toBe(true);
      modal.blurSearch();
      expect(modal.searchFocused).toBe(false);
    });

    test('does not focus search when disabled', () => {
      modal.open('Test', mkItems(3), { allowSearch: false });
      modal.focusSearch();
      expect(modal.searchFocused).toBe(false);
    });
  });

  // ── moveUp() / moveDown() ──────────────────────────────────────────────────

  describe('moveDown()', () => {
    test('advances selection', () => {
      modal.open('Test', mkItems(3));
      modal.moveDown();
      expect(modal.selectedIndex).toBe(1);
    });

    test('wraps around to first item', () => {
      const items = mkItems(3);
      modal.open('Test', items);
      modal.moveDown();
      modal.moveDown();
      modal.moveDown();
      expect(modal.selectedIndex).toBe(0);
    });
  });

  describe('moveUp()', () => {
    test('moves selection backwards', () => {
      const items = mkItems(3);
      modal.open('Test', items);
      modal.moveDown();
      modal.moveDown();
      modal.moveUp();
      expect(modal.selectedIndex).toBe(1);
    });

    test('wraps around to last item from first', () => {
      modal.open('Test', mkItems(3));
      modal.moveUp();
      expect(modal.selectedIndex).toBe(2);
    });
  });

  // ── setQuery() ─────────────────────────────────────────────────────────────

  describe('setQuery()', () => {
    test('filters items by fuzzy match', () => {
      const items: SelectionItem[] = [
        { id: 'apple', label: 'Apple' },
        { id: 'banana', label: 'Banana' },
        { id: 'apricot', label: 'Apricot' },
      ];
      modal.open('Test', items);
      modal.setQuery('ap');
      const ids = modal.filteredItems.map(i => i.id);
      expect(ids).toContain('apple');
      expect(ids).toContain('apricot');
      expect(ids).not.toContain('banana');
    });

    test('clamps selectedIndex when filtered list shrinks', () => {
      const items = mkItems(10);
      modal.open('Test', items);
      modal.selectedIndex = 8;
      // Filter to only items matching "Item 0"
      modal.setQuery('Item 0');
      expect(modal.selectedIndex).toBeLessThan(modal.filteredItems.length || 1);
    });

    test('empty query restores all items', () => {
      const items = mkItems(5);
      modal.open('Test', items);
      modal.setQuery('Item 0');
      modal.setQuery('');
      expect(modal.filteredItems).toHaveLength(5);
    });

    test('resets selectedIndex to 0', () => {
      const items = mkItems(5);
      modal.open('Test', items);
      modal.moveDown();
      modal.moveDown();
      modal.setQuery('Item 1');
      expect(modal.selectedIndex).toBe(0);
    });
  });

  // ── getSelected() ──────────────────────────────────────────────────────────

  describe('getSelected()', () => {
    test('returns null when no items', () => {
      modal.open('Test', []);
      expect(modal.getSelected()).toBeNull();
    });

    test('returns the highlighted item', () => {
      const items = mkItems(3);
      modal.open('Test', items);
      modal.moveDown();
      expect(modal.getSelected()?.id).toBe('item-1');
    });

    test('returns null when modal has never been opened', () => {
      expect(modal.getSelected()).toBeNull();
    });
  });

  // ── fuzzy match quality ────────────────────────────────────────────────────

  describe('fuzzy match scoring', () => {
    test('substring match scores higher than char-by-char match', () => {
      // "app" is a substring of "Application" but char-by-char matches "Async pipe pump"
      const items: SelectionItem[] = [
        { id: 'charbycharpipe', label: 'Async pipe pump' }, // a...p...p via chars
        { id: 'substring', label: 'Application' },         // "app" substring
      ];
      modal.open('Test', items);
      modal.setQuery('app');
      // Both should match; substring match should appear first (higher score)
      expect(modal.filteredItems.length).toBeGreaterThanOrEqual(1);
      expect(modal.filteredItems[0].id).toBe('substring');
    });
  });

  // ── category items ─────────────────────────────────────────────────────────

  describe('category items', () => {
    test('items with category field are included in filtered results', () => {
      const items: SelectionItem[] = [
        { id: 'a', label: 'Alpha', category: 'Group A' },
        { id: 'b', label: 'Beta', category: 'Group B' },
        { id: 'c', label: 'Gamma', category: 'Group A' },
      ];
      modal.open('Test', items);
      expect(modal.filteredItems).toHaveLength(3);
    });

    test('category items are included in fuzzy search results', () => {
      const items: SelectionItem[] = [
        { id: 'a', label: 'Alpha', category: 'Fruits' },
        { id: 'b', label: 'Beta', category: 'Vegetables' },
      ];
      modal.open('Test', items);
      // searching for category text should match via category field in fuzzy search
      modal.setQuery('Fruits');
      const ids = modal.filteredItems.map(i => i.id);
      expect(ids).toContain('a');
    });
  });

  // ── customActions ──────────────────────────────────────────────────────────

  describe('customActions', () => {
    test('open() sets provided customActions', () => {
      const actions = new Map([['d', 'delete' as const]]);
      modal.open('Test', mkItems(2), { customActions: actions });
      expect(modal.customActions.get('d')).toBe('delete');
    });

    test('open() defaults to empty customActions when not provided', () => {
      modal.open('Test', mkItems(2));
      expect(modal.customActions.size).toBe(0);
    });
  });
});
