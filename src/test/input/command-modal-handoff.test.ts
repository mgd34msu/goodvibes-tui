import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { handleCommandModeToken } from '../../input/handler-command-route.ts';
import { handlePromptTextToken } from '../../input/handler-feed-routes.ts';


function makeCommandContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    providerRegistry: {} as never,
    conversationManager: { log: () => {} } as never,
    config: {} as never,
    configManager: {} as never,
    runtime: {} as never,
    renderRequest: () => {},
    submitInput: () => {},
    executeCommand: async () => false,
    cancelGeneration: () => {},
    clearScreen: () => {},
    requestPermission: async () => ({ approved: false } as never),
    completeModelSelection: () => {},
    jumpToBookmark: () => {},
    scrollToLine: () => {},
    print: () => {},
    exit: () => {},
    ...overrides,
  } as CommandContext;
}

function key(logicalName: string) {
  return { type: 'key' as const, name: logicalName, logicalName, ctrl: false, shift: false, meta: false };
}

describe('command modal handoff', () => {
  test('escape closes the slash menu completely and removes stale command stack entries', async () => {
    let resetCount = 0;
    const { handleEscape } = await import('../../input/handler-modal-stack.ts');
    const modalStack = ['command', 'selection', 'command'];
    const result = handleEscape({
      helpOverlayActive: false,
      shortcutsOverlayActive: false,
      commandMode: true,
      modalStack,
      modalReturnFocus: 'prompt',
      panelFocused: false,
      indicatorFocused: false,
      prompt: '/',
      cursorPos: 1,
      helpScrollOffset: 0,
      shortcutsScrollOffset: 0,
      requestRender: () => {},
      saveUndoState: () => {},
      cancelGeneration: undefined,
      selectionCallback: null,
      bookmarkModal: { active: false, close: () => {} } as never,
      agentDetailModal: { active: false, close: () => {} } as never,
      liveTailModal: { active: false, close: () => {} } as never,
      settingsModal: { active: false, editingMode: false, cancelEdit: () => {}, close: () => {} } as never,
      sessionPickerModal: { active: false, close: () => {} } as never,
      profilePickerModal: { active: false, close: () => {} } as never,
      contextInspectorModal: { active: false, close: () => {} } as never,
      processModal: { active: false, close: () => {} } as never,
      modelPicker: { active: false, close: () => {} } as never,
      filePicker: { active: false, close: () => {} } as never,
      blockActionsMenu: { active: false, close: () => {} } as never,
      selectionModal: { active: false, close: () => {} } as never,
      autocompleteReset: () => { resetCount++; },
      autocompleteUpdate: () => {},
    });

    expect(result.commandMode).toBe(false);
    expect(result.prompt).toBe('');
    expect(result.cursorPos).toBe(0);
    expect(modalStack).toEqual(['selection']);
    expect(resetCount).toBe(1);
  });

  test('restores the slash command menu after closing a nested modal', async () => {
    const modalStack = ['command', 'modelPicker'];
    let activeName = 'modelPicker';
    let autocompleteQuery = 'stale';
    const { handleEscape } = await import('../../input/handler-modal-stack.ts');
    const result = handleEscape({
      helpOverlayActive: false,
      shortcutsOverlayActive: false,
      commandMode: false,
      modalStack,
      modalReturnFocus: 'prompt',
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
      bookmarkModal: { active: false, close: () => {} } as never,
      agentDetailModal: { active: false, close: () => {} } as never,
      liveTailModal: { active: false, close: () => {} } as never,
      settingsModal: { active: false, editingMode: false, cancelEdit: () => {}, close: () => {} } as never,
      sessionPickerModal: { active: false, close: () => {} } as never,
      profilePickerModal: { active: false, close: () => {} } as never,
      contextInspectorModal: { active: false, close: () => {} } as never,
      processModal: { active: false, close: () => {} } as never,
      modelPicker: { active: true, close: () => { activeName = 'command'; } } as never,
      filePicker: { active: false, close: () => {} } as never,
      blockActionsMenu: { active: false, close: () => {} } as never,
      selectionModal: { active: false, close: () => {} } as never,
      autocompleteReset: () => {},
      autocompleteUpdate: (query: string) => { autocompleteQuery = query; },
    });

    expect(modalStack).toEqual(['command']);
    expect(result.commandMode).toBe(true);
    expect(result.prompt).toBe('/');
    expect(result.cursorPos).toBe(1);
    expect(autocompleteQuery).toBe('');
    expect(activeName).toBe('command');
  });
  test('keeps command on the stack when a slash command opens a nested modal', async () => {
    const modalStack = ['command'];
    const registry = new CommandRegistry();
    const state = {
      commandMode: true,
      prompt: '/provider',
      cursorPos: '/provider'.length,
      autocomplete: null,
      modalStack,
      commandRegistry: registry,
      commandContext: makeCommandContext({
        executeCommand: async () => {
          modalStack.push('modelPicker');
          return true;
        },
      }),
      conversationManager: { log: () => {} } as never,
      requestRender: () => {},
      handleEscape: () => {},
    };

    const handled = handleCommandModeToken(state, key('enter'));
    await Promise.resolve();

    expect(handled).toBe(true);
    expect(state.commandMode).toBe(false);
    expect(modalStack).toEqual(['command', 'modelPicker']);
  });

  test('removes command from the stack when no nested modal opens', async () => {
    const modalStack = ['command'];
    const registry = new CommandRegistry();
    const state = {
      commandMode: true,
      prompt: '/help',
      cursorPos: '/help'.length,
      autocomplete: null,
      modalStack,
      commandRegistry: registry,
      commandContext: makeCommandContext({
        executeCommand: async () => true,
      }),
      conversationManager: { log: () => {} } as never,
      requestRender: () => {},
      handleEscape: () => {},
    };

    const handled = handleCommandModeToken(state, key('enter'));
    await Promise.resolve();

    expect(handled).toBe(true);
    expect(state.commandMode).toBe(false);
    expect(modalStack).toEqual([]);
    expect(state.prompt).toBe('');
    expect(state.cursorPos).toBe(0);
  });

  test('after escape closes slash mode, subsequent typing stays in normal prompt mode until / is typed again', async () => {
    let resetCount = 0;
    const { handleEscape } = await import('../../input/handler-modal-stack.ts');
    const modalStack = ['command'];
    const escaped = handleEscape({
      helpOverlayActive: false,
      shortcutsOverlayActive: false,
      commandMode: true,
      modalStack,
      modalReturnFocus: 'prompt',
      panelFocused: false,
      indicatorFocused: false,
      prompt: '/',
      cursorPos: 1,
      helpScrollOffset: 0,
      shortcutsScrollOffset: 0,
      requestRender: () => {},
      saveUndoState: () => {},
      cancelGeneration: undefined,
      selectionCallback: null,
      bookmarkModal: { active: false, close: () => {} } as never,
      agentDetailModal: { active: false, close: () => {} } as never,
      liveTailModal: { active: false, close: () => {} } as never,
      settingsModal: { active: false, editingMode: false, cancelEdit: () => {}, close: () => {} } as never,
      sessionPickerModal: { active: false, close: () => {} } as never,
      profilePickerModal: { active: false, close: () => {} } as never,
      contextInspectorModal: { active: false, close: () => {} } as never,
      processModal: { active: false, close: () => {} } as never,
      modelPicker: { active: false, close: () => {} } as never,
      filePicker: { active: false, close: () => {} } as never,
      blockActionsMenu: { active: false, close: () => {} } as never,
      selectionModal: { active: false, close: () => {} } as never,
      autocompleteReset: () => { resetCount++; },
      autocompleteUpdate: () => {},
    });

    const registry = new CommandRegistry();
    const textRoute = handlePromptTextToken({
      prompt: escaped.prompt,
      cursorPos: escaped.cursorPos,
      commandMode: escaped.commandMode,
      nextPasteId: 1,
      nextImageId: 1,
      pasteRegistry: new Map(),
      imageRegistry: new Map(),
      inputHistory: null,
      commandRegistry: registry,
      commandContext: makeCommandContext(),
      autocomplete: null,
      filePicker: { open: () => {} },
      modalOpened: () => { throw new Error('slash menu should not reopen while typing normal text'); },
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
      registerPaste: (content: string) => content,
      requestRender: () => {},
    }, { type: 'text', value: 'a' });

    expect(resetCount).toBe(1);
    expect(escaped.commandMode).toBe(false);
    expect(escaped.prompt).toBe('');
    expect(textRoute.commandMode).toBe(false);
    expect(textRoute.prompt).toBe('a');
    expect(modalStack).toEqual([]);
  });
});
