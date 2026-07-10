import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { BlockMeta, ConversationManager } from '../core/conversation';
import type { InputHistory } from './input-history.ts';
import type { ContentPart } from '@pellux/goodvibes-sdk/platform/providers';
import type { CommandRegistry, CommandContext } from './command-registry.ts';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { SelectionManager } from './selection.ts';
import type { WrappedPromptInfo } from './handler-prompt-buffer.ts';
import {
  ensureInputCursorVisible as computeInputScrollTop,
  getWrappedPromptInfo as computeWrappedPromptInfo,
  moveCursorVertical as computeCursorVerticalMove,
} from './handler-prompt-buffer.ts';
import { cleanupMarkerRegistry, expandPrompt, findMarkerAtPos, registerPaste } from './handler-content-actions.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import { getPanelUnderMouse, workspaceTabAtMouse } from './panel-mouse-geometry.ts';
import type { PanelMouseLayout } from './panel-mouse-geometry.ts';
export type { PanelMouseLayout };
import type { KeybindingsManager } from './keybindings.ts';
import type { KillRing } from './kill-ring.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { trackPanelPasteFloodGuard, type PanelBurstGuardState } from './panel-paste-flood-guard.ts';

export type PanelFocusRouteState = {
  panelManager: PanelManager;
  keybindingsManager: KeybindingsManager;
  panelFocused: boolean;
  commandMode: boolean;
  searchActive: boolean;
  autocompleteActive: boolean;
  requestRender: () => void;
  handlePathCompletion: () => boolean;
  cyclePanelTab: (direction: 'next' | 'prev') => void;
  onPanelInputConsumed?: (activePanel: import('../panels/types.ts').Panel | null, key: string) => void;
  /**
   * True when THIS token is a paste: a single 'text' token whose value holds
   * more than one character. The SDK tokenizer emits a bracketed paste
   * (\x1b[?2004h, enabled in main.ts init) as exactly one such token; discrete
   * keystrokes — even several batched into one feed() by render-tick latency —
   * arrive as separate 1-char tokens. See the text-token branch below.
   */
  isPasteToken: boolean;
  /**
   * One-shot hint emitted when a paste is dropped because the focused panel has
   * no text capture (Invariant A: focus must not silently flip to the composer).
   */
  onPasteDropped?: (panelName: string) => void;
  /** Wall-clock time (ms) for this token; `burstGuard` is DEBT-5 item 5's flood-guard state, mutated in place across tokens (see panel-paste-flood-guard.ts). */
  now: number;
  burstGuard: PanelBurstGuardState;
  /**
   * True while a turn is actively streaming; gates Escape's cancel-first
   * precedence (I6.1) ahead of the panel's own two-stage escape contract
   * below.
   */
  isTurnActive: () => boolean;
  /** Cancel the active turn. Wired to commandContext.cancelGeneration. */
  cancelGeneration: () => void;
};

export function handlePanelFocusToken(state: PanelFocusRouteState, token: InputToken): {
  handled: boolean;
  panelFocused: boolean;
} {
  let panelFocused = state.panelFocused;

  if (
    token.type === 'key' &&
    token.logicalName === 'tab' &&
    !state.commandMode &&
    !state.searchActive &&
    !state.autocompleteActive
  ) {
    const pm = state.panelManager;
    if (pm.isVisible() && pm.getAllOpen().length > 0) {
      if (panelFocused) {
        panelFocused = false;
      } else if (!state.handlePathCompletion()) {
        panelFocused = true;
      }
      state.requestRender();
      return { handled: true, panelFocused };
    }
  }

  if (!panelFocused) {
    return { handled: false, panelFocused };
  }

  if (token.type === 'key') {
    // I6: two-stage Escape — give the panel a chance to consume escape first
    // (e.g. dismiss a confirm dialog or clear search). Only unfocus if the
    // panel returns false (unconsumed) or there is no active panel.
    if (token.logicalName === 'escape') {
      // I6.1/replay R5: while streaming, a focused panel must not swallow the
      // only way to cancel — Escape's first job is always cancel-turn; the
      // panel's own two-stage consume-or-unfocus contract only runs once no
      // turn is active, so a *second* Escape falls through to it normally
      // (panelFocused stays unchanged here). Calls cancelGeneration()
      // directly rather than the shared handleEscape() (handler-modal-stack.ts),
      // whose fallthrough order doesn't guarantee reaching it first.
      if (state.isTurnActive()) {
        state.cancelGeneration();
        state.requestRender();
        return { handled: true, panelFocused };
      }
      const activePanel = state.panelManager.getActive();
      const panelConsumedEscape = activePanel?.handleInput?.('escape') ?? false;
      if (panelConsumedEscape) {
        state.onPanelInputConsumed?.(activePanel!, 'escape');
        state.requestRender();
        return { handled: true, panelFocused };
      }
      panelFocused = false;
      state.requestRender();
      return { handled: true, panelFocused };
    }
    const kb = state.keybindingsManager;
    // NOTE: panel-tab-next/prev, panel-close, and panel-close-all are handled
    // globally in handleGlobalShortcutToken (runs earlier in the feed loop) —
    // their old, drifted copies here were unreachable and are gone. Only
    // panel-focus-toggle stays, since it's meaningful only once the panel
    // workspace already owns focus (it swaps between the two panes).
    if (kb.matches('panel-focus-toggle', token)) {
      // Switch keyboard focus between the top and bottom panes (no-op when
      // there is no visible, non-empty bottom pane).
      state.panelManager.togglePaneFocus();
      state.requestRender();
      return { handled: true, panelFocused };
    }
    // Alt+1..9 (panel-tab-1..9) is a global KeyAction consumed earlier by
    // handleGlobalShortcutToken, so those meta+digit tokens never reach here.
    // Any other ctrl/meta combo this route does not own falls through so the
    // global handler (which ran first) or the prompt routes can act on it.
    if (token.ctrl || token.meta) {
      return { handled: false, panelFocused };
    }
    const activePanel = state.panelManager.getActive();
    if (activePanel?.handleInput) {
      const consumed = activePanel.handleInput(token.logicalName);
      if (consumed) {
        state.onPanelInputConsumed?.(activePanel, token.logicalName);
        state.requestRender();
        return { handled: true, panelFocused };
      }
    }
  }

  if (token.type === 'text' && token.value) {
    const activePanel = state.panelManager.getActive();
    // UX-C: '/' is an explicit transfer verb back to the composer (a capturing panel, isCapturingTextBurst, keeps '/' for itself).
    if (token.value === '/' && !activePanel?.isCapturingTextBurst?.()) {
      panelFocused = false;
      return { handled: false, panelFocused };
    }
    // Invariant A/B (W6.2): a paste (isPasteToken, one multi-char token) into
    // a capturing panel forwards verbatim below; elsewhere it is DROPPED with
    // a one-shot hint (never exploded into hotkeys, never a silent focus
    // flip — focus moves only on an explicit verb). Discrete keystrokes fall
    // through to the per-char dispatch below.
    if (state.isPasteToken && !activePanel?.isCapturingTextBurst?.()) {
      state.onPasteDropped?.(activePanel?.name ?? 'the panel');
      state.requestRender();
      return { handled: true, panelFocused };
    }

    // DEBT-5 item 5 — paste flood guard (rate-based; see panel-paste-flood-guard.ts).
    if (!state.isPasteToken && !activePanel?.isCapturingTextBurst?.()) {
      const guard = trackPanelPasteFloodGuard(state.burstGuard, state.now);
      if (!guard.dispatch) {
        if (guard.showHintNow) state.onPasteDropped?.(activePanel?.name ?? 'the panel');
        state.requestRender();
        return { handled: true, panelFocused };
      }
    }

    if (activePanel?.handleInput) {
      for (const ch of token.value) {
        activePanel.handleInput(ch);
      }
      state.requestRender();
    }
    return { handled: true, panelFocused };
  }

  return { handled: true, panelFocused };
}

export type IndicatorFocusRouteState = {
  indicatorFocused: boolean;
  modalOpened: (name: string) => void;
  /** The footer process indicator's [Enter] opens the Fleet panel (F2 also opens it; the process modal was retired). */
  openFleetPanel: () => void;
  requestRender: () => void;
};

export function handleIndicatorFocusToken(state: IndicatorFocusRouteState, token: InputToken): {
  handled: boolean;
  indicatorFocused: boolean;
} {
  let indicatorFocused = state.indicatorFocused;
  if (!indicatorFocused) {
    return { handled: false, indicatorFocused };
  }

  if (token.type === 'key') {
    if (token.logicalName === 'up' || token.logicalName === 'escape') {
      indicatorFocused = false;
      state.requestRender();
      return { handled: true, indicatorFocused };
    }
    if (token.logicalName === 'enter') {
      indicatorFocused = false;
      // W2.2: opens the Fleet panel (see openFleetPanel's own doc, line ~352).
      state.openFleetPanel();
      state.requestRender();
      return { handled: true, indicatorFocused };
    }
    if (token.ctrl || token.logicalName === 'left' || token.logicalName === 'right') {
      indicatorFocused = false;
      return { handled: false, indicatorFocused };
    }
    state.requestRender();
    return { handled: true, indicatorFocused };
  }

  indicatorFocused = false;
  return { handled: false, indicatorFocused };
}

export type TextRouteState = {
  prompt: string;
  cursorPos: number;
  commandMode: boolean;
  nextPasteId: number;
  nextImageId: number;
  pasteRegistry: Map<string, string>;
  imageRegistry: Map<string, { data: string; mediaType: string }>;
  inputHistory: InputHistory | null;
  commandRegistry: CommandRegistry | null;
  commandContext: CommandContext | undefined;
  autocomplete: AutocompleteEngine | null;
  filePicker: { open: (insertPos: number, injectMode?: boolean) => void };
  modalOpened: (name: string) => void;
  saveUndoState: () => void;
  /** Coalescing undo snapshot for plain text insertions. */
  saveUndoStateForText: () => void;
  ensureInputCursorVisible: () => void;
  registerPaste: (content: string) => string;
  requestRender: () => void;
  killRing: KillRing;
};

export function handlePromptTextToken(state: TextRouteState, token: InputToken): {
  handled: boolean;
  prompt: string;
  cursorPos: number;
  commandMode: boolean;
} {
  if (token.type !== 'text') {
    return { handled: false, prompt: state.prompt, cursorPos: state.cursorPos, commandMode: state.commandMode };
  }

  if (token.value === '?' && state.prompt === '' && !state.commandMode) {
    if (state.commandContext?.openSelection) {
      state.commandRegistry?.execute('help', [], state.commandContext);
    }
    state.requestRender();
    return { handled: true, prompt: state.prompt, cursorPos: state.cursorPos, commandMode: state.commandMode };
  }

  if (state.inputHistory?.isBrowsing) {
    state.inputHistory.resetPosition();
  }
  state.killRing.clearYankState();
  state.saveUndoStateForText();
  const text = state.registerPaste(token.value);
  let prompt = state.prompt.slice(0, state.cursorPos) + text + state.prompt.slice(state.cursorPos);
  let cursorPos = state.cursorPos + text.length;
  let commandMode = state.commandMode;
  state.ensureInputCursorVisible();

  if (token.value === '@' && !commandMode) {
    const charBefore = cursorPos >= 2 ? prompt[cursorPos - 2] : undefined;
    if (charBefore === '!') {
      state.modalOpened('filePicker');
      state.filePicker.open(cursorPos - 2, true);
    } else if (charBefore === undefined || charBefore === ' ' || charBefore === '\n') {
      state.modalOpened('filePicker');
      state.filePicker.open(cursorPos - 1);
    }
  }

  if (prompt === '/') {
    // Arm commandMode as soon as the prompt becomes a bare '/', regardless of
    // whether commandRegistry has been (re)attached yet — this is a one-shot
    // transition (the only place commandMode ever becomes true), and gating
    // it on commandRegistry meant a transient null during a modal/overlay
    // handoff would permanently miss the window: every following keystroke
    // is then processed as plain chat text with no way to recover. Dispatch
    // (handleCommandModeToken, and the enter-key fallback below) still checks
    // commandRegistry itself before actually running anything.
    commandMode = true;
    state.modalOpened('command');
    state.autocomplete?.update('');
  } else if (commandMode && state.commandRegistry) {
    const query = prompt.startsWith('/') ? prompt.slice(1) : '';
    const spaceIdx = query.indexOf(' ');
    if (spaceIdx === -1) {
      state.autocomplete?.update(query);
    } else {
      state.autocomplete?.reset();
    }
  }

  return { handled: true, prompt, cursorPos, commandMode };
}

export type KeyRouteState = {
  prompt: string;
  cursorPos: number;
  inputScrollTop: number;
  commandMode: boolean;
  contentWidth: number;
  maxInputRows: number;
  inputHistory: InputHistory | null;
  indicatorFocused: boolean;
  conversationManager: ConversationManager | null;
  commandContext: CommandContext | undefined;
  /**
   * Deliver a concealed submission. When it returns true, concealed mode was
   * active and consumed the value — the plaintext went straight to the
   * requester, bypassing input history and the transcript. Optional so bare
   * test callers omit it.
   */
  submitConcealedInput?: (value: string) => boolean;
  /**
   * Optional: only used by the enter-key desync safety net below (a stray
   * slash-prefixed submission with commandMode somehow still false). When
   * absent, that fallback simply doesn't trigger — the primary fix (arming
   * commandMode on the '/' keystroke regardless of registry attachment, in
   * handlePromptTextToken above) is what actually prevents the desync.
   */
  commandRegistry?: CommandRegistry | null;
  autocomplete: AutocompleteEngine | null;
  blockActionsMenu: { open: (block: BlockMeta) => void };
  /** F2 opens+focuses the Fleet panel (which subsumes the retired process modal). */
  openFleetPanel: () => void;
  modalOpened: (name: string) => void;
  saveUndoState: () => void;
  /** Break the undo coalescing group (call on cursor moves). */
  breakUndoCoalesce: () => void;
  ensureInputCursorVisible: (contentWidth?: number) => void;
  getWrappedPromptInfo: (contentWidth: number) => WrappedPromptInfo;
  moveCursorVertical: (direction: -1 | 1) => boolean;
  handlePathCompletion: () => boolean;
  handleBlockToggle: () => void;
  findMarkerAtPos: (pos: number) => { start: number; end: number } | null;
  cleanupMarkerRegistry: (markerText: string) => void;
  expandPrompt: (text: string) => string | ContentPart[];
  scroll: (delta: number) => void;
  exitApp: () => void;
  requestRender: () => void;
  killRing: KillRing;
};

export function handlePromptKeyToken(state: KeyRouteState, token: InputToken): {
  handled: boolean;
  prompt: string;
  cursorPos: number;
  inputScrollTop: number;
  commandMode: boolean;
  indicatorFocused: boolean;
} {
  if (token.type !== 'key') {
    return {
      handled: false,
      prompt: state.prompt,
      cursorPos: state.cursorPos,
      inputScrollTop: state.inputScrollTop,
      commandMode: state.commandMode,
      indicatorFocused: state.indicatorFocused,
    };
  }

  let prompt = state.prompt;
  let cursorPos = state.cursorPos;
  let inputScrollTop = state.inputScrollTop;
  let commandMode = state.commandMode;
  let indicatorFocused = state.indicatorFocused;
  const ensureLocalInputCursorVisible = () => {
    inputScrollTop = computeInputScrollTop(prompt, cursorPos, inputScrollTop, state.contentWidth, state.maxInputRows);
  };
  const runQuitShortcut = (commandName: 'quit' | 'wq') => {
    if (state.commandContext?.executeCommand) {
      void state.commandContext.executeCommand(commandName, []).catch((error) => {
        state.commandContext?.print(
          `[${commandName}] ${summarizeError(error)}`,
        );
      });
      return;
    }
    state.exitApp();
  };

  if (token.logicalName === 'tab' && !commandMode) {
    if (!state.handlePathCompletion()) {
      state.handleBlockToggle();
    }
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'enter') {
    if (token.shift) {
      prompt = prompt.slice(0, cursorPos) + '\n' + prompt.slice(cursorPos);
      cursorPos++;
      ensureLocalInputCursorVisible();
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }

    // Concealed input: the typed line is a secret. Deliver the plaintext (the
    // live feed snapshot, not the possibly-stale handler buffer) to the
    // concealed consumer, never to input history or the transcript, then clear.
    if (state.submitConcealedInput?.(prompt)) {
      prompt = '';
      cursorPos = 0;
      state.requestRender();
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }

    const text = prompt.trim();
    if (!text && !commandMode) {
      const lineIndex = 0;
      const nearest = state.conversationManager?.findNearestBlock(lineIndex);
      if (nearest) {
        state.modalOpened('blockActions');
        state.blockActionsMenu.open(nearest);
        state.requestRender();
        return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
      }
    }
    if (text === ':q' || text === ':wq') {
      prompt = '';
      cursorPos = 0;
      runQuitShortcut(text === ':wq' ? 'wq' : 'quit');
      state.requestRender();
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }
    if (text) {
      // Safety net for a desynced commandMode: text is command-shaped (starts
      // with '/') but commandMode never armed — e.g. the '/' keystroke landed
      // during a modal/overlay handoff window. handleCommandModeToken (the
      // normal dispatch path for '/name ...') never runs in this state since
      // it early-returns when commandMode is false, so without this the text
      // would fall straight through to submitInput as ordinary chat. Re-derive
      // intent from the literal text instead of trusting commandMode alone.
      if (!commandMode && text.startsWith('/') && state.commandRegistry && state.commandContext?.executeCommand) {
        const parts = text.slice(1).trim().split(/\s+/);
        const name = parts[0];
        const args = parts.slice(1);
        prompt = '';
        cursorPos = 0;
        if (name) {
          const executeCommand = state.commandContext.executeCommand;
          void executeCommand(name, args).then((handled) => {
            if (!handled) {
              state.commandContext?.submitInput?.(text);
            }
            state.requestRender();
          });
        }
        return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
      }
      const expanded = state.expandPrompt(text);
      const historyRecallText = typeof expanded === 'string'
        ? expanded
        : expanded
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map(p => p.text)
            .join('');
      state.inputHistory?.add(text, { recallText: historyRecallText });
      prompt = '';
      cursorPos = 0;
      if (typeof expanded === 'string') {
        state.commandContext?.submitInput?.(expanded);
      } else {
        const textOnly = expanded
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map(p => p.text)
          .join('');
        state.commandContext?.submitInput?.(textOnly, expanded);
      }
    }
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'backspace') {
    if (cursorPos > 0) {
      state.killRing.clearYankState();
      state.saveUndoState();
      let marker = state.findMarkerAtPos(cursorPos);
      if (!marker) {
        const ahead = state.findMarkerAtPos(cursorPos + 1);
        if (ahead && ahead.start === cursorPos) {
          marker = ahead;
        }
      }
      if (marker) {
        const markerText = prompt.slice(marker.start, marker.end);
        state.cleanupMarkerRegistry(markerText);
        prompt = prompt.slice(0, marker.start) + prompt.slice(marker.end);
        cursorPos = marker.start;
      } else {
        prompt = prompt.slice(0, cursorPos - 1) + prompt.slice(cursorPos);
        cursorPos--;
      }
      ensureLocalInputCursorVisible();
    }
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'delete') {
    if (cursorPos < prompt.length) {
      state.killRing.clearYankState();
      state.saveUndoState();
      const marker = state.findMarkerAtPos(cursorPos + 1);
      if (marker) {
        const markerText = prompt.slice(marker.start, marker.end);
        state.cleanupMarkerRegistry(markerText);
        prompt = prompt.slice(0, marker.start) + prompt.slice(marker.end);
      } else {
        prompt = prompt.slice(0, cursorPos) + prompt.slice(cursorPos + 1);
      }
      ensureLocalInputCursorVisible();
    }
    state.requestRender();
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'left') {
    if (cursorPos > 0) {
      const marker = state.findMarkerAtPos(cursorPos);
      cursorPos = marker ? marker.start : cursorPos - 1;
      ensureLocalInputCursorVisible();
    }
    state.killRing.clearYankState();
    state.breakUndoCoalesce();
    state.requestRender();
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'right') {
    if (cursorPos < prompt.length) {
      const marker = state.findMarkerAtPos(cursorPos + 1);
      cursorPos = marker ? marker.end : cursorPos + 1;
      ensureLocalInputCursorVisible();
    }
    state.killRing.clearYankState();
    state.breakUndoCoalesce();
    state.requestRender();
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'home') {
    cursorPos = 0;
    state.killRing.clearYankState();
    state.breakUndoCoalesce();
    ensureLocalInputCursorVisible();
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'end') {
    cursorPos = prompt.length;
    state.killRing.clearYankState();
    state.breakUndoCoalesce();
    ensureLocalInputCursorVisible();
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'up') {
    const move = computeCursorVerticalMove(prompt, cursorPos, inputScrollTop, state.contentWidth, state.maxInputRows, -1);
    if (move.moved) {
      cursorPos = move.cursorPos;
      inputScrollTop = move.inputScrollTop;
    } else {
      const info = computeWrappedPromptInfo(prompt, cursorPos, inputScrollTop, state.contentWidth, state.maxInputRows);
      if (info.cursorWrappedLine === 0) {
        if (state.inputHistory) {
          const recalled = state.inputHistory.up(prompt);
          if (recalled !== null) {
            prompt = recalled;
            cursorPos = recalled.length;
            ensureLocalInputCursorVisible();
          } else {
            state.scroll(-3);
          }
        } else {
          state.scroll(-3);
        }
      }
    }
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'down') {
    const move = computeCursorVerticalMove(prompt, cursorPos, inputScrollTop, state.contentWidth, state.maxInputRows, 1);
    if (move.moved) {
      cursorPos = move.cursorPos;
      inputScrollTop = move.inputScrollTop;
    } else {
      const info = computeWrappedPromptInfo(prompt, cursorPos, inputScrollTop, state.contentWidth, state.maxInputRows);
      const atBottom = info.cursorWrappedLine >= info.wrappedLines.length - 1;
      if (atBottom && state.inputHistory?.isBrowsing) {
        const recalled = state.inputHistory.down();
        if (recalled !== null) {
          prompt = recalled;
          cursorPos = recalled.length;
          ensureLocalInputCursorVisible();
        } else {
          indicatorFocused = true;
        }
      } else {
        indicatorFocused = true;
      }
    }
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  // UX-C: F2 is now handled globally with toggle semantics (handler-shortcuts.ts)
  // BEFORE it ever reaches this route; this branch is dead in the real
  // pipeline but stays for panel-entry-points-reachable.test.ts's direct test.
  if (token.logicalName === 'f2') {
    indicatorFocused = false;
    state.openFleetPanel();
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  return { handled: false, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
}

export type MouseRouteState = {
  conversationManager: ConversationManager | null;
  selection: SelectionManager;
  panelManager: PanelManager;
  panelMouseLayout: PanelMouseLayout | null;
  mouseDownRow: number;
  mouseDownCol: number;
  scrollTop: number;
  viewportHeight: number;
  lineCount: number;
  scroll: (delta: number) => void;
  requestRender: () => void;
  handlePaste: () => void;
  handleCopy: () => void;
};

function scrollPanelUnderMouse(
  state: MouseRouteState,
  token: Extract<InputToken, { type: 'mouse' }>,
  deltaRows: number,
): boolean {
  const panel = getPanelUnderMouse(state.panelManager, state.panelMouseLayout, token.row, token.col);
  if (!panel?.handleScroll) return false;
  const consumed = panel.handleScroll(deltaRows);
  if (consumed) state.requestRender();
  return true;
}

export function handleMouseToken(state: MouseRouteState, token: InputToken): {
  handled: boolean;
  mouseDownRow: number;
  mouseDownCol: number;
} {
  let mouseDownRow = state.mouseDownRow;
  let mouseDownCol = state.mouseDownCol;
  if (token.type !== 'mouse') {
    return { handled: false, mouseDownRow, mouseDownCol };
  }

  const headerH = 2;
  const viewportRow = token.row - headerH;

  if (token.button === 64) {
    if (scrollPanelUnderMouse(state, token, -3)) {
      return { handled: true, mouseDownRow, mouseDownCol };
    }
    state.scroll(-3);
    return { handled: true, mouseDownRow, mouseDownCol };
  }
  if (token.button === 65) {
    if (scrollPanelUnderMouse(state, token, 3)) {
      return { handled: true, mouseDownRow, mouseDownCol };
    }
    state.scroll(3);
    return { handled: true, mouseDownRow, mouseDownCol };
  }
  if (token.button === 1 && token.action === 'press') {
    state.handlePaste();
    return { handled: true, mouseDownRow, mouseDownCol };
  }
  if (token.button === 0 && token.action === 'press') {
    // Click on a workspace tab activates it (checked before starting a text
    // selection so a tab click doesn't begin a drag-select).
    const tabIndex = workspaceTabAtMouse(state.panelManager, state.panelMouseLayout, token.row, token.col);
    if (tabIndex !== null) {
      state.panelManager.activateWorkspaceIndex(tabIndex);
      state.requestRender();
      return { handled: true, mouseDownRow, mouseDownCol };
    }
    mouseDownRow = token.row;
    mouseDownCol = token.col;
    state.selection.startSelection(token.col, viewportRow, state.scrollTop, state.viewportHeight, state.lineCount);
    return { handled: true, mouseDownRow, mouseDownCol };
  }
  if (token.button === 32) {
    state.selection.extendSelection(token.col, viewportRow, state.scrollTop, state.viewportHeight, state.lineCount);
    return { handled: true, mouseDownRow, mouseDownCol };
  }
  if (token.action === 'release') {
    const moved = Math.abs(token.row - mouseDownRow) + Math.abs(token.col - mouseDownCol);
    if (moved <= 2 && state.conversationManager) {
      const offset = Math.max(0, state.viewportHeight - state.lineCount);
      const absoluteLine = state.scrollTop + (viewportRow - offset);
      if (absoluteLine >= 0) {
        const blockIdx = state.conversationManager.toggleCollapseAtLine(absoluteLine);
        if (blockIdx >= 0) {
          state.selection.clearSelection();
          state.requestRender();
          return { handled: true, mouseDownRow: -1, mouseDownCol: -1 };
        }
      }
    }
    state.handleCopy();
    state.selection.endSelection();
    return { handled: true, mouseDownRow: -1, mouseDownCol: -1 };
  }

  return { handled: false, mouseDownRow, mouseDownCol };
}
