/**
 * ProviderEvent — discriminated union for provider registry and fallback events.
 */
export type ProviderEvent =
  | { type: 'PROVIDERS_CHANGED'; added: string[]; removed: string[]; updated: string[] }
  | { type: 'PROVIDER_WARNING'; message: string }
  | { type: 'MODEL_FALLBACK'; from: string; to: string; provider: string };

export type ProviderEventType = ProviderEvent['type'];
