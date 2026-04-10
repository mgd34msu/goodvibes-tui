/**
 * Delivery emitters — typed wrappers for DeliveryEvent domain.
 */

import { createEventEnvelope } from '../events/envelope.ts';
import type { RuntimeEventEnvelope } from '../events/envelope.ts';
import type { RuntimeEventBus } from '../events/index.ts';
import type { DeliveryEvent, DeliveryKind } from '../events/deliveries.ts';
import type { RouteSurfaceKind } from '../events/routes.ts';
import type { EmitterContext } from './index.ts';

function deliveryEvent<T extends DeliveryEvent['type']>(
  type: T,
  data: Omit<Extract<DeliveryEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<DeliveryEvent, { type: T }>> {
  return createEventEnvelope(type, { type, ...data } as Extract<DeliveryEvent, { type: T }>, ctx);
}

export function emitDeliveryQueued(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    deliveryId: string;
    jobId: string;
    runId: string;
    surfaceKind: RouteSurfaceKind;
    targetId: string;
    deliveryKind: DeliveryKind;
  },
): void {
  bus.emit('deliveries', deliveryEvent('DELIVERY_QUEUED', data, ctx));
}

export function emitDeliveryStarted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { deliveryId: string; jobId: string; runId: string; surfaceKind: RouteSurfaceKind; targetId: string; startedAt: number },
): void {
  bus.emit('deliveries', deliveryEvent('DELIVERY_STARTED', data, ctx));
}

export function emitDeliverySucceeded(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { deliveryId: string; jobId: string; runId: string; surfaceKind: RouteSurfaceKind; targetId: string; completedAt: number; durationMs: number; statusCode: number },
): void {
  bus.emit('deliveries', deliveryEvent('DELIVERY_SUCCEEDED', data, ctx));
}

export function emitDeliveryFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { deliveryId: string; jobId: string; runId: string; surfaceKind: RouteSurfaceKind; targetId: string; failedAt: number; error: string; retryable: boolean },
): void {
  bus.emit('deliveries', deliveryEvent('DELIVERY_FAILED', data, ctx));
}

export function emitDeliveryDeadLettered(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { deliveryId: string; jobId: string; runId: string; surfaceKind: RouteSurfaceKind; targetId: string; reason: string; attempts: number },
): void {
  bus.emit('deliveries', deliveryEvent('DELIVERY_DEAD_LETTERED', data, ctx));
}
