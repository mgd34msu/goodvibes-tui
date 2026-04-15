/**
 * Session emitters — typed emission wrappers for SessionEvent domain.
 *
 * Import and call these instead of emitting raw strings.
 */
import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '../events/index.ts';
import type { SessionEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/session';
import type { EmitterContext } from './index.ts';

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Creates a typed session event envelope, reducing boilerplate across the
 * 7 public wrapper functions below.
 */
function sessionEvent<T extends SessionEvent['type']>(
  type: T,
  data: Omit<Extract<SessionEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<SessionEvent, { type: T }>> {
  return createEventEnvelope(type, { type, ...data } as Extract<SessionEvent, { type: T }>, ctx);
}

// ---------------------------------------------------------------------------
// Public typed emitter wrappers
// ---------------------------------------------------------------------------

/** Emit SESSION_STARTED when a new session is created and initialising. */
export function emitSessionStarted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; profileId: string; workingDir: string }
): void {
  bus.emit('session', sessionEvent('SESSION_STARTED', data, ctx));
}

/** Emit SESSION_LOADING when an existing session is being loaded from disk. */
export function emitSessionLoading(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; path: string }
): void {
  bus.emit('session', sessionEvent('SESSION_LOADING', data, ctx));
}

/** Emit SESSION_RESUMED when a previously saved session is being resumed. */
export function emitSessionResumed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; turnCount: number }
): void {
  bus.emit('session', sessionEvent('SESSION_RESUMED', data, ctx));
}

/** Emit SESSION_REPAIRING when session state is being repaired after a detected inconsistency. */
export function emitSessionRepairing(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; reason: string }
): void {
  bus.emit('session', sessionEvent('SESSION_REPAIRING', data, ctx));
}

/** Emit SESSION_RECONCILING when context messages are being reconciled with stored state. */
export function emitSessionReconciling(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; messageCount: number }
): void {
  bus.emit('session', sessionEvent('SESSION_RECONCILING', data, ctx));
}

/** Emit SESSION_READY when session is fully loaded and ready for input. */
export function emitSessionReady(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string }
): void {
  bus.emit('session', sessionEvent('SESSION_READY', data, ctx));
}

/** Emit SESSION_RECOVERY_FAILED when session recovery has failed unrecoverably. */
export function emitSessionRecoveryFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; error: string }
): void {
  bus.emit('session', sessionEvent('SESSION_RECOVERY_FAILED', data, ctx));
}
