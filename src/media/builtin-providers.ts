import { MediaProviderRegistry } from './provider-registry.ts';
import {
  createAnthropicImageUnderstandingProvider,
  createBuiltinImageUnderstandingProvider,
  createGeminiImageUnderstandingProvider,
  createLocalImageUnderstandingProvider,
  createOpenAIImageUnderstandingProvider,
} from './builtin-image-understanding.ts';
import { builtinGenerationProviders } from './builtin-generation-providers.ts';
import type { ArtifactStore } from '../artifacts/index.ts';
import type { ProviderRegistry } from '../providers/registry.ts';

export function ensureBuiltinMediaProviders(
  registry: MediaProviderRegistry,
  artifactStore: Pick<ArtifactStore, 'readContent'>,
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'listModels'>,
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
