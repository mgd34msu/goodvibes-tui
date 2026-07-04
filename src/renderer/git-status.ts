import { GitService } from '@pellux/goodvibes-sdk/platform/git';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

/** Git state shown in the header bar. */
export interface GitHeaderInfo {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

const FALLBACK: GitHeaderInfo = { branch: '?', dirty: false, ahead: 0, behind: 0 };

/**
 * GitStatusProvider — Fetches git state for the header bar.
 *
 * Results are cached for 2 seconds (TTL). The next call after expiry triggers
 * a fresh fetch and returns the cached value immediately (stale-while-revalidate).
 * Never throws — returns FALLBACK on any error.
 */
export class GitStatusProvider {
  private cache: GitHeaderInfo = { ...FALLBACK };
  private lastFetch = 0;
  private readonly ttlMs = 2000;
  private fetching = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly workingDirectory: string) {}

  /** Returns cached info immediately; refreshes in background if TTL expired. */
  async getStatus(): Promise<GitHeaderInfo> {
    const now = Date.now();
    if (now - this.lastFetch < this.ttlMs) {
      return this.cache;
    }
    // Fetch synchronously on first call (no cache yet), otherwise return stale
    if (this.lastFetch === 0) {
      await this._fetch().catch(() => {
        // Ensure fallback is set if _fetch failed before setting lastFetch
        if (this.lastFetch === 0) {
          this.lastFetch = Date.now();
        }
      });
    } else if (!this.fetching) {
      this._fetch().catch(err => { logger.debug('GitStatusProvider: background refresh failed', { error: summarizeError(err) }); });
    }
    return this.cache;
  }

  /** Force a fresh fetch and update the cache. Returns updated info. */
  async refresh(): Promise<GitHeaderInfo> {
    await this._fetch();
    return this.cache;
  }

  /**
   * Start a lightweight live-repo-state poll. Mirrors DiffPanel's principle of
   * never trusting a cached "is this a repo" flag (see diff-panel.ts
   * showGitDiff/showFileDiffs/showStagedDiff, all gated on a fresh
   * GitService.isGitRepo() check) but amortizes the cost for the header: the
   * cheap synchronous isGitRepo() spawn runs every tick; the heavier async
   * status()+branch() fetch (this.refresh()) only runs when that boolean
   * actually flips — e.g. an external `git init`, or `.git` removed.
   */
  startPolling(intervalMs: number, onChange: (info: GitHeaderInfo) => void): void {
    if (this.pollTimer !== null) return;
    const checkIsRepo = (): boolean | null => {
      try {
        return GitService.isGitRepo(this.workingDirectory);
      } catch (err) {
        logger.debug('GitStatusProvider: isGitRepo poll check failed', { error: summarizeError(err) });
        return null;
      }
    };
    let lastKnownIsRepo = checkIsRepo();
    this.pollTimer = setInterval(() => {
      const isRepoNow = checkIsRepo();
      if (isRepoNow !== null && isRepoNow !== lastKnownIsRepo) {
        lastKnownIsRepo = isRepoNow;
        this.refresh().then(onChange).catch((err) => {
          logger.debug('GitStatusProvider: poll-triggered refresh failed', { error: summarizeError(err) });
        });
      }
    }, intervalMs);
  }

  /** Stop the live-repo-state poll started by startPolling(). No-op if not polling. */
  stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async _fetch(): Promise<void> {
    if (this.fetching) return;
    this.fetching = true;
    try {
      const git = new GitService(this.workingDirectory);
      const [statusResult, branchResult] = await Promise.all([
        git.status(),
        git.branch(),
      ]);
      const dirty =
        statusResult.modified.length > 0 ||
        statusResult.created.length > 0 ||
        statusResult.deleted.length > 0 ||
        statusResult.renamed.length > 0 ||
        statusResult.conflicted.length > 0 ||
        statusResult.not_added.length > 0;
      this.cache = {
        branch: branchResult.current || '?',
        dirty,
        ahead: statusResult.ahead ?? 0,
        behind: statusResult.behind ?? 0,
      };
      this.lastFetch = Date.now();
    } catch {
      // Never throw — return fallback
      if (this.lastFetch === 0) {
        this.cache = { ...FALLBACK };
        this.lastFetch = Date.now();
      }
    } finally {
      this.fetching = false;
    }
  }
}
