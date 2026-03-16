import { existsSync } from 'fs';
import { join } from 'path';
import simpleGit from 'simple-git';
import { GitService } from '../git/service.ts';
import { logger } from '../utils/logger.ts';


/**
 * AgentWorktree — Manages git worktree lifecycle for spawned agents.
 *
 * Each agent works in an isolated git worktree so its file changes are
 * sandboxed from the main working tree.
 *
 * Lifecycle:
 *   create()  — create worktree + branch, return path
 *   merge()   — merge agent branch back to current branch, remove worktree
 *   cleanup() — remove worktree without merging (cancel/error path)
 */
export class AgentWorktree {
  private readonly git: GitService;

  constructor(cwd?: string) {
    this.git = new GitService(cwd ?? process.cwd());
  }

  /**
   * Create a new worktree for the given agent.
   * Returns the absolute path to the worktree directory.
   */
  async create(agentId: string): Promise<string> {
    const worktreePath = this._worktreePath(agentId);
    const branch = this._branchName(agentId);

    logger.debug('AgentWorktree.create', { agentId, worktreePath, branch });

    await this.git.worktreeAdd(worktreePath, branch);
    return worktreePath;
  }

  /**
   * Merge the agent's branch back into the current branch and remove the worktree.
   * Returns true if a merge was performed, false if no changes were found.
   */
  async merge(agentId: string): Promise<boolean> {
    const worktreePath = this._worktreePath(agentId);
    const branch = this._branchName(agentId);

    logger.debug('AgentWorktree.merge', { agentId, worktreePath, branch });

    // Check if the agent branch has any commits beyond base
    const hasChanges = await this._hasChanges(worktreePath, branch);
    if (!hasChanges) {
      logger.debug('AgentWorktree.merge: no changes, skipping merge', { agentId });
      await this._removeWorktree(worktreePath);
      await this._deleteBranch(branch);
      return false;
    }

    // Remove worktree first (required before merging the branch)
    await this._removeWorktree(worktreePath);

    // Merge the branch
    await this.git.merge(branch);

    // Clean up the agent branch
    await this._deleteBranch(branch);

    logger.debug('AgentWorktree.merge: complete', { agentId });
    return true;
  }

  /**
   * Remove the worktree without merging (cancel/error path).
   */
  async cleanup(agentId: string): Promise<void> {
    const worktreePath = this._worktreePath(agentId);
    const branch = this._branchName(agentId);

    logger.debug('AgentWorktree.cleanup', { agentId, worktreePath });

    if (existsSync(worktreePath)) {
      await this._removeWorktree(worktreePath);
    }

    await this._deleteBranch(branch).catch(() => {
      // Branch may not exist if create() never completed
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _worktreePath(agentId: string): string {
    return join(this.git.getCwd(), '.goodvibes', '.worktrees', `agent-${agentId}`);
  }

  private _branchName(agentId: string): string {
    return `agent/${agentId}`;
  }

  /**
   * Check whether the agent branch has any commits that differ from
   * the current branch (the main working tree HEAD).
   */
  private async _hasChanges(worktreePath: string, branch: string): Promise<boolean> {
    try {
      // Use a simple-git instance pointed at the worktree to check status
      const wgit = simpleGit({ baseDir: this.git.getCwd() });
      // Count commits on the branch that aren't on the current branch
      const result = await wgit.raw(['rev-list', '--count', `HEAD..${branch}`]);
      const count = parseInt(result.trim(), 10);
      return count > 0;
    } catch (err) {
      // If rev-list fails (e.g. brand-new worktree with no commits), treat as no changes
      logger.debug('AgentWorktree._hasChanges: rev-list failed, treating as no changes', { branch, error: String(err) });
      return false;
    }
  }

  /**
   * Force-remove a worktree directory.
   */
  private async _removeWorktree(worktreePath: string): Promise<void> {
    try {
      await this.git.worktreeRemove(worktreePath);
    } catch (err) {
      // Try with --force flag via raw if normal remove fails
      logger.debug('AgentWorktree._removeWorktree: first attempt failed, retrying with --force', { worktreePath, error: String(err) });
      try {
        const wgit = simpleGit({ baseDir: this.git.getCwd() });
        await wgit.raw(['worktree', 'remove', '--force', worktreePath]);
      } catch (err) {
        logger.error('AgentWorktree._removeWorktree failed', { worktreePath, error: String(err) });
        throw err;
      }
    }
  }

  /**
   * Delete a branch (no-op if it doesn't exist).
   */
  private async _deleteBranch(branch: string): Promise<void> {
    try {
      const wgit = simpleGit({ baseDir: this.git.getCwd() });
      await wgit.raw(['branch', '-D', branch]);
    } catch (err) {
      // Branch may not exist — that's fine
      logger.debug('AgentWorktree._deleteBranch: ignored error', { branch, error: String(err) });
    }
  }
}
