import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { InfiniteBuffer } from '../core/history.ts';
import type { SearchManager } from './search.ts';
import type { HistorySearch } from './input-history.ts';
import type {
  OnboardingWizardController,
  OnboardingWizardMode,
  OnboardingWizardSnapshot,
} from './onboarding/onboarding-wizard.ts';
export type { OnboardingWizardSnapshot } from './onboarding/onboarding-wizard.ts';

export interface OpenOnboardingWizardOptions {
  readonly mode?: OnboardingWizardMode;
  readonly reset?: boolean;
  readonly preload?: OnboardingWizardSnapshot | ((wizard: OnboardingWizardController) => void);
}

export function captureOnboardingWizardSnapshot(
  wizard: OnboardingWizardController,
): OnboardingWizardSnapshot {
  return wizard.captureSnapshot();
}

export function restoreOnboardingWizardSnapshot(
  wizard: OnboardingWizardController,
  snapshot: OnboardingWizardSnapshot,
  options?: { active?: boolean },
): void {
  wizard.restoreSnapshot(snapshot, options);
}

export function openOnboardingWizardState(
  wizard: OnboardingWizardController,
  options: OpenOnboardingWizardOptions = {},
): void {
  const snapshot = typeof options.preload === 'function' ? null : options.preload;
  const nextMode = options.mode ?? snapshot?.mode ?? wizard.mode;
  const shouldReset = options.reset ?? !wizard.active;

  if (shouldReset) {
    wizard.open(nextMode);
  } else {
    wizard.reopen();
    if (options.mode !== undefined) wizard.setMode(options.mode);
  }

  if (typeof options.preload === 'function') {
    options.preload(wizard);
  } else if (snapshot) {
    restoreOnboardingWizardSnapshot(wizard, snapshot, { active: true });
  }
}

export type ActiveModalState = {
  helpOverlayActive: boolean;
  shortcutsOverlayActive: boolean;
  bookmarkModal: { active: boolean; close: () => void };
  agentDetailModal: { active: boolean; close: () => void };
  liveTailModal: { active: boolean; close: () => void };
  settingsModal: { active: boolean; close: () => void };
  mcpWorkspace?: { active: boolean; close: () => void; reopen: () => void };
  sessionPickerModal: { active: boolean; close: () => void };
  profilePickerModal: { active: boolean; close: () => void };
  configModal: { active: boolean; close: () => void };
  contextInspectorModal: { active: boolean; close: () => void };
  processModal: { active: boolean; close: () => void };
  modelPicker: { active: boolean; close: () => void };
  filePicker: { active: boolean; close: () => void };
  blockActionsMenu: { active: boolean; close: () => void };
  selectionModal: { active: boolean; close: () => void };
  onboardingWizard?: Pick<OnboardingWizardController, 'active' | 'close' | 'reopen'>;
  commandMode: boolean;
};

export function getActiveModalName(state: ActiveModalState): string | null {
  if (state.helpOverlayActive) return 'help';
  if (state.shortcutsOverlayActive) return 'shortcuts';
  if (state.bookmarkModal.active) return 'bookmark';
  if (state.agentDetailModal.active) return 'agentDetail';
  if (state.liveTailModal.active) return 'liveTail';
  if (state.settingsModal.active) return 'settings';
  if (state.mcpWorkspace?.active) return 'mcpWorkspace';
  if (state.sessionPickerModal.active) return 'sessionPicker';
  if (state.profilePickerModal.active) return 'profilePicker';
  if (state.configModal.active) return 'config';
  if (state.contextInspectorModal.active) return 'contextInspector';
  if (state.processModal.active) return 'process';
  if (state.modelPicker.active) return 'modelPicker';
  if (state.filePicker.active) return 'filePicker';
  if (state.blockActionsMenu.active) return 'blockActions';
  if (state.selectionModal.active) return 'selection';
  if (state.onboardingWizard?.active) return 'onboarding';
  if (state.commandMode) return 'command';
  return null;
}

export type ModalCloseOps = {
  resetHelp: () => void;
  resetShortcuts: () => void;
  closeBookmark: () => void;
  closeAgentDetail: () => void;
  closeLiveTail: () => void;
  closeSettings: () => void;
  closeMcpWorkspace: () => void;
  closeSessionPicker: () => void;
  closeProfilePicker: () => void;
  closeConfigModal: () => void;
  closeContextInspector: () => void;
  closeProcess: () => void;
  closeModelPicker: () => void;
  closeFilePicker: () => void;
  closeBlockActions: () => void;
  closeSelection: () => void;
  closeOnboarding?: () => void;
  closeCommandMode: () => void;
};

export function closeModalByName(name: string, ops: ModalCloseOps): void {
  switch (name) {
    case 'help':
      ops.resetHelp();
      break;
    case 'shortcuts':
      ops.resetShortcuts();
      break;
    case 'bookmark':
      ops.closeBookmark();
      break;
    case 'agentDetail':
      ops.closeAgentDetail();
      break;
    case 'liveTail':
      ops.closeLiveTail();
      break;
    case 'settings':
      ops.closeSettings();
      break;
    case 'mcpWorkspace':
      ops.closeMcpWorkspace();
      break;
    case 'sessionPicker':
      ops.closeSessionPicker();
      break;
    case 'profilePicker':
      ops.closeProfilePicker();
      break;
    case 'config':
      ops.closeConfigModal();
      break;
    case 'contextInspector':
      ops.closeContextInspector();
      break;
    case 'process':
      ops.closeProcess();
      break;
    case 'modelPicker':
      ops.closeModelPicker();
      break;
    case 'filePicker':
      ops.closeFilePicker();
      break;
    case 'blockActions':
      ops.closeBlockActions();
      break;
    case 'selection':
      ops.closeSelection();
      break;
    case 'onboarding':
      ops.closeOnboarding?.();
      break;
    case 'command':
      ops.closeCommandMode();
      break;
  }
}

export type ModalOpenOps = {
  openHelp: () => void;
  openShortcuts: () => void;
  openBookmark: () => void;
  openProcess: () => void;
  openContextInspector: () => void;
  openMcpWorkspace?: () => void;
  openOnboarding?: () => void;
  openConfigModal?: () => void;
  openCommandMode: () => void;
};

export function reopenModalByName(name: string, ops: ModalOpenOps): void {
  switch (name) {
    case 'help':
      ops.openHelp();
      break;
    case 'shortcuts':
      ops.openShortcuts();
      break;
    case 'bookmark':
      ops.openBookmark();
      break;
    case 'process':
      ops.openProcess();
      break;
    case 'contextInspector':
      ops.openContextInspector();
      break;
    case 'mcpWorkspace':
      ops.openMcpWorkspace?.();
      break;
    case 'config':
      ops.openConfigModal?.();
      break;
    case 'onboarding':
      ops.openOnboarding?.();
      break;
    case 'command':
      ops.openCommandMode();
      break;
  }
}

type SearchRouteState = {
  searchManager: SearchManager;
  requestRender: () => void;
  scroll: (delta: number) => void;
  getScrollTop: () => number;
  getViewportHeight: () => number;
};

export function handleSearchModeToken(
  state: SearchRouteState,
  token: InputToken,
  history: InfiniteBuffer,
  matchesSearchShortcut: boolean,
): boolean {
  const { searchManager } = state;
  if (!searchManager.active) return false;

  if (!searchManager.locked) {
    if (token.type === 'text') {
      const newQuery = searchManager.query + token.value;
      searchManager.search(newQuery, history);
    } else if (token.type === 'key') {
      if (token.logicalName === 'escape') {
        searchManager.close();
      } else if (token.logicalName === 'enter' || token.logicalName === 'tab') {
        if (searchManager.query.length > 0) {
          searchManager.lock();
          const matchLine = searchManager.getCurrentMatchLine();
          if (matchLine >= 0) {
            state.scroll(matchLine - state.getScrollTop() - Math.floor(state.getViewportHeight() / 2));
          }
        }
      } else if (token.logicalName === 'backspace') {
        const newQuery = searchManager.query.slice(0, -1);
        searchManager.search(newQuery, history);
      } else if (matchesSearchShortcut) {
        searchManager.close();
      }
    }
  } else {
    if (token.type === 'key') {
      if (token.logicalName === 'escape' || matchesSearchShortcut) {
        searchManager.close();
      } else if (token.logicalName === 'right' || token.logicalName === 'down') {
        searchManager.nextMatch();
        const matchLine = searchManager.getCurrentMatchLine();
        if (matchLine >= 0) {
          state.scroll(matchLine - state.getScrollTop() - Math.floor(state.getViewportHeight() / 2));
        }
      } else if (token.logicalName === 'left' || token.logicalName === 'up') {
        searchManager.prevMatch();
        const matchLine = searchManager.getCurrentMatchLine();
        if (matchLine >= 0) {
          state.scroll(matchLine - state.getScrollTop() - Math.floor(state.getViewportHeight() / 2));
        }
      } else if (token.logicalName === 'backspace') {
        searchManager.unlock();
      }
    } else if (token.type === 'text') {
      if (token.value === 'n' || token.value === 'j' || token.value === 'l') {
        searchManager.nextMatch();
        const matchLine = searchManager.getCurrentMatchLine();
        if (matchLine >= 0) {
          state.scroll(matchLine - state.getScrollTop() - Math.floor(state.getViewportHeight() / 2));
        }
      } else if (token.value === 'N' || token.value === 'k' || token.value === 'h') {
        searchManager.prevMatch();
        const matchLine = searchManager.getCurrentMatchLine();
        if (matchLine >= 0) {
          state.scroll(matchLine - state.getScrollTop() - Math.floor(state.getViewportHeight() / 2));
        }
      }
    }
  }

  state.requestRender();
  return true;
}

type OverlayRouteState = {
  helpOverlayActive: boolean;
  helpScrollOffset: number;
  shortcutsOverlayActive: boolean;
  shortcutsScrollOffset: number;
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleOverlayToken(state: OverlayRouteState, token: InputToken): boolean {
  if (state.helpOverlayActive) {
    if (token.type === 'key') {
      if (token.logicalName === 'escape') {
        state.handleEscape();
        return true;
      }
      if (token.logicalName === 'up') state.helpScrollOffset = Math.max(0, state.helpScrollOffset - 1);
      else if (token.logicalName === 'down') state.helpScrollOffset = Math.min(state.helpScrollOffset + 1, 100);
    } else if (token.type === 'text' && token.value === '?') {
      state.helpOverlayActive = false;
      state.helpScrollOffset = 0;
    }
    state.requestRender();
    return true;
  }

  if (state.shortcutsOverlayActive) {
    if (token.type === 'key') {
      if (token.logicalName === 'escape') {
        state.handleEscape();
        return true;
      }
      if (token.logicalName === 'up') state.shortcutsScrollOffset = Math.max(0, state.shortcutsScrollOffset - 1);
      else if (token.logicalName === 'down') state.shortcutsScrollOffset = Math.min(state.shortcutsScrollOffset + 1, 50);
    }
    state.requestRender();
    return true;
  }

  return false;
}

type HistorySearchRouteState = {
  historySearch: HistorySearch;
  prompt: string;
  cursorPos: number;
  requestRender: () => void;
};

export function handleHistorySearchToken(state: HistorySearchRouteState, token: InputToken): boolean {
  if (!state.historySearch.active) return false;

  if (token.type === 'text') {
    state.historySearch.appendChar(token.value);
  } else if (token.type === 'key') {
    if (token.logicalName === 'escape' || (token.ctrl && token.logicalName === 'g')) {
      state.prompt = state.historySearch.cancel();
      state.cursorPos = state.prompt.length;
    } else if (token.logicalName === 'enter' || token.logicalName === 'return') {
      state.prompt = state.historySearch.accept();
      state.cursorPos = state.prompt.length;
    } else if (token.logicalName === 'backspace') {
      state.historySearch.deleteChar();
    } else if (token.ctrl && token.logicalName === 'r') {
      state.historySearch.stepOlder();
    } else if (token.ctrl && token.logicalName === 's') {
      state.historySearch.stepNewer();
    } else if (token.logicalName === 'up') {
      state.historySearch.stepOlder();
    } else if (token.logicalName === 'down') {
      state.historySearch.stepNewer();
    }
  }

  state.requestRender();
  return true;
}
