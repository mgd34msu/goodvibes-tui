/**
 * Remote Substrate — Core Types
 *
 * Implements v3 Sections 10.1–10.4: durable identity, handshake tokens,
 * typed transport messages, and replay configuration.
 */

import type { DaemonTransportState } from '../store/domains/daemon.ts';

// ── Transport State ───────────────────────────────────────────────────────────

/** Re-export the shared transport lifecycle state. */
export type { DaemonTransportState as RemoteTransportState };

// ── Durable Identity (Section 10.1) ──────────────────────────────────────────

/**
 * Globally unique, stable identity for a remote substrate session.
 *
 * These IDs are stable across reconnects — a new transport connection
 * to the same remote session reuses the same identifiers.
 */
export interface DurableIdentity {
  /** Globally unique session identifier, stable across reconnects. */
  readonly sessionId: string;
  /** Task identifier scoped to the current remote task, stable across reconnects. */
  readonly taskId: string;
  /** Agent identifier for this remote agent instance, stable across reconnects. */
  readonly agentId: string;
  /** Epoch ms when this identity was first created. */
  readonly createdAt: number;
  /** Monotonic generation counter — increments on each identity refresh (not reconnect). */
  readonly generation: number;
}

// ── Handshake Token (Section 10.2) ───────────────────────────────────────────

/**
 * Handshake token exchanged during reconnect negotiations.
 *
 * The token proves continuity with a prior session and carries the
 * epoch and last acknowledged message offset for replay.
 */
export interface HandshakeToken {
  /** The durable session ID this token represents. */
  readonly sessionId: string;
  /** Opaque token string issued by the remote server on initial connect. */
  readonly token: string;
  /** Epoch number — increments on each server restart. Server sets this. */
  readonly epoch: number;
  /** Epoch ms when this token was issued. */
  readonly issuedAt: number;
  /** Epoch ms when this token expires (0 = never). */
  readonly expiresAt: number;
}

// ── Replay Configuration (Section 10.2) ──────────────────────────────────────

/**
 * Configuration for replaying missed messages after a reconnect.
 */
export interface ReplayConfig {
  /**
   * The offset (sequence number) of the last acknowledged message.
   * The server will replay all messages with offset > lastAckedOffset.
   */
  readonly lastAckedOffset: number;
  /** Maximum number of messages to replay (0 = unlimited). */
  readonly maxReplayCount: number;
  /** Whether to enable replay on reconnect. */
  readonly enabled: boolean;
}

// ── Transport Messages (Section 10.3) ─────────────────────────────────────────

/** Message class discriminant. */
export type TransportMessageClass = 'control' | 'data' | 'ack' | 'failure';

/** Error category for failure classification and retry routing. */
export type TransportErrorCategory =
  | 'network'
  | 'timeout'
  | 'authentication'
  | 'protocol'
  | 'server'
  | 'client'
  | 'transient'
  | 'unknown';

/** Retry/backoff policy per message class or error category. */
export interface RetryPolicy {
  /** Maximum retry attempts (0 = no retries). */
  readonly maxAttempts: number;
  /** Initial delay in ms before first retry. */
  readonly initialDelayMs: number;
  /** Maximum delay in ms between retries. */
  readonly maxDelayMs: number;
  /** Backoff multiplier applied to delay on each attempt. */
  readonly backoffMultiplier: number;
  /** Jitter fraction 0–1 applied to computed delay to prevent thundering herds. */
  readonly jitter: number;
  /** Error categories that trigger retry. */
  readonly retryOn: readonly TransportErrorCategory[];
}

/**
 * Base fields present on every transport message.
 */
export interface TransportMessageBase {
  /** Message class discriminant. */
  readonly class: TransportMessageClass;
  /** Monotonically increasing message offset within a session. */
  readonly offset: number;
  /** Durable session ID this message belongs to. */
  readonly sessionId: string;
  /** Server epoch when this message was produced. */
  readonly epoch: number;
  /** Epoch ms when this message was created. */
  readonly ts: number;
  /** Idempotency key — same key on retry means server deduplicates. */
  readonly idempotencyKey: string;
}

/**
 * Discriminated union of all typed transport messages.
 * Enforces structural typing over raw string payloads.
 */
export type TransportMessage =
  | ControlMessage
  | DataMessage
  | AckMessage
  | FailureMessage;

// ── Specific message shapes (see transport-contract.ts for full definitions) ──

/** Forward-reference: control plane message shape. */
export interface ControlMessage extends TransportMessageBase {
  readonly class: 'control';
  readonly controlType: string;
  readonly payload: Record<string, unknown>;
}

/** Forward-reference: data plane message shape. */
export interface DataMessage extends TransportMessageBase {
  readonly class: 'data';
  readonly dataType: string;
  readonly payload: Record<string, unknown>;
}

/** Acknowledgement message. */
export interface AckMessage extends TransportMessageBase {
  readonly class: 'ack';
  /** Offset being acknowledged. */
  readonly ackedOffset: number;
}

/** Failure message. */
export interface FailureMessage extends TransportMessageBase {
  readonly class: 'failure';
  /** Error category for retry routing. */
  readonly errorCategory: TransportErrorCategory;
  /** Human-readable error message. */
  readonly error: string;
  /** Whether the failure is recoverable (triggers reconnect vs terminal failure). */
  readonly recoverable: boolean;
  /** Structured error context. */
  readonly context?: Record<string, unknown>;
}

// ── Remote Session (Section 10.4) ─────────────────────────────────────────────

/** Health status of a remote connection. */
export type RemoteConnectionHealth = 'healthy' | 'degraded' | 'unreachable';

/**
 * A mirrored remote task — subset of RuntimeTask fields synced from remote.
 */
export interface RemoteTask {
  /** Remote task ID (stable across reconnects). */
  readonly taskId: string;
  /** Remote agent ID owning this task. */
  readonly agentId: string;
  /** Human-readable task title. */
  readonly title: string;
  /** Current remote task status. */
  readonly status: 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  /** Epoch ms when the remote task was last updated. */
  readonly updatedAt: number;
  /** Progress value 0–100 (undefined if not reported). */
  readonly progress?: number;
  /** Error message if status === 'failed'. */
  readonly error?: string;
}

/**
 * Health snapshot from the remote substrate.
 */
export interface RemoteHealth {
  /** Overall health status of the remote substrate. */
  readonly status: RemoteConnectionHealth;
  /** Epoch ms of last health update. */
  readonly updatedAt: number;
  /** Round-trip latency in ms (undefined if not measured). */
  readonly latencyMs?: number;
  /** Remote server version string. */
  readonly serverVersion?: string;
  /** Human-readable degradation reason. */
  readonly degradedReason?: string;
}

/**
 * Full state of a remote substrate connection.
 */
export interface RemoteSession {
  /** Connection ID (local tracking ID, not stable across reconnects). */
  readonly connectionId: string;
  /** Durable identity stable across reconnects. */
  readonly identity: DurableIdentity;
  /** Remote endpoint URL or address. */
  readonly endpoint: string;
  /** Current transport state. */
  readonly transportState: DaemonTransportState;
  /** Current handshake token (undefined until first handshake). */
  readonly handshakeToken?: HandshakeToken;
  /** Replay configuration. */
  readonly replayConfig: ReplayConfig;
  /** Number of reconnect attempts since last successful connect. */
  readonly reconnectAttempts: number;
  /** Epoch ms of last successful connection. */
  readonly lastConnectedAt?: number;
  /** Last error message. */
  readonly lastError?: string;
  /** Remote tasks mirrored into local store. */
  readonly remoteTasks: ReadonlyMap<string, RemoteTask>;
  /** Latest remote health snapshot. */
  readonly health: RemoteHealth;
  /** Total messages sent this session. */
  readonly messagesSent: number;
  /** Total messages received this session. */
  readonly messagesReceived: number;
  /** Offset of last acknowledged message. */
  readonly lastAckedOffset: number;
}

// ── Substrate Config ─────────────────────────────────────────────────────────

/**
 * Configuration for creating a remote substrate instance.
 */
export interface RemoteSubstrateConfig {
  /** Remote endpoint URL. */
  readonly endpoint: string;
  /** Initial durable identity (caller supplies stable IDs). */
  readonly identity: DurableIdentity;
  /** Replay settings. */
  readonly replayConfig?: Partial<ReplayConfig>;
  /** Reconnect policy override. */
  readonly reconnectPolicy?: Partial<RetryPolicy>;
  /** Authentication credentials or token factory. */
  readonly authProvider?: AuthProvider;
}

/** Provides authentication tokens for transport handshakes. */
export interface AuthProvider {
  /**
   * Returns a bearer token or auth header value.
   * Called before each connect and reconnect attempt.
   */
  getToken(): Promise<string>;
  /** Optional revocation — called on terminal failure. */
  revokeToken?(): Promise<void>;
}
