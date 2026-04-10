/**
 * Surface emitters — typed wrappers for SurfaceEvent domain.
 */

import { createEventEnvelope } from '../events/envelope.ts';
import type { RuntimeEventEnvelope } from '../events/envelope.ts';
import type { RuntimeEventBus } from '../events/index.ts';
import type { SurfaceEvent, SurfaceKind } from '../events/surfaces.ts';
import type { EmitterContext } from './index.ts';

function surfaceEvent<T extends SurfaceEvent['type']>(
  type: T,
  data: Omit<Extract<SurfaceEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<SurfaceEvent, { type: T }>> {
  return createEventEnvelope(type, { type, ...data } as Extract<SurfaceEvent, { type: T }>, ctx);
}

export function emitSurfaceEnabled(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { surfaceKind: SurfaceKind; surfaceId: string; accountId: string },
): void {
  bus.emit('surfaces', surfaceEvent('SURFACE_ENABLED', data, ctx));
}

export function emitSurfaceDisabled(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { surfaceKind: SurfaceKind; surfaceId: string; reason: string },
): void {
  bus.emit('surfaces', surfaceEvent('SURFACE_DISABLED', data, ctx));
}

export function emitSurfaceAccountConnected(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { surfaceKind: SurfaceKind; surfaceId: string; accountId: string; displayName: string },
): void {
  bus.emit('surfaces', surfaceEvent('SURFACE_ACCOUNT_CONNECTED', data, ctx));
}

export function emitSurfaceAccountDegraded(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { surfaceKind: SurfaceKind; surfaceId: string; accountId: string; error: string },
): void {
  bus.emit('surfaces', surfaceEvent('SURFACE_ACCOUNT_DEGRADED', data, ctx));
}

export function emitSurfaceCapabilityChanged(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { surfaceKind: SurfaceKind; surfaceId: string; capability: string; enabled: boolean },
): void {
  bus.emit('surfaces', surfaceEvent('SURFACE_CAPABILITY_CHANGED', data, ctx));
}
