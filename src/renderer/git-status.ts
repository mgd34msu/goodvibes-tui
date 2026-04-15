import { GitService } from '../git/service.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

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
