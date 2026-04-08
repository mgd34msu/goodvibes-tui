import { describe, expect, test } from 'bun:test';
import { handleEscape, modalOpened } from '../../input/handler-modal-stack.ts';

function buildState() {
  return {
    helpOverlayActive: true,
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
    bookmarkModal: { active: false, open: () => {}, close: () => {} },
    agentDetailModal: { active: false, open: () => {}, close: () => {} },
    liveTailModal: { active: false, open: () => {}, close: () => {} },
    settingsModal: { active: false, editingMode: false, cancelEdit: () => {}, open: () => {}, close: () => {} },
    sessionPickerModal: { active: false, open: () => {}, close: () => {} },
    profilePickerModal: { active: false, open: () => {}, close: () => {} },
    contextInspectorModal: { active: false, open: () => {}, close: () => {} },
    processModal: { active: false, open: () => {}, close: () => {} },
    modelPicker: { active: false, open: () => {}, close: () => {} },
    filePicker: { active: false, open: () => {}, close: () => {} },
    blockActionsMenu: { active: false, open: () => {}, close: () => {} },
    selectionModal: { active: false, open: () => {}, close: () => {} },
    autocompleteReset: () => {},
  };
}

describe('modal focus restoration', () => {
  test('records panel focus when the first modal opens', () => {
    const state = buildState();
    state.panelFocused = true;
    modalOpened(state, 'help');
    expect(state.modalReturnFocus).toBe('panel');
  });

  test('restores panel focus when the last modal closes', () => {
    const state = buildState();
    state.panelFocused = true;
    modalOpened(state, 'help');
    const result = handleEscape(state);
    expect(result.panelFocused).toBe(true);
    expect(result.indicatorFocused).toBe(false);
  });

  test('restores indicator focus when the last modal closes', () => {
    const state = buildState();
    state.helpOverlayActive = false;
    state.indicatorFocused = true;
    state.processModal.active = true;
    modalOpened(state, 'process');
    const result = handleEscape(state);
    expect(result.panelFocused).toBe(false);
    expect(result.indicatorFocused).toBe(true);
  });
});
