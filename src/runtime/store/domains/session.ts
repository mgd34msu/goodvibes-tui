/**
 * Session domain state — tracks the active TUI session lifecycle,
 * recovery machine state, lineage, and identity metadata.
 */

/** States for the session recovery machine. */
export type SessionRecoveryState =
  | 'loading'
  | 'repairing'
  | 'reconciling'
  | 'ready'
  | 'failed';

/** States representing overall session status. */
export type SessionStatus =
  | 'initializing'
  | 'active'
  | 'suspended'
  | 'terminating'
  | 'terminated';

/**
 * Snapshot of a session lineage entry, used for branching/resume tracking.
 */
export interface SessionLineageEntry {
  /** Session ID in the lineage chain. */
  sessionId: string;
  /** Timestamp when this lineage node was created. */
  createdAt: number;
  /** Optional parent session ID (undefined = root). */
  parentId?: string;
  /** Reason this session was branched or resumed. */
  branchReason?: 'resume' | 'fork' | 'repair' | 'compaction';
}

/**
 * SessionDomainState — full session context including recovery state machine.
 */
export interface SessionDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Identity ───────────────────────────────────────────────────────────────
  /** Unique session identifier (ulid/uuid). */
  id: string;
  /** Absolute path to the project root for this session. */
  projectRoot: string;
  /** Optional user identifier (from config or auth layer). */
  userId?: string;

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  /** Current overall session status. */
  status: SessionStatus;
  /** Epoch ms when the session was started. */
  startedAt: number;
  /** Epoch ms when the session ended (undefined while active). */
  endedAt?: number;

  // ── Recovery machine ───────────────────────────────────────────────────────
  /** Current state of the session recovery state machine. */
  recoveryState: SessionRecoveryState;
  /** Whether this session was resumed from a saved state. */
  isResumed: boolean;
  /** ID of the session that was resumed (undefined for fresh sessions). */
  resumedFromId?: string;
  /** Whether a compaction repair was applied during load. */
  wasRepaired: boolean;
  /** Error message if recoveryState === 'failed'. */
  recoveryError?: string;

  // ── Lineage ────────────────────────────────────────────────────────────────
  /** The root session ID in the lineage chain (equals id for root sessions). */
  lineageId: string;
  /** Ordered lineage history from root to current. */
  lineage: SessionLineageEntry[];

  // ── Compaction ─────────────────────────────────────────────────────────────
  /** Current state of the compaction lifecycle machine. */
  compactionState:
    | 'idle'
    | 'checking_threshold'
    | 'microcompact'
    | 'collapse'
    | 'autocompact'
    | 'reactive_compact'
    | 'boundary_commit'
    | 'done'
    | 'failed';
  /** Epoch ms of the last compaction run. */
  lastCompactedAt?: number;
  /** Number of messages at last compaction checkpoint. */
  compactionMessageCount?: number;
}

/**
 * Returns the default initial state for the session domain.
 */
export function createInitialSessionState(): SessionDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    id: '',
    projectRoot: '',
    userId: undefined,
    status: 'initializing',
    startedAt: 0,
    endedAt: undefined,
    recoveryState: 'loading',
    isResumed: false,
    resumedFromId: undefined,
    wasRepaired: false,
    recoveryError: undefined,
    lineageId: '',
    lineage: [],
    compactionState: 'idle',
    lastCompactedAt: undefined,
    compactionMessageCount: undefined,
  };
}
