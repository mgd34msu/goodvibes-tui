/**
 * Provider emitters — typed emission wrappers for provider events.
 */
import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { EmitterContext } from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';

export function emitProvidersChanged(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { added: string[]; removed: string[]; updated: string[] }
): void {
  bus.emit('providers', createEventEnvelope('PROVIDERS_CHANGED', { type: 'PROVIDERS_CHANGED', ...data }, ctx));
}

export function emitProviderWarning(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { message: string }
): void {
  bus.emit('providers', createEventEnvelope('PROVIDER_WARNING', { type: 'PROVIDER_WARNING', ...data }, ctx));
}

export function emitModelFallback(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { from: string; to: string; provider: string }
): void {
  bus.emit('providers', createEventEnvelope('MODEL_FALLBACK', { type: 'MODEL_FALLBACK', ...data }, ctx));
}
