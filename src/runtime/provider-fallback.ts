/**
 * provider-fallback.ts — the pre-catalog fallback registration for the
 * configured model, extracted verbatim from services.ts (file-size hygiene):
 * before the model catalog cache has loaded, the configured provider:model is
 * registered with SDK family-aware context-window inference so the meter and
 * compaction denominator agree with the post-catalog window.
 */
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import {
  inferFallbackContextWindow,
  resolveReasoningEffortSpec,
  type ModelDefinition,
  type ProviderRegistry,
} from '@pellux/goodvibes-sdk/platform/providers';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';

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
    // Which levels this model accepts is a property of the model, not of the
    // provider it sits behind: the hardcoded four ('instant', 'low', 'medium',
    // 'high') offered 'instant' to models that reject it and hid 'xhigh',
    // 'max' and 'none' from models that accept them. The SDK resolver answers
    // from the curated family table when the catalog has not loaded yet, and
    // otherwise returns its own labelled best guess, which the adapters treat
    // as "send nothing" rather than as verified levels.
    ...(isReasoningProvider
      ? { reasoningEffort: resolveReasoningEffortSpec({ modelId }) }
      : {}),
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

/**
 * Boot-time custom-provider readiness. Custom providers register
 * asynchronously (services.ts fires initCustomProviders() without awaiting),
 * while the boot path resolves the current model synchronously — without
 * waiting here, a saved provider.model that points at a custom provider
 * throws "not in registry" before the first frame renders. The routability
 * guard must re-run after ready(): its services-composition pass bails when
 * the provider itself isn't registered yet, which is exactly the
 * custom-provider case. As a last resort (the configured provider's file was
 * deleted entirely), boot on a real selectable model with a warning instead
 * of dying before the UI exists.
 */
export async function ensureBootModelResolvable(
  providerRegistry: ProviderRegistry,
  configManager: ConfigManager,
): Promise<void> {
  await providerRegistry.ready();
  ensureConfiguredModelIsRoutable(providerRegistry, configManager);
  try {
    providerRegistry.getCurrentModel();
  } catch (err) {
    const configured = String(configManager.get('provider.model') ?? '');
    const replacement = providerRegistry.getSelectableModels()[0]?.registryKey;
    if (!replacement) throw err;
    providerRegistry.setCurrentModel(replacement);
    configManager.set('provider.model', replacement);
    logger.warn(`[bootstrap] Configured model '${configured}' is not resolvable (its provider is not registered); switched to '${replacement}'.`);
  }
}
