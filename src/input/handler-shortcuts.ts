import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { CommandContext } from './command-registry.ts';
import type { SearchManager } from './search.ts';
import type { HistorySearch } from './input-history.ts';
import type { ConversationManager } from '../core/conversation';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { KeybindingsManager } from './keybindings.ts';
import type { KillRing } from './kill-ring.ts';
import { wordBoundaryBack, wordBoundaryForward } from './kill-ring.ts';

type WrappedPromptInfo = {
  wrappedLines: string[];
  segments: { rawStart: number; length: number }[];
  cursorWrappedLine: number;
};

export type GlobalShortcutRouteState = {
  panelFocused: boolean;
  panelManager: PanelManager;
  keybindingsManager: KeybindingsManager;
  prompt: string;
  cursorPos: number;
  commandMode: boolean;
  autocomplete: AutocompleteEngine | null;
  historySearch: HistorySearch;
  searchManager: SearchManager;
  conversationManager: ConversationManager | null;
  commandContext?: CommandContext;
  contentWidth: number;
  getScrollTop: () => number;
  getWrappedPromptInfo: (contentWidth: number) => WrappedPromptInfo;
  saveUndoState: () => void;
  requestRender: () => void;
  scroll: (delta: number) => void;
  ensureInputCursorVisible: () => void;
  handleCopy: () => void;
  handleCtrlC: () => void;
  handleBlockCopy: () => void;
  handleBookmark: () => void;
  handleBlockSave: () => void;
  handleDiffApply: () => boolean;
  handleUndo: () => void;
  handleRedo: () => void;
  handlePaste: () => void;
  handleEscape: () => void;
  cyclePanelTab: (direction: 'next' | 'prev') => void;
  killRing: KillRing;
};

export function handleGlobalShortcutToken(
  state: GlobalShortcutRouteState,
  token: InputToken,
  viewportHeight: number,
): boolean {
  if (token.type !== 'key') return false;

  // Fast-path: BARE pageup/pagedown scroll the transcript. The `!token.ctrl`
  // guard is load-bearing: Ctrl+PageUp/PageDown are the panel-tab-prev/next
  // chords, so they must fall through to the keybinding lookup below instead of
  // being swallowed here as a scroll.
  if (token.logicalName === 'pageup' && !token.ctrl) {
    if (state.panelFocused) return false;
    state.scroll(-Math.max(1, viewportHeight - 2));
    return true;
  }
  if (token.logicalName === 'pagedown' && !token.ctrl) {
    if (state.panelFocused) return false;
    state.scroll(Math.max(1, viewportHeight - 2));
    return true;
  }
  // Bare escape is also not in the keybinding table.
  if (token.logicalName === 'escape' && !state.panelFocused) {
    state.handleEscape();
    return true;
  }

  // Bare F2 is also not in the keybinding table (hardcoded, like pageup/
  // pagedown/escape above) — it must be handled here, GLOBALLY, rather than
  // in handlePromptKeyToken (handler-feed-routes.ts) where it used to live.
  // That location only ever runs when the panel workspace does NOT already
  // own focus (handlePanelFocusToken, which runs before it, swallows every
  // unclaimed key once panelFocused is true and reports it handled). The
  // practical effect was that F2 could OPEN+focus the Fleet panel exactly
  // once; every subsequent press while already focused vanished silently —
  // "F2 pressed 4x never closed the panel" (UX-C evaluator finding). Routing
  // it here, before handlePanelFocusToken ever sees the token, gives F2 the
  // same toggle semantics as Ctrl+O below, matching how Ctrl+P/panel-picker
  // was already reachable regardless of panelFocused.
  if (token.logicalName === 'f2' && !token.ctrl && !token.meta) {
    toggleFleetPanel(state);
    return true;
  }

  // O(1) lookup via inverted map.
  const kb = state.keybindingsManager;
  const action = kb.lookup(token);

  switch (action) {
    case 'copy-selection':
      state.handleCopy();
      return true;

    case 'clear-cancel':
      state.handleCtrlC();
      return true;

    case 'screen-clear':
      state.commandContext?.clearScreen?.();
      return true;

    case 'panel-close-all': {
      const pm = state.panelManager;
      for (const p of pm.getAllOpen()) pm.close(p.id);
      pm.hide();
      state.panelFocused = false;
      state.requestRender();
      return true;
    }

    case 'panel-close': {
      const pm = state.panelManager;
      const active = pm.getActivePanel();
      // Wave-3: give the active panel a chance to consume Ctrl+X for an
      // in-panel action (FleetPanel session-tab detach) before it closes the
      // panel outright — see Panel.interceptPanelClose's doc comment.
      if (active?.interceptPanelClose?.()) {
        // UX-C fix: a consumed Ctrl+X (the Fleet panel's session-tab detach)
        // used to leave panelFocused untouched, so focus stayed on the panel
        // — the evaluator's "Ctrl+X detach landed focus in the panel and a
        // typed question became nav keys". Detach is a leave-taking action:
        // like the ordinary close below, it hands control back to the
        // composer rather than leaving the user stranded on the fleet tree.
        state.panelFocused = false;
        state.requestRender();
        return true;
      }
      if (active) {
        pm.close(active.id);
        state.requestRender();
      }
      state.panelFocused = false;
      return true;
    }

    case 'panel-picker':
      state.commandContext?.openPanelPicker?.();
      state.panelFocused = state.panelManager.isVisible() && state.panelManager.getAllOpen().length > 0;
      state.requestRender();
      return true;

    case 'panel-focus-toggle': {
      // Global entry point for the focus-toggle key (Ctrl+G): from the prompt
      // it grabs focus for the panel workspace. Once the workspace already has
      // focus we let it fall through (return false) so handlePanelFocusToken
      // can do the top/bottom pane swap — keeping that behavior in one place.
      if (state.panelFocused) return false;
      const pm = state.panelManager;
      if (pm.isVisible() && pm.getAllOpen().length > 0) {
        state.panelFocused = true;
        state.requestRender();
        return true;
      }
      return false;
    }

    case 'panel-tab-next':
      state.cyclePanelTab('next');
      return true;

    case 'panel-tab-prev':
      state.cyclePanelTab('prev');
      return true;

    case 'panel-tab-1':
    case 'panel-tab-2':
    case 'panel-tab-3':
    case 'panel-tab-4':
    case 'panel-tab-5':
    case 'panel-tab-6':
    case 'panel-tab-7':
    case 'panel-tab-8':
    case 'panel-tab-9': {
      // Alt+1..9: jump directly to the Nth workspace tab. Routed globally (like
      // panel-tab-next/prev) so the jump works whether focus is on the prompt or
      // the workspace; gated on visibility, matching cyclePanelTab semantics.
      // UX-C: a chord jump is "I'm going panel-driving" (focus rule 1a) — the
      // jump now also grabs keyboard focus, matching F2/Ctrl+O/Ctrl+P, so j/k
      // land in the newly-active tab immediately instead of the composer.
      const pm = state.panelManager;
      if (pm.isVisible()) {
        const index = Number(action.slice('panel-tab-'.length)) - 1;
        pm.activateWorkspaceIndex(index);
        pm.focusPanels();
        state.panelFocused = true;
        state.requestRender();
      }
      return true;
    }

    case 'panel-ops': {
      // Ctrl+O: TOGGLE the Fleet panel (UX-C — same semantics as F2 above; see
      // toggleFleetPanel's doc comment). The former Ops Control panel was
      // retired to an 'ops-control' -> 'fleet' alias (W6.1); rather than route
      // through the now-aliased openOpsPanel callback (which opens without
      // transferring focus), this operates on 'fleet' directly.
      toggleFleetPanel(state);
      return true;
    }

    case 'history-search':
      state.historySearch.open(state.prompt);
      state.requestRender();
      return true;

    case 'search':
      if (state.searchManager.active) state.searchManager.close();
      else state.searchManager.open();
      state.requestRender();
      return true;

    case 'block-copy':
      if (!state.commandMode) { state.handleBlockCopy(); return true; }
      return false;

    case 'bookmark':
      if (!state.commandMode) { state.handleBookmark(); return true; }
      return false;

    case 'block-save':
      if (!state.commandMode) { state.handleBlockSave(); return true; }
      return false;

    case 'delete-word': {
      state.saveUndoState();
      let pos = state.cursorPos;
      while (pos > 0 && state.prompt[pos - 1] === ' ') pos--;
      while (pos > 0 && state.prompt[pos - 1] !== ' ') pos--;
      const killedWord = state.prompt.slice(pos, state.cursorPos);
      if (killedWord) { state.killRing.push(killedWord); state.killRing.clearYankState(); }
      state.prompt = state.prompt.slice(0, pos) + state.prompt.slice(state.cursorPos);
      state.cursorPos = pos;
      state.ensureInputCursorVisible();
      return true;
    }

    case 'apply-diff-line-start': {
      if (!state.commandMode && state.handleDiffApply()) return true;
      const info = state.getWrappedPromptInfo(state.contentWidth);
      state.cursorPos = info.wrappedLines.length > 1 ? info.segments[info.cursorWrappedLine].rawStart : 0;
      state.ensureInputCursorVisible();
      return true;
    }

    case 'next-error-line-end': {
      if (state.prompt === '' && !state.commandMode) {
        const nextLine = state.conversationManager?.nextErrorLine(state.getScrollTop()) ?? -1;
        if (nextLine >= 0) {
          state.scroll(nextLine - state.getScrollTop());
          state.requestRender();
          return true;
        }
      }
      const info = state.getWrappedPromptInfo(state.contentWidth);
      state.cursorPos = info.wrappedLines.length > 1
        ? info.segments[info.cursorWrappedLine].rawStart + info.segments[info.cursorWrappedLine].length
        : state.prompt.length;
      state.ensureInputCursorVisible();
      return true;
    }

    case 'kill-line': {
      const killed = state.prompt.slice(state.cursorPos);
      state.saveUndoState();
      state.killRing.push(killed);
      state.killRing.clearYankState();
      state.prompt = state.prompt.slice(0, state.cursorPos);
      state.ensureInputCursorVisible();
      return true;
    }

    case 'clear-prompt': {
      // Legacy full-clear: keep as alias but do NOT call this when kill-to-start is bound.
      state.saveUndoState();
      state.prompt = '';
      state.cursorPos = 0;
      if (state.commandMode) {
        state.commandMode = false;
        state.autocomplete?.reset();
      }
      return true;
    }

    case 'kill-to-start': {
      // Kill from start of buffer to cursor, push to ring.
      const killed = state.prompt.slice(0, state.cursorPos);
      state.saveUndoState();
      state.killRing.push(killed);
      state.killRing.clearYankState();
      state.prompt = state.prompt.slice(state.cursorPos);
      state.cursorPos = 0;
      state.ensureInputCursorVisible();
      return true;
    }

    case 'kill-word-forward': {
      // Kill from cursor to end of next word, push to ring.
      const end = wordBoundaryForward(state.prompt, state.cursorPos);
      const killed = state.prompt.slice(state.cursorPos, end);
      if (killed) {
        state.saveUndoState();
        state.killRing.push(killed);
        state.killRing.clearYankState();
        state.prompt = state.prompt.slice(0, state.cursorPos) + state.prompt.slice(end);
        state.ensureInputCursorVisible();
      }
      return true;
    }

    case 'word-back': {
      const newPos = wordBoundaryBack(state.prompt, state.cursorPos);
      if (newPos !== state.cursorPos) {
        state.killRing.clearYankState();
        state.cursorPos = newPos;
        state.ensureInputCursorVisible();
      }
      return true;
    }

    case 'word-forward': {
      const newPos = wordBoundaryForward(state.prompt, state.cursorPos);
      if (newPos !== state.cursorPos) {
        state.killRing.clearYankState();
        state.cursorPos = newPos;
        state.ensureInputCursorVisible();
      }
      return true;
    }

    case 'yank': {
      const text = state.killRing.yank();
      if (text) {
        state.saveUndoState();
        state.prompt = state.prompt.slice(0, state.cursorPos) + text + state.prompt.slice(state.cursorPos);
        state.cursorPos += text.length;
        state.ensureInputCursorVisible();
      }
      return true;
    }

    case 'yank-pop': {
      // Only valid immediately after a yank or yank-pop.
      if (!state.killRing.lastActionWasYank) return false;
      // Undo the previous yank by restoring: we store the pre-yank snapshot on
      // the undo stack so a single undo covers the whole yank sequence.
      // For yank-pop: replace the last yanked text with the next ring entry.
      // We rely on the undo stack having the pre-yank state at the top.
      state.handleUndo();
      const text = state.killRing.yankPop();
      if (text) {
        state.saveUndoState();
        state.prompt = state.prompt.slice(0, state.cursorPos) + text + state.prompt.slice(state.cursorPos);
        state.cursorPos += text.length;
        state.ensureInputCursorVisible();
      }
      return true;
    }

    case 'undo':
      state.handleUndo();
      return true;

    case 'redo':
      state.handleRedo();
      return true;

    case 'paste':
      state.handlePaste();
      return true;

    default:
      return false;
  }
}

/**
 * toggleFleetPanel — the shared F2 / Ctrl+O TOGGLE (UX-C item 2): if the
 * Fleet panel is open AND the panel workspace currently owns keyboard focus
 * with Fleet as the active tab, the chord CLOSES it and returns focus to the
 * composer; if Fleet is open but not the focused/active tab, the chord brings
 * it to front and focuses it; if Fleet isn't open at all, the chord opens and
 * focuses it. Uses `state.panelFocused` (not a panelManager query) for the
 * focus check, consistent with every other case in this file and with what
 * the mocked PanelManager test doubles in global-shortcuts.test.ts actually
 * implement.
 */
function toggleFleetPanel(state: GlobalShortcutRouteState): void {
  const pm = state.panelManager;
  const fleetOpen = pm.getAllOpen().some((p) => p.id === 'fleet');
  const fleetIsFocusedActive = fleetOpen && state.panelFocused && pm.getActivePanel()?.id === 'fleet';
  if (fleetIsFocusedActive) {
    pm.close('fleet');
    state.panelFocused = false;
  } else {
    pm.open('fleet');
    pm.focusPanels();
    state.panelFocused = true;
  }
  state.requestRender();
}
