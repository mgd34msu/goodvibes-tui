import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The TUI's own `.goodvibes/` directory (logs, overflow buffers, exec output,
 * cache, session state, etc.) is transient scratch space, not project source,
 * but nothing else in the codebase excludes it from the *project's* git
 * history. Any `git add -A` (write-quit's auto-commit, a WRFC chain's own
 * commit, etc.) sweeps the whole tree in unless the project's .gitignore
 * already happens to exclude it. Idempotent and append-only: never rewrites
 * or reorders a project's existing .gitignore, only adds the rule if it is
 * verifiably absent, and never touches a directory that isn't a git repo.
 */
const GOODVIBES_IGNORE_PATTERN = /(^|\n)[ \t]*\/?\.goodvibes\/?\*?[ \t]*(\n|$)/;

/**
 * Ensures the project's .gitignore excludes .goodvibes/, appending the rule
 * exactly once if it is verifiably absent.
 *
 * @returns true only the FIRST time the rule is actually written this call,
 * i.e. this specific invocation just appended/created it. Every subsequent
 * launch (rule already present) and every no-op case (not a git repo, or the
 * write failed) return false. The caller uses this to print a one-time
 * notice instead of staying silent about an edit to the user's own project file.
 */
export function ensureGoodvibesGitignore(projectRoot: string): boolean {
  try {
    if (!existsSync(join(projectRoot, '.git'))) return false; // only matters for git projects
    const gitignorePath = join(projectRoot, '.gitignore');
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
    if (GOODVIBES_IGNORE_PATTERN.test(existing)) return false; // already excluded
    const rule = '# goodvibes-tui transient state\n.goodvibes/\n';
    if (existing.length === 0) {
      writeFileSync(gitignorePath, rule);
      return true;
    }
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    appendFileSync(gitignorePath, separator + rule);
    return true;
  } catch {
    // Best-effort only, never block startup on a gitignore write failure.
    return false;
  }
}
