/**
 * handler-session-view-route.ts, the keyboard while an agent or process is
 * open full screen, and the session chips' Tab cycling everywhere.
 *
 * Runs after the modals (a modal open takes every key first) and before the
 * work tree and the composer.
 *
 *   Tab / Shift+Tab   next / previous session chip, only while the composer
 *                     is empty and not completing a command (otherwise Tab
 *                     keeps its completion meaning and Shift+Tab its mode
 *                     cycling), and only when the chips row shows
 *   ctrl+x            stop the agent or process: the first press asks, the
 *                     second (within 3 s) stops
 *   PageUp/PageDown   scroll the view
 *
 * Agent view: Enter sends the composer's text to the agent as a steer (main
 * keeps running); everything else types into the composer as usual.
 *
 * Process view: the composer takes no text (the process's stdin is not
 * reachable), so letters are the view's keys: / search, n next match, y copy
 * the output, r restart (when supported); ↑ ↓ scroll a row, End follows the
 * output again.
 *
 * Esc is not handled here: it goes through the shared chain
 * (handler-modal-stack.ts), whose view step goes back up one level and never
 * cancels anything.
 */

import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import { isTextBackspace } from './delete-key-policy.ts';

/** What the route can do to the session views (shell/session-views.ts). */
export interface SessionViewControls {
  /** 'main' when no view is open. */
  readonly kind: 'main' | 'agent' | 'process';
  readonly active: boolean;
  /** The chips row is showing (more than one session to switch to). */
  chipsVisible(): boolean;
  cycle(delta: 1 | -1): void;
  /** ctrl+x: ask on the first press, stop on the second. */
  pressStop(): void;
  scroll(rows: number): void;
  /** Rows a page scroll moves. */
  pageRows(): number;
  /** Follow the newest output again (End). */
  follow(): void;
  /** Agent view: send text to the agent as a steer. True when it was accepted. */
  steer(text: string): boolean;
  /** Process view keys. */
  readonly searchEditing: boolean;
  startSearch(): void;
  searchType(text: string): void;
  searchBackspace(): void;
  searchNext(): void;
  copyOutput(): void;
  restart(): void;
  /** A key the process view does not take (the composer is off there). */
  refuseText(): void;
  /** Esc in a view: close the search, else go back up one level. */
  escape(): void;
}

export interface SessionViewRouteState {
  readonly controls: SessionViewControls | null;
  prompt: string;
  cursorPos: number;
  readonly commandMode: boolean;
  readonly saveUndoState: () => void;
  readonly requestRender: () => void;
}

function isBackTab(token: InputToken): boolean {
  return token.type === 'key' && (token.logicalName === '\x1b[Z' || (token.logicalName === 'tab' && token.shift === true));
}

/** Returns true when the token was handled here. */
export function handleSessionViewToken(state: SessionViewRouteState, token: InputToken): boolean {
  const c = state.controls;
  if (!c) return false;
  const composerIdle = state.prompt.length === 0 && !state.commandMode;

  if (token.type === 'key' && composerIdle && !token.ctrl && !token.meta && (token.logicalName === 'tab' || isBackTab(token)) && c.chipsVisible()) {
    c.cycle(isBackTab(token) ? -1 : 1);
    state.requestRender();
    return true;
  }
  if (!c.active) return false;

  if (token.type === 'key') {
    const name = token.logicalName ?? '';
    if (token.ctrl && !token.meta && name === 'x') {
      c.pressStop();
      state.requestRender();
      return true;
    }
    if (!token.ctrl && !token.meta && (name === 'pageup' || name === 'pagedown')) {
      c.scroll(name === 'pageup' ? c.pageRows() : -c.pageRows());
      state.requestRender();
      return true;
    }
    if (c.kind === 'agent' && name === 'enter' && !token.shift && !token.ctrl && !token.meta && !state.commandMode) {
      const text = state.prompt.trim();
      if (!text) return true; // an empty Enter in an agent view sends nothing (and never opens main's block actions)
      if (c.steer(text)) {
        state.saveUndoState();
        state.prompt = '';
        state.cursorPos = 0;
      }
      state.requestRender();
      return true;
    }
    if (c.kind === 'process') return handleProcessKey(state, c, token, name);
    return false;
  }

  if (token.type === 'text' && c.kind === 'process') {
    if (c.searchEditing) {
      c.searchType(token.value.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, ''));
    } else if (token.value === '/') c.startSearch();
    else if (token.value === 'n') c.searchNext();
    else if (token.value === 'y') c.copyOutput();
    else if (token.value === 'r') c.restart();
    else if (token.value === 'G') c.follow();
    else c.refuseText();
    state.requestRender();
    return true;
  }
  return false;
}

function handleProcessKey(state: SessionViewRouteState, c: SessionViewControls, token: InputToken & { type: 'key' }, name: string): boolean {
  if (token.ctrl || token.meta) return false;
  if (c.searchEditing) {
    if (name === 'enter') c.searchNext();
    else if (isTextBackspace(name)) c.searchBackspace();
    else return false;
    state.requestRender();
    return true;
  }
  switch (name) {
    case 'up': c.scroll(1); break;
    case 'down': c.scroll(-1); break;
    case 'end': c.follow(); break;
    case 'enter': break; // no stdin to send a line to
    default: return false;
  }
  state.requestRender();
  return true;
}
