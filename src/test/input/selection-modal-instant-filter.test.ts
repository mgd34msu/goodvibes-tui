/**
 * SelectionModal-based pickers (/help, /tools, /sessions, /bookmarks, TTS
 * provider/voice, ...): the search row is always live. There is no search
 * mode to enter:
 *   - an unclaimed keystroke goes straight into the query;
 *   - a claimed hotkey letter (e.g. /bookmarks' 'd' for delete) fires its
 *     action while the query is empty, and is typed once a query exists;
 *   - Escape ALWAYS closes in one press, regardless of the query.
 */
import { describe, expect, test } from 'bun:test';
import { handleSelectionModalToken } from '../../input/handler-modal-routes.ts';
import { SelectionModal } from '../../input/selection-modal.ts';
import type { SelectionAction } from '../../input/selection-modal.ts';

function buildState(modal: SelectionModal, overrides: Record<string, unknown> = {}) {
  return {
    selectionModal: modal,
    selectionCallback: null,
    modalStack: ['selection'],
    requestRender: () => {},
    handleEscape: () => {
      modal.close();
    },
    ...overrides,
  };
}

describe('SelectionModal instant filter (item 3a)', () => {
  test('/help-shaped modal (allowSearch, no customActions): an unclaimed letter goes straight into the query', () => {
    const modal = new SelectionModal();
    modal.open('Help: Commands', [
      { id: '/model', label: '/model' },
      { id: '/config', label: '/config' },
    ], { allowSearch: true });

    const state = buildState(modal);
    const result = handleSelectionModalToken(state, { type: 'text', value: 'c' });

    expect(result).toBe(true);
    expect(modal.query).toBe('c');
  });

  test("'/' is an ordinary character (command labels contain it)", () => {
    const modal = new SelectionModal();
    modal.open('Help: Commands', [{ id: '/model', label: '/model' }], { allowSearch: true });
    const state = buildState(modal);

    handleSelectionModalToken(state, { type: 'text', value: '/' });
    handleSelectionModalToken(state, { type: 'text', value: 'mo' });
    expect(modal.query).toBe('/mo');
    expect(modal.filteredItems.map((item) => item.id)).toEqual(['/model']);
  });

  test('a claimed hotkey letter still fires its action instead of arming search (no regression to /bookmarks-style pickers)', () => {
    let dispatched: string | null = null;
    const customActions = new Map<string, SelectionAction>([['d', 'delete']]);
    const modal = new SelectionModal();
    modal.open('Bookmarks', [{ id: 'b1', label: 'Bookmark 1' }], { allowSearch: true, customActions });
    const state = buildState(modal, {
      selectionCallback: (r: { action: string } | null) => { dispatched = r?.action ?? null; },
    });

    handleSelectionModalToken(state, { type: 'text', value: 'd' });
    // TS narrows dispatched to its initializer (null) and doesn't widen back
    // across the closure reassignment inside selectionCallback, the cast
    // reflects the variable's real declared type.
    expect(dispatched as string | null).toBe('delete');
    expect(modal.query).toBe(''); // the letter was not typed
  });

  test('allowSearch: false pickers (e.g. /effort) are unaffected; an unclaimed letter still does nothing', () => {
    const modal = new SelectionModal();
    modal.open('Reasoning Effort', [{ id: 'low', label: 'low' }], { allowSearch: false });
    const state = buildState(modal);

    handleSelectionModalToken(state, { type: 'text', value: 'x' });
    expect(modal.query).toBe('');
  });
});

describe('SelectionModal single-Escape close (item 3b)', () => {
  test('ONE Escape closes the modal even with a non-empty query (no clear-the-query step)', () => {
    const modal = new SelectionModal();
    modal.open('Help: Commands', [{ id: '/model', label: '/model' }], { allowSearch: true });
    let closed = false;
    const state = buildState(modal, { handleEscape: () => { modal.close(); closed = true; } });

    handleSelectionModalToken(state, { type: 'text', value: 'foo' });
    expect(modal.query).toBe('foo');

    const result = handleSelectionModalToken(state, { type: 'key', name: '\x1b', logicalName: 'escape', ctrl: false, shift: false, meta: false });

    expect(result).toBe(true);
    expect(closed).toBe(true);
    expect(modal.active).toBe(false);
  });

  test('ONE Escape closes the modal with an empty query', () => {
    const modal = new SelectionModal();
    modal.open('Help: Commands', [{ id: '/model', label: '/model' }], { allowSearch: true });
    let closed = false;
    const state = buildState(modal, { handleEscape: () => { modal.close(); closed = true; } });

    handleSelectionModalToken(state, { type: 'key', name: '\x1b', logicalName: 'escape', ctrl: false, shift: false, meta: false });
    expect(closed).toBe(true);
  });
});
