/**
 * Git domain state — tracks the current repository status, staged/unstaged
 * changes, active branch, and recent commits.
 */

/** Git working tree file status codes. */
export type GitFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'ignored';

/** A single file's status in the working tree. */
export interface GitFileRecord {
  /** Relative file path from repo root. */
  path: string;
  /** Old path (only present for renames). */
  oldPath?: string;
  /** Working tree status. */
  workingStatus: GitFileStatus;
  /** Index (staged) status. */
  indexStatus: GitFileStatus;
  /** Whether the file is staged for commit. */
  staged: boolean;
}

/** A recent commit summary. */
export interface GitCommitSummary {
  /** Full commit hash. */
  hash: string;
  /** Short commit hash (7 chars). */
  shortHash: string;
  /** Commit message (first line). */
  message: string;
  /** Author name. */
  author: string;
  /** Commit timestamp (epoch ms). */
  timestamp: number;
}

/** Branch information. */
export interface GitBranchInfo {
  /** Current branch name. */
  name: string;
  /** Whether HEAD is detached. */
  detached: boolean;
  /** Remote tracking branch (if any). */
  upstream?: string;
  /** Number of commits ahead of upstream. */
  ahead: number;
  /** Number of commits behind upstream. */
  behind: number;
}

/**
 * GitDomainState — git repository status and change tracking.
 */
export interface GitDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Repository ────────────────────────────────────────────────────────────
  /** Whether the session's project root is a git repository. */
  isRepo: boolean;
  /** Absolute path to the repository root. */
  repoRoot?: string;

  // ── Branch ────────────────────────────────────────────────────────────────
  /** Current branch info (undefined if not a repo or not loaded). */
  branch?: GitBranchInfo;

  // ── Working tree ──────────────────────────────────────────────────────────
  /** All tracked changed files in the working tree. */
  changedFiles: GitFileRecord[];
  /** Count of staged files. */
  stagedCount: number;
  /** Count of unstaged modified/deleted files. */
  unstagedCount: number;
  /** Count of untracked files. */
  untrackedCount: number;
  /** Count of conflicted files. */
  conflictCount: number;

  // ── Commits ─────────────────────────────────────────────────────────────
  /** Recent commits (last 20). */
  recentCommits: GitCommitSummary[];
  /** Hash of the HEAD commit. */
  headCommitHash?: string;

  // ── Refresh ─────────────────────────────────────────────────────────────
  /** Epoch ms of the last git status refresh. */
  lastRefreshedAt?: number;
  /** Whether a git status refresh is in progress. */
  refreshing: boolean;
}

/**
 * Returns the default initial state for the git domain.
 */
export function createInitialGitState(): GitDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    isRepo: false,
    repoRoot: undefined,
    branch: undefined,
    changedFiles: [],
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictCount: 0,
    recentCommits: [],
    headCommitHash: undefined,
    lastRefreshedAt: undefined,
    refreshing: false,
  };
}
