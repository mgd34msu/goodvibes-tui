/**
 * operator-token-cleanup.ts
 *
 * Shared helper that enumerates the legacy workspace-scoped `operator-tokens.json`
 * locations the TUI has written at various pre-0.21.28 versions. Used by both the
 * in-process bootstrap path (`src/runtime/bootstrap.ts`) and the standalone daemon
 * CLI (`src/daemon/cli.ts`) so F3 (stale-token pruning) has a single source of
 * truth for where to look.
 *
 * Adding a new legacy location: append to `workspaceOperatorTokenCandidates` and
 * the new path will be inspected on the next daemon boot.
 */

import { join } from 'node:path';

/**
 * Return the list of absolute operator-tokens.json paths the TUI may have written
 * at legacy (pre-0.21.28) workspace-scoped locations under `workingDirectory`.
 *
 * The canonical, current-SDK location is `<daemonHomeDir>/operator-tokens.json`;
 * this helper is strictly for legacy-cleanup candidates.
 */
export function workspaceOperatorTokenCandidates(workingDirectory: string): readonly string[] {
  return [
    join(workingDirectory, '.goodvibes', 'operator-tokens.json'),
    join(workingDirectory, '.goodvibes', 'tui', 'operator-tokens.json'),
  ];
}
