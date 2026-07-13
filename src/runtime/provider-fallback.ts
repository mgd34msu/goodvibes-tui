/**
 * provider-fallback.ts — the pre-catalog fallback registration for the
 * configured model, extracted verbatim from services.ts (file-size hygiene):
 * before the model catalog cache has loaded, the configured provider:model is
 * registered with SDK family-aware context-window inference so the meter and
 * compaction denominator agree with the post-catalog window.
 */
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { inferFallbackContextWindow, type ModelDefinition, type ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';

function buildFallbackModelDefinition(provider: string, modelId: string): ModelDefinition {
  const providerLower = provider.toLowerCase();
  const isReasoningProvider = providerLower.includes('openai')
    || providerLower.includes('anthropic')
    || providerLower.includes('gemini')
    || providerLower.includes('google');

  return {
    id: modelId,
    provider,
    registryKey: `${provider}:${modelId}`,
    displayName: modelId,
    description: 'Configured model available before the model catalog cache has loaded.',
    capabilities: {
      toolCalling: true,
      codeEditing: true,
      reasoning: isReasoningProvider,
      multimodal: isReasoningProvider,
    },
    contextWindow: inferFallbackContextWindow(provider, modelId),
    contextWindowProvenance: 'fallback',
    selectable: true,
    tier: 'standard',
    ...(isReasoningProvider ? { reasoningEffort: ['instant', 'low', 'medium', 'high'] } : {}),
  };
}

export function ensureConfiguredModelIsRoutable(providerRegistry: ProviderRegistry, configManager: ConfigManager): void {
  const configuredModel = String(configManager.get('provider.model') ?? '').trim();
  if (!configuredModel.includes(':')) return;
  if (providerRegistry.listModels().some((model) => model.registryKey === configuredModel)) return;

  const [providerId, ...modelParts] = configuredModel.split(':');
  const modelId = modelParts.join(':').trim();
  if (!providerId || !modelId) return;

  const provider = providerRegistry.tryGet(providerId);
  if (!provider) return;

  providerRegistry.registerRuntimeProvider({
    provider,
    replace: true,
    models: [buildFallbackModelDefinition(providerId, modelId)],
  });
}
