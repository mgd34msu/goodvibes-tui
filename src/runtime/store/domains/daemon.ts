/**
 * Daemon domain state — tracks the goodvibes daemon process lifecycle
 * and IPC transport health.
 *
 * Note: The daemon is a separate long-running process that manages
 * background tasks, scheduling, and inter-session coordination.
 */

/**
 * States from the ACP/daemon transport lifecycle machine.
 * Shared with acp.ts since the daemon uses the same transport lifecycle.
 */
export type DaemonTransportState =
  | 'initializing'
  | 'authenticating'
  | 'connected'
  | 'syncing'
  | 'degraded'
  | 'reconnecting'
  | 'disconnected'
  | 'terminal_failure';

/** Daemon process information (when running). */
export interface DaemonProcessInfo {
  /** OS process ID of the daemon. */
  pid: number;
  /** Daemon version string. */
  version: string;
  /** Epoch ms when the daemon process started. */
  startedAt: number;
  /** IPC socket path or named pipe. */
  socketPath: string;
}

/** Status of a background job managed by the daemon. */
export interface DaemonJob {
  /** Job ID. */
  id: string;
  /** Job type identifier. */
  type: 'scheduled' | 'background_agent' | 'file_watch' | 'index_update' | 'compaction';
  /** Human-readable job label. */
  label: string;
  /** Whether the job is currently running. */
  running: boolean;
  /** Epoch ms of next scheduled run (for recurring jobs). */
  nextRunAt?: number;
  /** Epoch ms of last run. */
  lastRunAt?: number;
  /** Last run exit status. */
  lastStatus?: 'success' | 'failure' | 'skipped';
}

/**
 * DaemonDomainState — daemon process and IPC transport state.
 */
export interface DaemonDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Transport ─────────────────────────────────────────────────────────────
  /** Current transport lifecycle state. */
  transportState: DaemonTransportState;
  /** Whether the daemon process is currently running. */
  isRunning: boolean;
  /** Daemon process info (undefined if not connected). */
  processInfo?: DaemonProcessInfo;

  // ── Connection ──────────────────────────────────────────────────────────
  /** Number of reconnect attempts since last successful connection. */
  reconnectAttempts: number;
  /** Epoch ms of last successful connection. */
  lastConnectedAt?: number;
  /** Last IPC error message. */
  lastError?: string;

  // ── Jobs ─────────────────────────────────────────────────────────────────
  /** Background jobs registered with the daemon. */
  jobs: Map<string, DaemonJob>;
  /** Count of currently running daemon jobs. */
  runningJobCount: number;
}

/**
 * Returns the default initial state for the daemon domain.
 */
export function createInitialDaemonState(): DaemonDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    transportState: 'disconnected',
    isRunning: false,
    processInfo: undefined,
    reconnectAttempts: 0,
    lastConnectedAt: undefined,
    lastError: undefined,
    jobs: new Map(),
    runningJobCount: 0,
  };
}
