/**
 * recall-files-git.ts — the synchronous git seam for memory file projection.
 *
 * `projectMemoryToFiles(records, dir, { git })` (SDK, platform/state) is a
 * pure synchronous function and its `MemoryProjectionGit` seam is declared
 * synchronous (`add(dir): void`, `commit(dir, message): void`) — it throws on
 * failure rather than returning a result. The TUI's existing git wrapper,
 * `GitService` (platform/git), is async (wraps simple-git), so it cannot
 * satisfy this seam directly. `GitService`'s own static helpers
 * (initRepo/isGitRepo/getRepoRoot) ARE synchronous, using `Bun.spawnSync`
 * directly (see service.ts) — this file follows the exact same convention
 * for `add`/`commit` so the seam matches the SDK's synchronous contract.
 */
import type { MemoryProjectionGit } from '@pellux/goodvibes-sdk/platform/state';
import { GitService } from '@pellux/goodvibes-sdk/platform/git';

function decode(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder().decode(bytes).trim() : '';
}

/**
 * Build a synchronous git seam rooted at `repoRoot`. `commit()` treats a
 * "nothing to commit" exit as a benign no-op (not an error) so
 * `/recall files sync` stays safely re-runnable when the projection files
 * did not actually change since the last sync — any OTHER commit failure
 * (no git identity configured, hook rejection, etc.) still throws, since the
 * seam's contract has no way to report partial failure back to the caller
 * other than throwing.
 */
export function createSyncGitSeam(repoRoot: string): MemoryProjectionGit {
  return {
    resolveToplevel(dir: string): string | null {
      return GitService.getRepoRoot(dir);
    },
    init(dir: string): void {
      const result = GitService.initRepo(dir);
      if (!result.success) {
        throw new Error(`git init failed: ${result.error ?? 'unknown error'}`);
      }
    },
    add(dir: string): void {
      const result = Bun.spawnSync(['git', 'add', dir], { cwd: repoRoot });
      if (result.exitCode !== 0) {
        throw new Error(`git add failed: ${decode(result.stderr) || 'unknown error'}`);
      }
    },
    commit(dir: string, message: string): void {
      const result = Bun.spawnSync(['git', 'commit', '-m', message, '--', dir], { cwd: repoRoot });
      if (result.exitCode === 0) return;
      const output = `${decode(result.stdout)} ${decode(result.stderr)}`;
      if (/nothing to commit/i.test(output)) return; // benign — no new/changed files this run
      throw new Error(`git commit failed: ${output.trim() || 'unknown error'}`);
    },
  };
}

/**
 * Resolve the git seam for `dir`, or null when `dir` is not inside a git
 * repository. Never auto-initializes a repository — that is a much bigger
 * side effect than a memory sync command should take unasked.
 */
export function resolveSyncGitSeam(dir: string): { seam: MemoryProjectionGit; repoRoot: string } | null {
  const repoRoot = GitService.getRepoRoot(dir);
  if (!repoRoot) return null;
  return { seam: createSyncGitSeam(repoRoot), repoRoot };
}
