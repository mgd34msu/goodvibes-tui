/**
 * Security emitters — typed wrappers for SecurityEvent domain.
 */

import { createEventEnvelope } from '../events/envelope.ts';
import type { RuntimeEventEnvelope } from '../events/envelope.ts';
import type { RuntimeEventBus } from '../events/index.ts';
import type { SecurityEvent } from '../events/security.ts';
import type { EmitterContext } from './index.ts';

function securityEvent<T extends SecurityEvent['type']>(
  type: T,
  data: Omit<Extract<SecurityEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<SecurityEvent, { type: T }>> {
  return createEventEnvelope(type, { type, ...data } as Extract<SecurityEvent, { type: T }>, ctx);
}

export function emitTokenScopeViolation(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { tokenId: string; label: string; policyId: string; excessScopes: string[] },
): void {
  bus.emit('security', securityEvent('TOKEN_SCOPE_VIOLATION', data, ctx));
}

export function emitTokenRotationWarning(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { tokenId: string; label: string; msUntilDue: number; dueAt: number; ageMs: number },
): void {
  bus.emit('security', securityEvent('TOKEN_ROTATION_WARNING', data, ctx));
}

export function emitTokenRotationExpired(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { tokenId: string; label: string; ageMs: number; cadenceMs: number; dueAt: number },
): void {
  bus.emit('security', securityEvent('TOKEN_ROTATION_EXPIRED', data, ctx));
}

export function emitTokenBlocked(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    tokenId: string;
    label: string;
    reason: 'scope_violation' | 'rotation_overdue' | 'scope_violation_and_rotation_overdue';
  },
): void {
  bus.emit('security', securityEvent('TOKEN_BLOCKED', data, ctx));
}
