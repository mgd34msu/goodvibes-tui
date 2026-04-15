import type { InputToken } from '@pellux/goodvibes-sdk/platform/core/tokenizer';
import type { BlockMeta, ConversationManager } from '../core/conversation.ts';
import type { InputHistory } from './input-history.ts';
import type { ContentPart } from '../providers/interface.ts';
import type { CommandRegistry, CommandContext } from './command-registry.ts';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { SelectionManager } from './selection.ts';
import type { WrappedPromptInfo } from './handler-prompt-buffer.ts';
import { cleanupMarkerRegistry, expandPrompt, findMarkerAtPos, registerPaste } from './handler-content-actions.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { KeybindingsManager } from './keybindings.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

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
    if (token.logicalName === 'escape') {
      panelFocused = false;
      state.requestRender();
      return { handled: true, panelFocused };
    }
    const kb = state.keybindingsManager;
    if (kb.matches('panel-tab-next', token)) {
      state.cyclePanelTab('next');
      return { handled: true, panelFocused };
    }
    if (kb.matches('panel-tab-prev', token)) {
      state.cyclePanelTab('prev');
      return { handled: true, panelFocused };
    }
    if (kb.matches('panel-close-all', token)) {
      const pm = state.panelManager;
      for (const p of pm.getAllOpen()) pm.close(p.id);
      panelFocused = false;
      state.requestRender();
      return { handled: true, panelFocused };
    }
    if (kb.matches('panel-close', token)) {
      const pm = state.panelManager;
      const active = pm.getActivePanel();
      if (active) {
        pm.close(active.id);
        if (pm.getAllOpen().length === 0) {
          panelFocused = false;
        }
      }
      state.requestRender();
      return { handled: true, panelFocused };
    }
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
  processModal: { open: () => void };
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
      state.modalOpened('process');
      state.processModal.open();
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
  ensureInputCursorVisible: () => void;
  registerPaste: (content: string) => string;
  requestRender: () => void;
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
  state.saveUndoState();
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

  if (prompt === '/' && state.commandRegistry) {
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
  commandMode: boolean;
  contentWidth: number;
  inputHistory: InputHistory | null;
  indicatorFocused: boolean;
  conversationManager: ConversationManager | null;
  commandContext: CommandContext | undefined;
  autocomplete: AutocompleteEngine | null;
  blockActionsMenu: { open: (block: BlockMeta) => void };
  processModal: { open: () => void };
  modalOpened: (name: string) => void;
  saveUndoState: () => void;
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
};

export function handlePromptKeyToken(state: KeyRouteState, token: InputToken): {
  handled: boolean;
  prompt: string;
  cursorPos: number;
  commandMode: boolean;
  indicatorFocused: boolean;
} {
  if (token.type !== 'key') {
    return {
      handled: false,
      prompt: state.prompt,
      cursorPos: state.cursorPos,
      commandMode: state.commandMode,
      indicatorFocused: state.indicatorFocused,
    };
  }

  let prompt = state.prompt;
  let cursorPos = state.cursorPos;
  let commandMode = state.commandMode;
  let indicatorFocused = state.indicatorFocused;
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
    return { handled: true, prompt, cursorPos, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'enter') {
    if (token.shift) {
      prompt = prompt.slice(0, cursorPos) + '\n' + prompt.slice(cursorPos);
      cursorPos++;
      state.ensureInputCursorVisible();
      return { handled: true, prompt, cursorPos, commandMode, indicatorFocused };
    }

    const text = prompt.trim();
    if (!text && !commandMode) {
      const lineIndex = 0;
      const nearest = state.conversationManager?.findNearestBlock(lineIndex);
      if (nearest) {
        state.modalOpened('blockActions');
        state.blockActionsMenu.open(nearest);
        state.requestRender();
        return { handled: true, prompt, cursorPos, commandMode, indicatorFocused };
      }
    }
    if (text === ':q' || text === ':wq') {
      prompt = '';
      cursorPos = 0;
      runQuitShortcut(text === ':wq' ? 'wq' : 'quit');
      state.requestRender();
      return { handled: true, prompt, cursorPos, commandMode, indicatorFocused };
    }
    if (text) {
      state.inputHistory?.add(text);
      prompt = '';
      cursorPos = 0;
      const expanded = state.expandPrompt(text);
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
    return { handled: true, prompt, cursorPos, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'backspace') {
    if (cursorPos > 0) {
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
      state.ensureInputCursorVisible(state.contentWidth);
    }
    return { handled: true, prompt, cursorPos, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'delete') {
    if (cursorPos < prompt.length) {
      state.saveUndoState();
      const marker = state.findMarkerAtPos(cursorPos + 1);
      if (marker) {
        const markerText = prompt.slice(marker.start, marker.end);
        state.cleanupMarkerRegistry(markerText);
        prompt = prompt.slice(0, marker.start) + prompt.slice(marker.end);
      } else {
        prompt = prompt.slice(0, cursorPos) + prompt.slice(cursorPos + 1);
      }
      state.ensureInputCursorVisible(state.contentWidth);
    }
    state.requestRender();
    return { handled: true, prompt, cursorPos, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'left') {
    if (cursorPos > 0) {
      const marker = state.findMarkerAtPos(cursorPos);
      cursorPos = marker ? marker.start : cursorPos - 1;
      state.ensureInputCursorVisible(state.contentWidth);
    }
    state.requestRender();
    return { handled: true, prompt, cursorPos, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'right') {
    if (cursorPos < prompt.length) {
      const marker = state.findMarkerAtPos(cursorPos + 1);
      cursorPos = marker ? marker.end : cursorPos + 1;
      state.ensureInputCursorVisible(state.contentWidth);
    }
    state.requestRender();
    return { handled: true, prompt, cursorPos, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'home') {
    cursorPos = 0;
    return { handled: true, prompt, cursorPos, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'end') {
    cursorPos = prompt.length;
    return { handled: true, prompt, cursorPos, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'up') {
    if (!state.moveCursorVertical(-1)) {
      const info = state.getWrappedPromptInfo(state.contentWidth);
      if (info.cursorWrappedLine === 0) {
        if (state.inputHistory) {
          const recalled = state.inputHistory.up(prompt);
          if (recalled !== null) {
            prompt = recalled;
            cursorPos = recalled.length;
            state.ensureInputCursorVisible();
          } else {
            state.scroll(-3);
          }
        } else {
          state.scroll(-3);
        }
      }
    }
    return { handled: true, prompt, cursorPos, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'down') {
    if (!state.moveCursorVertical(1)) {
      const info = state.getWrappedPromptInfo(state.contentWidth);
      if (info.wrappedLines.length <= 1) {
        if (state.inputHistory?.isBrowsing) {
          const recalled = state.inputHistory.down();
          if (recalled !== null) {
            prompt = recalled;
            cursorPos = recalled.length;
            state.ensureInputCursorVisible();
          } else {
            indicatorFocused = true;
          }
        } else {
          indicatorFocused = true;
        }
      } else {
        indicatorFocused = true;
      }
    }
    return { handled: true, prompt, cursorPos, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'f2') {
    indicatorFocused = false;
    state.modalOpened('process');
    state.processModal.open();
    return { handled: true, prompt, cursorPos, commandMode, indicatorFocused };
  }

  return { handled: false, prompt, cursorPos, commandMode, indicatorFocused };
}

export type MouseRouteState = {
  conversationManager: ConversationManager | null;
  selection: SelectionManager;
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
    state.scroll(-3);
    return { handled: true, mouseDownRow, mouseDownCol };
  }
  if (token.button === 65) {
    state.scroll(3);
    return { handled: true, mouseDownRow, mouseDownCol };
  }
  if (token.button === 1 && token.action === 'press') {
    state.handlePaste();
    return { handled: true, mouseDownRow, mouseDownCol };
  }
  if (token.button === 0 && token.action === 'press') {
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
