import type { DiscoveredServer } from '@pellux/goodvibes-sdk/platform/discovery/scanner';
import type { LLMProvider } from './interface.ts';
import { getDiscoveredTraits } from './discovered-traits.ts';
import { LocalAIProvider, TGIProvider, VLLMProvider } from './discovered-compat.ts';
import { LlamaCppProvider } from './llama-cpp.ts';
import { LMStudioProvider } from './lm-studio.ts';
import { OpenAICompatProvider } from './openai-compat.ts';
import { OllamaProvider } from './ollama.ts';

export function createDiscoveredProvider(server: DiscoveredServer): LLMProvider {
  const traits = getDiscoveredTraits(server.serverType);
  const common = {
    name: server.name,
    baseURL: server.baseURL,
    apiKey: '',
    defaultModel: server.models[0]!,
    models: server.models,
    capabilities: traits.providerCapabilities,
  };

  switch (traits.adapter) {
    case 'lm-studio':
      return new LMStudioProvider(common);
    case 'ollama':
      return new OllamaProvider({
        ...common,
        reasoningFormat: traits.reasoningFormat,
      });
    case 'vllm':
      return new VLLMProvider({
        ...common,
        reasoningFormat: traits.reasoningFormat,
      });
    case 'llamacpp':
      return new LlamaCppProvider({
        ...common,
        reasoningFormat: traits.reasoningFormat,
      });
    case 'tgi':
      return new TGIProvider({
        ...common,
        reasoningFormat: traits.reasoningFormat,
      });
    case 'localai':
      return new LocalAIProvider({
        ...common,
        reasoningFormat: traits.reasoningFormat,
      });
    default:
      return new OpenAICompatProvider({
        ...common,
        reasoningFormat: traits.reasoningFormat,
      });
  }
}

export function getDiscoveredReasoningFormat(
  serverType: DiscoveredServer['serverType'],
): 'llamacpp' | 'none' {
  return getDiscoveredTraits(serverType).reasoningFormat;
}
