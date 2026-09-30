import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import { servingEffortForLevel, toEffortModel } from '../providers/reasoning-effort-surface.ts';
import type { SelectionResult, SelectionAction } from './selection-modal.ts';
import type { CommandContext } from './command-registry.ts';
import type { ConfigModal } from './config-modal.ts';
import { openTtsProviderPicker, openTtsVoicePicker } from './tts-settings-actions.ts';
import { openThemePicker } from './theme-settings-actions.ts';
import { isTextBackspace } from './delete-key-policy.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

type SelectionRouteState = {
  selectionModal: {
    active: boolean;
    query: string;
    allowSearch: boolean;
    customActions: Map<string, SelectionAction>;
    selectedIndex: number;
    getSelected: () => SelectionResult['item'] | null | undefined;
    setQuery: (query: string) => void;
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

  const fireClaimedKey = (key: string): boolean => {
    const action = state.selectionModal.customActions.get(key);
    if (!action) return false;
    const selected = state.selectionModal.getSelected();
    if (selected) dispatchSelectionAction(action, selected);
    return true;
  };

  const fireSpace = (): void => {
    const selected = state.selectionModal.getSelected();
    const action = getSpaceAction(selected);
    if (action && selected && state.selectionCallback) {
      state.selectionCallback({ item: selected, action });
    }
  };

  // The search row is always live (no search mode): printable text goes into
  // the query, except a key the picker claims (a custom action, or Space for
  // a toggle) which fires while the query is empty. Pickers without search
  // only have their claimed keys.
  if (token.type === 'text') {
    const queryEmpty = state.selectionModal.query.length === 0;
    const single = [...token.value].length === 1;
    if (queryEmpty && single && token.value === ' ' && getSpaceAction(state.selectionModal.getSelected())) {
      fireSpace();
    } else if (queryEmpty && single && state.selectionModal.customActions.has(token.value)) {
      fireClaimedKey(token.value);
    } else if (state.selectionModal.allowSearch) {
      state.selectionModal.setQuery(state.selectionModal.query + token.value);
    } else if (single && token.value === ' ') {
      fireSpace();
    }
  } else if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      // ONE Escape always closes the modal, whatever the query holds. Clearing
      // the query is Backspace's job, not Esc's.
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter') {
      const selected = state.selectionModal.getSelected();
      if (selected) {
        dispatchSelectionAction(getPrimaryAction(selected) ?? 'select', selected);
      }
    } else if (token.logicalName === 'space') {
      fireSpace();
    } else if (token.logicalName === 'up') {
      state.selectionModal.moveUp();
    } else if (token.logicalName === 'down') {
      state.selectionModal.moveDown();
    } else if (token.logicalName === 'left' || token.logicalName === 'right') {
      const selected = state.selectionModal.getSelected();
      if (selected?.adjustable) {
        dispatchSelectionAction(
          token.logicalName === 'right' ? 'increment' : 'decrement',
          selected,
          getAdjustmentStep(selected, token.shift),
        );
      }
    } else if (isTextBackspace(token.logicalName ?? '')) {
      if (state.selectionModal.allowSearch && state.selectionModal.query.length > 0) {
        state.selectionModal.setQuery(state.selectionModal.query.slice(0, -1));
      }
      // 'delete' is intentionally absent here: modal search filters are
      // end-anchored with no cursor, so forward-delete is a no-op per the
      // delete-key policy (src/input/delete-key-policy.ts).
    } else if (token.logicalName && [...token.logicalName].length === 1) {
      // A modified letter (a CSI-u chord): fires a claimed action whatever
      // the query holds, it is never typed.
      fireClaimedKey(token.logicalName);
    }
  }

  state.requestRender();
  return true;
}

type BookmarkRouteState = {
  bookmarkModal: {
    active: boolean;
    entries: Array<unknown>;
    query: string;
    setQuery: (query: string) => void;
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

/**
 * Bookmarks: the search row is always live. `d` (remove) and `o` (open the
 * saved file) fire while the query is empty; otherwise every printable key is
 * typed into the query. Backspace edits it; Esc closes.
 */
export function handleBookmarkModalToken(state: BookmarkRouteState, token: InputToken): boolean {
  if (!state.bookmarkModal.active) return false;
  const modal = state.bookmarkModal;

  const act = (key: string): boolean => {
    if (key === 'd') {
      modal.removeSelected();
      if (modal.entries.length === 0) modal.close();
      return true;
    }
    if (key === 'o') {
      modal.openSelectedFile();
      return true;
    }
    return false;
  };

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'up') modal.moveUp();
    else if (token.logicalName === 'down') modal.moveDown();
    else if (token.logicalName === 'enter') {
      const entry = modal.getSelected();
      if (entry) state.commandContext?.jumpToBookmark?.(entry.key);
      modal.close();
    } else if (isTextBackspace(token.logicalName ?? '')) {
      if (modal.query.length > 0) modal.setQuery(modal.query.slice(0, -1));
    } else if (token.logicalName) {
      // Modified letters (CSI-u chords) fire their action whatever the query holds.
      act(token.logicalName);
    }
  } else if (token.type === 'text') {
    const claimed = modal.query.length === 0 && (token.value === 'd' || token.value === 'o');
    if (claimed) act(token.value);
    else modal.setQuery(modal.query + token.value);
  }

  state.requestRender();
  return true;
}

type SettingsRouteState = {
  settingsModal: {
    active: boolean;
    editingMode: boolean;
    currentCategory: string;
    focusRegion?: 'categories' | 'settings';
    /** True when the user is actively typing into the search input bar. */
    searchFocused: boolean;
    /** Current cross-category search query. */
    searchQuery: string;
    commitEdit: () => void;
    toggleSelectedFlag: () => void;
    /** Scroll the documentation region (PgUp/PgDn); the renderer clamps and shows honest markers. */
    scrollContext?: (delta: number) => void;
    activateSelected: () => void;
    handleSubscriptionLogoutKey?: (key: string) => 'confirmed' | 'cancelled' | 'absorbed' | 'inactive';
    adjustSelected: (direction: 'left' | 'right', step?: number) => void;
    moveFocusedUp?: () => void;
    moveFocusedDown?: () => void;
    moveUp?: () => void;
    moveDown?: () => void;
    focusCategories?: () => void;
    focusSettings?: () => void;
    toggleFocusRegion?: () => void;
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
    pendingSettingsPickerAction?: 'tts-provider' | 'tts-voice' | 'theme' | null;
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
  if (key === 'provider.reasoningEffort') {
    // config holds the REQUESTED level; the session holds the EFFECTIVE one for
    // whichever model is serving, so the reset value is resolved rather than
    // copied straight across. A context with no reachable provider registry
    // (a surface that routes only through the provider API) stores the reset
    // value unresolved rather than failing the whole reset.
    const serving = ctx.provider?.providerRegistry?.getCurrentModel?.();
    ctx.session.runtime.reasoningEffort = serving
      ? servingEffortForLevel(String(value), toEffortModel(serving)).effective ?? ''
      : String(value);
  }
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
    if (settingsAction === 'theme') {
      openThemePicker(state.commandContext);
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

  // The search row is always live: printable text goes to the query. While
  // the query is non-empty the list shows search results across every
  // category (searchFocused); clearing it returns to the category view. Space
  // toggles the selected setting only while the query is empty; resets are
  // key chords (ctrl+r selected, shift+R category, ctrl+shift+R all) so every
  // letter can be searched for.
  const modal = state.settingsModal;
  const searching = modal.searchQuery.length > 0;
  const setQuery = (query: string): void => {
    if (query.length === 0) modal.clearSearch();
    else modal.setSearchQuery(query);
  };
  const resetSelected = (): void => {
    const reset = modal.resetSelected?.();
    if (reset) syncRuntimeAfterSettingReset(state.commandContext, reset.key, reset.value);
  };

  if (token.type === 'key') {
    const focusRegion = modal.focusRegion ?? 'settings';
    if (token.logicalName === 'escape') {
      // One level per press: an inline edit is a sub-dialog and is cancelled
      // first (mirrors handler-modal-stack.ts); otherwise the modal closes.
      if (modal.editingMode) {
        modal.cancelEdit();
        state.requestRender();
        return true;
      }
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter' || (token.logicalName === 'space' && !modal.editingMode && !searching)) {
      if (modal.editingMode) modal.commitEdit();
      else if (focusRegion === 'categories' && !searching) modal.focusSettings?.();
      else {
        // Feature-unit toggle headers are boolean settings rows, so
        // activateSelected toggles them the same way it edits/toggles any
        // other setting (search results included).
        modal.activateSelected();
        consumeSettingsPickerRequest(state);
      }
    } else if (token.logicalName === 'space' && searching && !modal.editingMode) {
      setQuery(`${modal.searchQuery} `);
    } else if ((token.logicalName === 'left' || token.logicalName === 'right') && !modal.editingMode && !searching) {
      if (token.logicalName === 'left') modal.focusCategories?.();
      else modal.focusSettings?.();
    } else if (token.logicalName === 'up') {
      if (searching) modal.moveUp?.();
      else if (modal.moveFocusedUp) modal.moveFocusedUp();
      else modal.moveUp?.();
    } else if (token.logicalName === 'down') {
      if (searching) modal.moveDown?.();
      else if (modal.moveFocusedDown) modal.moveFocusedDown();
      else modal.moveDown?.();
    }
    else if (token.logicalName === 'r' && token.shift && token.ctrl && !modal.editingMode && !searching) {
      modal.initiateResetAll?.();
    }
    else if (token.logicalName === 'r' && token.ctrl && !modal.editingMode) {
      resetSelected();
    }
    else if (token.logicalName === 'r' && token.shift && !modal.editingMode && !searching) {
      modal.initiateResetCategory?.();
    }
    else if (token.logicalName === 'pageup' && !modal.editingMode) {
      modal.scrollContext?.(-3);
    }
    else if (token.logicalName === 'pagedown' && !modal.editingMode) {
      modal.scrollContext?.(3);
    }
    else if (token.logicalName === 'tab' && !searching) {
      if (modal.toggleFocusRegion) modal.toggleFocusRegion();
      else if (focusRegion === 'categories') modal.focusSettings?.();
      else modal.focusCategories?.();
    }
    else if (isTextBackspace(token.logicalName ?? '')) {
      if (modal.editingMode) modal.editBackspace();
      else if (searching) setQuery(modal.searchQuery.slice(0, -1));
    }
    // token.logicalName === 'delete' is intentionally absent: search filters
    // are end-anchored with no cursor, so forward-delete is a no-op per
    // delete-key policy (src/input/delete-key-policy.ts).
  } else if (token.type === 'text') {
    if (modal.editingMode) {
      // Inline edit takes priority over search: characters go to the edit buffer.
      modal.editChar(token.value);
    } else if (searching) {
      setQuery(modal.searchQuery + token.value);
    } else if (token.value === ' ') {
      const focusRegion = modal.focusRegion ?? 'settings';
      if (focusRegion === 'categories') modal.focusSettings?.();
      else {
        modal.activateSelected();
        consumeSettingsPickerRequest(state);
      }
    } else if (token.value !== '/') {
      // '/' used to arm search; search is always live now, so it is ignored
      // as a first character rather than searched for.
      setQuery(token.value);
    }
  }

  state.requestRender();
  return true;
}

type SessionPickerRouteState = {
  sessionPickerModal: {
    active: boolean;
    query: string;
    setQuery: (query: string) => void;
    loadSelected: (conversationManager: CommandContext['session']['conversationManager']) => void;
    moveUp: () => void;
    moveDown: () => void;
    deleteSelected: () => void;
  };
  commandContext?: CommandContext;
  requestRender: () => void;
  handleEscape: () => void;
};

/**
 * The session picker's search row is always live: printable keys go to the
 * query. `d` arms (then confirms) delete only while the query is empty, so a
 * search can still contain the letter d.
 */
export function handleSessionPickerToken(state: SessionPickerRouteState, token: InputToken): boolean {
  if (!state.sessionPickerModal.active) return false;
  const modal = state.sessionPickerModal;

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter') {
      const conversationManager = state.commandContext?.session.conversationManager;
      if (conversationManager) {
        modal.loadSelected(conversationManager);
      }
    } else if (token.logicalName === 'up') modal.moveUp();
    else if (token.logicalName === 'down') modal.moveDown();
    else if (isTextBackspace(token.logicalName ?? '')) modal.setQuery(modal.query.slice(0, -1));
    else if (token.logicalName === 'd' && !token.ctrl && modal.query.length === 0) modal.deleteSelected();
  } else if (token.type === 'text') {
    if (token.value === 'd' && modal.query.length === 0) modal.deleteSelected();
    else modal.setQuery(modal.query + token.value);
  }

  state.requestRender();
  return true;
}

type ProfilePickerRouteState = {
  profilePickerModal: {
    active: boolean;
    query: string;
    setQuery: (query: string) => void;
    cancelDeleteConfirmation: () => boolean;
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

/**
 * Profiles: the search row is always live. `d` (arm, then delete) and `s`
 * (save the current settings) fire while the query is empty; otherwise every
 * printable key is typed into the query. Esc drops an armed delete first,
 * otherwise it closes.
 */
export function handleProfilePickerToken(state: ProfilePickerRouteState, token: InputToken): boolean {
  if (!state.profilePickerModal.active) return false;
  const modal = state.profilePickerModal;

  const saveCurrent = (): void => {
    if (state.commandContext?.platform.configManager) {
      const name = `profile-${Date.now()}`;
      modal.saveCurrentAs(name, state.commandContext.platform.configManager);
    }
  };
  const act = (key: string): void => {
    if (key === 'd') modal.deleteSelected();
    else if (key === 's') saveCurrent();
  };

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      if (modal.cancelDeleteConfirmation()) {
        state.requestRender();
        return true;
      }
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter') {
      if (state.commandContext?.platform.configManager) {
        modal.loadSelected(state.commandContext.platform.configManager);
      }
    } else if (token.logicalName === 'up') modal.moveUp();
    else if (token.logicalName === 'down') modal.moveDown();
    else if (isTextBackspace(token.logicalName ?? '')) {
      if (modal.query.length > 0) modal.setQuery(modal.query.slice(0, -1));
    } else if (token.logicalName) act(token.logicalName);
  } else if (token.type === 'text') {
    if (modal.query.length === 0 && (token.value === 'd' || token.value === 's')) act(token.value);
    else modal.setQuery(modal.query + token.value);
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
 * Route a key to the generic config-modal host (MIGRATE-TO-MODAL
 * surfaces). The host owns the reserved navigation keys (Esc, up/down, tab,
 * left/right) and the always-live search row: a printable key the surface
 * claims as an action fires the action while the query is empty; every other
 * printable key (and any multi-char paste) is typed into the query, and
 * Backspace edits it. Other named keys (Enter, ctrl chords) go to the
 * surface's declarative action table (fireAction handles the two-press
 * confirm for destructive actions). Any unrecognised key is absorbed so the
 * modal stays modal.
 *
 * Esc pops exactly one level: an armed destructive confirm is cancelled
 * first; otherwise the modal closes through handleEscape. Esc never clears
 * the query as a separate step.
 */
export function handleConfigModalToken(state: ConfigModalRouteState, token: InputToken): boolean {
  if (!state.configModal.active) return false;

  // Every token that reaches the modal is a user interaction, after the
  // first one, structure freezes to interaction boundaries (liveness rule).
  // Before it, renders may sync structure so async onOpen loads appear
  // without a keypress (batch refutation finding 3).
  state.configModal.noteInteraction();

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      if (state.configModal.cancelPendingConfirm()) {
        state.requestRender();
        return true;
      }
      state.handleEscape();
      return true;
    }
    if (isTextBackspace(token.logicalName ?? '')) {
      state.configModal.backspaceFilter();
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
    // Any other 'key' token (Enter, a ctrl chord) falls through to the
    // action table below, whatever the query holds.
  } else if (token.type === 'text') {
    const claimed = state.configModal.getFilterQuery().length === 0
      && [...token.value].length === 1
      && state.configModal.resolveAction(token.value) !== null;
    if (!claimed) {
      // The WHOLE token value lands in the query in one call, including a
      // multi-char paste token, never split into per-char dispatch.
      state.configModal.appendFilterText(token.value);
      state.requestRender();
      return true;
    }
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
