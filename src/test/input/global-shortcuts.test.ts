import { describe, expect, mock, test } from 'bun:test';
import { handleGlobalShortcutToken, type GlobalShortcutRouteState } from '../../input/handler-shortcuts.ts';
import { KillRing } from '../../input/kill-ring.ts';

function key(logicalName: string, mods: { ctrl?: boolean; shift?: boolean; meta?: boolean } = {}) {
  return { type: 'key' as const, name: '', logicalName, ctrl: mods.ctrl ?? false, shift: mods.shift ?? false, meta: mods.meta ?? false };
}

function buildState(overrides: Partial<GlobalShortcutRouteState> = {}): GlobalShortcutRouteState {
  return {
    keybindingsManager: {
      matches: () => false,
      lookup: (token: { logicalName?: string; ctrl?: boolean }) => {
        if (token.logicalName === 'p' && token.ctrl) return 'command-palette';
        if (token.logicalName === 'o' && token.ctrl) return 'open-agents';
        return null;
      },
    } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    prompt: '',
    cursorPos: 0,
    commandMode: false,
    autocomplete: null,
    historySearch: { open: mock(() => {}) } as unknown as GlobalShortcutRouteState['historySearch'],
    searchManager: { active: false, open: mock(() => {}), close: mock(() => {}) } as unknown as GlobalShortcutRouteState['searchManager'],
    conversationManager: null,
    commandContext: {
      openCommandPalette: mock(() => {}),
      openAgents: mock(() => {}),
      clearScreen: mock(() => {}),
    } as unknown as NonNullable<GlobalShortcutRouteState['commandContext']>,
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
    killRing: new KillRing(),
    ...overrides,
  };
}

describe('handleGlobalShortcutToken', () => {
  test('the command palette (Ctrl+P) is reachable during an active turn; the route carries no turn state to gate on', () => {
    const state = buildState();
    expect(handleGlobalShortcutToken(state, key('p', { ctrl: true }), 24)).toBe(true);
    expect(state.commandContext?.openCommandPalette).toHaveBeenCalled();
    expect(state.requestRender).toHaveBeenCalled();
  });

  test('F2 opens the Agents modal', () => {
    const state = buildState();
    expect(handleGlobalShortcutToken(state, key('f2'), 24)).toBe(true);
    expect(state.commandContext?.openAgents).toHaveBeenCalledTimes(1);
  });

  test('Ctrl+O (open-agents) opens the Agents modal too', () => {
    const state = buildState();
    expect(handleGlobalShortcutToken(state, key('o', { ctrl: true }), 24)).toBe(true);
    expect(state.commandContext?.openAgents).toHaveBeenCalledTimes(1);
  });

  test('the old pane chords (Ctrl+X, Ctrl+G, Alt+digit, Ctrl+PageUp) are not bound any more and fall through', () => {
    const state = buildState();
    expect(handleGlobalShortcutToken(state, key('x', { ctrl: true }), 24)).toBe(false);
    expect(handleGlobalShortcutToken(state, key('g', { ctrl: true }), 24)).toBe(false);
    expect(handleGlobalShortcutToken(state, key('1', { meta: true }), 24)).toBe(false);
    expect(handleGlobalShortcutToken(state, key('pageup', { ctrl: true }), 24)).toBe(false);
    expect(state.scroll).not.toHaveBeenCalled();
  });

  test('BARE PageUp/PageDown scroll the transcript', () => {
    const state = buildState();
    expect(handleGlobalShortcutToken(state, key('pageup'), 24)).toBe(true);
    expect(handleGlobalShortcutToken(state, key('pagedown'), 24)).toBe(true);
    expect(state.scroll).toHaveBeenCalledTimes(2);
  });

  test('Escape always reaches the shared Esc chain', () => {
    const state = buildState();
    expect(handleGlobalShortcutToken(state, key('escape'), 24)).toBe(true);
    expect(state.handleEscape).toHaveBeenCalledTimes(1);
  });
});

describe('Shift+Tab cycles the session permission mode', () => {
  function stateWithConfig(mode: string) {
    const store: Record<string, unknown> = { 'permissions.mode': mode };
    const setCalls: Array<[string, unknown]> = [];
    const prints: string[] = [];
    const state = buildState({
      commandContext: {
        print: (t: string) => { prints.push(t); },
        platform: {
          configManager: {
            get: (k: string) => store[k],
            set: (k: string, v: unknown) => { store[k] = v; setCalls.push([k, v]); },
          },
        },
      } as unknown as NonNullable<GlobalShortcutRouteState['commandContext']>,
    });
    return { state, store, setCalls, prints };
  }

  test('legacy backtab (\\x1b[Z) advances normal → accept-edits and narrates it', () => {
    const { state, store, setCalls, prints } = stateWithConfig('prompt');
    expect(handleGlobalShortcutToken(state, key('\x1b[Z'), 24)).toBe(true);
    expect(store['permissions.mode']).toBe('accept-edits');
    expect(setCalls).toEqual([['permissions.mode', 'accept-edits']]);
    expect(prints.at(-1)).toContain('accept-edits');
  });

  test('kitty shift+tab advances plan → auto (allow-all)', () => {
    const { state, store } = stateWithConfig('plan');
    expect(handleGlobalShortcutToken(state, key('tab', { shift: true }), 24)).toBe(true);
    expect(store['permissions.mode']).toBe('allow-all');
  });
});

describe('voice input (Alt+V)', () => {
  function voiceState(): { state: GlobalShortcutRouteState; toggleVoiceInput: ReturnType<typeof mock> } {
    const toggleVoiceInput = mock(() => {});
    const state = buildState({
      keybindingsManager: {
        lookup: (token: { logicalName?: string; alt?: boolean; meta?: boolean }) =>
          token.logicalName === 'v' && (token.alt === true || token.meta === true) ? 'voice-input' : null,
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
      commandContext: { toggleVoiceInput } as unknown as NonNullable<GlobalShortcutRouteState['commandContext']>,
    });
    return { state, toggleVoiceInput };
  }

  test('Alt+V starts or stops the recording through the command-context seam', () => {
    const { state, toggleVoiceInput } = voiceState();
    expect(handleGlobalShortcutToken(state, key('v', { meta: true }), 24)).toBe(true);
    expect(toggleVoiceInput).toHaveBeenCalledTimes(1);
  });

  test('the key is still consumed when voice capture is not wired, so Alt+V never types a "v"', () => {
    const state = buildState({
      keybindingsManager: {
        lookup: (token: { logicalName?: string; meta?: boolean }) =>
          token.logicalName === 'v' && token.meta === true ? 'voice-input' : null,
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
      commandContext: {} as unknown as NonNullable<GlobalShortcutRouteState['commandContext']>,
    });
    expect(handleGlobalShortcutToken(state, key('v', { meta: true }), 24)).toBe(true);
    expect(state.prompt).toBe('');
  });
});
