/**
 * Remote Substrate — Transport Contract
 *
 * Implements v3 Section 10.3: typed message definitions for control/data/ack/failure
 * message classes with retry/backoff policies per class.
 *
 * This module defines the full structural contract for all messages that cross
 * the remote transport boundary. No raw strings — all messages are typed.
 */

import { randomUUID } from 'node:crypto';
import type {
  ControlMessage,
  DataMessage,
  AckMessage,
  FailureMessage,
  TransportMessageBase,
  RetryPolicy,
  TransportErrorCategory,
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
    readonly clientVersion: string;
  };
  HANDSHAKE_ACCEPT: {
    readonly sessionId: string;
    readonly epoch: number;
    readonly serverVersion: string;
    readonly handshakeToken: string;
    readonly expiresAt: number;
    readonly replayFromOffset: number;
  };
  HANDSHAKE_REJECT: {
    readonly reason: string;
    readonly retryable: boolean;
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
export function computeRetryDelay(policy: RetryPolicy, attempt: number): number {
  const base = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attempt - 1);
  const capped = Math.min(base, policy.maxDelayMs);
  const jitterMs = capped * policy.jitter * (Math.random() * 2 - 1);
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
