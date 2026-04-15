import { readFileSync } from 'node:fs';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core/tokenizer';
import type { CommandContext } from './command-registry.ts';
import type { CategoryFilter, ModelPickerModal } from './model-picker.ts';
import { MODEL_PICKER_CHROME_LINES } from '../renderer/model-picker-overlay.ts';
import { resolveAndValidatePath } from '@pellux/goodvibes-sdk/platform/utils/path-safety';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { ProcessEntry } from '../renderer/process-modal.ts';
import type { BlockActionId } from '../renderer/block-actions.ts';

type ModelPickerRouteState = {
  modelPicker: ModelPickerModal;
  modalStack: string[];
  commandContext?: CommandContext;
  getViewportHeight: () => number;
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleModelPickerToken(state: ModelPickerRouteState, token: InputToken): boolean {
  if (!state.modelPicker.active) return false;

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      if (state.modelPicker.searchFocused && state.modelPicker.mode !== 'contextCap') {
        if (state.modelPicker.query.length > 0) {
          state.modelPicker.clearQuery();
        } else {
          state.modelPicker.blurSearch();
        }
      } else if (state.modelPicker.query.length > 0) {
        state.modelPicker.clearQuery();
      } else if (state.modelPicker.mode === 'effort') {
        state.modelPicker.mode = 'model';
        state.modelPicker.selectedIndex = 0;
      } else if (state.modelPicker.mode === 'contextCap') {
        state.modelPicker.contextCapQuery = '';
        state.modelPicker.contextCapPendingModel = null;
        state.modelPicker.mode = 'model';
      } else if (state.modelPicker.mode === 'model' && state.modelPicker.previousMode === 'provider') {
        state.modelPicker.mode = 'provider';
        state.modelPicker.selectedIndex = 0;
      } else {
        state.handleEscape();
        return true;
      }
    } else if (token.logicalName === 'backspace') {
      if (state.modelPicker.mode === 'contextCap') state.modelPicker.deleteContextCapChar();
      else if (state.modelPicker.searchFocused && (state.modelPicker.mode === 'model' || state.modelPicker.mode === 'provider')) state.modelPicker.deleteChar();
    } else if (token.logicalName === 'enter') {
      const mode = state.modelPicker.mode;
      const idx = state.modelPicker.selectedIndex;
      if (mode === 'model') {
        const selected = state.modelPicker.getSelected();
        if (selected) {
          const currentEffort = state.commandContext?.session.runtime.reasoningEffort ?? 'medium';
          if (selected.reasoningEffort && selected.reasoningEffort.length > 0) {
            state.modelPicker.showEffortPicker(selected, currentEffort);
          } else {
            state.commandContext?.completeModelSelection?.({
              model: selected,
              effort: currentEffort,
            });
            state.modelPicker.close();
            if (state.modalStack[state.modalStack.length - 1] === 'modelPicker') state.modalStack.pop();
          }
        }
      } else if (mode === 'provider') {
        const selectedProvider = state.modelPicker.getFilteredProviders()[idx];
        if (selectedProvider) {
          const models = state.commandContext
            ? state.commandContext.provider.providerRegistry.getSelectableModels().filter(m => m.provider === selectedProvider)
            : [];
          state.modelPicker.showModelsForProvider(models, selectedProvider);
        }
      } else if (mode === 'effort') {
        const model = state.modelPicker.pendingModel;
        const effort = state.modelPicker.effortLevels[idx];
        if (model && effort) state.commandContext?.completeModelSelection?.({ model, effort });
        state.modelPicker.close();
        if (state.modalStack[state.modalStack.length - 1] === 'modelPicker') state.modalStack.pop();
      } else if (mode === 'contextCap') {
        const capModel = state.modelPicker.contextCapPendingModel;
        if (capModel) {
          const rawInput = state.modelPicker.contextCapQuery.trim();
          const parsedCap = rawInput.length > 0 ? parseInt(rawInput, 10) : null;
          const validCap = parsedCap !== null && parsedCap > 0 && parsedCap <= 10_000_000 ? parsedCap : null;
          const effort = state.commandContext?.session.runtime.reasoningEffort ?? 'medium';
          state.commandContext?.completeModelSelection?.({ model: capModel, effort, contextCap: validCap });
        }
        state.modelPicker.close();
        if (state.modalStack[state.modalStack.length - 1] === 'modelPicker') state.modalStack.pop();
      }
    } else if (token.logicalName === 'up') {
      if (state.modelPicker.canFocusSearch() && !state.modelPicker.searchFocused && state.modelPicker.selectedIndex === 0) {
        state.modelPicker.focusSearch();
      } else if (!state.modelPicker.searchFocused) {
        const maxVis = Math.max(5, state.getViewportHeight() - MODEL_PICKER_CHROME_LINES - 4);
        state.modelPicker.moveUp(maxVis);
      }
    } else if (token.logicalName === 'down') {
      if (state.modelPicker.searchFocused) {
        state.modelPicker.blurSearch();
      } else {
        const maxVis = Math.max(5, state.getViewportHeight() - MODEL_PICKER_CHROME_LINES - 4);
        state.modelPicker.moveDown(maxVis);
      }
    } else if (token.logicalName === 'tab' && state.modelPicker.mode === 'model') {
      const cycle: CategoryFilter[] = ['all', 'free', 'paid', 'subscription'];
      const cur = cycle.indexOf(state.modelPicker.categoryFilter);
      state.modelPicker.setCategoryFilter(cycle[(cur + 1) % cycle.length]!);
    } else if (!state.modelPicker.searchFocused && token.logicalName === 'g' && state.modelPicker.mode === 'model') {
      state.modelPicker.cycleGroupBy();
    } else if (!state.modelPicker.searchFocused && token.logicalName === '/' && state.modelPicker.canFocusSearch()) {
      state.modelPicker.focusSearch();
    }
  } else if (token.type === 'text') {
    if (state.modelPicker.mode === 'contextCap') {
      if (token.value.length === 1) state.modelPicker.appendContextCapChar(token.value);
    } else if ((state.modelPicker.mode === 'model' || state.modelPicker.mode === 'provider') && state.modelPicker.searchFocused) {
      const ch = token.value;
      if (ch === ' ' && state.modelPicker.mode === 'model') {
        const selected = state.modelPicker.getSelected();
        if (selected && state.modelPicker.isLocalModel(selected)) state.modelPicker.enterContextCapMode(selected);
        else if (ch.length === 1 && ch >= ' ') state.modelPicker.appendChar(ch);
      } else if (ch.length === 1 && ch >= ' ') {
        state.modelPicker.appendChar(ch);
      }
    } else if (token.value === ' ' && state.modelPicker.mode === 'model') {
      const selected = state.modelPicker.getSelected();
      if (selected && state.modelPicker.isLocalModel(selected)) state.modelPicker.enterContextCapMode(selected);
    } else if (token.value === 'g' && state.modelPicker.mode === 'model') {
      state.modelPicker.cycleGroupBy();
    } else if (token.value === '/' && state.modelPicker.canFocusSearch()) {
      state.modelPicker.focusSearch();
    }
  }

  state.requestRender();
  return true;
}

type ProcessRouteState = {
  processModal: {
    active: boolean;
    moveUp: () => void;
    moveDown: () => void;
    getSelected: () => ProcessEntry | undefined;
    close: () => void;
    open: () => void;
    killSelected: () => boolean;
    refresh: () => void;
  };
  liveTailModal: {
    open: (entry: ProcessEntry) => void;
  };
  agentDetailModal: {
    open: (id: string) => void;
  };
  modalOpened: (name: string) => void;
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleProcessModalToken(state: ProcessRouteState, token: InputToken): boolean {
  if (!state.processModal.active) return false;

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'up') state.processModal.moveUp();
    else if (token.logicalName === 'down') state.processModal.moveDown();
    else if (token.logicalName === 'enter') {
      const entry = state.processModal.getSelected();
      if (entry) {
        if (entry.type === 'agent') {
          state.modalOpened('agentDetail');
          state.processModal.close();
          state.agentDetailModal.open(entry.id);
        } else {
          state.modalOpened('liveTail');
          state.processModal.close();
          state.liveTailModal.open(entry);
        }
      }
    }
  } else if (token.type === 'text' && token.value === 'k') {
    const killed = state.processModal.killSelected();
    if (killed) state.processModal.refresh();
  }

  state.requestRender();
  return true;
}

type LiveTailRouteState = {
  liveTailModal: {
    active: boolean;
    scrollUp: () => void;
    scrollDown: () => void;
    killProcess: () => void;
    close: () => void;
  };
  processModal: {
    open: () => void;
  };
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleLiveTailToken(state: LiveTailRouteState, token: InputToken): boolean {
  if (!state.liveTailModal.active) return false;

  const killAndReturn = (): void => {
    state.liveTailModal.killProcess();
    state.handleEscape();
  };

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'up') state.liveTailModal.scrollUp();
    else if (token.logicalName === 'down') state.liveTailModal.scrollDown();
    else if (token.logicalName === 'k') killAndReturn();
  } else if (token.type === 'text' && token.value === 'k') {
    killAndReturn();
  }

  state.requestRender();
  return true;
}

type EscapeOnlyModalRouteState = {
  active: boolean;
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleEscapeOnlyModalToken(state: EscapeOnlyModalRouteState, token: InputToken): boolean {
  if (!state.active) return false;
  if (token.type === 'key' && token.logicalName === 'escape') {
    state.handleEscape();
    return true;
  }
  state.requestRender();
  return true;
}

type FilePickerRouteState = {
  filePicker: {
    active: boolean;
    query: string;
    searchFocused: boolean;
    insertPos: number;
    injectMode: boolean;
    close: () => void;
    setQuery: (query: string) => void;
    focusSearch: () => void;
    blurSearch: () => void;
    getSelected: () => string | null;
    selectedIndex: number;
    moveUp: () => void;
    moveDown: () => void;
  };
  prompt: string;
  cursorPos: number;
  commandContext?: CommandContext;
  imageRegistry: Map<string, { data: string; mediaType: string }>;
  nextImageId: number;
  requestRender: () => void;
  handleEscape: () => void;
  saveUndoState: () => void;
  ensureInputCursorVisible: () => void;
  formatFileSize: (bytes: number) => string;
  mediaTypeFromExt: (ext: string) => string;
  imageExtensions: string[];
};

export function handleFilePickerToken(state: FilePickerRouteState, token: InputToken): boolean {
  if (!state.filePicker.active) return false;

  if (token.type === 'text') {
    if (!state.filePicker.searchFocused && token.value === '/') {
      state.filePicker.focusSearch();
    } else if (state.filePicker.searchFocused && token.value === ' ' && state.filePicker.query === '') {
      state.filePicker.close();
    } else if (state.filePicker.searchFocused) {
      state.filePicker.setQuery(state.filePicker.query + token.value);
    }
  } else if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      if (state.filePicker.searchFocused && state.filePicker.query.length > 0) {
        state.filePicker.setQuery('');
        state.requestRender();
        return true;
      }
      state.handleEscape();
      return true;
    } else if (token.logicalName === 'enter') {
      const selected = state.filePicker.getSelected();
      if (selected) {
        state.saveUndoState();
        const atPos = state.filePicker.insertPos;
        const injectMode = state.filePicker.injectMode;
        const prefixLen = injectMode ? 2 : 1;
        const queryLen = state.filePicker.query.length + prefixLen;
        const ext = selected.slice(selected.lastIndexOf('.'));
        if (!injectMode && state.imageExtensions.some(e => e === ext.toLowerCase())) {
          try {
            const projectRoot = state.commandContext?.workspace.shellPaths?.workingDirectory
              ?? state.commandContext?.platform.configManager.getWorkingDirectory();
            if (!projectRoot) {
              throw new Error('working directory is unavailable');
            }
            const resolvedPath = resolveAndValidatePath(selected, projectRoot);
            const data = readFileSync(resolvedPath);
            const base64 = data.toString('base64');
            const mediaType = state.mediaTypeFromExt(ext);
            const filename = selected.split('/').pop() ?? selected;
            const id = `img${state.nextImageId++}`;
            state.imageRegistry.set(id, { data: base64, mediaType });
            const marker = `[IMAGE: ${id}, ${filename}, ${state.formatFileSize(data.length)}]`;
            state.prompt = state.prompt.slice(0, atPos) + marker + ' ' + state.prompt.slice(atPos + queryLen);
            state.cursorPos = atPos + marker.length + 1;
          } catch (err) {
            logger.debug('file-picker: could not read image file', { err });
            state.prompt = state.prompt.slice(0, atPos) + '@' + selected + ' ' + state.prompt.slice(atPos + queryLen);
            state.cursorPos = atPos + selected.length + 2;
          }
        } else if (injectMode) {
          const marker = `!@${selected}`;
          state.prompt = state.prompt.slice(0, atPos) + marker + ' ' + state.prompt.slice(atPos + queryLen);
          state.cursorPos = atPos + marker.length + 1;
        } else {
          state.prompt = state.prompt.slice(0, atPos) + '@' + selected + ' ' + state.prompt.slice(atPos + queryLen);
          state.cursorPos = atPos + selected.length + 2;
        }
        state.ensureInputCursorVisible();
      }
      state.filePicker.close();
    } else if (token.logicalName === 'up') {
      if (!state.filePicker.searchFocused && state.filePicker.selectedIndex === 0) {
        state.filePicker.focusSearch();
      } else if (!state.filePicker.searchFocused) {
        state.filePicker.moveUp();
      }
    } else if (token.logicalName === 'down') {
      if (state.filePicker.searchFocused) {
        state.filePicker.blurSearch();
      } else {
        state.filePicker.moveDown();
      }
    } else if (token.logicalName === 'backspace') {
      if (state.filePicker.searchFocused && state.filePicker.query.length > 0) {
        state.filePicker.setQuery(state.filePicker.query.slice(0, -1));
      } else if (state.filePicker.searchFocused) {
        const removeCount = state.filePicker.injectMode ? 2 : 1;
        if (state.cursorPos >= removeCount) {
          state.prompt = state.prompt.slice(0, state.cursorPos - removeCount) + state.prompt.slice(state.cursorPos);
          state.cursorPos -= removeCount;
        }
        state.filePicker.close();
      }
    }
  }

  state.requestRender();
  return true;
}

type BlockActionsRouteState = {
  blockActionsMenu: {
    active: boolean;
    moveUp: () => void;
    moveDown: () => void;
    getSelected: () => { id: BlockActionId } | null;
    close: () => void;
    getActionForKey: (key: string) => { id: BlockActionId } | null;
  };
  executeBlockAction: (id: BlockActionId) => void;
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleBlockActionsToken(state: BlockActionsRouteState, token: InputToken): boolean {
  if (!state.blockActionsMenu.active) return false;

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'up') state.blockActionsMenu.moveUp();
    else if (token.logicalName === 'down') state.blockActionsMenu.moveDown();
    else if (token.logicalName === 'enter') {
      const action = state.blockActionsMenu.getSelected();
      state.blockActionsMenu.close();
      if (action) state.executeBlockAction(action.id);
    } else if (token.logicalName === 'tab') {
      const action = state.blockActionsMenu.getActionForKey('Tab');
      state.blockActionsMenu.close();
      if (action) state.executeBlockAction(action.id);
    }
  } else if (token.type === 'text') {
    const action = state.blockActionsMenu.getActionForKey(token.value);
    state.blockActionsMenu.close();
    if (action) state.executeBlockAction(action.id);
  }

  state.requestRender();
  return true;
}
