import type { DiscoveredServer } from '@pellux/goodvibes-sdk/platform/discovery/scanner';
import type { LLMProvider } from '@pellux/goodvibes-sdk/platform/providers/interface';
import { getDiscoveredTraits } from '@pellux/goodvibes-sdk/platform/providers/discovered-traits';
import { LocalAIProvider, TGIProvider, VLLMProvider } from '@pellux/goodvibes-sdk/platform/providers/discovered-compat';
import { LlamaCppProvider } from '@pellux/goodvibes-sdk/platform/providers/llama-cpp';
import { LMStudioProvider } from '@pellux/goodvibes-sdk/platform/providers/lm-studio';
import { OpenAICompatProvider } from '@pellux/goodvibes-sdk/platform/providers/openai-compat';
import { OllamaProvider } from '@pellux/goodvibes-sdk/platform/providers/ollama';

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
