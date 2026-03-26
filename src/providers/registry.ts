import type { LLMProvider } from './interface.ts';
import type { DiscoveredServer } from '../discovery/scanner.ts';
import { OpenAIProvider } from './openai.ts';
import { OpenAICompatProvider } from './openai-compat.ts';
import { AnthropicProvider } from './anthropic.ts';
import { GeminiProvider } from './gemini.ts';
import { config } from '../config/index.ts';
import type { EventBus } from '../core/event-bus.ts';
import { loadCustomProviders, watchCustomProviders } from './custom-loader.ts';

/** Model capability tier — controls system prompt verbosity. */
export type ModelTier = 'free' | 'standard' | 'premium';

/** Describes a selectable model and its capabilities. */
export interface ModelDefinition {
  id: string;
  provider: string;
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
}

const BUILTIN_MODEL_REGISTRY: ModelDefinition[] = [
  // --- InceptionLabs ---
  {
    id: 'mercury-2',
    provider: 'inceptionlabs',
    displayName: 'Mercury 2',
    description: 'InceptionLabs diffusion LLM with configurable reasoning depth.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: true, multimodal: false },
    contextWindow: 32768,
    selectable: true,
    reasoningEffort: ['instant', 'low', 'medium', 'high'],
    tier: 'standard',
  },
  {
    id: 'mercury-edit',
    provider: 'inceptionlabs',
    displayName: 'Mercury Edit',
    description: 'InceptionLabs specialised code-editing model (not user-selectable).',
    capabilities: { toolCalling: false, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 32768,
    selectable: false,
    tier: 'standard',
  },

  // --- OpenAI ---
  {
    id: 'gpt-5.4',
    provider: 'openai',
    displayName: 'GPT-5.4',
    description: 'OpenAI flagship model.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 128000,
    selectable: true,
    tier: 'premium',
  },
  {
    id: 'gpt-5.3-chat-latest',
    provider: 'openai',
    displayName: 'GPT-5.3 Chat (latest)',
    description: 'OpenAI GPT-5.3 chat optimised model.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 128000,
    selectable: true,
    tier: 'premium',
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    displayName: 'GPT-5 Mini',
    description: 'OpenAI lightweight fast model.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 128000,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'gpt-5-nano',
    provider: 'openai',
    displayName: 'GPT-5 Nano',
    description: 'OpenAI ultra-lightweight model for edge tasks.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 32768,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'gpt-oss-120b',
    provider: 'openai',
    displayName: 'GPT OSS 120B',
    description: 'OpenAI open-source 120B parameter model.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 128000,
    selectable: true,
    tier: 'standard',
  },

  // --- Gemini ---
  {
    id: 'gemini-3.1-pro-preview',
    provider: 'gemini',
    displayName: 'Gemini 3.1 Pro (preview)',
    description: 'Google Gemini 3.1 Pro preview.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'premium',
  },
  {
    id: 'gemini-3-flash',
    provider: 'gemini',
    displayName: 'Gemini 3 Flash',
    description: 'Google Gemini 3 Flash — fast and cost-efficient.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'gemini-3.1-flash-lite-preview',
    provider: 'gemini',
    displayName: 'Gemini 3.1 Flash Lite (preview)',
    description: 'Google Gemini 3.1 Flash Lite preview — ultra-fast.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 128000,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'gemini-2.5-pro',
    provider: 'gemini',
    displayName: 'Gemini 2.5 Pro',
    description: 'Google Gemini 2.5 Pro — current stable release.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'premium',
  },

  // --- OpenRouter (free) ---
  {
    id: 'openrouter/free',
    provider: 'openrouter',
    displayName: 'Free Models Router',
    description: 'Auto-routes to the best available free model on OpenRouter.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 200000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'arcee-ai/trinity-mini:free',
    provider: 'openrouter',
    displayName: 'Arcee AI Trinity Mini',
    description: 'Arcee AI Trinity Mini — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'minimax/minimax-m2.5:free',
    provider: 'openrouter',
    displayName: 'MiniMax M2.5',
    description: 'MiniMax M2.5 — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 196608,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'nvidia/nemotron-3-super-120b-a12b:free',
    provider: 'openrouter',
    displayName: 'Nemotron 3 Super 120B',
    description: 'NVIDIA Nemotron 3 Super 120B MoE — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 262144,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'nvidia/nemotron-3-nano-30b-a3b:free',
    provider: 'openrouter',
    displayName: 'Nemotron 3 Nano 30B',
    description: 'NVIDIA Nemotron 3 Nano 30B — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 256000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'nvidia/nemotron-nano-12b-v2-vl:free',
    provider: 'openrouter',
    displayName: 'Nemotron Nano 12B V2 VL',
    description: 'NVIDIA Nemotron Nano 12B V2 with vision — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 128000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'nvidia/nemotron-nano-9b-v2:free',
    provider: 'openrouter',
    displayName: 'Nemotron Nano 9B V2',
    description: 'NVIDIA Nemotron Nano 9B V2 — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 128000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'openai/gpt-oss-120b:free',
    provider: 'openrouter',
    displayName: 'GPT OSS 120B',
    description: 'OpenAI open-source 120B via OpenRouter — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'openai/gpt-oss-20b:free',
    provider: 'openrouter',
    displayName: 'GPT OSS 20B',
    description: 'OpenAI open-source 20B via OpenRouter — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'stepfun/step-3.5-flash:free',
    provider: 'openrouter',
    displayName: 'Step 3.5 Flash',
    description: 'StepFun Step 3.5 Flash — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 256000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'z-ai/glm-4.5-air:free',
    provider: 'openrouter',
    displayName: 'GLM 4.5 Air',
    description: 'Z.ai GLM 4.5 Air — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },

  // --- Anthropic ---
  {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    displayName: 'Claude Opus 4.6',
    description: 'Anthropic most powerful model.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'premium',
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 4.6',
    description: 'Anthropic balanced model — fast and capable.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'premium',
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    description: 'Anthropic lightweight fast model.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 200000,
    selectable: true,
    tier: 'standard',
  },
  // --- AIHubMix (Free) ---
  // All models below are confirmed free ($0/M tokens) with rate limits:
  // 5 req/min, 250-500 req/day, 500K-1M tokens/day
  {
    id: 'gpt-4.1-free',
    provider: 'aihubmix',
    displayName: 'GPT-4.1 (Free)',
    description: 'Free GPT-4.1 via Azure. Content filter enforced.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gpt-4.1-mini-free',
    provider: 'aihubmix',
    displayName: 'GPT-4.1 Mini (Free)',
    description: 'Free GPT-4.1 Mini via Azure. Content filter enforced.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gpt-4.1-nano-free',
    provider: 'aihubmix',
    displayName: 'GPT-4.1 Nano (Free)',
    description: 'Free GPT-4.1 Nano via Azure. Content filter enforced.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 1000000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gpt-4o-free',
    provider: 'aihubmix',
    displayName: 'GPT-4o (Free)',
    description: 'Free GPT-4o via Azure. Content filter enforced.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gemini-2.0-flash-free',
    provider: 'aihubmix',
    displayName: 'Gemini 2.0 Flash (Free)',
    description: 'Free Gemini 2.0 Flash. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gemini-3-flash-preview-free',
    provider: 'aihubmix',
    displayName: 'Gemini 3 Flash Preview (Free)',
    description: 'Free Gemini 3 Flash preview. 5 req/min, 250 req/day, 500K tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gemini-3.1-flash-image-preview-free',
    provider: 'aihubmix',
    displayName: 'Gemini 3.1 Flash Image (Free)',
    description: 'Free Gemini 3.1 Flash image generation preview.',
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'glm-4.7-flash-free',
    provider: 'aihubmix',
    displayName: 'GLM-4.7 Flash (Free)',
    description: 'Free GLM-4.7 Flash. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 128000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-glm-4.6-free',
    provider: 'aihubmix',
    displayName: 'Coding GLM-4.6 (Free)',
    description: 'Free coding-optimised GLM-4.6. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 200000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-glm-4.7-free',
    provider: 'aihubmix',
    displayName: 'Coding GLM-4.7 (Free)',
    description: 'Free coding-optimised GLM-4.7. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 128000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-glm-5-free',
    provider: 'aihubmix',
    displayName: 'Coding GLM-5 (Free)',
    description: 'Free coding-optimised GLM-5. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 128000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-glm-5-turbo-free',
    provider: 'aihubmix',
    displayName: 'Coding GLM-5 Turbo (Free)',
    description: 'Free fast coding-optimised GLM-5. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 128000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-minimax-m2-free',
    provider: 'aihubmix',
    displayName: 'Coding MiniMax M2 (Free)',
    description: 'Free coding-optimised MiniMax M2. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 204000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-minimax-m2.1-free',
    provider: 'aihubmix',
    displayName: 'Coding MiniMax M2.1 (Free)',
    description: 'Free coding-optimised MiniMax M2.1. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 204000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-minimax-m2.5-free',
    provider: 'aihubmix',
    displayName: 'Coding MiniMax M2.5 (Free)',
    description: 'Free coding-optimised MiniMax M2.5. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 204000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-minimax-m2.7-free',
    provider: 'aihubmix',
    displayName: 'Coding MiniMax M2.7 (Free)',
    description: 'Free coding-optimised MiniMax M2.7. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 204000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'kimi-for-coding-free',
    provider: 'aihubmix',
    displayName: 'Kimi for Coding (Free)',
    description: 'Free Kimi coding model by Moonshot AI. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 256000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'mimo-v2-flash-free',
    provider: 'aihubmix',
    displayName: 'MiMo V2 Flash (Free)',
    description: 'Free Xiaomi MiMo V2 Flash. MoE 309B/15B active, 256K context, #1 open-source on SWE-bench.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 256000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'minimax-m2.5-free',
    provider: 'aihubmix',
    displayName: 'MiniMax M2.5 (Free)',
    description: 'Free MiniMax M2.5 via DaoCloud. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 204000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'step-3.5-flash-free',
    provider: 'aihubmix',
    displayName: 'Step 3.5 Flash (Free)',
    description: 'Free StepFun Step 3.5 Flash. 5 req/min, 250 req/day, 500K tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 256000,
    selectable: true,
    tier: 'free',
  },
];

/** Mutable array of custom-loaded model definitions. */
let customModels: ModelDefinition[] = [];

/** Mutable array of discovered (scanned) model definitions — lowest priority. */
let discoveredModels: ModelDefinition[] = [];

/**
 * Returns the combined model registry: custom models take precedence over built-ins
 * when a custom model has the same ID as a built-in.
 */
export function getModelRegistry(): ModelDefinition[] {
  const builtinFiltered = BUILTIN_MODEL_REGISTRY.filter(
    (b) => !customModels.some((c) => c.id === b.id),
  );
  const discoveredFiltered = discoveredModels.filter(
    (d) =>
      !BUILTIN_MODEL_REGISTRY.some((b) => b.id === d.id) &&
      !customModels.some((c) => c.id === d.id),
  );
  return [...customModels, ...builtinFiltered, ...discoveredFiltered];
}

/**
 * Backward-compatible export. Prefer getModelRegistry() for live model lists.
 * This refers to the built-in models only and does NOT include custom providers.
 * @deprecated Use getModelRegistry() to include custom providers.
 */
export const MODEL_REGISTRY: ModelDefinition[] = BUILTIN_MODEL_REGISTRY;

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

    this.register(new OpenAIProvider(apiKey('openai')));
    this.register(new AnthropicProvider(apiKey('anthropic')));
    this.register(new GeminiProvider(apiKey('gemini')));
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
          selectable: true,
          tier: 'standard',
        });
      }
    }
  }

  /** Retrieve a provider by name. Throws if not found. */
  get(name: string): LLMProvider {
    const p = this.providers.get(name);
    if (!p) throw new Error(`Provider '${name}' is not registered.`);
    return p;
  }

  /** Return the provider responsible for a given model ID. */
  getForModel(modelId: string): LLMProvider {
    const def = getModelRegistry().find((m) => m.id === modelId);
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
    const def = getModelRegistry().find((m) => m.id === this.currentModelId);
    if (!def) {
      // Check if this is a discovered/custom model that hasn't loaded yet.
      // Don't clobber currentModelId — return a placeholder so the saved ID is preserved
      // until the discovered provider registers later.
      const isBuiltin = BUILTIN_MODEL_REGISTRY.some((m) => m.id === this.currentModelId);
      if (!isBuiltin && this.currentModelId) {
        return {
          id: this.currentModelId,
          provider: config.provider ?? 'unknown',
          displayName: this.currentModelId,
          description: 'Waiting for provider discovery...',
          capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
          contextWindow: 0, // Unknown until provider discovery completes; 0 = no progress bar
          selectable: true,
          tier: 'standard' as ModelTier,
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

  /** Switch to a different model. Throws if the model is not selectable. */
  setCurrentModel(modelId: string): void {
    const def = getModelRegistry().find((m) => m.id === modelId);
    if (!def) throw new Error(`Model '${modelId}' not found.`);
    if (!def.selectable) throw new Error(`Model '${modelId}' is not selectable.`);
    this.currentModelId = modelId;
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

    // Warn about collisions with built-in models
    for (const model of result.models) {
      const isBuiltin = BUILTIN_MODEL_REGISTRY.some((b) => b.id === model.id);
      if (isBuiltin) {
        const msg = `[registry] Custom model '${model.id}' from provider '${model.provider}' overrides built-in model.`;
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
