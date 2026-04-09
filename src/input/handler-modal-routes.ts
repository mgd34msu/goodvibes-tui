import type { InputToken } from '../core/tokenizer.ts';
import type { SelectionResult, SelectionAction } from './selection-modal.ts';
import type { CommandContext } from './command-registry.ts';

type SelectionRouteState = {
  selectionModal: {
    active: boolean;
    query: string;
    searchFocused: boolean;
    allowSearch: boolean;
    customActions: Map<string, SelectionAction>;
    selectedIndex: number;
    getSelected: () => SelectionResult['item'] | null | undefined;
    setQuery: (query: string) => void;
    focusSearch: () => void;
    blurSearch: () => void;
    moveUp: () => void;
    moveDown: () => void;
    close: () => void;
  };
  selectionCallback: ((result: SelectionResult | null) => void) | null;
  modalStack: string[];
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleSelectionModalToken(state: SelectionRouteState, token: InputToken): boolean {
  if (!state.selectionModal.active) return false;

  const getPrimaryAction = (selected: NonNullable<ReturnType<typeof state.selectionModal.getSelected>> | null | undefined): SelectionAction | null => {
    if (selected?.primaryAction) return selected.primaryAction;
    const enterAction = state.selectionModal.customActions.get('enter');
    return enterAction ?? null;
  };

  const getSpaceAction = (selected: NonNullable<ReturnType<typeof state.selectionModal.getSelected>> | null | undefined): SelectionAction | null => {
    if (selected?.primaryAction === 'toggle') return 'toggle';
    const direct = state.selectionModal.customActions.get(' ');
    if (direct) return direct;
    const enterAction = getPrimaryAction(selected);
    if (enterAction === 'toggle') return enterAction;
    return null;
  };

  const dispatchSelectionAction = (
    action: SelectionAction,
    selected: NonNullable<ReturnType<typeof state.selectionModal.getSelected>>,
    step?: number,
  ): void => {
    if (action === 'toggle' || action === 'increment' || action === 'decrement') {
      state.selectionCallback?.({ item: selected, action, step });
      return;
    }
    const cb = state.selectionCallback;
    state.selectionCallback = null;
    state.selectionModal.close();
    if (state.modalStack.length > 0 && state.modalStack[state.modalStack.length - 1] === 'selection') {
      state.modalStack.pop();
    }
    cb?.({ item: selected, action, step });
  };

  if (token.type === 'text') {
    if (state.selectionModal.allowSearch && !state.selectionModal.searchFocused && token.value === '/') {
      state.selectionModal.focusSearch();
    } else if (state.selectionModal.allowSearch && state.selectionModal.searchFocused) {
      state.selectionModal.setQuery(state.selectionModal.query + token.value);
    } else if (token.value === ' ') {
      const selected = state.selectionModal.getSelected();
      const action = getSpaceAction(selected);
      if (action && selected && state.selectionCallback) {
        state.selectionCallback({ item: selected, action });
      }
    } else {
      const action = state.selectionModal.customActions.get(token.value);
      if (action) {
        const selected = state.selectionModal.getSelected();
        if (selected) {
          dispatchSelectionAction(action, selected);
        }
      }
    }
  } else if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      if (state.selectionModal.allowSearch && state.selectionModal.searchFocused) {
        if (state.selectionModal.query.length > 0) state.selectionModal.setQuery('');
        else state.selectionModal.blurSearch();
        state.requestRender();
        return true;
      }
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter') {
      const selected = state.selectionModal.getSelected();
      if (selected) {
        dispatchSelectionAction(getPrimaryAction(selected) ?? 'select', selected);
      }
    } else if (token.logicalName === 'space') {
      const selected = state.selectionModal.getSelected();
      const action = getSpaceAction(selected);
      if (action && selected && state.selectionCallback) {
        state.selectionCallback({ item: selected, action });
      }
    } else if (token.logicalName === 'up') {
      if (state.selectionModal.allowSearch && !state.selectionModal.searchFocused && state.selectionModal.selectedIndex === 0) {
        state.selectionModal.focusSearch();
      } else {
        state.selectionModal.moveUp();
      }
    } else if (token.logicalName === 'down') {
      if (state.selectionModal.allowSearch && state.selectionModal.searchFocused) {
        state.selectionModal.blurSearch();
      } else {
        state.selectionModal.moveDown();
      }
    } else if ((token.logicalName === 'left' || token.logicalName === 'right') && !state.selectionModal.searchFocused) {
      const selected = state.selectionModal.getSelected();
      if (selected?.adjustable) {
        dispatchSelectionAction(token.logicalName === 'right' ? 'increment' : 'decrement', selected, token.shift ? 10 : 1);
      }
    } else if (token.logicalName === 'backspace') {
      if (state.selectionModal.allowSearch && state.selectionModal.searchFocused && state.selectionModal.query.length > 0) {
        state.selectionModal.setQuery(state.selectionModal.query.slice(0, -1));
      }
    } else if (state.selectionModal.allowSearch && !state.selectionModal.searchFocused && token.logicalName === '/') {
      state.selectionModal.focusSearch();
    } else if (!state.selectionModal.searchFocused && token.logicalName && token.logicalName.length === 1) {
      const action = state.selectionModal.customActions.get(token.logicalName);
      if (action) {
        const selected = state.selectionModal.getSelected();
        if (selected) {
          dispatchSelectionAction(action, selected);
        }
      }
    }
  }

  state.requestRender();
  return true;
}

type BookmarkRouteState = {
  bookmarkModal: {
    active: boolean;
    entries: Array<unknown>;
    moveUp: () => void;
    moveDown: () => void;
    getSelected: () => { key: string } | null;
    close: () => void;
    removeSelected: () => void;
    openSelectedFile: () => void;
  };
  commandContext?: CommandContext;
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleBookmarkModalToken(state: BookmarkRouteState, token: InputToken): boolean {
  if (!state.bookmarkModal.active) return false;

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'up') state.bookmarkModal.moveUp();
    else if (token.logicalName === 'down') state.bookmarkModal.moveDown();
    else if (token.logicalName === 'enter') {
      const entry = state.bookmarkModal.getSelected();
      if (entry) state.commandContext?.jumpToBookmark?.(entry.key);
      state.bookmarkModal.close();
    } else if (token.logicalName === 'd') {
      state.bookmarkModal.removeSelected();
      if (state.bookmarkModal.entries.length === 0) state.bookmarkModal.close();
    } else if (token.logicalName === 'o') {
      state.bookmarkModal.openSelectedFile();
    }
  } else if (token.type === 'text') {
    if (token.value === 'd') {
      state.bookmarkModal.removeSelected();
      if (state.bookmarkModal.entries.length === 0) state.bookmarkModal.close();
    } else if (token.value === 'o') {
      state.bookmarkModal.openSelectedFile();
    }
  }

  state.requestRender();
  return true;
}

type SettingsRouteState = {
  settingsModal: {
    active: boolean;
    editingMode: boolean;
    currentCategory: string;
    commitEdit: () => void;
    toggleSelectedFlag: () => void;
    activateSelected: () => void;
    adjustSelected: (direction: 'left' | 'right', step?: number) => void;
    moveUp: () => void;
    moveDown: () => void;
    nextCategory: () => void;
    editBackspace: () => void;
    editChar: (char: string) => void;
  };
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleSettingsModalToken(state: SettingsRouteState, token: InputToken): boolean {
  if (!state.settingsModal.active) return false;

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter' || (token.logicalName === 'space' && !state.settingsModal.editingMode)) {
      if (state.settingsModal.editingMode) state.settingsModal.commitEdit();
      else if (state.settingsModal.currentCategory === 'flags') state.settingsModal.toggleSelectedFlag();
      else state.settingsModal.activateSelected();
    } else if ((token.logicalName === 'left' || token.logicalName === 'right') && !state.settingsModal.editingMode) {
      state.settingsModal.adjustSelected(token.logicalName, token.shift ? 10 : 1);
    } else if (token.logicalName === 'up') state.settingsModal.moveUp();
    else if (token.logicalName === 'down') state.settingsModal.moveDown();
    else if (token.logicalName === 'tab') state.settingsModal.nextCategory();
    else if (token.logicalName === 'backspace' && state.settingsModal.editingMode) state.settingsModal.editBackspace();
  } else if (token.type === 'text') {
    if (token.value === ' ' && !state.settingsModal.editingMode) {
      if (state.settingsModal.currentCategory === 'flags') state.settingsModal.toggleSelectedFlag();
      else state.settingsModal.activateSelected();
    } else if (state.settingsModal.editingMode) {
      state.settingsModal.editChar(token.value);
    }
  }

  state.requestRender();
  return true;
}

type SessionPickerRouteState = {
  sessionPickerModal: {
    active: boolean;
    loadSelected: (conversationManager: CommandContext['conversationManager']) => void;
    moveUp: () => void;
    moveDown: () => void;
    deleteSelected: () => void;
  };
  commandContext?: CommandContext;
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleSessionPickerToken(state: SessionPickerRouteState, token: InputToken): boolean {
  if (!state.sessionPickerModal.active) return false;

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter') {
      if (state.commandContext?.conversationManager) {
        state.sessionPickerModal.loadSelected(state.commandContext.conversationManager);
      }
    } else if (token.logicalName === 'up') state.sessionPickerModal.moveUp();
    else if (token.logicalName === 'down') state.sessionPickerModal.moveDown();
    else if (token.logicalName === 'd') state.sessionPickerModal.deleteSelected();
  } else if (token.type === 'text' && token.value === 'd') {
    state.sessionPickerModal.deleteSelected();
  }

  state.requestRender();
  return true;
}

type ProfilePickerRouteState = {
  profilePickerModal: {
    active: boolean;
    loadSelected: (configManager: NonNullable<CommandContext['configManager']>) => void;
    moveUp: () => void;
    moveDown: () => void;
    deleteSelected: () => void;
    saveCurrentAs: (name: string, configManager: NonNullable<CommandContext['configManager']>) => void;
  };
  commandContext?: CommandContext;
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleProfilePickerToken(state: ProfilePickerRouteState, token: InputToken): boolean {
  if (!state.profilePickerModal.active) return false;

  const saveCurrent = (): void => {
    if (state.commandContext?.configManager) {
      const name = `profile-${Date.now()}`;
      state.profilePickerModal.saveCurrentAs(name, state.commandContext.configManager);
    }
  };

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter') {
      if (state.commandContext?.configManager) {
        state.profilePickerModal.loadSelected(state.commandContext.configManager);
      }
    } else if (token.logicalName === 'up') state.profilePickerModal.moveUp();
    else if (token.logicalName === 'down') state.profilePickerModal.moveDown();
    else if (token.logicalName === 'd') state.profilePickerModal.deleteSelected();
    else if (token.logicalName === 's') saveCurrent();
  } else if (token.type === 'text') {
    if (token.value === 'd') state.profilePickerModal.deleteSelected();
    else if (token.value === 's') saveCurrent();
  }

  state.requestRender();
  return true;
}
