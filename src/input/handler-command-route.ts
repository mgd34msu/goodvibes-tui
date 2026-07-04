import { loadSkillByTrigger } from '@pellux/goodvibes-sdk/platform/tools';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { CommandContext, CommandRegistry } from './command-registry.ts';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { ConversationManager } from '../core/conversation';
import type { PanelManager } from '../panels/panel-manager.ts';
import { handleClipboardPaste, type ClipboardPasteSource } from './handler-content-actions.ts';

export type CommandModeRouteState = {
  commandMode: boolean;
  prompt: string;
  cursorPos: number;
  autocomplete: AutocompleteEngine | null;
  modalStack: string[];
  commandRegistry: CommandRegistry | null;
  commandContext?: CommandContext;
  panelFocused: boolean;
  panelManager: PanelManager;
  conversationManager: ConversationManager | null;
  requestRender: () => void;
  handleEscape: () => void;
  projectRoot: string;
  pasteRegistry: Map<string, string>;
  imageRegistry: Map<string, { data: string; mediaType: string }>;
  nextPasteId: number;
  nextImageId: number;
  saveUndoState: () => void;
  ensureInputCursorVisible: () => void;
  clipboard?: ClipboardPasteSource;
};

export function handleCommandModeToken(state: CommandModeRouteState, token: InputToken): boolean {
  if (!state.commandMode) return false;

  const closeCommandMode = (): void => {
    state.commandMode = false;
    for (let i = state.modalStack.length - 1; i >= 0; i--) {
      if (state.modalStack[i] === 'command') state.modalStack.splice(i, 1);
    }
    state.autocomplete?.reset();
    state.prompt = '';
    state.cursorPos = 0;
  };

  if (token.type !== 'key') return false;

  if (token.logicalName === 'escape') {
    state.handleEscape();
    return true;
  }
  if (token.logicalName === 'up') {
    state.autocomplete?.moveUp();
    return true;
  }
  if (token.logicalName === 'down') {
    state.autocomplete?.moveDown();
    return true;
  }
  if (token.logicalName === 'tab') {
    const selected = state.autocomplete?.getSelected();
    if (selected) {
      state.prompt = `/${selected.name} `;
      state.cursorPos = state.prompt.length;
      state.autocomplete?.reset();
    }
    return true;
  }
  if (token.logicalName === 'backspace') {
    if (state.cursorPos > 0) {
      state.prompt = state.prompt.slice(0, state.cursorPos - 1) + state.prompt.slice(state.cursorPos);
      state.cursorPos--;
    }
    if (state.prompt === '') {
      closeCommandMode();
      state.autocomplete?.reset();
    } else {
      const query = state.prompt.startsWith('/') ? state.prompt.slice(1) : '';
      const spaceIdx = query.indexOf(' ');
      if (spaceIdx === -1) state.autocomplete?.update(query);
    }
    return true;
  }
  if (token.logicalName === 'enter') {
    const selectedCmd = state.autocomplete?.isActive ? state.autocomplete.getSelected() : undefined;
    const raw = selectedCmd ? `/${selectedCmd.name}` : state.prompt.trim();
    if (raw.startsWith('/') && state.commandRegistry && state.commandContext) {
      closeCommandMode();
      const parts = raw.slice(1).trim().split(/\s+/);
      const name = parts[0];
      const args = parts.slice(1);
      const ctx = withPanelFocusSync(state.commandContext, state);
      const commandPromise = state.commandRegistry.get(name)
        ? state.commandRegistry.execute(name, args, ctx)
        : (ctx.executeCommand?.(name, args) ?? Promise.resolve(false));
      commandPromise
        .then((handled) => {
          if (handled) {
            state.requestRender();
          } else {
            const shellPaths = state.commandContext?.workspace.shellPaths;
            const skillContent = shellPaths
              ? loadSkillByTrigger('/' + name, {
                  workingDirectory: shellPaths.workingDirectory,
                  homeDirectory: shellPaths.homeDirectory,
                })
              : null;
            if (skillContent) {
              state.commandContext?.submitInput?.(skillContent);
            } else {
              state.conversationManager?.log(`Unknown command: /${name}. Type /help for available commands.`, { fg: '#ef4444' });
              state.requestRender();
            }
          }
        })
        .catch((err: unknown) => {
          // Defense in depth for EVERY command, not just the ones that
          // already guard their own internals: a handler that throws or
          // awaits a rejected promise must never become a silent unhandled
          // rejection — it renders the same way an unknown command does.
          state.conversationManager?.log(`Command /${name} failed: ${summarizeError(err)}`, { fg: '#ef4444' });
          state.requestRender();
        });
    } else {
      closeCommandMode();
    }
    return true;
  }

  return token.logicalName !== 'left' && token.logicalName !== 'right' && token.logicalName !== 'home' && token.logicalName !== 'end';
}

function withPanelFocusSync(context: CommandContext, state: CommandModeRouteState): CommandContext {
  const panelIsFocusable = (): boolean =>
    state.panelManager.isVisible() && state.panelManager.getAllOpen().length > 0;

  return {
    ...context,
    openPanelPicker: context.openPanelPicker
      ? () => {
          context.openPanelPicker?.();
          state.panelFocused = panelIsFocusable();
        }
      : undefined,
    showPanel: context.showPanel
      ? (panelId, pane) => {
          context.showPanel?.(panelId, pane);
          state.panelFocused = true;
        }
      : undefined,
    focusPanels: context.focusPanels
      ? () => {
          context.focusPanels?.();
          state.panelFocused = panelIsFocusable();
        }
      : undefined,
    focusPrompt: context.focusPrompt
      ? () => {
          context.focusPrompt?.();
          state.panelFocused = false;
        }
      : undefined,
    pasteFromClipboard: () => {
      const result = handleClipboardPaste({
        prompt: state.prompt,
        cursorPos: state.cursorPos,
        pasteRegistry: state.pasteRegistry,
        nextPasteId: state.nextPasteId,
        imageRegistry: state.imageRegistry,
        nextImageId: state.nextImageId,
        saveUndoState: state.saveUndoState,
        ensureInputCursorVisible: state.ensureInputCursorVisible,
        requestRender: state.requestRender,
      }, context.workspace.shellPaths?.workingDirectory ?? state.projectRoot, state.clipboard);
      state.prompt = result.prompt;
      state.cursorPos = result.cursorPos;
      state.nextImageId = result.nextImageId;
      state.nextPasteId = result.nextPasteId;
      return result;
    },
    executeCommand: async (name, args) => {
      const wrapped = withPanelFocusSync(context, state);
      const handled = state.commandRegistry?.get(name)
        ? await state.commandRegistry.execute(name, args, wrapped)
        : false;
      if (handled) return true;
      return (await context.executeCommand?.(name, args)) ?? false;
    },
  };
}
