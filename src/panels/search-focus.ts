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

export function isPanelSearchBackspace(key: string): boolean {
  return key === 'backspace' || key === 'delete';
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
