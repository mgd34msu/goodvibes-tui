/**
 * Remote Substrate — Reconnect Engine
 *
 * Implements v3 Section 10.2: reconnect with handshake tokens, epoch tracking,
 * replay from last acknowledged offset, and idempotent command submission.
 *
 * The reconnect engine drives the transport state machine:
 *   disconnected → initializing → authenticating → connected → syncing → degraded
 *   → reconnecting → ... (retry loop)
 *   → terminal_failure (max attempts exceeded or non-retryable error)
 */

import type {
  HandshakeToken,
  ReplayConfig,
  RemoteSession,
  DurableIdentity,
  RetryPolicy,
  TransportErrorCategory,
  NegotiatedProtocol,
} from './types.ts';
import {
  CONTROL_RETRY_POLICY,
  computeRetryDelay,
  shouldRetry,
} from './transport-contract.ts';
import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger.ts';

/** Default reconnect policy. */
const DEFAULT_RECONNECT_POLICY: Readonly<RetryPolicy> = Object.freeze({
  ...CONTROL_RETRY_POLICY,
  maxAttempts: 10,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  retryOn: ['network', 'timeout', 'server', 'transient'] as const,
}) satisfies RetryPolicy;

/** Default replay configuration. */
const DEFAULT_REPLAY_CONFIG: Readonly<ReplayConfig> = Object.freeze({
  lastAckedOffset: 0,
  maxReplayCount: 500,
  enabled: true,
});

/** Outcome of a connect/reconnect attempt. */
export type ConnectOutcome =
  | {
      readonly success: true;
      readonly token: HandshakeToken;
      readonly epoch: number;
      readonly replayFromOffset: number;
      /** Negotiated protocol agreed during handshake. */
      readonly negotiatedProtocol: NegotiatedProtocol;
    }
  | {
      readonly success: false;
      readonly category: TransportErrorCategory;
      readonly error: string;
      readonly retryable: boolean;
      /**
       * Incompatibility code when the failure is due to version mismatch.
       * Absent for auth/network failures.
       */
      readonly incompatibilityCode?:
        | 'major_version_mismatch'
        | 'peer_version_too_old'
        | 'peer_version_unsupported';
    };

/**
 * Adapter interface — callers implement the actual transport operations.
 *
 * The reconnect engine delegates real I/O to this adapter, keeping itself
 * transport-agnostic (WebSocket, HTTP, stdio all implement the same adapter).
 */
export interface TransportAdapter {
  /**
   * Attempt to establish a connection and perform the handshake.
   *
   * Implementations must:
   * 1. Open the transport channel
   * 2. Send HANDSHAKE_INIT with identity, epoch, lastAckedOffset, authToken,
   *    and the local `protocolVersion` from CURRENT_PROTOCOL_VERSION
   * 3. Wait for HANDSHAKE_ACCEPT or HANDSHAKE_REJECT
   * 4. On HANDSHAKE_ACCEPT, extract `negotiatedProtocol` and return it in the outcome
   * 5. On HANDSHAKE_REJECT with an `incompatibilityCode`, return success=false with
   *    that code — the engine will treat it as a terminal (non-retryable) failure
   *
   * @param identity - Stable durable identity to present.
   * @param lastAckedOffset - Offset to replay from.
   * @param authToken - Bearer token from the AuthProvider.
   * @returns ConnectOutcome — success with token+negotiatedProtocol or failure with category.
   */
  connect(
    identity: DurableIdentity,
    lastAckedOffset: number,
    authToken: string,
  ): Promise<ConnectOutcome>;

  /** Disconnect the transport cleanly. */
  disconnect(): Promise<void>;

  /**
   * Called after a successful handshake to replay messages since lastAckedOffset.
   * The adapter fetches and delivers replayed messages via its normal receive path.
   */
  requestReplay(fromOffset: number, maxCount: number): Promise<void>;
}

/** Lifecycle event callbacks fired by the reconnect engine. */
export interface ReconnectEngineCallbacks {
  /** Called when version negotiation produces a downgrade. Incompatible = terminal failure. */
  onVersionNegotiated?(protocol: NegotiatedProtocol): void;
  /** Called when the transport enters 'initializing'. */
  onInitializing?(attempt: number): void;
  /** Called when authentication is in progress. */
  onAuthenticating?(): void;
  /** Called when the connection is successfully established. */
  onConnected(token: HandshakeToken, epoch: number): void;
  /** Called when state sync is in progress after connect. */
  onSyncing?(): void;
  /** Called when a reconnect attempt is scheduled. */
  onReconnecting?(attempt: number, maxAttempts: number, delayMs: number): void;
  /** Called when the transport is disconnected (willRetry indicates intent). */
  onDisconnected?(reason?: string, willRetry?: boolean): void;
  /** Called when all retries are exhausted — terminal failure. */
  onTerminalFailure(error: string): void;
}

/**
 * ReconnectEngine — manages the full reconnect lifecycle with backoff and replay.
 *
 * Usage:
 * ```ts
 * const engine = new ReconnectEngine(adapter, identity, replayConfig, callbacks);
 * await engine.connect(); // blocks until connected or terminal failure
 * // After a failure detected externally:
 * await engine.reconnect(); // drives the retry loop
 * engine.dispose(); // cancel any pending reconnect
 * ```
 */
export class ReconnectEngine {
  private readonly _policy: Readonly<RetryPolicy>;
  private readonly _replay: Readonly<ReplayConfig>;
  private _handshakeToken: HandshakeToken | undefined;
  private _epoch = 0;
  private _lastAckedOffset: number;
  private _attempts = 0;
  private _disposed = false;
  private _pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Negotiated protocol from the last successful handshake. */
  private _negotiatedProtocol: NegotiatedProtocol | undefined;

  constructor(
    private readonly adapter: TransportAdapter,
    private readonly identity: DurableIdentity,
    replayConfig?: Partial<ReplayConfig>,
    private readonly callbacks?: ReconnectEngineCallbacks,
    reconnectPolicy?: Partial<RetryPolicy>,
  ) {
    this._policy = reconnectPolicy
      ? Object.freeze({ ...DEFAULT_RECONNECT_POLICY, ...reconnectPolicy })
      : DEFAULT_RECONNECT_POLICY;
    this._replay = replayConfig
      ? Object.freeze({ ...DEFAULT_REPLAY_CONFIG, ...replayConfig })
      : DEFAULT_REPLAY_CONFIG;
    this._lastAckedOffset = this._replay.lastAckedOffset;
  }

  /** Current handshake token (undefined until first successful connect). */
  get handshakeToken(): HandshakeToken | undefined {
    return this._handshakeToken;
  }

  /** Current server epoch. */
  get epoch(): number {
    return this._epoch;
  }

  /** Offset of the last acknowledged message. */
  get lastAckedOffset(): number {
    return this._lastAckedOffset;
  }

  /** Number of reconnect attempts since last successful connect. */
  get attempts(): number {
    return this._attempts;
  }

  /**
   * The negotiated protocol from the last successful handshake.
   * Undefined until the first successful connect.
   */
  get negotiatedProtocol(): NegotiatedProtocol | undefined {
    return this._negotiatedProtocol;
  }

  /**
   * Update the last acknowledged offset.
   * Call this whenever an ack is sent or a message is durably processed.
   *
   * @param offset - The offset to record as acknowledged.
   */
  ackOffset(offset: number): void {
    if (offset > this._lastAckedOffset) {
      this._lastAckedOffset = offset;
    }
  }

  /**
   * Perform the initial connect attempt.
   *
   * @param authToken - Bearer token from the AuthProvider.
   * @returns True on success, false on terminal failure.
   */
  async connect(authToken: string): Promise<boolean> {
    if (this._disposed) return false;
    return this._attemptConnect(authToken, false);
  }

  /**
   * Drive the reconnect retry loop.
   *
   * Attempts reconnection up to `policy.maxAttempts` times using
   * exponential backoff with jitter. Calls callbacks at each state transition.
   *
   * @param getAuthToken - Called before each attempt to get a fresh token.
   * @returns True if eventually connected, false on terminal failure.
   */
  async reconnect(getAuthToken: () => Promise<string>): Promise<boolean> {
    if (this._disposed) return false;

    while (this._attempts < this._policy.maxAttempts) {
      if (this._disposed) return false;

      this._attempts++;
      const delayMs = computeRetryDelay(this._policy, this._attempts);

      this.callbacks?.onReconnecting?.(
        this._attempts,
        this._policy.maxAttempts,
        delayMs,
      );

      logger.debug('ReconnectEngine: scheduling reconnect attempt', {
        attempt: this._attempts,
        maxAttempts: this._policy.maxAttempts,
        delayMs,
      });

      await this._sleep(delayMs);
      if (this._disposed) return false;

      const authToken = await getAuthToken();
      const connected = await this._attemptConnect(authToken, true);
      if (connected) {
        this._attempts = 0;
        return true;
      }

      // If not connected and not retryable, terminal failure was already signalled
    }

    const error = `ReconnectEngine: max reconnect attempts (${this._policy.maxAttempts}) exceeded`;
    logger.error(error);
    this.callbacks?.onTerminalFailure(error);
    return false;
  }

  /** Cancel any pending reconnect timer and mark engine as disposed. */
  dispose(): void {
    this._disposed = true;
    if (this._pendingTimer !== null) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _attemptConnect(authToken: string, isReconnect: boolean): Promise<boolean> {
    if (this._disposed) return false;

    this.callbacks?.onInitializing?.(this._attempts);
    this.callbacks?.onAuthenticating?.();

    const outcome = await this.adapter.connect(
      this.identity,
      this._lastAckedOffset,
      authToken,
    );

    if (!outcome.success) {
      // Version incompatibility is always terminal — never retry
      if (outcome.incompatibilityCode) {
        logger.error('ReconnectEngine: incompatible peer version — terminal failure', {
          error: outcome.error,
          incompatibilityCode: outcome.incompatibilityCode,
        });
        if (this._disposed) return false;
        this.callbacks?.onTerminalFailure(outcome.error);
        return false;
      }

      const retryable = outcome.retryable && shouldRetry(this._policy, outcome.category);
      logger.warn('ReconnectEngine: connect attempt failed', {
        error: outcome.error,
        category: outcome.category,
        retryable,
        isReconnect,
      });

      if (!retryable) {
        this.callbacks?.onTerminalFailure(outcome.error);
        return false;
      }

      this.callbacks?.onDisconnected?.(outcome.error, true);
      return false;
    }

    // Success path
    const { token, epoch, replayFromOffset, negotiatedProtocol } = outcome;
    this._epoch = epoch;
    this._handshakeToken = token;
    this._negotiatedProtocol = negotiatedProtocol;

    if (this.callbacks?.onVersionNegotiated) {
      this.callbacks.onVersionNegotiated(negotiatedProtocol);
    }

    this.callbacks?.onConnected(token, epoch);

    // Trigger replay if enabled and the server offers messages to replay
    if (this._replay.enabled && replayFromOffset > 0) {
      this.callbacks?.onSyncing?.();
      try {
        await this.adapter.requestReplay(
          replayFromOffset,
          this._replay.maxReplayCount,
        );
      } catch (err) {
        // Replay failure is non-fatal — degraded mode, not terminal
        logger.warn('ReconnectEngine: replay request failed (degraded mode)', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.debug('ReconnectEngine: connected successfully', {
      sessionId: this.identity.sessionId,
      epoch,
      lastAckedOffset: this._lastAckedOffset,
    });

    return true;
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this._pendingTimer = setTimeout(() => {
        this._pendingTimer = null;
        resolve();
      }, ms);
    });
  }
}

/**
 * Generate an idempotent submission key for a command.
 *
 * The key combines the session ID with a random UUID so that retried
 * submissions with the same key can be deduplicated by the server.
 *
 * @param sessionId - Durable session ID.
 * @returns A stable key string for use as `idempotencyKey`.
 */
export function generateIdempotencyKey(sessionId: string): string {
  return `${sessionId}:${randomUUID()}`;
}
