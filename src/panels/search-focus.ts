import { isTextBackspace } from '../input/delete-key-policy.ts';

export type PanelSearchFocusTransition = 'focus-search' | 'focus-list' | null;

export function getPanelSearchFocusTransition(
  key: string,
  options: { selectedIndex: number; itemCount: number; focusKeys?: ReadonlyArray<string> },
): PanelSearchFocusTransition {
  const focusKeys = options.focusKeys ?? ['/'];
  if (focusKeys.includes(key)) return 'focus-search';
  if (key === 'up' && options.selectedIndex <= 0) {
    return 'focus-search';
  }
  if (key === 'down' && options.itemCount > 0) {
    return 'focus-list';
  }
  return null;
}

// Panel search filters are end-anchored (no moveable cursor).
// Per the delete-key policy (src/input/delete-key-policy.ts):
//   'backspace' removes the last character.
//   'delete' is a no-op, there is no cursor, so forward-delete is meaningless.
export function isPanelSearchBackspace(key: string): boolean {
  return isTextBackspace(key);
}

export function isPanelSearchCancel(key: string): boolean {
  return key === 'escape';
}

export function isPanelSearchCommit(key: string): boolean {
  return key === 'return' || key === 'enter';
}

export function isPanelSearchPrintable(key: string): boolean {
  return key.length === 1 && key >= ' ';
}
