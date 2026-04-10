/**
 * Route emitters — typed wrappers for RouteEvent domain.
 */

import { createEventEnvelope } from '../events/envelope.ts';
import type { RuntimeEventEnvelope } from '../events/envelope.ts';
import type { RuntimeEventBus } from '../events/index.ts';
import type { RouteEvent, RouteSurfaceKind, RouteTargetKind } from '../events/routes.ts';
import type { EmitterContext } from './index.ts';

function routeEvent<T extends RouteEvent['type']>(
  type: T,
  data: Omit<Extract<RouteEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<RouteEvent, { type: T }>> {
  return createEventEnvelope(type, { type, ...data } as Extract<RouteEvent, { type: T }>, ctx);
}

export function emitRouteBindingCreated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { bindingId: string; surfaceKind: RouteSurfaceKind; externalId: string; targetKind: RouteTargetKind; targetId: string },
): void {
  bus.emit('routes', routeEvent('ROUTE_BINDING_CREATED', data, ctx));
}

export function emitRouteBindingUpdated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { bindingId: string; changedFields: string[] },
): void {
  bus.emit('routes', routeEvent('ROUTE_BINDING_UPDATED', data, ctx));
}

export function emitRouteBindingResolved(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { bindingId: string; surfaceKind: RouteSurfaceKind; externalId: string; targetKind: RouteTargetKind; targetId: string },
): void {
  bus.emit('routes', routeEvent('ROUTE_BINDING_RESOLVED', data, ctx));
}

export function emitRouteReplyTargetCaptured(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { bindingId: string; surfaceKind: RouteSurfaceKind; externalId: string; replyTargetId: string; threadId: string },
): void {
  bus.emit('routes', routeEvent('ROUTE_REPLY_TARGET_CAPTURED', data, ctx));
}

export function emitRouteBindingFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { surfaceKind: RouteSurfaceKind; externalId: string; error: string },
): void {
  bus.emit('routes', routeEvent('ROUTE_BINDING_FAILED', data, ctx));
}
