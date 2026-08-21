/**
 * focus foundation (Invariants A & B). End-to-end through the real path:
 * InputHandler.feed() -> the SDK's InputTokenizer -> feedInputTokens ->
 * handlePanelFocusToken.
 *
 * Invariant B: paste-ness is per-TOKEN, not a per-feed char sum. The tokenizer
 * emits a bracketed paste as ONE multi-char 'text' token; discrete keystrokes,
 * even several batched into one feed() by tick latency, arrive as separate
 * 1-char tokens. Invariant A: focus never silently flips to the composer; a
 * paste into a focused non-capturing panel is DROPPED (with a one-shot hint),
 * focus unchanged.
 *
 * The old per-feed char-SUM burst guard flagged two quick nav keystrokes in one
 * feed() as a burst and yanked focus, leaking the keys to the composer, the
 * exact bug this suite now pins closed.
 */
import { describe, test, expect, mock } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '@pellux/goodvibes-terminal-shell';
import { FocusTracker } from '@pellux/goodvibes-sdk/platform/runtime/operations';

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
    platform: { focusTracker: new FocusTracker() },
  };

  const selection = new SelectionManager();
  const handler = new InputHandler(
    mock(() => {}),
    selection,
    () => 0,
    () => 24,
    (() => ({ getLineCount: () => 0 })) as unknown as () => import('@pellux/goodvibes-terminal-shell').InfiniteBuffer,
    mock(() => {}),
    mock(() => {}),
    uiServices as unknown as import('../../runtime/ui-services.ts').UiRuntimeServices,
  );
  handler.panelFocused = true;
  return handler;
}

describe('panel-focus paste/keystroke routing (Invariants A & B)', () => {
  test('a single keystroke while a panel has focus is dispatched as a panel hotkey', () => {
    const received: string[] = [];
    const handler = buildHandler({ id: 'a', handleInput: (k) => { received.push(k); return true; } });

    handler.feed('r');

    expect(received).toEqual(['r']);
    expect(handler.panelFocused).toBe(true);
    expect(handler.prompt).toBe('');
  });

  test('Invariant B repro: two nav keystrokes batched into one feed() BOTH reach the focused panel (never leaked to the composer)', () => {
    const received: string[] = [];
    const handler = buildHandler({ id: 'a', handleInput: (k) => { received.push(k); return true; } });

    // No bracketed-paste markers: "jk" arriving in one stdin drain (fast typing
    // or one render tick) tokenizes to TWO separate 1-char 'text' tokens. The
    // old char-sum guard summed them to 2 and flipped focus; the per-token
    // model keeps each as a non-paste keystroke.
    handler.feed('jk');

    expect(received).toEqual(['j', 'k']);
    expect(handler.panelFocused).toBe(true);
    expect(handler.prompt).toBe('');
  });

  test('Invariant A: a bracketed paste into a non-capturing focused panel is DROPPED, focus and composer unchanged', () => {
    const received: string[] = [];
    const handler = buildHandler({ id: 'a', handleInput: (k) => { received.push(k); return true; } });

    // \x1b[200~ ... \x1b[201~ is how a terminal wraps a bracketed paste; the
    // SDK's InputTokenizer turns the wrapped payload into one 'text' token whose
    // value is the whole string (value.length > 1 => a paste).
    handler.feed('\x1b[200~hello world\x1b[201~');

    expect(received).toEqual([]);              // not exploded into per-char hotkeys
    expect(handler.panelFocused).toBe(true);   // focus NOT flipped to the composer
    expect(handler.prompt).toBe('');           // paste did NOT land in the composer
  });

  test('a bracketed paste IS forwarded char-by-char to a panel with an open text-capture buffer (e.g. active steer draft / `/`-search)', () => {
    const received: string[] = [];
    const handler = buildHandler({
      id: 'a',
      handleInput: (k) => { received.push(k); return true; },
      isCapturingTextBurst: () => true,
    });

    handler.feed('\x1b[200~abc\x1b[201~');

    expect(received).toEqual(['a', 'b', 'c']);
    expect(handler.panelFocused).toBe(true);
    expect(handler.prompt).toBe('');
  });

  test('composer-focused behavior unchanged: a paste with no panel focus lands in the composer', () => {
    const received: string[] = [];
    const handler = buildHandler({ id: 'a', handleInput: (k) => { received.push(k); return true; } });
    handler.panelFocused = false; // focus on the composer, not the panel

    handler.feed('\x1b[200~hello world\x1b[201~');

    expect(received).toEqual([]);
    expect(handler.panelFocused).toBe(false);
    expect(handler.prompt).toBe('hello world');
  });
});
