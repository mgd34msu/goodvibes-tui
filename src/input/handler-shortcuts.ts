import type { InputToken } from '../core/tokenizer.ts';
import { getPanelManager } from '../panels/panel-manager.ts';
import { getKeybindingsManager } from './keybindings.ts';
import type { CommandContext } from './command-registry.ts';
import type { SearchManager } from './search.ts';
import type { HistorySearch } from './input-history.ts';
import type { ConversationManager } from '../core/conversation.ts';
import type { AutocompleteEngine } from './autocomplete.ts';

type WrappedPromptInfo = {
  wrappedLines: string[];
  segments: { rawStart: number; length: number }[];
  cursorWrappedLine: number;
};

export type GlobalShortcutRouteState = {
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

  const kb = getKeybindingsManager();
  if (kb.matches('copy-selection', token)) {
    state.handleCopy();
    return true;
  }
  if (kb.matches('clear-cancel', token)) {
    state.handleCtrlC();
    return true;
  }
  if (token.logicalName === 'escape') {
    state.handleEscape();
    return true;
  }
  if (kb.matches('screen-clear', token)) {
    state.commandContext?.clearScreen?.();
    return true;
  }
  if (kb.matches('panel-close-all', token)) {
    const pm = getPanelManager();
    for (const p of pm.getAllOpen()) pm.close(p.id);
    pm.hide();
    state.requestRender();
    return true;
  }
  if (kb.matches('panel-close', token)) {
    const pm = getPanelManager();
    const active = pm.getActivePanel();
    if (active) {
      pm.close(active.id);
      state.requestRender();
    }
    return true;
  }
  if (kb.matches('panel-picker', token)) {
    state.commandContext?.openPanelPicker?.();
    state.requestRender();
    return true;
  }
  if (kb.matches('panel-tab-next', token)) {
    state.cyclePanelTab('next');
    return true;
  }
  if (kb.matches('panel-tab-prev', token)) {
    state.cyclePanelTab('prev');
    return true;
  }
  if (kb.matches('history-search', token)) {
    state.historySearch.open(state.prompt);
    state.requestRender();
    return true;
  }
  if (kb.matches('search', token)) {
    if (state.searchManager.active) state.searchManager.close();
    else state.searchManager.open();
    state.requestRender();
    return true;
  }
  if (kb.matches('block-copy', token) && !state.commandMode) {
    state.handleBlockCopy();
    return true;
  }
  if (kb.matches('bookmark', token) && !state.commandMode) {
    state.handleBookmark();
    return true;
  }
  if (kb.matches('block-save', token) && !state.commandMode) {
    state.handleBlockSave();
    return true;
  }
  if (kb.matches('delete-word', token)) {
    state.saveUndoState();
    let pos = state.cursorPos;
    while (pos > 0 && state.prompt[pos - 1] === ' ') pos--;
    while (pos > 0 && state.prompt[pos - 1] !== ' ') pos--;
    state.prompt = state.prompt.slice(0, pos) + state.prompt.slice(state.cursorPos);
    state.cursorPos = pos;
    state.ensureInputCursorVisible();
    return true;
  }
  if (kb.matches('apply-diff-line-start', token)) {
    if (!state.commandMode && state.handleDiffApply()) return true;
    const info = state.getWrappedPromptInfo(state.contentWidth);
    state.cursorPos = info.wrappedLines.length > 1 ? info.segments[info.cursorWrappedLine].rawStart : 0;
    state.ensureInputCursorVisible();
    return true;
  }
  if (kb.matches('next-error-line-end', token)) {
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
  if (kb.matches('kill-line', token)) {
    state.saveUndoState();
    state.prompt = state.prompt.slice(0, state.cursorPos);
    state.ensureInputCursorVisible();
    return true;
  }
  if (kb.matches('clear-prompt', token)) {
    state.saveUndoState();
    state.prompt = '';
    state.cursorPos = 0;
    if (state.commandMode) {
      state.commandMode = false;
      state.autocomplete?.reset();
    }
    return true;
  }
  if (kb.matches('undo', token)) {
    state.handleUndo();
    return true;
  }
  if (kb.matches('redo', token)) {
    state.handleRedo();
    return true;
  }
  if (kb.matches('paste', token)) {
    state.handlePaste();
    return true;
  }
  if (token.logicalName === 'pageup') {
    state.scroll(-Math.max(1, viewportHeight - 2));
    return true;
  }
  if (token.logicalName === 'pagedown') {
    state.scroll(Math.max(1, viewportHeight - 2));
    return true;
  }

  return false;
}
