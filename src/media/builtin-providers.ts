import { MediaProviderRegistry } from './provider-registry.ts';
import {
  createAnthropicImageUnderstandingProvider,
  createBuiltinImageUnderstandingProvider,
  createGeminiImageUnderstandingProvider,
  createLocalImageUnderstandingProvider,
  createOpenAIImageUnderstandingProvider,
} from './builtin-image-understanding.ts';

export function ensureBuiltinMediaProviders(registry = MediaProviderRegistry.getActive()): void {
  registry.register(createOpenAIImageUnderstandingProvider(), { replace: true });
  registry.register(createGeminiImageUnderstandingProvider(), { replace: true });
  registry.register(createAnthropicImageUnderstandingProvider(), { replace: true });
  registry.register(createLocalImageUnderstandingProvider(), { replace: true });
  registry.register(createBuiltinImageUnderstandingProvider(), { replace: true });
}
