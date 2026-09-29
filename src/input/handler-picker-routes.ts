import { readFileSync } from 'node:fs';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { CommandContext } from './command-registry.ts';
import type { CapabilityFilter, CategoryFilter, ModelPickerModal } from './model-picker.ts';
import { MODEL_PICKER_CHROME_LINES } from '../renderer/model-picker-overlay.ts';
import { ensureProviderKeyThenSelect } from './provider-key-intake.ts';
import { isTextBackspace } from './delete-key-policy.ts';
import { resolveAndValidatePath } from '@pellux/goodvibes-sdk/platform/utils';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { BlockActionId } from '../renderer/block-actions.ts';
import { offersConfigurableEffort, requestedEffortLevel, servingEffortForLevel, toEffortModel } from '../providers/reasoning-effort-surface.ts';

type ModelPickerRouteState = {
  modelPicker: ModelPickerModal;
  modalStack: string[];
  commandContext?: CommandContext;
  getViewportHeight: () => number;
  requestRender: () => void;
  handleEscape: () => void;
  onModelPickerCommit?: () => boolean;
};

/**
 * The user's REQUESTED reasoning level for this session, or undefined when the
 * command context is not attached. Read from config through the shared helper,
 * never from `session.runtime.reasoningEffort`, which holds the EFFECTIVE level
 * for whichever model is serving and would re-seed a resolution with an already
 * snapped-down value.
 */
function readRequestedEffort(state: ModelPickerRouteState): string | undefined {
  const configManager = state.commandContext?.platform?.configManager;
  if (!configManager) return undefined;
  return requestedEffortLevel(configManager) || undefined;
}

/**
 * The level the effort step should open on for a model about to be selected:
 * the requested level SNAPPED to that model. Opening on the raw requested level
 * would miss the list entirely whenever the target model caps lower, and
 * showEffortPicker falls back to index 0, landing the cursor on the LOWEST
 * level rather than on what pressing Enter would actually give you.
 */
function effortStepPreselect(state: ModelPickerRouteState, model: { id: string; provider?: string; displayName?: string }): string {
  const requested = readRequestedEffort(state) ?? 'medium';
  return servingEffortForLevel(requested, toEffortModel(model as never)).effective ?? requested;
}

export function handleModelPickerToken(state: ModelPickerRouteState, token: InputToken): boolean {
  if (!state.modelPicker.active) return false;

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      // Esc pops exactly one level: the effort and context-cap steps and a
      // provider-first model list are sub-levels of the picker; otherwise the
      // picker closes. A typed query is not a level, it goes with the picker.
      if (state.modelPicker.mode === 'effort') {
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
    } else if (isTextBackspace(token.logicalName ?? '')) {
      if (state.modelPicker.mode === 'contextCap') state.modelPicker.deleteContextCapChar();
      else if (state.modelPicker.canFocusSearch()) state.modelPicker.deleteChar();
    } else if (token.logicalName === 'enter') {
      if (state.modelPicker.focusPane === 'targets') {
        state.modelPicker.focusItems();
        state.requestRender();
        return true;
      }
      const mode = state.modelPicker.mode;
      const idx = state.modelPicker.selectedIndex;
      if (mode === 'model') {
        const selected = state.modelPicker.getSelected();
        if (selected) {
          // Preselect the REQUESTED level, not the effective one: the effort step
          // re-chooses the preference, so it must open on what the user asked for
          // even while a model that caps lower is serving.
          const currentEffort = readRequestedEffort(state) ?? 'medium';
          // Whether an effort step appears at all is now this model's own
          // resolved spec: a model with no configurable reasoning level, or
          // one whose levels are only a labelled best guess the adapters will
          // discard, skips straight to commit instead of showing a list it
          // does not honour.
          if (state.modelPicker.target === 'main' && offersConfigurableEffort(toEffortModel(selected))) {
            state.modelPicker.showEffortPicker(selected, effortStepPreselect(state, selected));
          } else {
            const target = state.modelPicker.target;
            const handled = state.onModelPickerCommit?.() ?? false;
            state.modelPicker.close();
            if (state.modalStack[state.modalStack.length - 1] === 'modelPicker') state.modalStack.pop();
            const ctx = state.commandContext;
            if (!handled && ctx) {
              // Selecting an unconfigured provider captures its key inline
              // (concealed prompt → secrets manager → live re-register) and
              // only then completes the original selection.
              ensureProviderKeyThenSelect(ctx, selected.provider, () => {
                // No effort step ran, so `currentEffort` is carried over, not
                // chosen: the commit path re-resolves from the stored
                // preference instead of treating this as a new choice.
                ctx.completeModelSelection?.({ model: selected, effort: currentEffort, target });
              });
            }
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
        const target = state.modelPicker.target;
        const handled = model && effort ? (state.onModelPickerCommit?.() ?? false) : false;
        state.modelPicker.close();
        if (state.modalStack[state.modalStack.length - 1] === 'modelPicker') state.modalStack.pop();
        const ctx = state.commandContext;
        if (model && effort && !handled && ctx) {
          ensureProviderKeyThenSelect(ctx, model.provider, () => {
            // The effort STEP: the level below is one the user just picked.
            ctx.completeModelSelection?.({ model, effort, target, effortChosenByUser: true });
          });
        }
      } else if (mode === 'embeddingProvider') {
        const selectedProvider = state.modelPicker.embeddingProviders[idx];
        if (selectedProvider) {
          state.commandContext?.completeEmbeddingProviderSelection?.(selectedProvider.id);
        }
        state.modelPicker.close();
        if (state.modalStack[state.modalStack.length - 1] === 'modelPicker') state.modalStack.pop();
      } else if (mode === 'contextCap') {
        const capModel = state.modelPicker.contextCapPendingModel;
        if (capModel) {
          const rawInput = state.modelPicker.contextCapQuery.trim();
          const parsedCap = rawInput.length > 0 ? parseInt(rawInput, 10) : null;
          if (parsedCap !== null && (parsedCap <= 0 || parsedCap > 10_000_000)) {
            // Non-empty but out of valid range, surface notice; keep picker open for correction.
            state.modelPicker.contextCapError = 'Context cap must be 1–10,000,000';
          } else {
            state.modelPicker.contextCapError = null;
            const validCap = parsedCap !== null && parsedCap > 0 && parsedCap <= 10_000_000 ? parsedCap : null;
            const effort = readRequestedEffort(state) ?? 'medium';
            const target = state.modelPicker.target;
            const handled = state.onModelPickerCommit?.() ?? false;
            state.modelPicker.close();
            if (state.modalStack[state.modalStack.length - 1] === 'modelPicker') state.modalStack.pop();
            const ctx = state.commandContext;
            if (!handled && ctx) {
              ensureProviderKeyThenSelect(ctx, capModel.provider, () => {
                ctx.completeModelSelection?.({ model: capModel, effort, contextCap: validCap, target });
              });
            }
          }
        } else {
          state.modelPicker.close();
          if (state.modalStack[state.modalStack.length - 1] === 'modelPicker') state.modalStack.pop();
        }
      }
    } else if (token.logicalName === 'up' || token.logicalName === 'down') {
      // The search row is always live, so arrows always walk the list.
      const maxVis = Math.max(5, state.getViewportHeight() - MODEL_PICKER_CHROME_LINES - 4);
      state.modelPicker.focusItems();
      if (token.logicalName === 'up') state.modelPicker.moveUp(maxVis);
      else state.modelPicker.moveDown(maxVis);
    } else if ((token.logicalName === 'tab' || token.logicalName === 'right' || token.logicalName === 'left') && state.modelPicker.mode !== 'contextCap' && state.modelPicker.mode !== 'effort') {
      // The five model targets are tabs: tab / → next, shift+tab / ← previous.
      const back = token.logicalName === 'left' || (token.logicalName === 'tab' && token.shift);
      state.modelPicker.moveTarget(back ? -1 : 1);
    } else if (token.ctrl && state.modelPicker.mode === 'model') {
      const picker = state.modelPicker;
      if (token.logicalName === 't') {
        const cycle: CategoryFilter[] = ['all', 'free', 'paid', 'subscription'];
        picker.setCategoryFilter(cycle[(cycle.indexOf(picker.categoryFilter) + 1) % cycle.length]!);
      } else if (token.logicalName === 'k') cycleCapabilityFilter(picker);
      else if (token.logicalName === 'a') picker.toggleAvailableOnly();
      else if (token.logicalName === 'b') picker.cycleBenchmarkSort();
      else if (token.logicalName === 'g') picker.cycleGroupBy();
      else if (token.logicalName === 'f') togglePin(state);
      else if (token.logicalName === 'r') {
        void state.commandContext?.executeCommand?.('refresh-models', []);
      }
    }
  } else if (token.type === 'text') {
    const picker = state.modelPicker;
    if (picker.mode === 'contextCap') {
      if (token.value.length === 1) picker.appendContextCapChar(token.value);
    } else if (token.value === ' ' && picker.mode === 'model' && picker.query.length === 0) {
      // Space on an untouched search sets a context cap for a local model.
      const selected = picker.getSelected();
      if (selected && picker.isLocalModel(selected)) picker.enterContextCapMode(selected);
    } else if (token.value === '\t') {
      picker.moveTarget(1);
    } else if (picker.canFocusSearch() && !(token.value === '/' && picker.query.length === 0)) {
      // Every printable character goes to the always-live search.
      picker.focusItems();
      picker.focusSearch();
      for (const ch of token.value) if (ch >= ' ') picker.appendChar(ch);
    }
  }

  state.requestRender();
  return true;
}

/** Pin or unpin the selected model: flipped locally at once, persisted through /pin or /unpin. */
function togglePin(state: ModelPickerRouteState): void {
  const model = state.modelPicker.getSelected();
  if (!model) return;
  const pinned = state.modelPicker.togglePinnedLocal(model);
  void state.commandContext?.executeCommand?.(pinned ? 'pin' : 'unpin', [model.registryKey]);
}

function cycleCapabilityFilter(modelPicker: ModelPickerModal): void {
  const cycle: CapabilityFilter[] = ['none', 'reasoning', 'toolUse', 'multimodal'];
  const cur = cycle.indexOf(modelPicker.capabilityFilter);
  modelPicker.setCapabilityFilter(cycle[(cur + 1) % cycle.length]!);
}

// e / retirement: the process-modal and live-tail-modal token routes
// were removed with those modals (F2 now opens Fleet, which subsumes the live
// process tree). ProcessModal/AgentDetailModal/LiveTailModal were structurally
// unreachable after the F2 repoint and were deleted.

type EscapeOnlyModalRouteState = {
  active: boolean;
  requestRender: () => void;
  handleEscape: () => void;
  /** Optional scrolling for read-only modals: ↑ passes +1 (back), ↓ passes -1. */
  scroll?: (delta: number) => void;
};

export function handleEscapeOnlyModalToken(state: EscapeOnlyModalRouteState, token: InputToken): boolean {
  if (!state.active) return false;
  if (token.type === 'key' && token.logicalName === 'escape') {
    state.handleEscape();
    return true;
  }
  if (token.type === 'key' && state.scroll) {
    if (token.logicalName === 'up') state.scroll(1);
    else if (token.logicalName === 'down') state.scroll(-1);
    else if (token.logicalName === 'pageup') state.scroll(10);
    else if (token.logicalName === 'pagedown') state.scroll(-10);
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

  // The query is always live: typing filters, arrows move, Esc closes.
  if (token.type === 'text') {
    if (token.value === ' ' && state.filePicker.query === '') {
      state.filePicker.close();
    } else {
      state.filePicker.focusSearch();
      state.filePicker.setQuery(state.filePicker.query + token.value);
    }
  } else if (token.type === 'key') {
    if (token.logicalName === 'escape') {
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
      state.filePicker.moveUp();
    } else if (token.logicalName === 'down') {
      state.filePicker.moveDown();
    } else if (token.logicalName === 'backspace') {
      if (state.filePicker.query.length > 0) {
        state.filePicker.setQuery(state.filePicker.query.slice(0, -1));
      } else {
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
