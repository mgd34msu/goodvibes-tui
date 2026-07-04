/**
 * W0.8 sub-fix A: F2 and Enter-on-status (the other two panel/process-modal
 * entry points named in the brief, alongside Ctrl+P covered in
 * global-shortcuts.test.ts) must stay reachable while a turn is active.
 *
 * Root cause finding (see the W0.8 audit brief): no busy/turn guard exists
 * anywhere in the input pipeline. handlePromptKeyToken's F2 branch calls
 * processModal.open() and handleIndicatorFocusToken's Enter branch calls
 * openFleetPanel() (W2.2 repoint — previously processModal.open() too)
 * unconditionally — neither KeyRouteState nor IndicatorFocusRouteState
 * carries an orchestrator/isThinking field, so there is nothing here that
 * *could* gate on turn state. These tests lock in that reachability so a
 * future change can't accidentally introduce a busy guard that blocks them.
 */
import { describe, expect, mock, test } from 'bun:test';
import {
  handlePromptKeyToken,
  handleIndicatorFocusToken,
  type KeyRouteState,
  type IndicatorFocusRouteState,
} from '../../input/handler-feed-routes.ts';

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

describe('panel/process-modal entry points stay reachable during an active turn', () => {
  test('F2 opens the process modal (handlePromptKeyToken carries no turn-state field to gate on)', () => {
    const opened: string[] = [];
    const result = handlePromptKeyToken({
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
      processModal: { open: () => { opened.push('process'); } },
      modalOpened: mock(() => {}),
      saveUndoState: () => {},
      breakUndoCoalesce: () => {},
      ensureInputCursorVisible: () => {},
      getWrappedPromptInfo: () => wrappedPromptInfo(),
      moveCursorVertical: () => false,
      handlePathCompletion: () => false,
      handleBlockToggle: () => {},
      findMarkerAtPos: () => null,
      cleanupMarkerRegistry: () => {},
      expandPrompt: (text: string) => text,
      scroll: () => {},
      exitApp: () => {},
      requestRender: () => {},
    } as unknown as KeyRouteState, { type: 'key', name: '\x1bOQ', logicalName: 'f2', ctrl: false, shift: false, meta: false });

    expect(result.handled).toBe(true);
    expect(opened).toEqual(['process']);
  });

  test('Enter on the focused status/process indicator opens the Fleet panel (W2.2 repoint; handleIndicatorFocusToken carries no turn-state field to gate on)', () => {
    const opened: string[] = [];
    const state: IndicatorFocusRouteState = {
      indicatorFocused: true,
      modalOpened: mock(() => {}),
      openFleetPanel: () => { opened.push('fleet'); },
      requestRender: mock(() => {}),
    };
    const result = handleIndicatorFocusToken(state, {
      type: 'key', name: '\r', logicalName: 'enter', ctrl: false, shift: false, meta: false,
    });

    expect(result.handled).toBe(true);
    expect(opened).toEqual(['fleet']);
    expect(result.indicatorFocused).toBe(false);
  });
});
