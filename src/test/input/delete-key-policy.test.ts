/**
 * Delete-key policy unit tests
 *
 * Covers:
 *   1. Policy predicate contracts (isTextBackspace, isTextForwardDelete)
 *   2. Panel search filter: 'delete' is a no-op (isPanelSearchBackspace)
 *   3. Selection modal: 'delete' is a no-op (handleSelectionModalToken)
 *   4. Planning panel draft: delete opens confirm gate; draft survives until confirmed
 *   5. Planning panel clear-draft: Delete requires y/n confirmation
 *   6. Router-path reachability: handlePanelFocusToken → panel.handleInput('delete') opens confirm
 */
import { describe, expect, test } from 'bun:test';
import { isTextBackspace, isTextForwardDelete } from '../../input/delete-key-policy.ts';
import { isPanelSearchBackspace } from '../../panels/search-focus.ts';
import { handleSelectionModalToken } from '../../input/handler-modal-routes.ts';
import { SelectionModal } from '../../input/selection-modal.ts';
// (the purge), group B: the ProjectPlanningPanel delete-key/confirm-gate
// tests were removed with the panel (migrated to the 'planning' modal, which
// uses the host's input model, not the panel's inline draft form). The generic
// delete-key predicate + selection-modal coverage below is unaffected.

// ---------------------------------------------------------------------------
// 1. Policy predicates
// ---------------------------------------------------------------------------

describe('delete-key policy predicates', () => {
  test('isTextBackspace: backspace returns true', () => {
    expect(isTextBackspace('backspace')).toBe(true);
  });

  test('isTextBackspace: delete returns false', () => {
    expect(isTextBackspace('delete')).toBe(false);
  });

  test('isTextBackspace: other keys return false', () => {
    expect(isTextBackspace('a')).toBe(false);
    expect(isTextBackspace('escape')).toBe(false);
    expect(isTextBackspace('')).toBe(false);
  });

  test('isTextForwardDelete: delete returns true', () => {
    expect(isTextForwardDelete('delete')).toBe(true);
  });

  test('isTextForwardDelete: backspace returns false', () => {
    expect(isTextForwardDelete('backspace')).toBe(false);
  });

  test('isTextForwardDelete: other keys return false', () => {
    expect(isTextForwardDelete('a')).toBe(false);
    expect(isTextForwardDelete('escape')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Panel search filter: isPanelSearchBackspace
// ---------------------------------------------------------------------------

describe('isPanelSearchBackspace', () => {
  test('backspace returns true', () => {
    expect(isPanelSearchBackspace('backspace')).toBe(true);
  });

  test('delete returns false (no-op: end-anchored filter, no cursor)', () => {
    expect(isPanelSearchBackspace('delete')).toBe(false);
  });

  test('other keys return false', () => {
    expect(isPanelSearchBackspace('a')).toBe(false);
    expect(isPanelSearchBackspace('escape')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Selection modal: 'delete' is a no-op in search filters
// ---------------------------------------------------------------------------

describe('selection modal delete-key policy', () => {
  function makeModalState(modal: SelectionModal): {
    selectionModal: SelectionModal;
    selectionCallback: null;
    modalStack: string[];
    requestRender: () => void;
    handleEscape: () => void;
  } {
    return {
      selectionModal: modal,
      selectionCallback: null,
      modalStack: [],
      requestRender: () => {},
      handleEscape: () => {},
    };
  }

  test('backspace removes last char from search filter', () => {
    const modal = new SelectionModal();
    modal.open('Pick', [{ id: 'a', label: 'A' }], { allowSearch: true });
    modal.focusSearch();
    modal.setQuery('abc');

    const state = makeModalState(modal);
    handleSelectionModalToken(state, { type: 'key', name: 'backspace', logicalName: 'backspace', ctrl: false, shift: false, meta: false });
    expect(modal.query).toBe('ab');
  });

  test('delete is a no-op: filter remains intact', () => {
    const modal = new SelectionModal();
    modal.open('Pick', [{ id: 'a', label: 'A' }], { allowSearch: true });
    modal.focusSearch();
    modal.setQuery('abc');

    const state = makeModalState(modal);
    handleSelectionModalToken(state, { type: 'key', name: 'delete', logicalName: 'delete', ctrl: false, shift: false, meta: false });
    expect(modal.query).toBe('abc');
  });
});
