import type { ModelDefinition } from './registry-types.ts';

export function withRegistryKey(model: ModelDefinition): ModelDefinition {
  return model.registryKey ? model : { ...model, registryKey: `${model.provider}:${model.id}` };
}

export function splitModelRegistryKey(modelId: string): { providerId: string; resolvedModelId: string } {
  if (!modelId.includes(':')) {
    return { providerId: modelId, resolvedModelId: modelId };
  }

  return {
    providerId: modelId.split(':')[0] ?? 'unknown',
    resolvedModelId: modelId.split(':').slice(1).join(':'),
  };
}

export function getBaseModelId(modelId: string): string {
  return modelId.includes(':') ? modelId.split(':').slice(1).join(':') : modelId;
}

/**
 * Key-order-independent JSON serialisation used for model diff comparisons.
 * Recursively sorts object keys so that { a: 1, b: 2 } and { b: 2, a: 1 }
 * produce the same string.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  return '{' + sorted.map((key) => (
    JSON.stringify(key) + ':' + stableStringify((value as Record<string, unknown>)[key])
  )).join(',') + '}';
}
