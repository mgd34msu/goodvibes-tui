import {
  closeModalByName,
  getActiveModalName,
  reopenModalByName,
  type ActiveModalState,
} from './handler-ui-state.ts';
import type { SelectionResult } from './selection-modal.ts';

export type ModalStackState = ActiveModalState & {
  modalStack: string[];
};

export function modalOpened(state: ModalStackState, name: string): void {
  if (getActiveModalName(state) === null && state.modalStack.length > 0) {
    state.modalStack.length = 0;
  }
  state.modalStack.push(name);
}

export function clearModalStack(modalStack: string[]): void {
  modalStack.length = 0;
}

export type EscapeState = ModalStackState & {
  prompt: string;
  cursorPos: number;
  helpScrollOffset: number;
  shortcutsScrollOffset: number;
  requestRender: () => void;
  saveUndoState: () => void;
  cancelGeneration: (() => void) | undefined;
  selectionCallback: ((result: SelectionResult | null) => void) | null;
  bookmarkModal: ModalStackState['bookmarkModal'] & { open: () => void };
  contextInspectorModal: ModalStackState['contextInspectorModal'] & { open: () => void };
  processModal: ModalStackState['processModal'] & { open: () => void };
  settingsModal: ModalStackState['settingsModal'] & {
    editingMode: boolean;
    cancelEdit: () => void;
  };
  selectionModal: ModalStackState['selectionModal'];
  autocompleteReset: () => void;
};

export function handleEscape(state: EscapeState): {
  prompt: string;
  cursorPos: number;
  commandMode: boolean;
  helpOverlayActive: boolean;
  helpScrollOffset: number;
  shortcutsOverlayActive: boolean;
  shortcutsScrollOffset: number;
  selectionCallback: ((result: SelectionResult | null) => void) | null;
} {
  let prompt = state.prompt;
  let cursorPos = state.cursorPos;
  let commandMode = state.commandMode;
  let helpOverlayActive = state.helpOverlayActive;
  let helpScrollOffset = state.helpScrollOffset;
  let shortcutsOverlayActive = state.shortcutsOverlayActive;
  let shortcutsScrollOffset = state.shortcutsScrollOffset;
  let selectionCallback = state.selectionCallback;

  if (state.settingsModal.active && state.settingsModal.editingMode) {
    state.settingsModal.cancelEdit();
    state.requestRender();
    return {
      prompt,
      cursorPos,
      commandMode,
      helpOverlayActive,
      helpScrollOffset,
      shortcutsOverlayActive,
      shortcutsScrollOffset,
      selectionCallback,
    };
  }

  const closeModal = (name: string): void => {
    closeModalByName(name, {
      resetHelp: () => {
        helpOverlayActive = false;
        helpScrollOffset = 0;
      },
      resetShortcuts: () => {
        shortcutsOverlayActive = false;
        shortcutsScrollOffset = 0;
      },
      closeBookmark: () => state.bookmarkModal.close(),
      closeAgentDetail: () => state.agentDetailModal.close(),
      closeLiveTail: () => state.liveTailModal.close(),
      closeSettings: () => state.settingsModal.close(),
      closeSessionPicker: () => state.sessionPickerModal.close(),
      closeProfilePicker: () => state.profilePickerModal.close(),
      closeContextInspector: () => state.contextInspectorModal.close(),
      closeProcess: () => state.processModal.close(),
      closeModelPicker: () => state.modelPicker.close(),
      closeFilePicker: () => state.filePicker.close(),
      closeBlockActions: () => state.blockActionsMenu.close(),
      closeSelection: () => {
        const cb = selectionCallback;
        selectionCallback = null;
        state.selectionModal.close();
        cb?.(null);
      },
      closeCommandMode: () => {
        commandMode = false;
        state.autocompleteReset();
        prompt = '';
        cursorPos = 0;
      },
    });
  };

  const reopenModal = (name: string): void => {
    reopenModalByName(name, {
      openHelp: () => { helpOverlayActive = true; },
      openShortcuts: () => { shortcutsOverlayActive = true; },
      openBookmark: () => state.bookmarkModal.open(),
      openProcess: () => state.processModal.open(),
      openContextInspector: () => state.contextInspectorModal.open(),
      openCommandMode: () => {
        commandMode = true;
        prompt = '/';
        cursorPos = 1;
        state.autocompleteReset();
      },
    });
  };

  if (state.modalStack.length > 0) {
    const current = state.modalStack.pop()!;
    const previous = state.modalStack[state.modalStack.length - 1];
    closeModal(current);
    if (previous) {
      reopenModal(previous);
    }
    state.requestRender();
    return {
      prompt,
      cursorPos,
      commandMode,
      helpOverlayActive,
      helpScrollOffset,
      shortcutsOverlayActive,
      shortcutsScrollOffset,
      selectionCallback,
    };
  }

  const active = getActiveModalName({
    ...state,
    helpOverlayActive,
    shortcutsOverlayActive,
    commandMode,
  });
  if (active) {
    closeModal(active);
    state.requestRender();
    return {
      prompt,
      cursorPos,
      commandMode,
      helpOverlayActive,
      helpScrollOffset,
      shortcutsOverlayActive,
      shortcutsScrollOffset,
      selectionCallback,
    };
  }

  if (prompt.length > 0) {
    state.saveUndoState();
    prompt = '';
    cursorPos = 0;
    return {
      prompt,
      cursorPos,
      commandMode,
      helpOverlayActive,
      helpScrollOffset,
      shortcutsOverlayActive,
      shortcutsScrollOffset,
      selectionCallback,
    };
  }

  state.cancelGeneration?.();
  return {
    prompt,
    cursorPos,
    commandMode,
    helpOverlayActive,
    helpScrollOffset,
    shortcutsOverlayActive,
    shortcutsScrollOffset,
    selectionCallback,
  };
}
