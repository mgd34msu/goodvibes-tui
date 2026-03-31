import type { LLMProvider } from './interface.ts';
import type { DiscoveredServer } from '../discovery/scanner.ts';
import { OpenAIProvider } from './openai.ts';
import { OpenAICompatProvider } from './openai-compat.ts';
import { AnthropicProvider } from './anthropic.ts';
import { GeminiProvider } from './gemini.ts';
import { config } from '../config/index.ts';
import type { EventBus } from '../core/event-bus.ts';
import { loadCustomProviders, watchCustomProviders } from './custom-loader.ts';
import { SyntheticProvider } from './synthetic.ts';

import { getCatalogModelDefinitions, getSyntheticModelDefinitions, getSyntheticBackendModelIds } from './model-catalog.ts';

/** Model capability tier — controls system prompt verbosity. */
export type ModelTier = 'free' | 'standard' | 'premium' | 'subscription';

/** Per-model token limits for output, tool results, tool calls, and reasoning. */
export interface TokenLimits {
  maxOutputTokens?: number;       // max generation tokens sent as max_tokens to API
  maxToolResultTokens?: number;   // max tokens per tool result before truncation
  maxToolCalls?: number;          // max parallel tool calls per turn
  maxReasoningTokens?: number;    // budget for thinking/reasoning
}

/** Describes a selectable model and its capabilities. */
export interface ModelDefinition {
  id: string;
  provider: string;
  /** Compound unique key: `${provider}:${id}`. Safe separator since model IDs use `/` not `:`. */
  registryKey: string;
  displayName: string;
  description: string;
  capabilities: {
    toolCalling: boolean;
    codeEditing: boolean;
    reasoning: boolean;
    multimodal: boolean;
  };
  contextWindow: number;
  /** Whether the user can select this model in the model picker. */
  selectable: boolean;
  /** Available reasoning effort levels for this model (controls UI effort picker). */
  reasoningEffort?: string[];
  /** Model capability tier — controls system prompt verbosity. */
  tier?: ModelTier;
  /** Per-model token limits; overrides defaults and OpenRouter data when set. */
  tokenLimits?: TokenLimits;
}


/**
 * Returns built-in model definitions sourced from the model catalog.
 * Merge order in getModelRegistry(): custom providers → synthetic → catalog → discovered servers.
 */
function getCatalogBuiltins(): ModelDefinition[] {
  return getCatalogModelDefinitions() as ModelDefinition[];
}

/**
 * Returns synthetic failover model definitions.
 * These have provider='synthetic' and use canonical slug IDs.
 */
function getSyntheticBuiltins(): ModelDefinition[] {
  return getSyntheticModelDefinitions() as ModelDefinition[];
}


/** Mutable array of custom-loaded model definitions. */
let customModels: ModelDefinition[] = [];

/** Mutable array of discovered (scanned) model definitions — lowest priority. */
let discoveredModels: ModelDefinition[] = [];

/**
 * Returns the combined model registry.
 *
 * Merge order (highest → lowest priority):
 * 1. Custom providers from ~/.goodvibes/tui/providers/
 * 2. Synthetic failover models (multi-provider canonical models)
 * 3. Catalog-sourced models (from getCatalogBuiltins() / model-catalog.ts)
 * 4. Discovered local servers (lowest priority)
 */
export function getModelRegistry(): ModelDefinition[] {
  const catalogModels = getCatalogBuiltins();
  const syntheticModels = getSyntheticBuiltins();

  // Catalog models not overridden by custom providers and not represented as
  // synthetic canonical backends (prevents hf: and other raw backend IDs from
  // appearing alongside clean synthetic canonical slugs in the model picker).
  const catalogFiltered = catalogModels.filter(
    (b) =>
      !customModels.some((c) => c.id === b.id) &&
      // Filter out raw hf: prefixed IDs — these are HuggingFace catalog entries that
      // should not appear in the model picker.
      !b.id.startsWith('hf:'),
  );

  // Discovered server models not already covered by catalog or custom
  const discoveredFiltered = discoveredModels.filter(
    (d) =>
      !catalogModels.some((b) => b.id === d.id) &&
      !customModels.some((c) => c.id === d.id),
  );

  // Ensure every model has a registryKey
  const ensureKey = (m: ModelDefinition): ModelDefinition =>
    m.registryKey ? m : { ...m, registryKey: `${m.provider}:${m.id}` };

  return [
    ...customModels.map(ensureKey),
    ...syntheticModels.map(ensureKey),  // synthetic before catalog so they take priority
    ...catalogFiltered.map(ensureKey),
    ...discoveredFiltered.map(ensureKey),
  ];
}

/**
 * Maps catalog provider IDs to registered provider names when they differ.
 * Add an entry when a catalog's provider ID does not match the register() name.
 */
const PROVIDER_ALIASES: Record<string, string> = {
  'inception': 'inceptionlabs',
};

/**
 * ProviderRegistry — manages LLM provider instances and model selection.
 * Lazily instantiates providers on first use.
 */
export class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();
  private currentModelId: string;
  private discoveredProviderNames: Set<string> = new Set();

  constructor() {
    this.currentModelId = config.model ?? 'openrouter/free';
    this.registerBuiltins();
  }

  private registerBuiltins(): void {
    const apiKey = (name: string): string => {
      const key = config.apiKeys[name] ?? '';
      if (!key) {
        // Silently skip — console.warn corrupts TUI display. Missing keys are handled at request time.
      }
      return key;
    };

    this.register(
      new OpenAICompatProvider({
        name: 'inceptionlabs',
        baseURL: 'https://api.inceptionlabs.ai/v1',
        apiKey: apiKey('inceptionlabs'),
        defaultModel: 'mercury-2',
        models: ['mercury-2', 'mercury-edit'],
        reasoningFormat: 'mercury',
      }),
    );

    this.register(
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
      }),
    );

    this.register(
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
      }),
    );

    this.register(
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
      }),
    );

    this.register(
      new OpenAICompatProvider({
        name: 'cerebras',
        baseURL: 'https://api.cerebras.ai/v1',
        apiKey: apiKey('cerebras'),
        defaultModel: 'qwen-3-235b-a22b-instruct-2507',
        models: ['llama3.1-8b', 'qwen-3-235b-a22b-instruct-2507'],
        reasoningFormat: 'none',
      }),
    );

    this.register(
      new OpenAICompatProvider({
        name: 'mistral',
        baseURL: 'https://api.mistral.ai/v1',
        apiKey: apiKey('mistral'),
        defaultModel: 'mistral-large-latest',
        models: [
          'mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest',
          'codestral-latest', 'devstral-latest', 'devstral-medium-latest', 'devstral-small-latest',
          'magistral-medium-latest', 'magistral-small-latest',
          'ministral-14b-latest', 'ministral-8b-latest', 'ministral-3b-latest',
          'pixtral-large-latest', 'open-mistral-nemo',
        ],
        reasoningFormat: 'none',
      }),
    );

    this.register(
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
      }),
    );


    this.register(new OpenAIProvider(apiKey('openai')));
    this.register(new AnthropicProvider(apiKey('anthropic')));
    this.register(new GeminiProvider(apiKey('gemini')));

    this.register(
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
      }),
    );

    this.register(
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
      }),
    );

    this.register(
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
      }),
    );

    // Synthetic failover provider — must be after all backends.
    // Stage 3: catalog-driven SyntheticProvider manages its own backend lists.
    this.register(new SyntheticProvider());
  }

  /** Register a provider. Overwrites any existing entry with the same name. */
  register(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Register providers discovered by the local LLM scanner.
   * Clears previously discovered providers before re-registering.
   * Does not overwrite built-in or custom-loaded providers/models.
   */
  registerDiscoveredProviders(servers: DiscoveredServer[]): void {
    // Unregister previously discovered providers
    for (const name of this.discoveredProviderNames) {
      this.providers.delete(name);
    }
    this.discoveredProviderNames.clear();
    discoveredModels = [];

    for (const server of servers) {
      // Skip if a non-discovered provider already holds this name
      if (this.providers.has(server.name)) continue;
      // Skip servers with no models — defaultModel would be undefined
      if (server.models.length === 0) continue;

      // Map serverType to reasoningFormat so discovered providers send correct params
      const reasoningFormat = 
        server.serverType === 'llamacpp' ? 'llamacpp' as const :
        server.serverType === 'ollama' ? 'llamacpp' as const : // Ollama uses same enable_thinking param
        'none' as const;

      const provider = new OpenAICompatProvider({
        name: server.name,
        baseURL: server.baseURL,
        apiKey: '',
        defaultModel: server.models[0],
        models: server.models,
        reasoningFormat,
      });

      this.providers.set(server.name, provider);
      this.discoveredProviderNames.add(server.name);

      for (const modelId of server.models) {
        discoveredModels.push({
          id: modelId,
          provider: server.name,
          registryKey: `${server.name}:${modelId}`,
          displayName: modelId,
          description: `Discovered local model on ${server.baseURL}`,
          capabilities: {
            toolCalling: true,
            codeEditing: true,
            reasoning: reasoningFormat !== 'none',
            multimodal: false,
          },
          ...(reasoningFormat !== 'none' ? { reasoningEffort: ['low', 'medium', 'high'] } : {}),
          contextWindow: server.modelContextWindows?.[modelId] ?? 8192,
          ...(server.modelOutputLimits?.[modelId] != null
            ? { tokenLimits: { maxOutputTokens: server.modelOutputLimits[modelId] } }
            : {}),
          selectable: true,
          tier: 'standard',
        });
      }
    }
  }

  /** Retrieve a provider by name. Throws if not found. */
  get(name: string): LLMProvider {
    const p = this.providers.get(name);
    if (p) return p;
    // Check alias map — catalog may use a different name than the registered provider
    const aliased = PROVIDER_ALIASES[name];
    if (aliased) {
      const pa = this.providers.get(aliased);
      if (pa) return pa;
    }
    throw new Error(`Provider '${name}' is not registered.`);
  }

  /** Return the provider responsible for a given model ID.
   * Accepts a registryKey (`provider:modelId`) OR a plain modelId.
   * - If input contains `:`, treats as registryKey — exact match on `m.registryKey`
   * - If no `:`, treats as plain modelId — fallback match on `m.id` (backward compat)
   * When `provider` is supplied alongside a plain modelId, it disambiguates.
   * Falls back to provider-agnostic search if constrained search yields nothing.
   */
  getForModel(modelId: string, provider?: string): LLMProvider {
    const registry = getModelRegistry();
    let def: ModelDefinition | undefined;
    if (modelId.includes(':')) {
      // registryKey format — exact match
      def = registry.find((m) => m.registryKey === modelId);
      // Fallback: try plain modelId match in case registryKey not yet populated
      if (!def) def = registry.find((m) => m.id === modelId);
    } else {
      // Plain modelId — backward compat
      def = provider
        ? (registry.find((m) => m.id === modelId && m.provider === provider) ??
           registry.find((m) => m.id === modelId))
        : registry.find((m) => m.id === modelId);
    }
    if (!def) throw new Error(`No model '${modelId}' in registry.`);
    return this.get(def.provider);
  }

  /** All registered model definitions. */
  listModels(): ModelDefinition[] {
    return getModelRegistry();
  }

  /** Only the models the user can switch to. */
  getSelectableModels(): ModelDefinition[] {
    return getModelRegistry().filter((m) => m.selectable);
  }

  /** Currently active model definition. */
  getCurrentModel(): ModelDefinition {
    // Support registryKey lookup: if currentModelId contains ':', treat as registryKey
    const registry = getModelRegistry();
    const def = this.currentModelId.includes(':')
      ? (registry.find((m) => m.registryKey === this.currentModelId) ??
         registry.find((m) => m.id === this.currentModelId))
      : registry.find((m) => m.id === this.currentModelId);
    if (!def) {
      // Check if this is a discovered/custom model that hasn't loaded yet.
      // Don't clobber currentModelId — return a placeholder so the saved ID is preserved
      // until the discovered provider registers later.
      // Extract base model ID from registryKey if needed
      const baseId = this.currentModelId.includes(':')
        ? this.currentModelId.split(':').slice(1).join(':')
        : this.currentModelId;
      const isInCatalog = getCatalogBuiltins().some((m) => m.id === baseId || m.id === this.currentModelId);
      if (!isInCatalog && this.currentModelId) {
        const placeholderProvider = this.currentModelId.includes(':')
          ? this.currentModelId.split(':')[0]
          : (config.provider ?? 'unknown');
        return {
          id: baseId,
          provider: placeholderProvider ?? 'unknown',
          registryKey: this.currentModelId.includes(':') ? this.currentModelId : `${placeholderProvider}:${baseId}`,
          displayName: baseId,
          description: 'Waiting for provider discovery...',
          capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
          contextWindow: 0, // Unknown until provider discovery completes; 0 = no progress bar
          selectable: true,
          tier: 'standard',
        };
      }
      // Builtin model not found — genuinely broken, fall back to first selectable
      const fallback = getModelRegistry().find((m) => m.selectable);
      if (fallback) {
        this.currentModelId = fallback.id;
        return fallback;
      }
      throw new Error(`Current model '${this.currentModelId}' not in registry.`);
    }
    return def;
  }

  /** Switch to a different model. Accepts registryKey or plain modelId. Throws if not selectable. */
  setCurrentModel(modelId: string): void {
    const registry = getModelRegistry();
    const def = modelId.includes(':')
      ? (registry.find((m) => m.registryKey === modelId) ?? registry.find((m) => m.id === modelId))
      : registry.find((m) => m.id === modelId);
    if (!def) throw new Error(`Model '${modelId}' not found.`);
    if (!def.selectable) throw new Error(`Model '${modelId}' is not selectable.`);
    // Store the registryKey for unambiguous future lookups
    this.currentModelId = def.registryKey ?? modelId;
  }

  /**
   * Load custom providers from ~/.goodvibes/tui/providers/ and merge them
   * into the live model registry. Returns any warnings collected during loading.
   * Call this after construction to populate custom providers.
   */
  async loadCustomProviders(): Promise<{ warnings: string[]; added: string[]; removed: string[]; updated: string[] }> {
    const result = await loadCustomProviders();
    const previousIds = new Set(customModels.map((m) => m.id));
    const newIds = new Set(result.models.map((m) => m.id));

    const added: string[] = [];
    const removed: string[] = [];
    const updated: string[] = [];

    for (const id of newIds) {
      if (!previousIds.has(id)) {
        added.push(id);
      } else {
        // Only mark as updated if the model definition actually changed
        const oldModel = customModels.find((m) => m.id === id);
        const newModel = result.models.find((m) => m.id === id);
        if (stableStringify(oldModel) !== stableStringify(newModel)) {
          updated.push(id);
        }
      }
    }
    for (const id of previousIds) {
      if (!newIds.has(id)) removed.push(id);
    }

    // Warn about collisions with catalog models
    const catalogIds = new Set(getCatalogBuiltins().map((b) => b.id));
    for (const model of result.models) {
      if (catalogIds.has(model.id)) {
        const msg = `[registry] Custom model '${model.id}' from provider '${model.provider}' overrides catalog model.`;
        result.warnings.push(msg);
        // Warning already added to result.warnings — don't console.warn (corrupts TUI)
      }
    }

    // Register provider instances
    for (const { provider } of result.providers) {
      this.register(provider);
    }

    // Swap custom models
    customModels = result.models;

    return { warnings: result.warnings, added, removed, updated };
  }

  /**
   * Start watching ~/.goodvibes/tui/providers/ for file changes.
   * On change, reloads custom providers and emits 'providers:changed' on the bus.
   * Safe to call multiple times — stops the previous watcher first.
   */
  startWatching(bus: EventBus): void {
    this.stopWatching();
    this._watcher = watchCustomProviders(bus, async () => {
      const result = await this.loadCustomProviders();
      for (const msg of result.warnings) {
        bus.emit('providers:warning', { message: msg });
      }
      bus.emit('providers:changed', {
        added: result.added,
        removed: result.removed,
        updated: result.updated,
      });
    });
  }

  /** Stop the file watcher started by startWatching(). */
  stopWatching(): void {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = undefined;
    }
  }

  private _watcher: { close: () => void } | undefined;

  /**
   * Returns a promise that resolves when the initial custom provider load
   * completes. Callers can await this before calling getForModel() with a
   * custom model ID to avoid a "model not found" race window.
   */
  ready(): Promise<void> {
    return this._readyPromise ?? Promise.resolve();
  }

  private _readyPromise: Promise<void> | null = null;

  /**
   * Find an alternative model when the current provider fails non-transiently.
   * Prefers a synthetic failover wrapper; falls back to same-tier model on a different provider.
   */
  findAlternativeModel(currentModelId: string): ModelDefinition | null {
    const current = getModelRegistry().find(m => m.id === currentModelId);
    if (!current || current.provider === 'synthetic') return null;
    // Check if synthetic wrapper exists
    const baseName = current.id.split('/').pop() ?? '';
    const syntheticMatch = getModelRegistry().find(m => m.provider === 'synthetic' && (m.id === baseName || m.id.endsWith('/' + baseName)));
    if (syntheticMatch) return syntheticMatch;
    // Find same-tier model on different provider
    return getModelRegistry().find(m => m.id !== currentModelId && m.provider !== current.provider && m.tier === current.tier && m.selectable) ?? null;
  }

  /** Kick off async custom provider loading. Called once from singleton factory. */
  initCustomProviders(): void {
    this._readyPromise = this.loadCustomProviders()
      .then((result) => {
        // Warnings captured in result.warnings — don't console.warn (corrupts TUI)
        this._readyPromise = null;
      })
      .catch((err) => {
        // Non-fatal — don't console.warn (corrupts TUI display)
        this._readyPromise = null;
      });
  }
}

/**
 * Key-order-independent JSON serialisation used for model diff comparisons.
 * Recursively sorts object keys so that { a: 1, b: 2 } and { b: 2, a: 1 }
 * produce the same string.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  return '{' + sorted.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

/** Lazy singleton — instantiated on first access. */
let _providerRegistry: ProviderRegistry | undefined;
export function getProviderRegistry(): ProviderRegistry {
  if (!_providerRegistry) {
    _providerRegistry = new ProviderRegistry();
    // Kick off custom provider loading asynchronously.
    // The registry is immediately usable with built-in providers; custom
    // providers will be available shortly after the first access.
    // Callers can await providerRegistry.ready() to wait for completion.
    _providerRegistry.initCustomProviders();
  }
  return _providerRegistry;
}
/** Reset singleton — for testing only. */
export function _resetProviderRegistryForTesting(): void {
  _providerRegistry = undefined;
  customModels = [];
  discoveredModels = [];
}

// Note: this Proxy only traps `get` and `has`. Direct property assignments
// and other traps (set, deleteProperty, etc.) are not forwarded — treat the
// providerRegistry export as read-only and call methods via the returned instance.
export const providerRegistry: ProviderRegistry = new Proxy({} as ProviderRegistry, {
  get(_target, prop: string | symbol) {
    const registry = getProviderRegistry();
    const value = (registry as unknown as Record<string | symbol, unknown>)[prop];
    // Bind methods to the singleton so `this` is correct when called via the proxy.
    if (typeof value === 'function') {
      return (value as Function).bind(registry);
    }
    return value;
  },
  has(_target, prop: string | symbol) {
    return prop in (getProviderRegistry() as unknown as Record<string | symbol, unknown>);
  },
});
