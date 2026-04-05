import { loadSkillByTrigger } from '../tools/registry-tool/skill-loader.ts';
import type { CommandContext, CommandRegistry } from './command-registry.ts';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { InputToken } from '../core/tokenizer.ts';
import type { ConversationManager } from '../core/conversation.ts';

export type CommandModeRouteState = {
  commandMode: boolean;
  prompt: string;
  cursorPos: number;
  autocomplete: AutocompleteEngine | null;
  modalStack: string[];
  commandRegistry: CommandRegistry | null;
  commandContext?: CommandContext;
  conversationManager: ConversationManager | null;
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleCommandModeToken(state: CommandModeRouteState, token: InputToken): boolean {
  if (!state.commandMode) return false;

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
      state.commandMode = false;
      state.autocomplete?.reset();
      if (state.modalStack.length > 0 && state.modalStack[state.modalStack.length - 1] === 'command') {
        state.modalStack.pop();
      }
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
    state.prompt = '';
    state.cursorPos = 0;
    state.commandMode = false;
    state.autocomplete?.reset();
    if (raw.startsWith('/') && state.commandRegistry && state.commandContext) {
      const parts = raw.slice(1).trim().split(/\s+/);
      const name = parts[0];
      const args = parts.slice(1);
      const ctx = state.commandContext;
      (ctx.executeCommand?.(name, args) ?? state.commandRegistry.execute(name, args, ctx)).then((handled) => {
        if (handled) {
          state.requestRender();
        } else {
          const skillContent = loadSkillByTrigger('/' + name);
          if (skillContent) {
            state.commandContext?.submitInput?.(skillContent);
          } else {
            state.conversationManager?.log(`Unknown command: /${name}. Type /help for available commands.`, { fg: '#ef4444' });
            state.requestRender();
          }
        }
      });
    }
    return true;
  }

  return token.logicalName !== 'left' && token.logicalName !== 'right';
}
