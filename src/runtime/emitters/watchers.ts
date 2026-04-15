/**
 * Watcher emitters — typed wrappers for WatcherEvent domain.
 */

import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { WatcherEvent, WatcherSourceKind } from '@pellux/goodvibes-sdk/platform/runtime/events/watchers';
import type { EmitterContext } from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';

function watcherEvent<T extends WatcherEvent['type']>(
  type: T,
  data: Omit<Extract<WatcherEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<WatcherEvent, { type: T }>> {
  return createEventEnvelope(type, { type, ...data } as Extract<WatcherEvent, { type: T }>, ctx);
}

export function emitWatcherStarted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { watcherId: string; sourceKind: WatcherSourceKind; name: string },
): void {
  bus.emit('watchers', watcherEvent('WATCHER_STARTED', data, ctx));
}

export function emitWatcherHeartbeat(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { watcherId: string; sourceKind: WatcherSourceKind; seenAt: number; checkpoint: string },
): void {
  bus.emit('watchers', watcherEvent('WATCHER_HEARTBEAT', data, ctx));
}

export function emitWatcherCheckpointAdvanced(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { watcherId: string; sourceKind: WatcherSourceKind; checkpoint: string },
): void {
  bus.emit('watchers', watcherEvent('WATCHER_CHECKPOINT_ADVANCED', data, ctx));
}

export function emitWatcherFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { watcherId: string; sourceKind: WatcherSourceKind; error: string; retryable: boolean },
): void {
  bus.emit('watchers', watcherEvent('WATCHER_FAILED', data, ctx));
}

export function emitWatcherStopped(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { watcherId: string; sourceKind: WatcherSourceKind; reason: string },
): void {
  bus.emit('watchers', watcherEvent('WATCHER_STOPPED', data, ctx));
}
