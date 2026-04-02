/**
 * ACP domain state — tracks the Agent Client Protocol transport layer,
 * active subagent connections, and inter-session ACP sessions.
 */

import type { DaemonTransportState } from './daemon.ts';

/** ACP transport state reuses the daemon transport lifecycle (v3 §4.8). */
export type AcpTransportState = DaemonTransportState;

/** An active ACP subagent connection. */
export interface AcpConnection {
  /** Subagent ID. */
  agentId: string;
  /** Human-readable label for this connection. */
  label: string;
  /** ACP transport state for this specific connection. */
  transportState: AcpTransportState;
  /** Epoch ms when the connection was established. */
  connectedAt?: number;
  /** Whether the subagent has completed and the connection is being torn down. */
  completing: boolean;
  /** Number of messages exchanged on this connection. */
  messageCount: number;
  /** Number of protocol errors on this connection. */
  errorCount: number;
  /** Last protocol error message. */
  lastError?: string;
  /** Task associated with this ACP connection. */
  taskId?: string;
}

/**
 * AcpDomainState — ACP protocol transport and connection state.
 */
export interface AcpDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Transport ─────────────────────────────────────────────────────────────
  /** Current ACP manager transport state. */
  managerTransportState: AcpTransportState;
  /** Whether the ACP subsystem has been initialized. */
  initialized: boolean;

  // ── Active connections ─────────────────────────────────────────────────────
  /** All ACP connections keyed by agentId. */
  connections: Map<string, AcpConnection>;
  /** IDs of active (non-completing) connections. */
  activeConnectionIds: string[];

  // ── Statistics ─────────────────────────────────────────────────────────────
  /** Total subagents spawned via ACP this session. */
  totalSpawned: number;
  /** Total ACP connections that completed successfully. */
  totalCompleted: number;
  /** Total ACP connections that failed. */
  totalFailed: number;
  /** Total messages exchanged across all connections. */
  totalMessages: number;
}

/**
 * Returns the default initial state for the ACP domain.
 */
export function createInitialAcpState(): AcpDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    managerTransportState: 'disconnected',
    initialized: false,
    connections: new Map(),
    activeConnectionIds: [],
    totalSpawned: 0,
    totalCompleted: 0,
    totalFailed: 0,
    totalMessages: 0,
  };
}
