/**
 * legacy-pane-session.ts, fixtures for session files written while the TUI
 * still had side panes.
 *
 * Those files carry `returnContext.openPanels` (the panes that were open) and
 * an "Open panels: ..." summary line. The current SessionReturnContextSummary
 * type has neither, so the fixtures build the raw on-disk shape directly and
 * callers cast where a typed API takes it. Used only by the legacy-tolerance
 * tests that prove such files still load and are never written back with
 * that state.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const LEGACY_PANE_LIST: readonly string[] = ['sessions', 'git', 'fleet', 'tokens'];

/** A return context in the pre-removal on-disk shape. */
export function legacyPaneReturnContext(
  openPanels: readonly string[] = LEGACY_PANE_LIST,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    activityLabel: 'idle',
    statusLabel: 'idle',
    pendingApprovals: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    assistantTurnCount: 0,
    userTurnCount: 0,
    lines: ['Activity: idle', 'Status: idle', `Open panels: ${openPanels.join(', ')}`],
    openPanels: [...openPanels],
    ...overrides,
  };
}

/**
 * Rewrite the meta line of a session file (as SessionManager.save wrote it)
 * so its return context has the pre-removal shape.
 */
export function rewriteAsLegacyPaneSession(
  filePath: string,
  openPanels: readonly string[] = LEGACY_PANE_LIST,
): void {
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  const meta = JSON.parse(lines[0]!) as Record<string, unknown>;
  meta['returnContext'] = legacyPaneReturnContext(openPanels);
  lines[0] = JSON.stringify(meta);
  writeFileSync(filePath, lines.join('\n'), 'utf-8');
}
