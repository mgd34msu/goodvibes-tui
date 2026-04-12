import type { LLMProvider } from './interface.ts';
import { OpenAIProvider } from './openai.ts';
import { OpenAICompatProvider } from './openai-compat.ts';
import { AnthropicProvider } from './anthropic.ts';
import { AnthropicCompatProvider } from './anthropic-compat.ts';
import { OpenAICodexProvider } from './openai-codex.ts';
import { GeminiProvider } from './gemini.ts';
import { AmazonBedrockProvider } from './amazon-bedrock.ts';
import { AmazonBedrockMantleProvider } from './amazon-bedrock-mantle.ts';
import { AnthropicVertexProvider } from './anthropic-vertex.ts';
import { GitHubCopilotProvider } from './github-copilot.ts';
import { BUILTIN_COMPAT_PROVIDERS, type BuiltinCompatDefinition } from './builtin-catalog.ts';
import { normalizeFoundryEndpoint } from './microsoft-foundry-shared.ts';
import { SyntheticProvider } from './synthetic.ts';
import type { BenchmarkEntry } from './model-benchmarks.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { CanonicalModel } from './synthetic.ts';

export interface ProviderRegistrar {
  register(provider: LLMProvider): void;
}

export const CATALOG_PROVIDER_NAME_ALIASES: Record<string, string> = {
  inception: 'inceptionlabs',
  copilot: 'github-copilot',
  'azure-openai': 'microsoft-foundry',
  'azure-openai-responses': 'microsoft-foundry',
  dashscope: 'qwen',
  'volcano-engine': 'volcengine',
  'x-ai': 'xai',
  'z-ai': 'zai',
  'cloudflare-gateway': 'cloudflare-ai-gateway',
  'ai-gateway': 'vercel-ai-gateway',
};

function firstEnvValue(envVars: readonly string[]): string | undefined {
  for (const envVar of envVars) {
    const value = process.env[envVar];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function resolveFoundryBaseUrl(): string {
  const endpoint = firstEnvValue(['AZURE_OPENAI_ENDPOINT', 'AZURE_FOUNDRY_ENDPOINT']);
  if (!endpoint) return 'https://example.openai.azure.com/openai/v1';
  const normalized = normalizeFoundryEndpoint(endpoint);
  return normalized.endsWith('/openai/v1') ? normalized : `${normalized}/openai/v1`;
}

export function createBuiltinCompatProvider(
  definition: BuiltinCompatDefinition,
  apiKey: string,
  options: {
    readonly cacheHitTracker?: import('./cache-strategy.ts').CacheHitTracker;
  },
): LLMProvider {
  if (definition.kind === 'anthropic-compat') {
    return new AnthropicCompatProvider({
      name: definition.id,
      baseURL: definition.baseURL,
      apiKey,
      defaultModel: definition.defaultModel,
      models: [...definition.models],
      ...(definition.defaultHeaders ? { defaultHeaders: definition.defaultHeaders } : {}),
      authEnvVars: definition.envVars,
      serviceNames: definition.serviceNames,
      aliases: definition.aliases,
      ...(definition.subscriptionProviderId ? { subscriptionProviderId: definition.subscriptionProviderId } : {}),
      ...(definition.streamProtocol ? { streamProtocol: definition.streamProtocol } : {}),
      ...(definition.authHeaderMode ? { authHeaderMode: definition.authHeaderMode } : {}),
      ...(definition.allowAnonymous ? { allowAnonymous: true } : {}),
      ...(definition.anonymousConfigured ? { anonymousConfigured: true } : {}),
      ...(definition.anonymousDetail ? { anonymousDetail: definition.anonymousDetail } : {}),
      ...(options.cacheHitTracker ? { cacheHitTracker: options.cacheHitTracker } : {}),
    });
  }

  const baseURL = definition.id === 'microsoft-foundry' ? resolveFoundryBaseUrl() : definition.baseURL;
  const effectiveApiKey = apiKey || (definition.allowAnonymous ? 'gv-local' : '');
  return new OpenAICompatProvider({
    name: definition.id,
    baseURL,
    apiKey: effectiveApiKey,
    authConfigured: Boolean(apiKey),
    defaultModel: definition.defaultModel,
    models: [...definition.models],
    ...(definition.embeddingModel ? { embeddingModel: definition.embeddingModel } : {}),
    ...(definition.defaultHeaders ? { defaultHeaders: definition.defaultHeaders } : {}),
    reasoningFormat: definition.reasoningFormat ?? 'none',
    authEnvVars: definition.envVars,
    serviceNames: definition.serviceNames,
    ...(definition.subscriptionProviderId ? { subscriptionProviderId: definition.subscriptionProviderId } : {}),
    ...(definition.suppressedModels ? { suppressedModels: definition.suppressedModels } : {}),
    ...(definition.aliases ? { aliases: definition.aliases } : {}),
    ...(definition.streamProtocol ? { streamProtocol: definition.streamProtocol } : {}),
    ...(definition.allowAnonymous ? { allowAnonymous: true } : {}),
    ...(definition.anonymousConfigured ? { anonymousConfigured: true } : {}),
    ...(definition.anonymousDetail ? { anonymousDetail: definition.anonymousDetail } : {}),
    ...(options.cacheHitTracker ? { cacheHitTracker: options.cacheHitTracker } : {}),
  });
}

/**
 * Register the complete set of builtin provider implementations.
 * Kept in a separate module so the registry composition root stays focused.
 */
export function registerBuiltinProviders(
  registry: ProviderRegistrar,
  hasProvider: (name: string) => boolean,
  apiKey: (name: string) => string,
  options: {
    readonly resolveProvider: (providerName: string) => LLMProvider;
    readonly cacheHitTracker?: import('./cache-strategy.ts').CacheHitTracker;
    readonly getCatalogModels: () => readonly CanonicalModel[];
    readonly getBenchmarks: (modelId: string) => BenchmarkEntry | undefined;
    readonly runtimeBus?: RuntimeEventBus | null;
  },
): void {
  registry.register(
    new OpenAICompatProvider({
      name: 'inceptionlabs',
      baseURL: 'https://api.inceptionlabs.ai/v1',
      apiKey: apiKey('inceptionlabs'),
      defaultModel: 'mercury-2',
      models: ['mercury-2', 'mercury-edit'],
      reasoningFormat: 'mercury',
      authEnvVars: ['INCEPTION_API_KEY'],
      serviceNames: ['inceptionlabs'],
      aliases: ['inception'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'openrouter',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: apiKey('openrouter'),
      defaultModel: 'openrouter/free',
      models: [
        'openrouter/free',
        'arcee-ai/trinity-mini:free',
        'minimax/minimax-m2.5:free',
        'nvidia/nemotron-3-super-120b-a12b:free',
        'nvidia/nemotron-3-nano-30b-a3b:free',
        'nvidia/nemotron-nano-12b-v2-vl:free',
        'nvidia/nemotron-nano-9b-v2:free',
        'openai/gpt-oss-120b:free',
        'openai/gpt-oss-20b:free',
        'stepfun/step-3.5-flash:free',
        'z-ai/glm-4.5-air:free',
      ],
      reasoningFormat: 'openrouter',
      authEnvVars: ['OPENROUTER_API_KEY'],
      serviceNames: ['openrouter'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'aihubmix',
      baseURL: 'https://aihubmix.com/v1',
      apiKey: apiKey('aihubmix'),
      defaultModel: 'gpt-4.1-free',
      models: [
        'gpt-4.1-free', 'gpt-4.1-mini-free', 'gpt-4.1-nano-free', 'gpt-4o-free',
        'gemini-2.0-flash-free', 'gemini-3-flash-preview-free', 'gemini-3.1-flash-image-preview-free',
        'glm-4.7-flash-free',
        'coding-glm-4.6-free', 'coding-glm-4.7-free', 'coding-glm-5-free', 'coding-glm-5-turbo-free',
        'coding-minimax-m2-free', 'coding-minimax-m2.1-free', 'coding-minimax-m2.5-free', 'coding-minimax-m2.7-free',
        'kimi-for-coding-free', 'mimo-v2-flash-free', 'minimax-m2.5-free', 'step-3.5-flash-free',
      ],
      reasoningFormat: 'none',
      authEnvVars: ['AIHUBMIX_API_KEY'],
      serviceNames: ['aihubmix'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'groq',
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: apiKey('groq'),
      defaultModel: 'qwen/qwen3-32b',
      models: [
        'qwen/qwen3-32b',
        'openai/gpt-oss-120b', 'openai/gpt-oss-20b',
        'moonshotai/kimi-k2-instruct', 'moonshotai/kimi-k2-instruct-0905',
        'llama-3.3-70b-versatile', 'llama-3.1-8b-instant',
        'meta-llama/llama-4-scout-17b-16e-instruct',
        'groq/compound', 'groq/compound-mini',
      ],
      reasoningFormat: 'none',
      authEnvVars: ['GROQ_API_KEY'],
      serviceNames: ['groq'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'cerebras',
      baseURL: 'https://api.cerebras.ai/v1',
      apiKey: apiKey('cerebras'),
      defaultModel: 'qwen-3-235b-a22b-instruct-2507',
      models: ['llama3.1-8b', 'qwen-3-235b-a22b-instruct-2507'],
      reasoningFormat: 'none',
      authEnvVars: ['CEREBRAS_API_KEY'],
      serviceNames: ['cerebras'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'mistral',
      baseURL: 'https://api.mistral.ai/v1',
      apiKey: apiKey('mistral'),
      defaultModel: 'mistral-large-latest',
      embeddingModel: 'mistral-embed',
      models: [
        'mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest',
        'codestral-latest', 'devstral-latest', 'devstral-medium-latest', 'devstral-small-latest',
        'magistral-medium-latest', 'magistral-small-latest',
        'ministral-14b-latest', 'ministral-8b-latest', 'ministral-3b-latest',
        'pixtral-large-latest', 'open-mistral-nemo',
      ],
      reasoningFormat: 'none',
      authEnvVars: ['MISTRAL_API_KEY'],
      serviceNames: ['mistral'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'ollama-cloud',
      baseURL: 'https://ollama.com/v1',
      apiKey: apiKey('ollama-cloud'),
      defaultModel: 'deepseek-v3.2',
      models: [
        'deepseek-v3.2', 'deepseek-v3.1:671b', 'cogito-2.1:671b',
        'qwen3.5:397b', 'qwen3-coder:480b', 'qwen3-coder-next', 'qwen3-next:80b',
        'qwen3-vl:235b', 'qwen3-vl:235b-instruct',
        'kimi-k2:1t', 'kimi-k2-thinking', 'kimi-k2.5',
        'mistral-large-3:675b', 'devstral-2:123b', 'devstral-small-2:24b',
        'ministral-3:14b', 'ministral-3:8b', 'ministral-3:3b',
        'gemini-3-flash-preview', 'gemma3:27b', 'gemma3:12b', 'gemma3:4b',
        'glm-4.6', 'glm-4.7', 'glm-5',
        'gpt-oss:120b', 'gpt-oss:20b',
        'minimax-m2', 'minimax-m2.1', 'minimax-m2.5', 'minimax-m2.7',
        'nemotron-3-super', 'nemotron-3-nano:30b',
        'rnj-1:8b',
      ],
      reasoningFormat: 'none',
      authEnvVars: ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY'],
      serviceNames: ['ollama-cloud'],
    }),
  );

  registry.register(new OpenAIProvider(apiKey('openai'), options.cacheHitTracker));
  registry.register(new AnthropicProvider(apiKey('anthropic'), options.cacheHitTracker));
  registry.register(new OpenAICodexProvider());
  registry.register(new GeminiProvider(apiKey('gemini'), options.cacheHitTracker));

  registry.register(
    new OpenAICompatProvider({
      name: 'huggingface',
      baseURL: 'https://router.huggingface.co/v1',
      apiKey: apiKey('huggingface'),
      defaultModel: 'deepseek-ai/DeepSeek-V3.2',
      models: [
        'Qwen/QwQ-32B',
        'Qwen/Qwen2.5-72B-Instruct',
        'Qwen/Qwen2.5-7B-Instruct',
        'Qwen/Qwen2.5-Coder-32B-Instruct',
        'Qwen/Qwen2.5-Coder-3B-Instruct',
        'Qwen/Qwen2.5-Coder-7B-Instruct',
        'Qwen/Qwen2.5-VL-72B-Instruct',
        'Qwen/Qwen2.5-VL-7B-Instruct',
        'Qwen/Qwen3-14B',
        'Qwen/Qwen3-235B-A22B',
        'Qwen/Qwen3-235B-A22B-Instruct-2507',
        'Qwen/Qwen3-235B-A22B-Thinking-2507',
        'Qwen/Qwen3-30B-A3B',
        'Qwen/Qwen3-32B',
        'Qwen/Qwen3-4B-Instruct-2507',
        'Qwen/Qwen3-4B-Thinking-2507',
        'Qwen/Qwen3-8B',
        'Qwen/Qwen3-Coder-30B-A3B-Instruct',
        'Qwen/Qwen3-Coder-480B-A35B-Instruct',
        'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8',
        'Qwen/Qwen3-Coder-Next',
        'Qwen/Qwen3-Coder-Next-FP8',
        'Qwen/Qwen3-Next-80B-A3B-Instruct',
        'Qwen/Qwen3-Next-80B-A3B-Thinking',
        'Qwen/Qwen3-VL-235B-A22B-Instruct',
        'Qwen/Qwen3-VL-235B-A22B-Thinking',
        'Qwen/Qwen3-VL-30B-A3B-Instruct',
        'Qwen/Qwen3-VL-30B-A3B-Thinking',
        'Qwen/Qwen3-VL-8B-Instruct',
        'Qwen/Qwen3.5-122B-A10B',
        'Qwen/Qwen3.5-27B',
        'Qwen/Qwen3.5-35B-A3B',
        'Qwen/Qwen3.5-397B-A17B',
        'Qwen/Qwen3.5-9B',
        'deepseek-ai/DeepSeek-Prover-V2-671B',
        'deepseek-ai/DeepSeek-R1',
        'deepseek-ai/DeepSeek-R1-0528',
        'deepseek-ai/DeepSeek-R1-Distill-Llama-70B',
        'deepseek-ai/DeepSeek-R1-Distill-Llama-8B',
        'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B',
        'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B',
        'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
        'deepseek-ai/DeepSeek-V3',
        'deepseek-ai/DeepSeek-V3-0324',
        'deepseek-ai/DeepSeek-V3.1',
        'deepseek-ai/DeepSeek-V3.1-Terminus',
        'deepseek-ai/DeepSeek-V3.2',
        'deepseek-ai/DeepSeek-V3.2-Exp',
        'zai-org/AutoGLM-Phone-9B-Multilingual',
        'zai-org/GLM-4-32B-0414',
        'zai-org/GLM-4.5',
        'zai-org/GLM-4.5-Air',
        'zai-org/GLM-4.5-Air-FP8',
        'zai-org/GLM-4.5V',
        'zai-org/GLM-4.5V-FP8',
        'zai-org/GLM-4.6',
        'zai-org/GLM-4.6-FP8',
        'zai-org/GLM-4.6V',
        'zai-org/GLM-4.6V-FP8',
        'zai-org/GLM-4.6V-Flash',
        'zai-org/GLM-4.7',
        'zai-org/GLM-4.7-FP8',
        'zai-org/GLM-4.7-Flash',
        'zai-org/GLM-5',
        'meta-llama/Llama-3.1-70B-Instruct',
        'meta-llama/Llama-3.1-8B-Instruct',
        'meta-llama/Llama-3.2-1B-Instruct',
        'meta-llama/Llama-3.3-70B-Instruct',
        'meta-llama/Llama-4-Maverick-17B-128E-Instruct',
        'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
        'meta-llama/Llama-4-Scout-17B-16E-Instruct',
        'meta-llama/Meta-Llama-3-70B-Instruct',
        'meta-llama/Meta-Llama-3-8B-Instruct',
        'CohereLabs/aya-expanse-32b',
        'CohereLabs/aya-vision-32b',
        'CohereLabs/c4ai-command-a-03-2025',
        'CohereLabs/c4ai-command-r-08-2024',
        'CohereLabs/c4ai-command-r7b-12-2024',
        'CohereLabs/c4ai-command-r7b-arabic-02-2025',
        'CohereLabs/command-a-reasoning-08-2025',
        'CohereLabs/command-a-translate-08-2025',
        'CohereLabs/command-a-vision-07-2025',
        'CohereLabs/tiny-aya-earth',
        'CohereLabs/tiny-aya-fire',
        'CohereLabs/tiny-aya-global',
        'CohereLabs/tiny-aya-water',
        'moonshotai/Kimi-K2-Instruct',
        'moonshotai/Kimi-K2-Instruct-0905',
        'moonshotai/Kimi-K2-Thinking',
        'moonshotai/Kimi-K2.5',
        'MiniMaxAI/MiniMax-M1-80k',
        'MiniMaxAI/MiniMax-M2',
        'MiniMaxAI/MiniMax-M2.1',
        'MiniMaxAI/MiniMax-M2.5',
        'google/gemma-3-27b-it',
        'google/gemma-3n-E4B-it',
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'openai/gpt-oss-safeguard-20b',
        'XiaomiMiMo/MiMo-V2-Flash',
        'deepcogito/cogito-671b-v2.1',
        'deepcogito/cogito-671b-v2.1-FP8',
        'baidu/ERNIE-4.5-21B-A3B-PT',
        'baidu/ERNIE-4.5-300B-A47B-Base-PT',
        'baidu/ERNIE-4.5-VL-28B-A3B-PT',
        'baidu/ERNIE-4.5-VL-424B-A47B-Base-PT',
        'allenai/Olmo-3-7B-Instruct',
        'allenai/Olmo-3.1-32B-Instruct',
        'allenai/Olmo-3.1-32B-Think',
        'EssentialAI/rnj-1-instruct',
        'NousResearch/Hermes-2-Pro-Llama-3-8B',
        'Sao10K/L3-70B-Euryale-v2.1',
        'Sao10K/L3-8B-Lunaris-v1',
        'Sao10K/L3-8B-Stheno-v3.2',
        'ServiceNow-AI/Apriel-1.6-15b-Thinker',
        'aisingapore/Gemma-SEA-LION-v4-27B-IT',
        'aisingapore/Qwen-SEA-LION-v4-32B-IT',
        'alpindale/WizardLM-2-8x22B',
        'dicta-il/DictaLM-3.0-24B-Thinking',
        'katanemo/Arch-Router-1.5B',
        'swiss-ai/Apertus-70B-Instruct-2509',
        'swiss-ai/Apertus-8B-Instruct-2509',
        'tokyotech-llm/Llama-3.3-Swallow-70B-Instruct-v0.4',
        'utter-project/EuroLLM-22B-Instruct-2512',
      ],
      reasoningFormat: 'none',
      authEnvVars: ['HF_API_KEY', 'HUGGINGFACE_API_KEY', 'HF_TOKEN'],
      serviceNames: ['huggingface'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'nvidia',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      apiKey: apiKey('nvidia'),
      defaultModel: 'deepseek-ai/deepseek-v3.2',
      models: [
        'deepseek-ai/deepseek-v3.2',
        'deepseek-ai/deepseek-v3.1',
        'deepseek-ai/deepseek-v3.1-terminus',
        'deepseek-ai/deepseek-r1-distill-qwen-32b',
        'deepseek-ai/deepseek-r1-distill-qwen-14b',
        'deepseek-ai/deepseek-r1-distill-qwen-7b',
        'deepseek-ai/deepseek-r1-distill-llama-8b',
        'deepseek-ai/deepseek-coder-6.7b-instruct',
        'nvidia/llama-3.1-nemotron-ultra-253b-v1',
        'nvidia/nemotron-3-super-120b-a12b',
        'nvidia/nemotron-4-340b-instruct',
        'nvidia/llama-3.3-nemotron-super-49b-v1.5',
        'nvidia/llama-3.3-nemotron-super-49b-v1',
        'nvidia/llama-3.1-nemotron-70b-instruct',
        'nvidia/llama-3.1-nemotron-51b-instruct',
        'nvidia/nemotron-3-nano-30b-a3b',
        'nvidia/nemotron-nano-3-30b-a3b',
        'nvidia/nemotron-nano-12b-v2-vl',
        'nvidia/nvidia-nemotron-nano-9b-v2',
        'nvidia/llama-3.1-nemotron-nano-8b-v1',
        'nvidia/llama-3.1-nemotron-nano-vl-8b-v1',
        'nvidia/llama-3.1-nemotron-nano-4b-v1.1',
        'nvidia/nemotron-mini-4b-instruct',
        'nvidia/nemotron-4-mini-hindi-4b-instruct',
        'nvidia/usdcode-llama-3.1-70b-instruct',
        'nvidia/llama3-chatqa-1.5-70b',
        'nvidia/llama3-chatqa-1.5-8b',
        'nvidia/mistral-nemo-minitron-8b-8k-instruct',
        'nvidia/cosmos-reason2-8b',
        'meta/llama-3.1-405b-instruct',
        'meta/llama-3.2-90b-vision-instruct',
        'meta/llama-3.3-70b-instruct',
        'meta/llama-3.1-70b-instruct',
        'meta/llama3-70b-instruct',
        'meta/llama2-70b',
        'meta/codellama-70b',
        'meta/llama-4-maverick-17b-128e-instruct',
        'meta/llama-4-scout-17b-16e-instruct',
        'meta/llama-3.2-11b-vision-instruct',
        'meta/llama-3.1-8b-instruct',
        'meta/llama3-8b-instruct',
        'meta/llama-3.2-3b-instruct',
        'meta/llama-3.2-1b-instruct',
        'qwen/qwen3.5-397b-a17b',
        'qwen/qwen3-coder-480b-a35b-instruct',
        'qwen/qwen3.5-122b-a10b',
        'qwen/qwen3-next-80b-a3b-instruct',
        'qwen/qwen3-next-80b-a3b-thinking',
        'qwen/qwq-32b',
        'qwen/qwen2.5-coder-32b-instruct',
        'qwen/qwen2.5-coder-7b-instruct',
        'qwen/qwen2.5-7b-instruct',
        'qwen/qwen2-7b-instruct',
        'moonshotai/kimi-k2.5',
        'moonshotai/kimi-k2-thinking',
        'moonshotai/kimi-k2-instruct',
        'moonshotai/kimi-k2-instruct-0905',
        'mistralai/mistral-large-3-675b-instruct-2512',
        'mistralai/mistral-large-2-instruct',
        'mistralai/mistral-large',
        'mistralai/mistral-medium-3-instruct',
        'mistralai/mistral-small-4-119b-2603',
        'mistralai/mistral-small-3.1-24b-instruct-2503',
        'mistralai/mistral-small-24b-instruct',
        'mistralai/mistral-nemotron',
        'mistralai/magistral-small-2506',
        'mistralai/devstral-2-123b-instruct-2512',
        'mistralai/codestral-22b-instruct-v0.1',
        'mistralai/mamba-codestral-7b-v0.1',
        'mistralai/mathstral-7b-v0.1',
        'mistralai/ministral-14b-instruct-2512',
        'mistralai/mistral-7b-instruct-v0.3',
        'mistralai/mistral-7b-instruct-v0.2',
        'mistralai/mixtral-8x22b-instruct-v0.1',
        'mistralai/mixtral-8x7b-instruct-v0.1',
        'google/gemma-3-27b-it',
        'google/gemma-3-12b-it',
        'google/gemma-3-4b-it',
        'google/gemma-3-1b-it',
        'google/gemma-3n-e4b-it',
        'google/gemma-3n-e2b-it',
        'google/gemma-2-27b-it',
        'google/gemma-2-9b-it',
        'google/gemma-2-2b-it',
        'google/codegemma-1.1-7b',
        'google/codegemma-7b',
        'microsoft/phi-4-multimodal-instruct',
        'microsoft/phi-4-mini-instruct',
        'microsoft/phi-4-mini-flash-reasoning',
        'microsoft/phi-3.5-moe-instruct',
        'microsoft/phi-3.5-vision-instruct',
        'microsoft/phi-3.5-mini-instruct',
        'microsoft/phi-3-medium-128k-instruct',
        'microsoft/phi-3-medium-4k-instruct',
        'microsoft/phi-3-small-128k-instruct',
        'microsoft/phi-3-small-8k-instruct',
        'microsoft/phi-3-mini-128k-instruct',
        'microsoft/phi-3-mini-4k-instruct',
        'microsoft/phi-3-vision-128k-instruct',
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'ibm/granite-34b-code-instruct',
        'ibm/granite-3.3-8b-instruct',
        'ibm/granite-3.0-8b-instruct',
        'ibm/granite-3.0-3b-a800m-instruct',
        'ibm/granite-8b-code-instruct',
        'z-ai/glm5',
        'z-ai/glm4.7',
        'minimaxai/minimax-m2.5',
        'bytedance/seed-oss-36b-instruct',
        'stepfun-ai/step-3.5-flash',
        'writer/palmyra-creative-122b',
        'writer/palmyra-fin-70b-32k',
        'writer/palmyra-med-70b',
        'writer/palmyra-med-70b-32k',
      ],
      reasoningFormat: 'none',
      authEnvVars: ['NVIDIA_API_KEY'],
      serviceNames: ['nvidia'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'llm7',
      baseURL: 'https://api.llm7.io/v1',
      apiKey: apiKey('llm7'),
      defaultModel: 'codestral-latest',
      models: [
        'GLM-4.6V-Flash',
        'codestral-latest',
        'gpt-oss-20b',
        'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
        'ministral-8b-2512',
      ],
      reasoningFormat: 'none',
      authEnvVars: ['LLM7_API_KEY'],
      serviceNames: ['llm7'],
    }),
  );

  for (const definition of BUILTIN_COMPAT_PROVIDERS) {
    if (hasProvider(definition.id)) continue;
    const resolvedKey = apiKey(definition.id);
    registry.register(createBuiltinCompatProvider(definition, resolvedKey, options));
  }

  registry.register(new AmazonBedrockProvider());
  registry.register(new AmazonBedrockMantleProvider());
  registry.register(new AnthropicVertexProvider());
  registry.register(new GitHubCopilotProvider());

  // Synthetic failover provider — must be after all backends.
  // Stage 3: catalog-driven SyntheticProvider manages its own backend lists.
  registry.register(new SyntheticProvider({
    resolveProvider: options.resolveProvider,
    getCatalogModels: options.getCatalogModels,
    getBenchmarks: options.getBenchmarks,
    runtimeBus: options.runtimeBus,
  }));
}
