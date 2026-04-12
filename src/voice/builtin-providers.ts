import { VoiceProviderRegistry } from './provider-registry.ts';
import { createDeepgramProvider } from './providers/deepgram.ts';
import { createElevenLabsProvider } from './providers/elevenlabs.ts';
import { createGoogleProvider } from './providers/google.ts';
import { createMicrosoftProvider } from './providers/microsoft.ts';
import { createOpenAIProvider } from './providers/openai.ts';
import { createVydraProvider } from './providers/vydra.ts';

export function ensureBuiltinVoiceProviders(registry: VoiceProviderRegistry): void {
  registry.register(createOpenAIProvider(), { replace: true });
  registry.register(createDeepgramProvider(), { replace: true });
  registry.register(createGoogleProvider(), { replace: true });
  registry.register(createElevenLabsProvider(), { replace: true });
  registry.register(createMicrosoftProvider(), { replace: true });
  registry.register(createVydraProvider(), { replace: true });
}
