/**
 * Control-plane emitters — typed wrappers for ControlPlaneEvent domain.
 */

import { createEventEnvelope } from '../events/envelope.ts';
import type { RuntimeEventEnvelope } from '../events/envelope.ts';
import type { RuntimeEventBus } from '../events/index.ts';
import type { ControlPlaneClientKind, ControlPlaneEvent, ControlPlanePrincipalKind, ControlPlaneTransportKind } from '../events/control-plane.ts';
import type { EmitterContext } from './index.ts';

function controlPlaneEvent<T extends ControlPlaneEvent['type']>(
  type: T,
  data: Omit<Extract<ControlPlaneEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<ControlPlaneEvent, { type: T }>> {
  return createEventEnvelope(type, { type, ...data } as Extract<ControlPlaneEvent, { type: T }>, ctx);
}

export function emitControlPlaneClientConnected(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { clientId: string; clientKind: ControlPlaneClientKind; transport: ControlPlaneTransportKind },
): void {
  bus.emit('control-plane', controlPlaneEvent('CONTROL_PLANE_CLIENT_CONNECTED', data, ctx));
}

export function emitControlPlaneClientDisconnected(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { clientId: string; reason: string },
): void {
  bus.emit('control-plane', controlPlaneEvent('CONTROL_PLANE_CLIENT_DISCONNECTED', data, ctx));
}

export function emitControlPlaneSubscriptionCreated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { clientId: string; subscriptionId: string; topics: string[] },
): void {
  bus.emit('control-plane', controlPlaneEvent('CONTROL_PLANE_SUBSCRIPTION_CREATED', data, ctx));
}

export function emitControlPlaneSubscriptionDropped(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { clientId: string; subscriptionId: string; reason: string },
): void {
  bus.emit('control-plane', controlPlaneEvent('CONTROL_PLANE_SUBSCRIPTION_DROPPED', data, ctx));
}

export function emitControlPlaneAuthGranted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { clientId: string; principalId: string; principalKind: ControlPlanePrincipalKind; scopes: string[] },
): void {
  bus.emit('control-plane', controlPlaneEvent('CONTROL_PLANE_AUTH_GRANTED', data, ctx));
}

export function emitControlPlaneAuthRejected(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { clientId: string; principalId: string; reason: string },
): void {
  bus.emit('control-plane', controlPlaneEvent('CONTROL_PLANE_AUTH_REJECTED', data, ctx));
}
