/**
 * Discovery domain state — tracks the project index, file watcher state,
 * and language server availability for the active project.
 */

/** Status of the project index. */
export type IndexStatus = 'uninitialized' | 'indexing' | 'ready' | 'stale' | 'error';

/** A language server registration. */
export interface LanguageServerRecord {
  /** Language identifier (e.g. 'typescript', 'python'). */
  language: string;
  /** LSP server command. */
  command: string;
  /** Whether the server is currently running. */
  running: boolean;
  /** Server PID when running. */
  pid?: number;
  /** Whether the server is ready to handle requests. */
  ready: boolean;
  /** Epoch ms when the server started. */
  startedAt?: number;
  /** Last LSP error message. */
  lastError?: string;
}

/** File watcher status. */
export interface FileWatcherStatus {
  /** Whether the file watcher is active. */
  active: boolean;
  /** Number of paths being watched. */
  watchedPaths: number;
  /** Number of events received since session start. */
  eventCount: number;
  /** Epoch ms of the last file change event. */
  lastEventAt?: number;
}

/**
 * DiscoveryDomainState — project index, file watcher, and LSP state.
 */
export interface DiscoveryDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Project index ─────────────────────────────────────────────────────────
  /** Current project index status. */
  indexStatus: IndexStatus;
  /** Total number of files in the project index. */
  fileCount: number;
  /** Total number of directories indexed. */
  dirCount: number;
  /** Epoch ms of the last index completion. */
  lastIndexedAt?: number;
  /** Indexing duration in ms of the last run. */
  lastIndexDurationMs?: number;
  /** Error message if indexStatus === 'error'. */
  indexError?: string;

  // ── File watcher ──────────────────────────────────────────────────────────
  /** File watcher status. */
  fileWatcher: FileWatcherStatus;

  // ── Language servers ───────────────────────────────────────────────────────
  /** Language server records keyed by language identifier. */
  languageServers: Map<string, LanguageServerRecord>;
  /** Number of language servers currently running and ready. */
  activeServerCount: number;

  // ── Tree-sitter ──────────────────────────────────────────────────────────
  /** Whether the tree-sitter WASM runtime is loaded. */
  treeSitterReady: boolean;
  /** Languages with loaded tree-sitter grammars. */
  treeSitterLanguages: string[];
}

/**
 * Returns the default initial state for the discovery domain.
 */
export function createInitialDiscoveryState(): DiscoveryDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    indexStatus: 'uninitialized',
    fileCount: 0,
    dirCount: 0,
    lastIndexedAt: undefined,
    lastIndexDurationMs: undefined,
    indexError: undefined,
    fileWatcher: {
      active: false,
      watchedPaths: 0,
      eventCount: 0,
      lastEventAt: undefined,
    },
    languageServers: new Map(),
    activeServerCount: 0,
    treeSitterReady: false,
    treeSitterLanguages: [],
  };
}
