import { describe, expect, test } from 'bun:test';
import { handleEscape, modalOpened } from '../../input/handler-modal-stack.ts';

function buildState() {
  return {
    helpOverlayActive: false,
    shortcutsOverlayActive: false,
    commandMode: false,
    modalStack: [] as string[],
    modalReturnFocus: 'prompt' as 'prompt' | 'panel' | 'indicator',
    panelFocused: false,
    indicatorFocused: false,
    prompt: '',
    cursorPos: 0,
    helpScrollOffset: 0,
    shortcutsScrollOffset: 0,
    requestRender: () => {},
    saveUndoState: () => {},
    cancelGeneration: undefined,
    selectionCallback: null,
    bookmarkModal: { active: false, open: function () { this.active = true; }, close: function () { this.active = false; } },
    settingsModal: { active: false, editingMode: false, cancelEdit: () => {}, open: () => {}, close: () => {} },
    sessionPickerModal: { active: false, open: () => {}, close: () => {} },
    profilePickerModal: { active: false, open: () => {}, close: () => {} },
    configModal: { active: false, close: () => {}, reopen: () => {} },
    contextInspectorModal: { active: false, open: function () { this.active = true; }, close: function () { this.active = false; } },
    modelPicker: { active: false, open: () => {}, close: () => {} },
    filePicker: { active: false, open: () => {}, close: () => {} },
    blockActionsMenu: { active: false, open: () => {}, close: () => {} },
    selectionModal: { active: false, open: () => {}, close: () => {} },
    autocompleteReset: () => {},
    autocompleteUpdate: (_query: string) => {},
  };
}

describe('modal focus restoration', () => {
  test('records panel focus when the first modal opens', () => {
    const state = buildState();
    state.panelFocused = true;
    state.helpOverlayActive = true;
    modalOpened(state, 'help');
    expect(state.modalReturnFocus).toBe('panel');
  });

  test('restores panel focus when the last modal closes', () => {
    const state = buildState();
    state.panelFocused = true;
    state.helpOverlayActive = true;
    modalOpened(state, 'help');
    const result = handleEscape(state);
    expect(result.panelFocused).toBe(true);
    expect(result.indicatorFocused).toBe(false);
  });

  test('restores indicator focus when the last modal closes', () => {
    const state = buildState();
    state.indicatorFocused = true;
    state.contextInspectorModal.active = true;
    modalOpened(state, 'contextInspector');
    const result = handleEscape(state);
    expect(result.panelFocused).toBe(false);
    expect(result.indicatorFocused).toBe(true);
  });


  test('reopens command modal with the command list active again', () => {
    let autocompleteQuery = 'unchanged';
    const state = buildState();
    state.commandMode = true;
    modalOpened(state, 'command');
    state.commandMode = false;
    state.contextInspectorModal.active = true;
    modalOpened(state, 'contextInspector');
    state.autocompleteUpdate = (query: string) => {
      autocompleteQuery = query;
    };

    const result = handleEscape(state);

    expect(state.modalStack).toEqual(['command']);
    expect(result.commandMode).toBe(true);
    expect(result.prompt).toBe('/');
    expect(result.cursorPos).toBe(1);
    expect(autocompleteQuery).toBe('');
  });

  test('escape closes only the top modal and reopens the previous modal', () => {
    const state = buildState();
    // retirement: this exercised the process modal as the "previous" entry
    // in the stack; it now uses the bookmark modal (a surviving reopenable
    // modal), the escape/reopen focus-restoration logic under test is unchanged.
    state.bookmarkModal.active = true;
    modalOpened(state, 'bookmark');
    modalOpened(state, 'contextInspector');
    state.bookmarkModal.active = false;
    state.contextInspectorModal.active = true;

    const result = handleEscape(state);

    expect(state.modalStack).toEqual(['bookmark']);
    expect(state.contextInspectorModal.active).toBe(false);
    expect(state.bookmarkModal.active).toBe(true);
    expect(result.panelFocused).toBe(false);
    expect(result.indicatorFocused).toBe(false);
  });
});
