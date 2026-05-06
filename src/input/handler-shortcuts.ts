import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { CommandContext } from './command-registry.ts';
import type { SearchManager } from './search.ts';
import type { HistorySearch } from './input-history.ts';
import type { ConversationManager } from '../core/conversation';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { KeybindingsManager } from './keybindings.ts';

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
      return true;
    }

    case 'panel-picker':
      state.commandContext?.openPanelPicker?.();
      state.requestRender();
      return true;

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

    case 'kill-line':
      state.saveUndoState();
      state.prompt = state.prompt.slice(0, state.cursorPos);
      state.ensureInputCursorVisible();
      return true;

    case 'clear-prompt':
      state.saveUndoState();
      state.prompt = '';
      state.cursorPos = 0;
      if (state.commandMode) {
        state.commandMode = false;
        state.autocomplete?.reset();
      }
      return true;

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
