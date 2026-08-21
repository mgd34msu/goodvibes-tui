/**
 * item 3: SelectionModal-based pickers (/help, /tools, /sessions,
 * /bookmarks, TTS provider/voice, ...) used to require pressing '/' before
 * typing would filter the list, any other unclaimed keystroke silently did
 * nothing. /help in particular registers NO customActions, so every letter
 * was swallowed: "help search needs '/' arming while the palette filters
 * instantly" (evaluator finding). Escape also took up to three presses after
 * searching (1st cleared the query, 2nd blurred search, 3rd finally closed).
 *
 * Fixed in handler-modal-routes.ts's handleSelectionModalToken:
 *   - an unclaimed keystroke (no customAction bound to it) now instantly
 *     arms search AND starts the query, in addition to '/' still working;
 *   - a claimed hotkey letter (e.g. /bookmarks' 'd' for delete) still fires
 *     its action first, unaffected, search only claims what nothing else did;
 *   - Escape ALWAYS closes in one press, regardless of search/query state.
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
  test('/help-shaped modal (allowSearch, no customActions): an unclaimed letter instantly arms search and starts the query; no /-arming needed', () => {
    const modal = new SelectionModal();
    modal.open('Help: Commands', [
      { id: '/model', label: '/model' },
      { id: '/config', label: '/config' },
    ], { allowSearch: true });

    const state = buildState(modal);
    const result = handleSelectionModalToken(state, { type: 'text', value: 'c' });

    expect(result).toBe(true);
    expect(modal.searchFocused).toBe(true);
    expect(modal.query).toBe('c');
  });

  test("'/' still works too: additive, not a replacement", () => {
    const modal = new SelectionModal();
    modal.open('Help: Commands', [{ id: '/model', label: '/model' }], { allowSearch: true });
    const state = buildState(modal);

    handleSelectionModalToken(state, { type: 'text', value: '/' });
    expect(modal.searchFocused).toBe(true);
    expect(modal.query).toBe('');
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
    expect(modal.searchFocused).toBe(false); // search was never armed
  });

  test('allowSearch: false pickers (e.g. /effort) are unaffected; an unclaimed letter still does nothing', () => {
    const modal = new SelectionModal();
    modal.open('Reasoning Effort', [{ id: 'low', label: 'low' }], { allowSearch: false });
    const state = buildState(modal);

    handleSelectionModalToken(state, { type: 'text', value: 'x' });
    expect(modal.searchFocused).toBe(false);
    expect(modal.query).toBe('');
  });
});

describe('SelectionModal single-Escape close (item 3b)', () => {
  test('ONE Escape closes the modal even mid-search with a non-empty query (was a 3-press sequence: clear query, blur search, close)', () => {
    const modal = new SelectionModal();
    modal.open('Help: Commands', [{ id: '/model', label: '/model' }], { allowSearch: true });
    let closed = false;
    const state = buildState(modal, { handleEscape: () => { modal.close(); closed = true; } });

    handleSelectionModalToken(state, { type: 'text', value: '/' });
    handleSelectionModalToken(state, { type: 'text', value: 'foo' });
    expect(modal.searchFocused).toBe(true);
    expect(modal.query).toBe('foo');

    const result = handleSelectionModalToken(state, { type: 'key', name: '\x1b', logicalName: 'escape', ctrl: false, shift: false, meta: false });

    expect(result).toBe(true);
    expect(closed).toBe(true);
    expect(modal.active).toBe(false);
  });

  test('ONE Escape closes the modal when search is focused but the query is still empty', () => {
    const modal = new SelectionModal();
    modal.open('Help: Commands', [{ id: '/model', label: '/model' }], { allowSearch: true });
    let closed = false;
    const state = buildState(modal, { handleEscape: () => { modal.close(); closed = true; } });

    handleSelectionModalToken(state, { type: 'text', value: '/' });
    expect(modal.searchFocused).toBe(true);

    handleSelectionModalToken(state, { type: 'key', name: '\x1b', logicalName: 'escape', ctrl: false, shift: false, meta: false });
    expect(closed).toBe(true);
  });
});
