import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { CommandContext } from './command-registry.ts';
import type { SearchManager } from './search.ts';
import type { HistorySearch } from './input-history.ts';
import type { ConversationManager } from '../core/conversation';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { KeybindingsManager } from './keybindings.ts';
import type { KillRing } from './kill-ring.ts';
import { wordBoundaryBack, wordBoundaryForward } from './kill-ring.ts';
import { nextPermissionMode, permissionModeLabel, type PermissionModeValue } from '../core/permission-mode.ts';

type WrappedPromptInfo = {
  wrappedLines: string[];
  segments: { rawStart: number; length: number }[];
  cursorWrappedLine: number;
};

export type GlobalShortcutRouteState = {
  keybindingsManager: KeybindingsManager;
  prompt: string;
  cursorPos: number;
  commandMode: boolean;
  autocomplete: AutocompleteEngine | null;
  historySearch: HistorySearch;
  searchManager: SearchManager;
  conversationManager: ConversationManager | null;
  commandContext?: CommandContext;
  contentWidth: number;
  getScrollTop: () => number;
  getWrappedPromptInfo: (contentWidth: number) => WrappedPromptInfo;
  saveUndoState: () => void;
  requestRender: () => void;
  scroll: (delta: number) => void;
  ensureInputCursorVisible: () => void;
  handleCopy: () => void;
  handleCtrlC: () => void;
  handleBlockCopy: () => void;
  handleBookmark: () => void;
  handleBlockSave: () => void;
  handleDiffApply: () => boolean;
  handleUndo: () => void;
  handleRedo: () => void;
  handlePaste: () => void;
  handleEscape: () => void;
  killRing: KillRing;
};

export function handleGlobalShortcutToken(
  state: GlobalShortcutRouteState,
  token: InputToken,
  viewportHeight: number,
): boolean {
  if (token.type !== 'key') return false;

  // Fast-path: BARE pageup/pagedown scroll the transcript (modified ones fall
  // through to the keybinding lookup below).
  if (token.logicalName === 'pageup' && !token.ctrl) {
    state.scroll(-Math.max(1, viewportHeight - 2));
    return true;
  }
  if (token.logicalName === 'pagedown' && !token.ctrl) {
    state.scroll(Math.max(1, viewportHeight - 2));
    return true;
  }
  // Bare escape is also not in the keybinding table.
  if (token.logicalName === 'escape') {
    state.handleEscape();
    return true;
  }

  // Bare F2 opens the Agents modal (hardcoded, like pageup/pagedown/escape;
  // F2 inside the Agents modal closes it, see input/agents-modal.ts).
  if (token.logicalName === 'f2' && !token.ctrl && !token.meta) {
    state.commandContext?.openAgents?.();
    state.requestRender();
    return true;
  }

  // Shift+Tab cycles the session permission mode (normal → accept-edits → plan
  // → auto → normal), the settled convention. Handled here, hardcoded, like
  // escape/f2, because it is not in the keybinding table and bare Tab is
  // already heavily overloaded. Arrives as the legacy xterm backtab literal
  // ('\x1b[Z') OR, under a kitty/CSI-u terminal, as tab-with-shift. Only when
  // the composer owns focus; modal/picker routes run earlier and swallow the
  // token before it reaches here, so overlays keep their reverse-tab too.
  if (token.logicalName === '\x1b[Z' || (token.logicalName === 'tab' && token.shift)) {
    cycleSessionPermissionMode(state);
    return true;
  }

  // O(1) lookup via inverted map.
  const kb = state.keybindingsManager;
  const action = kb.lookup(token);

  switch (action) {
    case 'copy-selection':
      state.handleCopy();
      return true;

    case 'clear-cancel':
      state.handleCtrlC();
      return true;

    case 'cancel-tool-call':
      // Cancel JUST the currently-running tool call (the live transcript row).
      // No-op (still consumed) when nothing is running, the composer keeps the
      // keystroke rather than letting it fall through as text.
      state.commandContext?.cancelToolCall?.();
      return true;

    case 'toggle-memory-provenance':
      // Expand/collapse the provenance chip's drill-in. No-op when the chip is
      // not showing; still consumed so the composer never sees a stray Alt+M.
      state.commandContext?.toggleMemoryProvenance?.();
      return true;

    case 'voice-input':
      // Start recording, or stop the recording already running. Routed globally;
      // still consumed when voice input is not wired, so a stray Alt+V never
      // lands in the prompt as text.
      state.commandContext?.toggleVoiceInput?.();
      return true;

    case 'toggle-keep-awake': {
      // Flip the daemon-held keep-awake toggle; the always-visible "sleep
      // disabled" chip is the confirmation. Fire-and-forget (the seam renders on
      // completion); errors are swallowed so a keystroke never throws.
      const power = state.commandContext;
      const current = power?.getPowerState?.().keepAwake ?? false;
      void power?.setKeepAwake?.(!current);
      return true;
    }

    case 'screen-clear':
      state.commandContext?.clearScreen?.();
      return true;

    case 'command-palette':
      state.commandContext?.openCommandPalette?.();
      state.requestRender();
      return true;

    case 'open-agents':
      // Ctrl+O: the Agents modal (the same as F2).
      state.commandContext?.openAgents?.();
      state.requestRender();
      return true;

    case 'history-search':
      state.historySearch.open(state.prompt);
      state.requestRender();
      return true;

    case 'search':
      if (state.searchManager.active) state.searchManager.close(state.conversationManager);
      else state.searchManager.open();
      state.requestRender();
      return true;

    case 'block-copy':
      if (!state.commandMode) { state.handleBlockCopy(); return true; }
      return false;

    case 'bookmark':
      if (!state.commandMode) { state.handleBookmark(); return true; }
      return false;

    case 'block-save':
      if (!state.commandMode) { state.handleBlockSave(); return true; }
      return false;

    case 'delete-word': {
      state.saveUndoState();
      let pos = state.cursorPos;
      while (pos > 0 && state.prompt[pos - 1] === ' ') pos--;
      while (pos > 0 && state.prompt[pos - 1] !== ' ') pos--;
      const killedWord = state.prompt.slice(pos, state.cursorPos);
      if (killedWord) { state.killRing.push(killedWord); state.killRing.clearYankState(); }
      state.prompt = state.prompt.slice(0, pos) + state.prompt.slice(state.cursorPos);
      state.cursorPos = pos;
      state.ensureInputCursorVisible();
      return true;
    }

    case 'apply-diff-line-start': {
      if (!state.commandMode && state.handleDiffApply()) return true;
      const info = state.getWrappedPromptInfo(state.contentWidth);
      state.cursorPos = info.wrappedLines.length > 1 ? info.segments[info.cursorWrappedLine].rawStart : 0;
      state.ensureInputCursorVisible();
      return true;
    }

    case 'next-error-line-end': {
      if (state.prompt === '' && !state.commandMode) {
        const nextLine = state.conversationManager?.nextErrorLine(state.getScrollTop()) ?? -1;
        if (nextLine >= 0) {
          state.scroll(nextLine - state.getScrollTop());
          state.requestRender();
          return true;
        }
      }
      const info = state.getWrappedPromptInfo(state.contentWidth);
      state.cursorPos = info.wrappedLines.length > 1
        ? info.segments[info.cursorWrappedLine].rawStart + info.segments[info.cursorWrappedLine].length
        : state.prompt.length;
      state.ensureInputCursorVisible();
      return true;
    }

    case 'kill-line': {
      const killed = state.prompt.slice(state.cursorPos);
      state.saveUndoState();
      state.killRing.push(killed);
      state.killRing.clearYankState();
      state.prompt = state.prompt.slice(0, state.cursorPos);
      state.ensureInputCursorVisible();
      return true;
    }

    case 'clear-prompt': {
      // Legacy full-clear: keep as alias but do NOT call this when kill-to-start is bound.
      state.saveUndoState();
      state.prompt = '';
      state.cursorPos = 0;
      if (state.commandMode) {
        state.commandMode = false;
        state.autocomplete?.reset();
      }
      return true;
    }

    case 'kill-to-start': {
      // Kill from start of buffer to cursor, push to ring.
      const killed = state.prompt.slice(0, state.cursorPos);
      state.saveUndoState();
      state.killRing.push(killed);
      state.killRing.clearYankState();
      state.prompt = state.prompt.slice(state.cursorPos);
      state.cursorPos = 0;
      state.ensureInputCursorVisible();
      return true;
    }

    case 'kill-word-forward': {
      // Kill from cursor to end of next word, push to ring.
      const end = wordBoundaryForward(state.prompt, state.cursorPos);
      const killed = state.prompt.slice(state.cursorPos, end);
      if (killed) {
        state.saveUndoState();
        state.killRing.push(killed);
        state.killRing.clearYankState();
        state.prompt = state.prompt.slice(0, state.cursorPos) + state.prompt.slice(end);
        state.ensureInputCursorVisible();
      }
      return true;
    }

    case 'word-back': {
      const newPos = wordBoundaryBack(state.prompt, state.cursorPos);
      if (newPos !== state.cursorPos) {
        state.killRing.clearYankState();
        state.cursorPos = newPos;
        state.ensureInputCursorVisible();
      }
      return true;
    }

    case 'word-forward': {
      const newPos = wordBoundaryForward(state.prompt, state.cursorPos);
      if (newPos !== state.cursorPos) {
        state.killRing.clearYankState();
        state.cursorPos = newPos;
        state.ensureInputCursorVisible();
      }
      return true;
    }

    case 'yank': {
      const text = state.killRing.yank();
      if (text) {
        state.saveUndoState();
        state.prompt = state.prompt.slice(0, state.cursorPos) + text + state.prompt.slice(state.cursorPos);
        state.cursorPos += text.length;
        state.ensureInputCursorVisible();
      }
      return true;
    }

    case 'yank-pop': {
      // Only valid immediately after a yank or yank-pop.
      if (!state.killRing.lastActionWasYank) return false;
      // Undo the previous yank by restoring: we store the pre-yank snapshot on
      // the undo stack so a single undo covers the whole yank sequence.
      // For yank-pop: replace the last yanked text with the next ring entry.
      // We rely on the undo stack having the pre-yank state at the top.
      state.handleUndo();
      const text = state.killRing.yankPop();
      if (text) {
        state.saveUndoState();
        state.prompt = state.prompt.slice(0, state.cursorPos) + text + state.prompt.slice(state.cursorPos);
        state.cursorPos += text.length;
        state.ensureInputCursorVisible();
      }
      return true;
    }

    case 'undo':
      state.handleUndo();
      return true;

    case 'redo':
      state.handleRedo();
      return true;

    case 'paste':
      state.handlePaste();
      return true;

    default:
      return false;
  }
}

/**
 * Cycle the session permission mode (Shift+Tab). The change goes through the
 * SDK config surface, configManager.set('permissions.mode', ...), which is
 * what the SDK PermissionManager reads and what the orchestrator consults for
 * its standing plan-mode instruction, so every attached surface converges on
 * the same mode. The footer pill re-renders off the config-key subscription
 * wired in turn-event-wiring; the printed line narrates the change inline.
 */
function cycleSessionPermissionMode(state: GlobalShortcutRouteState): void {
  const configManager = state.commandContext?.platform?.configManager;
  if (!configManager) return;
  const current = configManager.get('permissions.mode') as PermissionModeValue | undefined;
  const next = nextPermissionMode(current);
  configManager.set('permissions.mode', next);
  state.commandContext?.print(`[Permissions] Mode: ${permissionModeLabel(next)}`);
  state.requestRender();
}
