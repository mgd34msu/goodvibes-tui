// ---------------------------------------------------------------------------
// enter-block-actions-anchor.test.ts
//
// Enter on an empty composer opens the BlockActionsMenu. It used to target a
// hardcoded lineIndex of 0 (always the conversation's OLDEST block,
// regardless of what's on screen). Covers: it now resolves via
// getBlockAnchorLine (the viewport's bottom-most visible line, the block
// the user is actually looking at), not a fixed line.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { handlePromptKeyToken, type KeyRouteState } from '../../input/handler-feed-routes.ts';
import type { BlockMeta } from '../../core/conversation';

function wrappedPromptInfo() {
  return { wrappedLines: [''], segments: [], cursorWrappedLine: 0 };
}

function enterToken() {
  return { type: 'key' as const, name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false };
}

function makeState(overrides: Partial<KeyRouteState> = {}): KeyRouteState {
  return {
    prompt: '',
    cursorPos: 0,
    inputScrollTop: 0,
    commandMode: false,
    contentWidth: 80,
    maxInputRows: 8,
    inputHistory: null,
    indicatorFocused: false,
    conversationManager: null,
    commandContext: undefined,
    autocomplete: null,
    blockActionsMenu: { open: () => {} },
    getBlockAnchorLine: () => 0,
    openFleetPanel: () => {},
    modalOpened: () => {},
    saveUndoState: () => {},
    breakUndoCoalesce: () => {},
    ensureInputCursorVisible: () => {},
    getWrappedPromptInfo: () => wrappedPromptInfo(),
    moveCursorVertical: () => false,
    handlePathCompletion: () => false,
    handleBlockToggle: () => {},
    findMarkerAtPos: () => null,
    cleanupMarkerRegistry: () => {},
    expandPrompt: (t) => t,
    scroll: () => {},
    exitApp: () => {},
    requestRender: () => {},
    ...overrides,
  } as KeyRouteState;
}

describe('Enter-on-empty-composer block-actions targeting', () => {
  test('resolves the block at getBlockAnchorLine, not a hardcoded line 0', () => {
    let requestedLine: number | null = null;
    let openedBlock: BlockMeta | null = null;
    const bottomBlock: BlockMeta = {
      blockIndex: 3, type: 'tool', startLine: 240, lineCount: 5, rawContent: 'bottom', collapseKey: 'k3',
    };
    const conversationManager = {
      findNearestBlock: (line: number) => {
        requestedLine = line;
        return bottomBlock;
      },
    } as unknown as KeyRouteState['conversationManager'];

    const state = makeState({
      conversationManager,
      // A long transcript, the viewport-bottom anchor should be far from 0.
      getBlockAnchorLine: () => 240,
      blockActionsMenu: { open: (block) => { openedBlock = block; } },
    });

    handlePromptKeyToken(state, enterToken());

    // Widening casts back to the declared union: both `let`s are only ever
    // reassigned inside a nested closure (findNearestBlock / blockActionsMenu.open),
    // and TS's control-flow narrowing doesn't see across that function
    // boundary, it keeps treating each variable as pinned to its literal
    // `null` initializer here, so `expected: number`/`BlockMeta` no longer
    // overlaps the (wrongly) narrowed `null` type without this.
    expect(requestedLine as number | null).toBe(240);
    expect(requestedLine as number | null).not.toBe(0);
    expect(openedBlock as BlockMeta | null).toBe(bottomBlock);
  });

  test('does not open the menu when no block exists near the anchor', () => {
    let opened = false;
    const conversationManager = {
      findNearestBlock: () => null,
    } as unknown as KeyRouteState['conversationManager'];
    const state = makeState({
      conversationManager,
      getBlockAnchorLine: () => 100,
      blockActionsMenu: { open: () => { opened = true; } },
    });

    handlePromptKeyToken(state, enterToken());
    expect(opened).toBe(false);
  });
});
