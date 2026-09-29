/**
 * handler-work-tree-route.ts, the keyboard inside the conversation work tree.
 *
 * The `focus-work-tree` binding (Alt+Up, Ctrl+Up) moves the keyboard from the
 * composer onto the work tree's rows. There:
 *
 *   ↑ ↓     move between beads (and turn headers and agent lanes)
 *   ← →     fold / unfold
 *   Enter   open a bead's body, unfold an agent lane
 *   y       copy the focused row's content
 *   Esc     back to typing (never stops or cancels anything)
 *
 * Any other key hands the keyboard back to the composer and is typed there,
 * so starting to type never needs an Esc first.
 */

import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { ConversationManager } from '../core/conversation.ts';
import { handleBlockCopy } from './handler-content-actions.ts';

export interface WorkTreeRouteState {
  readonly conversationManager: ConversationManager | null;
  /** The token matches the `focus-work-tree` binding. */
  readonly enterMatch: boolean;
  /** The last visible transcript line (where focus lands on entry). */
  readonly anchorLine: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly scroll: (delta: number) => void;
  readonly requestRender: () => void;
  readonly onCopied: () => void;
}

/** Scroll so the focused row (and as much of its opened body as fits) is visible. */
function revealFocus(state: WorkTreeRouteState): void {
  const block = state.conversationManager?.workTree.focusBlock();
  if (!block) return;
  const top = block.startLine;
  const bottom = block.startLine + Math.min(Math.max(1, block.lineCount), state.viewportHeight) - 1;
  if (top < state.scrollTop) state.scroll(top - state.scrollTop);
  else if (bottom >= state.scrollTop + state.viewportHeight) state.scroll(bottom - (state.scrollTop + state.viewportHeight) + 1);
}

/** Returns true when the token was handled here. */
export function handleWorkTreeToken(state: WorkTreeRouteState, token: InputToken): boolean {
  const cm = state.conversationManager;
  if (!cm) return false;
  const tree = cm.workTree;

  if (!tree.focused) {
    if (token.type !== 'key' || !state.enterMatch) return false;
    if (tree.enter(state.anchorLine)) revealFocus(state);
    state.requestRender();
    return true;
  }

  if (token.type === 'text') {
    if (token.value === 'y') {
      const block = tree.focusBlock();
      if (block) handleBlockCopy(cm, () => block.startLine, state.requestRender, state.onCopied);
      return true;
    }
    // Typing goes back to the composer.
    tree.leave();
    state.requestRender();
    return false;
  }
  if (token.type !== 'key') return false;

  if (!token.ctrl && !token.meta) {
    switch (token.logicalName) {
      case 'escape':
        tree.leave();
        state.requestRender();
        return true;
      case 'up':
      case 'down':
        tree.move(token.logicalName === 'up' ? -1 : 1);
        revealFocus(state);
        state.requestRender();
        return true;
      case 'left':
      case 'right':
      case 'enter':
        tree.act(token.logicalName === 'left' ? 'fold' : token.logicalName === 'right' ? 'unfold' : 'activate');
        revealFocus(state);
        state.requestRender();
        return true;
      case 'y':
        {
          const block = tree.focusBlock();
          if (block) handleBlockCopy(cm, () => block.startLine, state.requestRender, state.onCopied);
        }
        return true;
      default:
        break;
    }
  }
  if (state.enterMatch) return true;
  // Anything else goes back to the composer (and is handled there).
  tree.leave();
  state.requestRender();
  return false;
}
