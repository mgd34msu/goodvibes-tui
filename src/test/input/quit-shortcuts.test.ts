import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { handlePromptKeyToken } from '../../input/handler-feed-routes.ts';

function enterKey() {
  return { type: 'key' as const, name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false };
}

function wrappedPromptInfo() {
  return {
    wrappedLines: [''],
    segments: [],
    cursorWrappedLine: 0,
    cursorCol: 0,
    visibleLines: [''],
    visibleCursorLine: 0,
    visibleCursorCol: 0,
  };
}

function makeCommandContext(overrides: Partial<CommandContext> = {}): CommandContext {
  const providerRegistry = {} as never;
  const conversationManager = { log: () => {} } as never;
  const configManager = {} as never;
  return {
    session: {
      conversationManager,
      runtime: {} as never,
    },
    provider: {
      providerRegistry,
    },
    workspace: {},
    platform: {
      config: {} as never,
      configManager,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
    },
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

describe('vim-style quit shortcuts', () => {
  test(':wq routes through the shared command path and clears the prompt', async () => {
    const executed: string[] = [];
    let exited = false;
    let renderCount = 0;

    const result = handlePromptKeyToken({
      prompt: ':wq',
      cursorPos: 3,
      commandMode: false,
      contentWidth: 80,
      inputHistory: null,
      indicatorFocused: false,
      conversationManager: null,
      commandContext: makeCommandContext({
        executeCommand: async (name) => {
          executed.push(name);
          return true;
        },
      }),
      autocomplete: null,
      blockActionsMenu: { open: () => {} },
      processModal: { open: () => {} },
      modalOpened: () => {},
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
      getWrappedPromptInfo: () => wrappedPromptInfo(),
      moveCursorVertical: () => false,
      handlePathCompletion: () => false,
      handleBlockToggle: () => {},
      findMarkerAtPos: () => null,
      cleanupMarkerRegistry: () => {},
      expandPrompt: (text: string) => text,
      scroll: () => {},
      exitApp: () => { exited = true; },
      requestRender: () => { renderCount++; },
    }, enterKey());

    await Promise.resolve();

    expect(result.handled).toBe(true);
    expect(result.prompt).toBe('');
    expect(result.cursorPos).toBe(0);
    expect(executed).toEqual(['wq']);
    expect(exited).toBe(false);
    expect(renderCount).toBe(1);
  });

  test(':q falls back to the direct exit path when commands are unavailable', () => {
    let exited = false;

    const result = handlePromptKeyToken({
      prompt: ':q',
      cursorPos: 2,
      commandMode: false,
      contentWidth: 80,
      inputHistory: null,
      indicatorFocused: false,
      conversationManager: null,
      commandContext: undefined,
      autocomplete: null,
      blockActionsMenu: { open: () => {} },
      processModal: { open: () => {} },
      modalOpened: () => {},
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
      getWrappedPromptInfo: () => wrappedPromptInfo(),
      moveCursorVertical: () => false,
      handlePathCompletion: () => false,
      handleBlockToggle: () => {},
      findMarkerAtPos: () => null,
      cleanupMarkerRegistry: () => {},
      expandPrompt: (text: string) => text,
      scroll: () => {},
      exitApp: () => { exited = true; },
      requestRender: () => {},
    }, enterKey());

    expect(result.handled).toBe(true);
    expect(exited).toBe(true);
  });
});
