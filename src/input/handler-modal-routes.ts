import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { SelectionResult, SelectionAction } from './selection-modal.ts';
import type { CommandContext } from './command-registry.ts';
import type { ConfigModal } from './config-modal.ts';
import { openTtsProviderPicker, openTtsVoicePicker } from './tts-settings-actions.ts';
import { isTextBackspace } from './delete-key-policy.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

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
  getSelectionCallback?: () => ((result: SelectionResult | null) => void) | null;
  setSelectionCallback?: (callback: ((result: SelectionResult | null) => void) | null) => void;
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
    state.setSelectionCallback?.(null);
    state.selectionModal.close();
    if (state.modalStack.length > 0 && state.modalStack[state.modalStack.length - 1] === 'selection') {
      state.modalStack.pop();
    }
    cb?.({ item: selected, action, step });
    state.selectionCallback = state.getSelectionCallback?.() ?? state.selectionCallback;
  };

  const getAdjustmentStep = (
    selected: NonNullable<ReturnType<typeof state.selectionModal.getSelected>> | null | undefined,
    shift: boolean,
  ): number => {
    const baseStep = selected?.adjustStep ?? 1;
    return shift ? baseStep * 10 : baseStep;
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
      } else if (state.selectionModal.allowSearch) {
        // UX-C instant filter: an unclaimed keystroke arms search AND starts
        // the query immediately, instead of silently doing nothing until the
        // user discovers '/' first (the "help search needs '/' arming while
        // the palette filters instantly" evaluator finding — /help has no
        // customActions, so every letter used to be swallowed here). '/'
        // above still works too; this is additive, not a replacement, and
        // never fires for a claimed hotkey letter (checked first, above).
        state.selectionModal.focusSearch();
        state.selectionModal.setQuery(token.value);
      }
    }
  } else if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      // UX-C: ONE Escape always closes the modal, regardless of search state.
      // Clearing an in-progress query is Backspace's job, not Esc's — the old
      // two-stage contract (1st Esc clears query, 2nd blurs search, 3rd
      // finally closes) was the "help modal took 3 Escapes after searching"
      // evaluator finding (searchFocused is not modal-specific — every
      // SelectionModal-based picker had the same multi-Esc pattern).
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
        dispatchSelectionAction(
          token.logicalName === 'right' ? 'increment' : 'decrement',
          selected,
          getAdjustmentStep(selected, token.shift),
        );
      }
    } else if (isTextBackspace(token.logicalName ?? '')) {
      if (state.selectionModal.allowSearch && state.selectionModal.searchFocused && state.selectionModal.query.length > 0) {
        state.selectionModal.setQuery(state.selectionModal.query.slice(0, -1));
      }
      // 'delete' is intentionally absent here: modal search filters are
      // end-anchored with no cursor, so forward-delete is a no-op per the
      // delete-key policy (src/input/delete-key-policy.ts).
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
    focusPane?: 'categories' | 'settings';
    /** True when the user is actively typing into the search input bar. */
    searchFocused: boolean;
    /** Current cross-category search query. */
    searchQuery: string;
    commitEdit: () => void;
    toggleSelectedFlag: () => void;
    activateSelected: () => void;
    handleSubscriptionLogoutKey?: (key: string) => 'confirmed' | 'cancelled' | 'absorbed' | 'inactive';
    adjustSelected: (direction: 'left' | 'right', step?: number) => void;
    moveFocusedUp?: () => void;
    moveFocusedDown?: () => void;
    moveUp?: () => void;
    moveDown?: () => void;
    focusCategories?: () => void;
    focusSettings?: () => void;
    toggleFocusPane?: () => void;
    nextCategory: () => void;
    prevCategory?: () => void;
    editBackspace: () => void;
    editChar: (char: string) => void;
    /** Enter search mode (focus the search input bar). */
    focusSearch: () => void;
    /** Exit search mode without clearing the query. */
    blurSearch: () => void;
    /** Set search query and recompute results. */
    setSearchQuery: (query: string) => void;
    /** Clear search query, results, and exit search mode. */
    clearSearch: () => void;
    /** Cancel inline edit without saving (mirrors SettingsModal.cancelEdit). */
    cancelEdit: () => void;
    pendingModelPickerTarget: import('./model-picker.ts').ModelPickerTarget | null;
    pendingProviderModelPickerTarget?: import('./model-picker.ts').ModelPickerTarget | null;
    pendingSettingsPickerAction?: 'tts-provider' | 'tts-voice' | null;
    resetSelected?: () => { key: string; value: unknown } | null;
    initiateResetCategory?: () => void;
    initiateResetAll?: () => void;
    handleResetConfirmKey?: (
      key: string,
    ) =>
      | { result: 'confirmed'; entries: ReadonlyArray<{ key: string; value: unknown }> }
      | 'cancelled'
      | 'absorbed'
      | 'inactive';
  };
  commandContext?: CommandContext;
  /** Called when the settings modal requests the model picker for a non-main target. */
  openModelPickerWithTarget?: (target: import('./model-picker.ts').ModelPickerTarget) => void;
  /** Called when the settings modal requests provider selection before model selection. */
  openProviderModelPickerWithTarget?: (target: import('./model-picker.ts').ModelPickerTarget) => void;
  requestRender: () => void;
  handleEscape: () => void;
};

function syncRuntimeAfterSettingReset(ctx: CommandContext | undefined, key: string, value: unknown): void {
  if (!ctx) return;
  if (key === 'provider.model') ctx.session.runtime.model = String(value);
  if (key === 'provider.reasoningEffort') ctx.session.runtime.reasoningEffort = String(value);
}

function consumeSettingsPickerRequest(state: SettingsRouteState): void {
  const settingsAction = state.settingsModal.pendingSettingsPickerAction ?? null;
  if (settingsAction !== null) {
    state.settingsModal.pendingSettingsPickerAction = null;
    if (!state.commandContext) return;
    if (settingsAction === 'tts-provider') {
      openTtsProviderPicker(state.commandContext);
      return;
    }
    void openTtsVoicePicker(state.commandContext).catch((error: unknown) => {
      state.commandContext?.print(`Unable to list TTS voices: ${summarizeError(error)}`);
      state.requestRender();
    });
    return;
  }

  const providerModelTarget = state.settingsModal.pendingProviderModelPickerTarget ?? null;
  if (providerModelTarget !== null) {
    state.settingsModal.pendingProviderModelPickerTarget = null;
    state.openProviderModelPickerWithTarget?.(providerModelTarget);
    return;
  }
  const pickerTarget = state.settingsModal.pendingModelPickerTarget;
  if (pickerTarget !== null) {
    state.settingsModal.pendingModelPickerTarget = null;
    state.openModelPickerWithTarget?.(pickerTarget);
  }
}

export function handleSettingsModalToken(state: SettingsRouteState, token: InputToken): boolean {
  if (!state.settingsModal.active) return false;

  // Subscription logout confirm gate: routes all keys through the unified
  // confirm contract before normal dispatch when a confirm is pending.
  if (state.settingsModal.handleSubscriptionLogoutKey) {
    const key = token.type === 'key'
      ? (token.logicalName ?? '')
      : token.type === 'text'
        ? token.value
        : '';
    const logoutResult = state.settingsModal.handleSubscriptionLogoutKey(key);
    if (logoutResult !== 'inactive') {
      state.requestRender();
      return true;
    }
  }

  // Reset confirm gate: routes all keys through the confirm contract before
  // normal dispatch when a category or all-settings reset is pending.
  if (state.settingsModal.handleResetConfirmKey) {
    const key = token.type === 'key'
      ? (token.logicalName ?? '')
      : token.type === 'text'
        ? token.value
        : '';
    const resetResult = state.settingsModal.handleResetConfirmKey(key);
    if (resetResult !== 'inactive') {
      if (typeof resetResult === 'object' && resetResult.result === 'confirmed') {
        // Sync runtime for every reset entry so provider.model / reasoningEffort
        // stay consistent with the live session without requiring a restart.
        for (const entry of resetResult.entries) {
          syncRuntimeAfterSettingReset(state.commandContext, entry.key, entry.value);
        }
      }
      state.requestRender();
      return true;
    }
  }

  if (token.type === 'key') {
    const focusPane = state.settingsModal.focusPane ?? 'settings';
    if (token.logicalName === 'escape') {
      // Cancel inline edit first — mirrors the global contract in handler-modal-stack.ts.
      // Must check editingMode before searchFocused: the reachable path
      // search→Enter(string/number)→Esc must cancel the edit, NOT just clear search.
      if (state.settingsModal.editingMode) {
        state.settingsModal.cancelEdit();
        state.requestRender();
        return true;
      }
      // Two-stage escape: if in search mode, first Esc exits search (clearSearch),
      // second Esc closes the modal.
      if (state.settingsModal.searchFocused) {
        state.settingsModal.clearSearch();
        state.requestRender();
        return true;
      }
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter' || (token.logicalName === 'space' && !state.settingsModal.editingMode && !state.settingsModal.searchFocused)) {
      if (state.settingsModal.editingMode) state.settingsModal.commitEdit();
      else if (state.settingsModal.searchFocused) {
        // Enter in search mode: activate the selected search result
        state.settingsModal.activateSelected();
        consumeSettingsPickerRequest(state);
      } else if (focusPane === 'categories') state.settingsModal.focusSettings?.();
      else {
        // Feature-unit toggle headers are boolean settings rows now, so
        // activateSelected toggles them (via the flag-toggle chokepoint) the same
        // way it edits/toggles any other setting — no flags-category special case.
        state.settingsModal.activateSelected();
        consumeSettingsPickerRequest(state);
      }
    } else if ((token.logicalName === 'left' || token.logicalName === 'right') && !state.settingsModal.editingMode && !state.settingsModal.searchFocused) {
      if (token.logicalName === 'left') state.settingsModal.focusCategories?.();
      else state.settingsModal.focusSettings?.();
    } else if (token.logicalName === 'up') {
      if (state.settingsModal.searchFocused) {
        state.settingsModal.moveUp?.();
      } else if (state.settingsModal.moveFocusedUp) state.settingsModal.moveFocusedUp();
      else state.settingsModal.moveUp?.();
    } else if (token.logicalName === 'down') {
      if (state.settingsModal.searchFocused) {
        state.settingsModal.moveDown?.();
      } else if (state.settingsModal.moveFocusedDown) state.settingsModal.moveFocusedDown();
      else state.settingsModal.moveDown?.();
    }
    else if (token.logicalName === 'r' && token.shift && token.ctrl && !state.settingsModal.editingMode && !state.settingsModal.searchFocused) {
      state.settingsModal.initiateResetAll?.();
    }
    else if (token.logicalName === 'r' && token.shift && !state.settingsModal.editingMode && !state.settingsModal.searchFocused) {
      state.settingsModal.initiateResetCategory?.();
    }
    else if (token.logicalName === 'r' && !state.settingsModal.editingMode && !state.settingsModal.searchFocused) {
      const reset = state.settingsModal.resetSelected?.();
      if (reset) syncRuntimeAfterSettingReset(state.commandContext, reset.key, reset.value);
    }
    else if (token.logicalName === 'tab' && !state.settingsModal.searchFocused) {
      if (state.settingsModal.toggleFocusPane) state.settingsModal.toggleFocusPane();
      else if (focusPane === 'categories') state.settingsModal.focusSettings?.();
      else state.settingsModal.focusCategories?.();
    }
    else if (isTextBackspace(token.logicalName ?? '')) {
      if (state.settingsModal.editingMode) {
        state.settingsModal.editBackspace();
      } else if (state.settingsModal.searchFocused) {
        // Backspace in search mode: trim query
        const trimmed = state.settingsModal.searchQuery.slice(0, -1);
        state.settingsModal.setSearchQuery(trimmed);
      }
    }
    // token.logicalName === 'delete' is intentionally absent: search filters
    // are end-anchored with no cursor, so forward-delete is a no-op per
    // delete-key policy (src/input/delete-key-policy.ts).
    else if (!state.settingsModal.editingMode && !state.settingsModal.searchFocused && token.logicalName === '/') {
      state.settingsModal.focusSearch();
    }
  } else if (token.type === 'text') {
    if (state.settingsModal.editingMode) {
      // editingMode takes priority over search — Enter on a string/number search
      // result enters inline edit; subsequent chars must go to editChar, not the query.
      state.settingsModal.editChar(token.value);
    } else if (state.settingsModal.searchFocused) {
      // Any printable char in search mode appends to the query
      state.settingsModal.setSearchQuery(state.settingsModal.searchQuery + token.value);
    } else if (token.value === '/' && !state.settingsModal.editingMode) {
      // / enters search mode
      state.settingsModal.focusSearch();
    } else if (token.value === ' ' && !state.settingsModal.editingMode) {
      const focusPane = state.settingsModal.focusPane ?? 'settings';
      if (focusPane === 'categories') state.settingsModal.focusSettings?.();
      else {
        // See the Enter/Space handler above: feature-unit headers toggle through
        // activateSelected now, so no flags-category special case is needed.
        state.settingsModal.activateSelected();
        consumeSettingsPickerRequest(state);
      }
    } else if (token.value === 'r') {
      const reset = state.settingsModal.resetSelected?.();
      if (reset) syncRuntimeAfterSettingReset(state.commandContext, reset.key, reset.value);
    }
  }

  state.requestRender();
  return true;
}

type SessionPickerRouteState = {
  sessionPickerModal: {
    active: boolean;
    loadSelected: (conversationManager: CommandContext['session']['conversationManager']) => void;
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
      const conversationManager = state.commandContext?.session.conversationManager;
      if (conversationManager) {
        state.sessionPickerModal.loadSelected(conversationManager);
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
    loadSelected: (configManager: CommandContext['platform']['configManager']) => void;
    moveUp: () => void;
    moveDown: () => void;
    deleteSelected: () => void;
    saveCurrentAs: (name: string, configManager: CommandContext['platform']['configManager']) => void;
  };
  commandContext?: CommandContext;
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleProfilePickerToken(state: ProfilePickerRouteState, token: InputToken): boolean {
  if (!state.profilePickerModal.active) return false;

  const saveCurrent = (): void => {
    if (state.commandContext?.platform.configManager) {
      const name = `profile-${Date.now()}`;
      state.profilePickerModal.saveCurrentAs(name, state.commandContext.platform.configManager);
    }
  };

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter') {
      if (state.commandContext?.platform.configManager) {
        state.profilePickerModal.loadSelected(state.commandContext.platform.configManager);
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

type ConfigModalRouteState = {
  configModal: ConfigModal;
  commandContext?: CommandContext;
  requestRender: () => void;
  handleEscape: () => void;
};

/**
 * Route a key to the generic config-modal host (W6.1 MIGRATE-TO-MODAL
 * surfaces). The host owns the reserved navigation keys (Esc, up/down/j/k tab
 * left/right, and now '/' — DEBT-5 item 1's type-to-filter, armed the same
 * way as scrollable-list-panel.ts's opt-in filter and SettingsModal's own
 * '/'-armed search); every other key is offered to the active surface's
 * declarative action table (fireAction handles the two-press confirm for
 * destructive actions). Any unrecognised key is absorbed so the modal stays
 * modal — this is the same "active modal captures all keys" shape as the
 * other modal routers.
 *
 * While the filter is armed (`configModal.isFilterActive()`), printable text
 * tokens go to the query instead of nav/action dispatch — this is WHY 'j'/'k'
 * lose their vim-nav meaning mid-filter (you're typing, not navigating) but
 * Escape, Backspace, and the arrow/tab nav keys keep their ordinary meaning
 * (arrows navigate the FILTERED list; Enter still acts on the selected row).
 */
export function handleConfigModalToken(state: ConfigModalRouteState, token: InputToken): boolean {
  if (!state.configModal.active) return false;

  // Every token that reaches the modal is a user interaction — after the
  // first one, structure freezes to interaction boundaries (liveness rule).
  // Before it, renders may sync structure so async onOpen loads appear
  // without a keypress (batch refutation finding 3).
  state.configModal.noteInteraction();

  const filtering = state.configModal.isFilterActive();

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      // Two-stage Esc, but ONLY while there is a query to clear (the one
      // documented exception to single-Esc-close): clearFilterOrFallthrough
      // returns false on an empty query, so an armed-but-empty filter (or no
      // filter at all) closes the modal in one press, same as every other
      // modal here.
      if (state.configModal.clearFilterOrFallthrough()) {
        state.requestRender();
        return true;
      }
      state.handleEscape();
      return true;
    }
    if (filtering && isTextBackspace(token.logicalName ?? '')) {
      state.configModal.backspaceFilter();
      state.requestRender();
      return true;
    }
    if (!filtering && token.logicalName === '/') {
      state.configModal.activateFilter();
      state.requestRender();
      return true;
    }
    switch (token.logicalName) {
      case 'up':
        state.configModal.moveUp();
        state.requestRender();
        return true;
      case 'down':
        state.configModal.moveDown();
        state.requestRender();
        return true;
      case 'left':
        state.configModal.prevTab();
        state.requestRender();
        return true;
      case 'right':
      case 'tab':
        state.configModal.nextTab();
        state.requestRender();
        return true;
    }
    // Any other 'key' token (e.g. 'enter') falls through to the action table
    // below even while filtering — only printable TEXT tokens are captured
    // by the filter (below), so Enter still fires on the current selection.
  } else if (token.type === 'text') {
    if (!filtering && token.value === '/') {
      state.configModal.activateFilter();
      state.requestRender();
      return true;
    }
    if (filtering) {
      // The WHOLE token value lands in the filter in one call — including a
      // multi-char paste token — never split into per-char nav/action
      // dispatch (the text-capture invariant this item's brief calls out).
      state.configModal.appendFilterText(token.value);
      state.requestRender();
      return true;
    }
    if (token.value === 'j') { state.configModal.moveDown(); state.requestRender(); return true; }
    if (token.value === 'k') { state.configModal.moveUp(); state.requestRender(); return true; }
  }

  const actionKey = token.type === 'key' ? (token.logicalName ?? '') : token.type === 'text' ? token.value : '';
  const submitInput = state.commandContext?.submitInput;
  const fired = actionKey.length > 0 && state.configModal.fireAction(actionKey, {
    print: (message: string) => state.commandContext?.print(message),
    executeCommand: state.commandContext?.executeCommand,
    openModal: state.commandContext?.openModal,
    ...(submitInput ? { submitInput: (text: string) => submitInput(text) } : {}),
  });
  if (fired) {
    state.requestRender();
    return true;
  }

  // Unhandled key while a config modal is open: drop any pending confirm and
  // absorb the key (the modal owns the keyboard while it is active).
  state.configModal.clearConfirmOnMiss();
  state.requestRender();
  return true;
}
