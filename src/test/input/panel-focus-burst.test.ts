/**
 * W0.8 sub-fix B: a printable burst (bracketed paste, or several fast-typed
 * keystrokes landing in one input.feed() call) while a panel has focus must
 * never be exploded into per-character panel hotkeys — it should fall
 * through to the composer instead, same as if no panel had focus.
 *
 * Exercises the real end-to-end path: InputHandler.feed() -> the SDK's
 * InputTokenizer -> feedInputTokens -> handlePanelFocusToken.
 */
import { describe, test, expect, mock } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '../../input/selection.ts';

function buildHandler(activePanel: { id: string; handleInput: (key: string) => boolean; isCapturingTextBurst?: () => boolean }) {
  let focusTarget: 'panel' | 'prompt' = 'panel'; // start focused on the panel
  const panelManager = {
    isVisible: () => true,
    getAllOpen: () => [{ id: activePanel.id }],
    getActive: () => activePanel,
    getActivePanel: () => activePanel,
    getFocusTarget: () => focusTarget,
    focusPanels: () => { focusTarget = 'panel'; },
    focusPrompt: () => { focusTarget = 'prompt'; },
    close: () => {},
    hide: () => {},
  };

  const uiServices = {
    agents: {
      agentManager: { getAllAgents: () => [], on: () => {}, off: () => {} } as unknown,
      agentMessageBus: { on: () => {}, off: () => {} } as unknown,
      wrfcController: { on: () => {}, off: () => {} } as unknown,
    },
    environment: {
      shellPaths: {
        homeDirectory: '/tmp',
        workingDirectory: '/tmp',
        resolveProjectPath: (...parts: string[]) => parts.join('/'),
      },
    },
    providers: {
      favoritesStore: { getAll: () => [] } as unknown,
      benchmarkStore: { getAll: () => [] } as unknown,
      providerRegistry: { getAll: () => [] } as unknown,
    },
    sessions: { sessionManager: { getAll: () => [] } as unknown },
    shell: {
      processManager: { getAll: () => [] } as unknown,
      bookmarkManager: { getAll: () => [] } as unknown,
      profileManager: { getAll: () => [] } as unknown,
      panelManager: panelManager as unknown,
      keybindingsManager: { matches: () => false, lookup: () => null } as unknown,
    },
  };

  const selection = new SelectionManager();
  const handler = new InputHandler(
    mock(() => {}),
    selection,
    () => 0,
    () => 24,
    (() => ({ getLineCount: () => 0 })) as unknown as () => import('../../core/history.ts').InfiniteBuffer,
    mock(() => {}),
    mock(() => {}),
    uiServices as unknown as import('../../runtime/ui-services.ts').UiRuntimeServices,
  );
  handler.panelFocused = true;
  return handler;
}

describe('panel-focus burst routing (W0.8 sub-fix B)', () => {
  test('a single fast keystroke while a panel has focus is still dispatched as a panel hotkey', () => {
    const received: string[] = [];
    const handler = buildHandler({ id: 'a', handleInput: (k) => { received.push(k); return true; } });

    handler.feed('r');

    expect(received).toEqual(['r']);
    expect(handler.panelFocused).toBe(true);
    expect(handler.prompt).toBe('');
  });

  test('a bracketed paste (tokenizes to one multi-char text token) is routed to the composer, not eaten as per-char hotkeys', () => {
    const received: string[] = [];
    const handler = buildHandler({ id: 'a', handleInput: (k) => { received.push(k); return true; } });

    // \x1b[200~ ... \x1b[201~ is how a terminal wraps a bracketed paste;
    // the SDK's InputTokenizer turns the wrapped payload into one 'text'
    // token whose value is the whole string.
    handler.feed('\x1b[200~hello world\x1b[201~');

    expect(received).toEqual([]);
    expect(handler.panelFocused).toBe(false);
    expect(handler.prompt).toBe('hello world');
  });

  test('an unwrapped fast-typed burst (multiple keystrokes in one data chunk, no paste markers) is also routed to the composer', () => {
    const received: string[] = [];
    const handler = buildHandler({ id: 'a', handleInput: (k) => { received.push(k); return true; } });

    // No bracketed-paste markers — this is what a terminal delivers when a
    // user types faster than stdin is drained, or a script/tmux send-keys
    // writes several characters in one chunk.
    handler.feed('abc');

    expect(received).toEqual([]);
    expect(handler.panelFocused).toBe(false);
    expect(handler.prompt).toBe('abc');
  });

  test('a burst is still forwarded char-by-char to a panel with an open text-capture buffer (e.g. active `/`-search)', () => {
    const received: string[] = [];
    const handler = buildHandler({
      id: 'a',
      handleInput: (k) => { received.push(k); return true; },
      isCapturingTextBurst: () => true,
    });

    handler.feed('abc');

    expect(received).toEqual(['a', 'b', 'c']);
    expect(handler.panelFocused).toBe(true);
    expect(handler.prompt).toBe('');
  });
});
