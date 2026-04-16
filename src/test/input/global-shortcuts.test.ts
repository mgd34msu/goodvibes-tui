import { describe, expect, mock, test } from 'bun:test';
import { handleGlobalShortcutToken, type GlobalShortcutRouteState } from '../../input/handler-shortcuts.ts';

function buildState(overrides: Partial<GlobalShortcutRouteState> = {}): GlobalShortcutRouteState {
  return {
    panelFocused: false,
    panelManager: {
      getAllOpen: () => [],
      close: () => {},
      hide: () => {},
      getActivePanel: () => null,
    } as unknown as GlobalShortcutRouteState['panelManager'],
    keybindingsManager: {
      matches: (action: string, token: { logicalName?: string; ctrl?: boolean }) =>
        action === 'panel-picker' && token.logicalName === 'p' && !!token.ctrl,
      // lookup: O(1) inverted-map equivalent used by the refactored handler.
      lookup: (token: { logicalName?: string; ctrl?: boolean }) =>
        token.logicalName === 'p' && !!token.ctrl ? 'panel-picker' : null,
    } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    prompt: '',
    cursorPos: 0,
    commandMode: false,
    autocomplete: null,
    historySearch: { open: mock(() => {}) } as unknown as GlobalShortcutRouteState['historySearch'],
    searchManager: { active: false, open: mock(() => {}), close: mock(() => {}) } as unknown as GlobalShortcutRouteState['searchManager'],
    conversationManager: null,
    commandContext: { openPanelPicker: mock(() => {}), clearScreen: mock(() => {}) } as unknown as NonNullable<GlobalShortcutRouteState['commandContext']>,
    contentWidth: 80,
    getScrollTop: () => 0,
    getWrappedPromptInfo: () => ({ wrappedLines: [''], segments: [{ rawStart: 0, length: 0 }], cursorWrappedLine: 0 }),
    saveUndoState: mock(() => {}),
    requestRender: mock(() => {}),
    scroll: mock(() => {}),
    ensureInputCursorVisible: mock(() => {}),
    handleCopy: mock(() => {}),
    handleCtrlC: mock(() => {}),
    handleBlockCopy: mock(() => {}),
    handleBookmark: mock(() => {}),
    handleBlockSave: mock(() => {}),
    handleDiffApply: mock(() => false),
    handleUndo: mock(() => {}),
    handleRedo: mock(() => {}),
    handlePaste: mock(() => {}),
    handleEscape: mock(() => {}),
    cyclePanelTab: mock(() => {}),
    ...overrides,
  };
}

describe('handleGlobalShortcutToken', () => {
  test('panel-picker remains global while panel workspace has focus', () => {
    const state = buildState({ panelFocused: true });
    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x10', logicalName: 'p', ctrl: true, shift: false, meta: false },
      24,
    );

    expect(handled).toBe(true);
    expect(state.commandContext?.openPanelPicker).toHaveBeenCalled();
    expect(state.requestRender).toHaveBeenCalled();
  });

  test('escape does not bypass panel focus handling', () => {
    const state = buildState({ panelFocused: true });
    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x1b', logicalName: 'escape', ctrl: false, shift: false, meta: false },
      24,
    );

    expect(handled).toBe(false);
    expect(state.handleEscape).not.toHaveBeenCalled();
  });
});
