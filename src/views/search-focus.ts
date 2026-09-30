import { isTextBackspace } from '../input/delete-key-policy.ts';

export type ViewSearchFocusTransition = 'focus-search' | 'focus-list' | null;

export function getViewSearchFocusTransition(
  key: string,
  options: { selectedIndex: number; itemCount: number; focusKeys?: ReadonlyArray<string> },
): ViewSearchFocusTransition {
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

// View search filters are end-anchored (no moveable cursor).
// Per the delete-key policy (src/input/delete-key-policy.ts):
//   'backspace' removes the last character.
//   'delete' is a no-op, there is no cursor, so forward-delete is meaningless.
export function isViewSearchBackspace(key: string): boolean {
  return isTextBackspace(key);
}

export function isViewSearchCancel(key: string): boolean {
  return key === 'escape';
}

export function isViewSearchCommit(key: string): boolean {
  return key === 'return' || key === 'enter';
}

export function isViewSearchPrintable(key: string): boolean {
  return key.length === 1 && key >= ' ';
}
