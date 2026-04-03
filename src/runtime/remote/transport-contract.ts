/**
 * Remote Substrate — Transport Contract
 *
 * Implements v3 Section 10.3: typed message definitions for control/data/ack/failure
 * message classes with retry/backoff policies per class.
 *
 * This module defines the full structural contract for all messages that cross
 * the remote transport boundary. No raw strings — all messages are typed.
 */
import { logger } from '../../utils/logger.ts';

import { randomUUID } from 'node:crypto';
import type {
  ControlMessage,
  DataMessage,
  AckMessage,
  FailureMessage,
  TransportMessageBase,
  RetryPolicy,
  TransportErrorCategory,
  ProtocolVersion,
  CompatibilityMatrix,
  CompatibilityEntry,
  VersionNegotiationResult,
  NegotiatedProtocol,
  DowngradeReason,
} from './types.ts';

// ── Default retry policies per message class ──────────────────────────────────

/**
 * Default retry policy for control plane messages.
 * Control messages (handshake, ping, config) use aggressive retry with
 * short initial delay since they are small and critical.
 */
export const CONTROL_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 5,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  backoffMultiplier: 2,
  jitter: 0.15,
  retryOn: ['network', 'timeout', 'transient'] as const,
}) satisfies RetryPolicy;

/**
 * Default retry policy for data plane messages.
 * Data messages carry task payloads and need reliable delivery with
 * longer backoff to avoid overwhelming a recovering server.
 */
export const DATA_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 8,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2.5,
  jitter: 0.2,
  retryOn: ['network', 'timeout', 'server', 'transient'] as const,
}) satisfies RetryPolicy;

/**
 * Default retry policy for ack messages.
 * Acks are best-effort; fewer retries since missing acks trigger replay.
 */
export const ACK_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 2_000,
  backoffMultiplier: 2,
  jitter: 0.1,
  retryOn: ['network', 'timeout'] as const,
}) satisfies RetryPolicy;

/**
 * Default retry policy for failure messages.
 * Failure reports are fire-and-forget; minimal retry.
 */
export const FAILURE_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 2,
  initialDelayMs: 100,
  maxDelayMs: 1_000,
  backoffMultiplier: 2,
  jitter: 0.05,
  retryOn: ['network'] as const,
}) satisfies RetryPolicy;

// ── Protocol Version Constants ───────────────────────────────────────────────

/**
 * The current protocol version implemented by this build.
 *
 * Increment major on breaking wire changes, minor on additive features,
 * patch on bug fixes that do not affect the wire contract.
 */
export const CURRENT_PROTOCOL_VERSION: Readonly<ProtocolVersion> = Object.freeze({
  major: 1,
  minor: 2,
  patch: 0,
  label: '1.2.0',
});

/**
 * Compatibility matrix for v1.x of the transport protocol.
 *
 * Each entry records the minor-version range the local build can interoperate
 * with for a given local version. Major version must always match exactly.
 *
 * Policy:
 * - Peers advertising minor < minSupportedMinor are rejected (too old).
 * - Peers advertising minor > maxSupportedMinor are accepted; we downgrade to
 *   the peer's level (peer is newer — they offer a superset of our features).
 * - Peers advertising the same minor connect at full capability.
 */
export const TRANSPORT_COMPATIBILITY_MATRIX: CompatibilityMatrix = Object.freeze([
  Object.freeze<CompatibilityEntry>({
    localVersion: CURRENT_PROTOCOL_VERSION,
    minSupportedMinor: 0,
    maxSupportedMinor: 2,
    notes: 'v1.2: version negotiation; supports peers v1.0–v1.2',
  }),
  Object.freeze<CompatibilityEntry>({
    localVersion: Object.freeze<ProtocolVersion>({ major: 1, minor: 1, patch: 0, label: '1.1.0' }),
    minSupportedMinor: 0,
    maxSupportedMinor: 2,
    notes: 'v1.1: replay protocol; accepts peers v1.0–v1.2 (v1.2 peer downgraded to 1.1)',
  }),
  Object.freeze<CompatibilityEntry>({
    localVersion: Object.freeze<ProtocolVersion>({ major: 1, minor: 0, patch: 0, label: '1.0.0' }),
    minSupportedMinor: 0,
    maxSupportedMinor: 2,
    notes: 'v1.0: initial typed messages; accepts peers v1.0–v1.2 (newer peers downgraded to 1.0)',
  }),
]);

/**
 * VersionMismatchError — thrown (or returned as failure) when a peer presents
 * an incompatible protocol version and the handshake must be rejected.
 *
 * Carries the structured incompatibility details so callers can log,
 * surface diagnostics, and produce a typed HANDSHAKE_REJECT payload.
 */
export class VersionMismatchError extends Error {
  public readonly code:
    | 'major_version_mismatch'
    | 'peer_version_too_old'
    | 'peer_version_unsupported';
  public readonly offeredVersion: Readonly<ProtocolVersion>;
  public readonly peerVersion: Readonly<ProtocolVersion>;

  constructor(
    code: 'major_version_mismatch' | 'peer_version_too_old' | 'peer_version_unsupported',
    offeredVersion: Readonly<ProtocolVersion>,
    peerVersion: Readonly<ProtocolVersion>,
    message: string,
  ) {
    super(message);
    this.name = 'VersionMismatchError';
    this.code = code;
    this.offeredVersion = offeredVersion;
    this.peerVersion = peerVersion;
  }
}

/**
 * Negotiate a protocol version between this peer and a remote peer.
 *
 * Rules:
 * 1. Major versions must match exactly — a mismatch is always incompatible.
 * 2. Find the compatibility entry for the local version in the matrix.
 * 3. Peer minor below `minSupportedMinor` → incompatible (peer too old).
 * 4. Peer minor equal to local minor → full capability, no downgrade.
 * 5. Peer minor above local minor → downgrade to local (we are the older peer).
 * 6. Peer minor in (local, maxSupportedMinor] → downgrade to peer (peer is newer).
 *
 * Incompatible peers CANNOT proceed — callers must reject the handshake.
 *
 * @param localVersion - The version this side is running.
 * @param peerVersion - The version the remote peer advertised.
 * @param matrix - The compatibility matrix to look up against.
 * @returns A VersionNegotiationResult — check `proceed` before allowing the session.
 */
export function negotiateProtocolVersion(
  localVersion: Readonly<ProtocolVersion>,
  peerVersion: Readonly<ProtocolVersion>,
  matrix: CompatibilityMatrix = TRANSPORT_COMPATIBILITY_MATRIX,
): VersionNegotiationResult {
  // Rule 1: Major mismatch → always incompatible
  if (localVersion.major !== peerVersion.major) {
    return {
      proceed: false,
      incompatibilityCode: 'major_version_mismatch',
      incompatibilityReason:
        `Major version mismatch: local=${localVersion.label} peer=${peerVersion.label}. ` +
        `Peers on different major versions cannot interoperate.`,
      offeredVersion: localVersion,
      peerVersion,
    };
  }

  // Find the compatibility entry for the local version
  const entry = matrix.find(
    (e) =>
      e.localVersion.major === localVersion.major &&
      e.localVersion.minor === localVersion.minor,
  );

  // If no entry, treat all same-major peers as compatible (conservative default)
  if (!entry) {
    logger.warn('CompatibilityMatrix: no entry found for local version — falling back to conservative defaults', {
      localVersion: localVersion.label,
    });
  }
  const minMinor = entry?.minSupportedMinor ?? 0;
  const maxMinor = entry?.maxSupportedMinor ?? localVersion.minor;

  // Rule 3: Peer minor too old → reject
  if (peerVersion.minor < minMinor) {
    return {
      proceed: false,
      incompatibilityCode: 'peer_version_too_old',
      incompatibilityReason:
        `Peer version ${peerVersion.label} is below the minimum supported minor ` +
        `version ${localVersion.major}.${minMinor}.x for local ${localVersion.label}. ` +
        `Upgrade the peer to proceed.`,
      offeredVersion: localVersion,
      peerVersion,
    };
  }

  // Rule 6: Peer minor exceeds our matrix max → unsupported future version
  if (peerVersion.minor > maxMinor) {
    return {
      proceed: false,
      incompatibilityCode: 'peer_version_unsupported',
      incompatibilityReason:
        `Peer version ${peerVersion.label} exceeds the maximum supported minor ` +
        `version ${localVersion.major}.${maxMinor}.x for local ${localVersion.label}. ` +
        `Upgrade the local build to connect to this peer.`,
      offeredVersion: localVersion,
      peerVersion,
    };
  }

  // Rules 4 & 5: Negotiate to the lower of the two minor versions
  const agreedMinor = Math.min(localVersion.minor, peerVersion.minor);
  const agreedPatch = agreedMinor === localVersion.minor ? localVersion.patch : 0;
  const downgraded = agreedMinor < localVersion.minor;
  const downgradeReason: DowngradeReason | undefined = downgraded ? 'peer_minor_older' : undefined;

  const agreedVersion: ProtocolVersion = Object.freeze({
    major: localVersion.major,
    minor: agreedMinor,
    patch: agreedPatch,
    label: `${localVersion.major}.${agreedMinor}.${agreedPatch}`,
  });

  const protocol: NegotiatedProtocol = Object.freeze({
    version: agreedVersion,
    downgraded,
    downgradeReason,
    offeredVersion: localVersion,
    peerVersion,
    negotiatedAt: Date.now(),
  });

  return { proceed: true, protocol };
}

// ── Control message subtypes ──────────────────────────────────────────────────

/** Control message type literals. */
export type ControlMessageType =
  | 'HANDSHAKE_INIT'
  | 'HANDSHAKE_ACCEPT'
  | 'HANDSHAKE_REJECT'
  | 'PING'
  | 'PONG'
  | 'CONFIG_SYNC'
  | 'SHUTDOWN';

/** Payload shapes per control message type. */
export interface ControlPayloads {
  HANDSHAKE_INIT: {
    readonly sessionId: string;
    readonly agentId: string;
    readonly taskId: string;
    readonly epoch: number;
    readonly lastAckedOffset: number;
    readonly authToken: string;
    /** Semver label of the protocol version the client offers (e.g. "1.2.0"). */
    readonly clientVersion: string;
    /** Structured version object for server-side compatibility matrix lookup. */
    readonly protocolVersion: ProtocolVersion;
  };
  HANDSHAKE_ACCEPT: {
    readonly sessionId: string;
    readonly epoch: number;
    readonly serverVersion: string;
    readonly handshakeToken: string;
    readonly expiresAt: number;
    readonly replayFromOffset: number;
    /** The negotiated protocol version both peers will use for this session. */
    readonly negotiatedProtocol: NegotiatedProtocol;
  };
  HANDSHAKE_REJECT: {
    readonly reason: string;
    readonly retryable: boolean;
    /**
     * Structured incompatibility code when the reject is due to version mismatch.
     * Absent for auth/quota/other rejections.
     */
    readonly incompatibilityCode?:
      | 'major_version_mismatch'
      | 'peer_version_too_old'
      | 'peer_version_unsupported';
    /** The peer's offered version, echoed back for diagnostics. */
    readonly peerVersion?: ProtocolVersion;
    /** The server's offered version, for operator diagnostics. */
    readonly serverVersion?: ProtocolVersion;
  };
  PING: Record<string, never>;
  PONG: { readonly serverTimeMs: number };
  CONFIG_SYNC: { readonly config: Record<string, unknown> };
  SHUTDOWN: { readonly graceful: boolean; readonly reason?: string };
}

// ── Data message subtypes ─────────────────────────────────────────────────────

/** Data message type literals. */
export type DataMessageType =
  | 'TASK_SUBMIT'
  | 'TASK_CANCEL'
  | 'TASK_UPDATE'
  | 'AGENT_SPAWN'
  | 'AGENT_UPDATE'
  | 'AGENT_TERMINATE'
  | 'HEALTH_REPORT'
  | 'STATE_SNAPSHOT';

/** Payload shapes per data message type. */
export interface DataPayloads {
  TASK_SUBMIT: {
    readonly taskId: string;
    readonly agentId: string;
    readonly title: string;
    readonly description?: string;
    readonly payload: Record<string, unknown>;
  };
  TASK_CANCEL: {
    readonly taskId: string;
    readonly reason?: string;
  };
  TASK_UPDATE: {
    readonly taskId: string;
    readonly status: string;
    readonly progress?: number;
    readonly message?: string;
    readonly error?: string;
  };
  AGENT_SPAWN: {
    readonly agentId: string;
    readonly taskId: string;
    readonly role: string;
  };
  AGENT_UPDATE: {
    readonly agentId: string;
    readonly state: string;
    readonly message?: string;
  };
  AGENT_TERMINATE: {
    readonly agentId: string;
    readonly reason?: string;
  };
  HEALTH_REPORT: {
    readonly status: string;
    readonly latencyMs?: number;
    readonly serverVersion?: string;
    readonly degradedReason?: string;
  };
  STATE_SNAPSHOT: {
    readonly tasks: Array<Record<string, unknown>>;
    readonly health: Record<string, unknown>;
    readonly epoch: number;
  };
}

// ── Message factory helpers ───────────────────────────────────────────────────

/**
 * Builds the shared base fields for a transport message.
 *
 * @param sessionId - Durable session ID.
 * @param epoch - Server epoch.
 * @param offset - Message offset (caller manages monotonic counter).
 * @returns Frozen base fields.
 */
function buildBase(
  sessionId: string,
  epoch: number,
  offset: number,
): Omit<TransportMessageBase, 'class'> {
  return Object.freeze({
    offset,
    sessionId,
    epoch,
    ts: Date.now(),
    idempotencyKey: randomUUID(),
  });
}

/**
 * Create a typed control message.
 *
 * @param controlType - The control message subtype.
 * @param payload - The typed payload matching the control type.
 * @param sessionId - Durable session ID.
 * @param epoch - Server epoch at time of creation.
 * @param offset - Monotonic offset within the session.
 * @returns A frozen ControlMessage.
 */
export function createControlMessage<T extends ControlMessageType>(
  controlType: T,
  payload: ControlPayloads[T],
  sessionId: string,
  epoch: number,
  offset: number,
): Readonly<ControlMessage> {
  return Object.freeze({
    class: 'control' as const,
    controlType,
    // Cast to wire-format Record — call sites are fully type-safe via ControlPayloads[T]
    payload: payload as Record<string, unknown>,
    ...buildBase(sessionId, epoch, offset),
  });
}

/**
 * Create a typed data message.
 *
 * @param dataType - The data message subtype.
 * @param payload - The typed payload matching the data type.
 * @param sessionId - Durable session ID.
 * @param epoch - Server epoch at time of creation.
 * @param offset - Monotonic offset within the session.
 * @returns A frozen DataMessage.
 */
export function createDataMessage<T extends DataMessageType>(
  dataType: T,
  payload: DataPayloads[T],
  sessionId: string,
  epoch: number,
  offset: number,
): Readonly<DataMessage> {
  return Object.freeze({
    class: 'data' as const,
    dataType,
    // Cast to wire-format Record — call sites are fully type-safe via DataPayloads[T]
    payload: payload as Record<string, unknown>,
    ...buildBase(sessionId, epoch, offset),
  });
}

/**
 * Create an acknowledgement message.
 *
 * @param ackedOffset - The offset being acknowledged.
 * @param sessionId - Durable session ID.
 * @param epoch - Server epoch at time of creation.
 * @param offset - Monotonic offset of this ack message.
 * @returns A frozen AckMessage.
 */
export function createAckMessage(
  ackedOffset: number,
  sessionId: string,
  epoch: number,
  offset: number,
): Readonly<AckMessage> {
  return Object.freeze({
    class: 'ack' as const,
    ackedOffset,
    ...buildBase(sessionId, epoch, offset),
  });
}

/**
 * Create a failure message.
 *
 * @param error - Human-readable error description.
 * @param errorCategory - Error category for retry routing.
 * @param recoverable - Whether the remote substrate can recover.
 * @param sessionId - Durable session ID.
 * @param epoch - Server epoch at time of creation.
 * @param offset - Monotonic offset of this failure message.
 * @param context - Optional structured error context.
 * @returns A frozen FailureMessage.
 */
export function createFailureMessage(
  error: string,
  errorCategory: TransportErrorCategory,
  recoverable: boolean,
  sessionId: string,
  epoch: number,
  offset: number,
  context?: Record<string, unknown>,
): Readonly<FailureMessage> {
  return Object.freeze({
    class: 'failure' as const,
    error,
    errorCategory,
    recoverable,
    context,
    ...buildBase(sessionId, epoch, offset),
  });
}

// ── Retry delay calculator ────────────────────────────────────────────────────

/**
 * Compute the delay in ms before the next retry attempt.
 *
 * Applies exponential backoff with configurable jitter to spread retries
 * and avoid thundering herds.
 *
 * @param policy - The retry policy to apply.
 * @param attempt - Current attempt number (1-indexed).
 * @returns Delay in ms, capped at policy.maxDelayMs.
 */
export function computeRetryDelay(
  policy: RetryPolicy,
  attempt: number,
  rng: () => number = Math.random,
): number {
  const base = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attempt - 1);
  const capped = Math.min(base, policy.maxDelayMs);
  const jitterMs = capped * policy.jitter * (rng() * 2 - 1);
  return Math.max(0, Math.round(capped + jitterMs));
}

/**
 * Determine whether a given error category should trigger a retry
 * according to the supplied policy.
 *
 * @param policy - The retry policy to check.
 * @param category - The error category to test.
 * @returns True if the policy retries on this category.
 */
export function shouldRetry(
  policy: RetryPolicy,
  category: TransportErrorCategory,
): boolean {
  return (policy.retryOn as readonly string[]).includes(category);
}
