import { MediaProviderRegistry } from '@pellux/goodvibes-sdk/platform/media/provider-registry';
import {
  createAnthropicImageUnderstandingProvider,
  createBuiltinImageUnderstandingProvider,
  createGeminiImageUnderstandingProvider,
  createLocalImageUnderstandingProvider,
  createOpenAIImageUnderstandingProvider,
} from '@pellux/goodvibes-sdk/platform/media/builtin-image-understanding';
import { builtinGenerationProviders } from '@pellux/goodvibes-sdk/platform/media/builtin-generation-providers';
import type { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts/index';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';

export function ensureBuiltinMediaProviders(
  registry: MediaProviderRegistry,
  artifactStore: Pick<ArtifactStore, 'readContent'>,
  providerRegistry: Pick<ProviderRegistry, 'describeRuntime' | 'getCurrentModel' | 'getForModel' | 'listModels'>,
): void {
  registry.register(createOpenAIImageUnderstandingProvider(providerRegistry, artifactStore), { replace: true });
  registry.register(createGeminiImageUnderstandingProvider(providerRegistry, artifactStore), { replace: true });
  registry.register(createAnthropicImageUnderstandingProvider(providerRegistry, artifactStore), { replace: true });
  registry.register(createLocalImageUnderstandingProvider(providerRegistry, artifactStore), { replace: true });
  registry.register(createBuiltinImageUnderstandingProvider(providerRegistry, artifactStore), { replace: true });
  for (const provider of builtinGenerationProviders()) {
    registry.register(provider, { replace: true });
  }
}
