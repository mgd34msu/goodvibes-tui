/**
 * Plugin emitters — typed emission wrappers for PluginEvent domain.
 */
import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { EmitterContext } from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';

/** Emit PLUGIN_DISCOVERED when a plugin is found during scan. */
export function emitPluginDiscovered(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { pluginId: string; path: string; version: string }
): void {
  bus.emit('plugins', createEventEnvelope('PLUGIN_DISCOVERED', { type: 'PLUGIN_DISCOVERED', ...data }, ctx));
}

/** Emit PLUGIN_LOADING when a plugin begins loading. */
export function emitPluginLoading(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { pluginId: string; path: string }
): void {
  bus.emit('plugins', createEventEnvelope('PLUGIN_LOADING', { type: 'PLUGIN_LOADING', ...data }, ctx));
}

/** Emit PLUGIN_LOADED when a plugin is successfully loaded. */
export function emitPluginLoaded(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { pluginId: string; version: string; capabilities: string[] }
): void {
  bus.emit('plugins', createEventEnvelope('PLUGIN_LOADED', { type: 'PLUGIN_LOADED', ...data }, ctx));
}

/** Emit PLUGIN_ACTIVE when a plugin is fully active. */
export function emitPluginActive(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { pluginId: string }
): void {
  bus.emit('plugins', createEventEnvelope('PLUGIN_ACTIVE', { type: 'PLUGIN_ACTIVE', ...data }, ctx));
}

/** Emit PLUGIN_DEGRADED when a plugin loses partial functionality. */
export function emitPluginDegraded(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { pluginId: string; reason: string; affectedCapabilities: string[] }
): void {
  bus.emit('plugins', createEventEnvelope('PLUGIN_DEGRADED', { type: 'PLUGIN_DEGRADED', ...data }, ctx));
}

/** Emit PLUGIN_ERROR when a plugin encounters an error. */
export function emitPluginError(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { pluginId: string; error: string; fatal: boolean }
): void {
  bus.emit('plugins', createEventEnvelope('PLUGIN_ERROR', { type: 'PLUGIN_ERROR', ...data }, ctx));
}

/** Emit PLUGIN_UNLOADING when a plugin begins unloading. */
export function emitPluginUnloading(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { pluginId: string; reason?: string }
): void {
  bus.emit('plugins', createEventEnvelope('PLUGIN_UNLOADING', { type: 'PLUGIN_UNLOADING', ...data }, ctx));
}

/** Emit PLUGIN_DISABLED when a plugin is permanently disabled. */
export function emitPluginDisabled(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { pluginId: string; reason: string }
): void {
  bus.emit('plugins', createEventEnvelope('PLUGIN_DISABLED', { type: 'PLUGIN_DISABLED', ...data }, ctx));
}
