import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The TUI's own `.goodvibes/` directory (logs, overflow buffers, exec output,
 * cache, session state, etc.) is transient scratch space, not project source —
 * but nothing else in the codebase excludes it from the *project's* git
 * history. Any `git add -A` (write-quit's auto-commit, a WRFC chain's own
 * commit, etc.) sweeps the whole tree in unless the project's .gitignore
 * already happens to exclude it. Idempotent and append-only: never rewrites
 * or reorders a project's existing .gitignore, only adds the rule if it is
 * verifiably absent, and never touches a directory that isn't a git repo.
 */
const GOODVIBES_IGNORE_PATTERN = /(^|\n)[ \t]*\/?\.goodvibes\/?\*?[ \t]*(\n|$)/;

export function ensureGoodvibesGitignore(projectRoot: string): void {
  try {
    if (!existsSync(join(projectRoot, '.git'))) return; // only matters for git projects
    const gitignorePath = join(projectRoot, '.gitignore');
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
    if (GOODVIBES_IGNORE_PATTERN.test(existing)) return; // already excluded
    const rule = '# goodvibes-tui transient state\n.goodvibes/\n';
    if (existing.length === 0) {
      writeFileSync(gitignorePath, rule);
      return;
    }
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    appendFileSync(gitignorePath, separator + rule);
  } catch {
    // Best-effort only — never block startup on a gitignore write failure.
  }
}
