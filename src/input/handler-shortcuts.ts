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

  // Fast-path: bare pageup/pagedown have no keybinding entry.
  if (token.logicalName === 'pageup') {
    if (state.panelFocused) return false;
    state.scroll(-Math.max(1, viewportHeight - 2));
    return true;
  }
  if (token.logicalName === 'pagedown') {
    if (state.panelFocused) return false;
    state.scroll(Math.max(1, viewportHeight - 2));
    return true;
  }
  // Bare escape is also not in the keybinding table.
  if (token.logicalName === 'escape' && !state.panelFocused) {
    state.handleEscape();
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
