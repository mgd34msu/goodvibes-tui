import simpleGit, { type SimpleGit, type StatusResult } from 'simple-git';
import type { HookDispatcher } from '../hooks/dispatcher.ts';
import type { HookEvent } from '../hooks/types.ts';
import { logger } from '../utils/logger.ts';
import { summarizeError } from '../utils/error-display.ts';

/**
 * GitService — Wraps simple-git with hook emission on all mutating operations.
 *
 * Read-only operations (status, branch, log, diff, blame) do NOT emit hooks.
 * Mutating operations (commit, push, pull, merge, checkout, stash, worktreeAdd,
 * worktreeRemove) emit Pre:git:<op>, Post:git:<op>, and Fail:git:<op> events.
 */
export class GitService {
  private git: SimpleGit;
  private hooks: HookDispatcher | null;
  private cwd: string;

  constructor(cwd: string, hooks?: HookDispatcher) {
    this.cwd = cwd;
    this.hooks = hooks ?? null;
    this.git = simpleGit({ baseDir: this.cwd });
  }

  // ---------------------------------------------------------------------------
  // Hook emission helpers
  // ---------------------------------------------------------------------------

  private makeEvent(
    phase: 'Pre' | 'Post' | 'Fail',
    specific: string,
    payload: Record<string, unknown>,
  ): HookEvent {
    return {
      path: `${phase}:git:${specific}` as HookEvent['path'],
      phase,
      category: 'git',
      specific,
      sessionId: '',
      timestamp: Date.now(),
      payload,
    };
  }

  private async firePre(
    specific: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.hooks) return;
    const result = await this.hooks.fire(this.makeEvent('Pre', specific, payload));
    if (result.decision === 'deny') {
      throw new Error(`Git ${specific} blocked by hook: ${result.reason ?? 'no reason given'}`);
    }
  }

  private async firePost(
    specific: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.hooks) return;
    await this.hooks.fire(this.makeEvent('Post', specific, payload));
  }

  private async fireFail(
    specific: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.hooks) return;
    await this.hooks.fire(this.makeEvent('Fail', specific, payload));
  }

  // ---------------------------------------------------------------------------
  // Status & info (read-only — no hooks)
  // ---------------------------------------------------------------------------

  async status(): Promise<StatusResult> {
    return this.git.status();
  }

  async branch(): Promise<{ current: string; all: string[]; detached: boolean }> {
    const result = await this.git.branch();
    return {
      current: result.current,
      all: result.all,
      detached: result.detached,
    };
  }

  async log(
    maxCount = 20,
  ): Promise<Array<{ hash: string; date: string; message: string; author: string }>> {
    const result = await this.git.log({ maxCount });
    return result.all.map((entry) => ({
      hash: entry.hash,
      date: entry.date,
      message: entry.message,
      author: entry.author_name,
    }));
  }

  async diff(ref?: string): Promise<string> {
    if (ref) {
      return this.git.diff([ref]);
    }
    return this.git.diff();
  }

  /**
   * Get the diff for a single file, optionally from the staging area.
   * Read-only — no hooks emitted.
   */
  async diffFile(filePath: string, staged: boolean): Promise<string> {
    const args = staged
      ? ['diff', '--cached', '--', filePath]
      : ['diff', '--', filePath];
    return this.git.raw(args);
  }

  /**
   * Get the full diff between two refs, optionally scoped to specific files.
   * Read-only — no hooks emitted.
   */
  async diffBetween(before: string, after: string, files?: string[]): Promise<string> {
    const args = [before, after];
    if (files && files.length > 0) {
      args.push('--', ...files);
    }
    return this.git.diff(args);
  }

  /**
   * Get the --stat summary between two refs.
   * Read-only — no hooks emitted.
   */
  async diffStat(before: string, after: string): Promise<string> {
    return this.git.raw(['diff', '--stat', before, after]);
  }

  async blame(
    filePath: string,
  ): Promise<Array<{ hash: string; author: string; line: number; content: string }>> {
    const raw = await this.git.raw(['blame', '--porcelain', filePath]);
    const lines = raw.split('\n');
    const result: Array<{ hash: string; author: string; line: number; content: string }> = [];

    let currentHash = '';
    let currentAuthor = '';
    let currentLine = 0;

    for (const line of lines) {
      // Hash line: 40-char hex + original_line + final_line + num_lines
      if (/^[0-9a-f]{40}\s/.test(line)) {
        const parts = line.split(' ');
        currentHash = parts[0];
        currentLine = parseInt(parts[2] ?? parts[1], 10);
      } else if (line.startsWith('author ')) {
        currentAuthor = line.slice(7);
      } else if (line.startsWith('\t')) {
        result.push({
          hash: currentHash,
          author: currentAuthor,
          line: currentLine,
          content: line.slice(1),
        });
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Staging
  // ---------------------------------------------------------------------------

  async add(files: string | string[]): Promise<void> {
    await this.git.add(files);
  }

  async addAll(): Promise<void> {
    await this.git.raw(['add', '--all']);
  }

  async reset(files?: string | string[]): Promise<void> {
    if (files) {
      await this.git.reset(['HEAD', '--', ...(Array.isArray(files) ? files : [files])]);
    } else {
      await this.git.reset(['HEAD']);
    }
  }

  // ---------------------------------------------------------------------------
  // Commits
  // ---------------------------------------------------------------------------

  async commit(
    message: string,
    options?: { amend?: boolean; noVerify?: boolean },
  ): Promise<{ hash: string; summary: string }> {
    await this.firePre('commit', { message, options });
    try {
      const flags: string[] = [];
      if (options?.amend) flags.push('--amend');
      if (options?.noVerify) flags.push('--no-verify');

      // @ts-expect-error simple-git types do not expose the 3-arg commit signature
      const result = await this.git.commit(message, undefined, flags);
      const output = { hash: result.commit, summary: JSON.stringify(result.summary) };
      await this.firePost('commit', { message, ...output });
      return output;
    } catch (err) {
      await this.fireFail('commit', { message, error: summarizeError(err) });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Branches
  // ---------------------------------------------------------------------------

  async checkout(
    branch: string,
    options?: { create?: boolean },
  ): Promise<void> {
    await this.firePre('checkout', { branch, options });
    try {
      if (options?.create) {
        await this.git.checkoutLocalBranch(branch);
      } else {
        await this.git.checkout(branch);
      }
      await this.firePost('checkout', { branch });
    } catch (err) {
      await this.fireFail('checkout', { branch, error: summarizeError(err) });
      throw err;
    }
  }

  async merge(
    branch: string,
  ): Promise<{ success: boolean; conflicts?: string[] }> {
    await this.firePre('merge', { branch });
    try {
      await this.git.merge([branch]);
      await this.firePost('merge', { branch, success: true });
      return { success: true };
    } catch (err) {
      // simple-git throws on merge conflicts — only handle actual conflicts
      const message = summarizeError(err);
      if (!message.includes('CONFLICT')) {
        await this.fireFail('merge', { branch, error: message });
        throw err;
      }
      const conflicts = message
        .split('\n')
        .filter((l) => l.includes('CONFLICT'))
        .map((l) => l.replace(/^.*CONFLICT.*?:\s*/, '').trim())
        .filter(Boolean);

      await this.fireFail('merge', { branch, error: message, conflicts });
      return { success: false, conflicts };
    }
  }

  // ---------------------------------------------------------------------------
  // Remote
  // ---------------------------------------------------------------------------

  async push(
    remote = 'origin',
    branch?: string,
    options?: { force?: boolean },
  ): Promise<void> {
    await this.firePre('push', { remote, branch, options });
    try {
      const flags: string[] = [];
      if (options?.force) flags.push('--force');
      await this.git.push(remote, branch, flags);
      await this.firePost('push', { remote, branch });
    } catch (err) {
      await this.fireFail('push', { remote, branch, error: summarizeError(err) });
      throw err;
    }
  }

  async pull(
    remote = 'origin',
    branch?: string,
  ): Promise<void> {
    await this.firePre('pull', { remote, branch });
    try {
      await this.git.pull(remote, branch);
      await this.firePost('pull', { remote, branch });
    } catch (err) {
      await this.fireFail('pull', { remote, branch, error: summarizeError(err) });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Stash
  // ---------------------------------------------------------------------------

  async stash(
    action: 'push' | 'pop' | 'list' | 'drop' = 'push',
    message?: string,
  ): Promise<string> {
    const isReadOnly = action === 'list';
    if (!isReadOnly) await this.firePre('stash', { action, message });
    try {
      let result: string;
      switch (action) {
        case 'push': {
          const args = message ? ['push', '-m', message] : ['push'];
          result = await this.git.stash(args);
          break;
        }
        case 'pop':
          result = await this.git.stash(['pop']);
          break;
        case 'list':
          result = await this.git.stash(['list']);
          break;
        case 'drop':
          result = await this.git.stash(['drop']);
          break;
        default:
          result = '';
      }
      if (!isReadOnly) await this.firePost('stash', { action, result });
      return result;
    } catch (err) {
      if (!isReadOnly) await this.fireFail('stash', { action, error: summarizeError(err) });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Worktree (for agent isolation)
  // ---------------------------------------------------------------------------

  async worktreeAdd(path: string, branch: string): Promise<void> {
    await this.firePre('worktreeAdd', { path, branch });
    try {
      await this.git.raw(['worktree', 'add', path, '-b', branch]);
      await this.firePost('worktreeAdd', { path, branch });
    } catch (err) {
      await this.fireFail('worktreeAdd', { path, branch, error: summarizeError(err) });
      throw err;
    }
  }

  async worktreeRemove(path: string): Promise<void> {
    await this.firePre('worktreeRemove', { path });
    try {
      await this.git.raw(['worktree', 'remove', path]);
      await this.firePost('worktreeRemove', { path });
    } catch (err) {
      await this.fireFail('worktreeRemove', { path, error: summarizeError(err) });
      throw err;
    }
  }

  async worktreeList(): Promise<Array<{ path: string; branch: string; head: string }>> {
    const raw = await this.git.raw(['worktree', 'list', '--porcelain']);
    const entries = raw.trim().split('\n\n').filter(Boolean);
    return entries.map((block) => {
      const lines = block.split('\n');
      const worktreePath = lines.find((l) => l.startsWith('worktree '))?.slice(9) ?? '';
      const head = lines.find((l) => l.startsWith('HEAD '))?.slice(5) ?? '';
      const branchLine = lines.find((l) => l.startsWith('branch '));
      const branch = branchLine ? branchLine.slice(7).replace(/^refs\/heads\//, '') : '(detached)';
      return { path: worktreePath, branch, head };
    });
  }

  /**
   * Initialize a new git repository at the given path using Bun.spawnSync.
   * Returns true on success, false on failure.
   */
  static initRepo(cwd: string): { success: boolean; error?: string } {
    const result = Bun.spawnSync(['git', 'init', cwd]);
    if (result.exitCode === 0) {
      return { success: true };
    }
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : 'unknown error';
    return { success: false, error: stderr.trim() };
  }

  /**
   * Return true if the given directory is inside a git repository.
   * Uses `git rev-parse --git-dir` which exits 0 only inside a repo.
   */
  static isGitRepo(cwd: string): boolean {
    const result = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--git-dir']);
    return result.exitCode === 0;
  }

  static getRepoRoot(cwd: string): string | null {
    const result = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--show-toplevel']);
    if (result.exitCode !== 0 || !result.stdout) return null;
    const root = new TextDecoder().decode(result.stdout).trim();
    return root.length > 0 ? root : null;
  }

  /** Return the working directory this instance is bound to. */
  getCwd(): string {
    return this.cwd;
  }

  /** Release resources tied to this git client instance. */
  dispose(): void {
    logger.debug('GitService disposed', { cwd: this.cwd });
  }
}
