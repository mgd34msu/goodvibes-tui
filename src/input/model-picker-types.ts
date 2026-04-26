import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers/registry';

export type PickerMode = 'model' | 'provider' | 'effort' | 'contextCap';

/**
 * Which config keys the model picker writes to on commit.
 * 'main'   -> provider.provider + provider.model (default)
 * 'helper' -> helper.globalProvider + helper.globalModel (+ helper.enabled: true)
 * 'tool'   -> tools.llmProvider + tools.llmModel (+ tools.llmEnabled: true)
 * 'tts'    -> tts.llmProvider + tts.llmModel
 */
export type ModelPickerTarget = 'main' | 'helper' | 'tool' | 'tts';

/**
 * Pricing tier filter.
 * 'paid' matches ModelDefinition tiers 'standard' and 'premium' for forward-compat
 * with future CatalogModel tiers ('free' | 'paid' | 'subscription').
 */
export type CategoryFilter = 'all' | 'free' | 'paid' | 'subscription';

export type ModelFamily =
  | 'GPT'
  | 'Claude'
  | 'Gemini'
  | 'Llama'
  | 'Qwen'
  | 'GLM'
  | 'MiniMax'
  | 'DeepSeek'
  | 'Mistral'
  | 'Command'
  | 'Grok'
  | 'Kimi'
  | 'Other';

export type CapabilityFilter = 'reasoning' | 'toolUse' | 'multimodal' | 'none';
export type BenchmarkSort = 'none' | 'composite' | 'swe' | 'gpqa';
export type GroupByMode = 'provider' | 'family' | 'pricingTier' | 'qualityTier';

const FAMILY_PATTERNS: Array<{ pattern: RegExp; family: ModelFamily }> = [
  { pattern: /claude/i,          family: 'Claude' },
  { pattern: /gpt|\bo1\b|\bo3\b|\bo4\b/i, family: 'GPT' },
  { pattern: /gemini/i,          family: 'Gemini' },
  { pattern: /llama/i,           family: 'Llama' },
  { pattern: /qwen/i,            family: 'Qwen' },
  { pattern: /glm|chatglm/i,     family: 'GLM' },
  { pattern: /minimax|abab/i,    family: 'MiniMax' },
  { pattern: /deepseek/i,        family: 'DeepSeek' },
  { pattern: /mistral|mixtral/i, family: 'Mistral' },
  { pattern: /command|cohere/i,  family: 'Command' },
  { pattern: /grok/i,            family: 'Grok' },
  { pattern: /kimi|moonshot/i,   family: 'Kimi' },
];

export function detectFamily(model: ModelDefinition): ModelFamily {
  const haystack = `${model.id} ${model.displayName}`;
  for (const { pattern, family } of FAMILY_PATTERNS) {
    if (pattern.test(haystack)) return family;
  }
  return 'Other';
}

export function tierToCategoryFilter(tier: string | undefined): CategoryFilter {
  if (tier === 'free') return 'free';
  if (tier === 'subscription') return 'subscription';
  return 'paid';
}

export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  isGroupHeader?: boolean;
  qualityTier?: string;
  isPinned?: boolean;
  isFree?: boolean;
  isConfigured?: boolean;
  configuredVia?: 'env' | 'secrets' | 'subscription' | 'anonymous';
}

export const POPULAR_PROVIDERS: ReadonlySet<string> = new Set([
  'anthropic',
  'google',
  'groq',
  'mistral',
  'nvidia',
  'ollama',
  'openai',
  'openrouter',
  'synthetic',
]);

export interface FilteredModelsCache {
  readonly modelsRef: ModelDefinition[];
  readonly configuredProvidersKey: string;
  readonly pinnedIdsKey: string;
  readonly recentIdsKey: string;
  readonly query: string;
  readonly categoryFilter: CategoryFilter;
  readonly capabilityFilter: CapabilityFilter;
  readonly availableOnly: boolean;
  readonly benchmarkSort: BenchmarkSort;
  readonly groupBy: GroupByMode;
  readonly result: ModelDefinition[];
}

export interface FilteredProvidersCache {
  readonly providersRef: string[];
  readonly query: string;
  readonly result: string[];
}

export interface ModelItemsCache {
  readonly filteredModelsRef: ModelDefinition[];
  readonly pinnedIdsKey: string;
  readonly groupBy: GroupByMode;
  readonly result: PickerItem[];
}

export interface ProviderItemsCache {
  readonly filteredProvidersRef: string[];
  readonly configuredProvidersKey: string;
  readonly configuredViaKey: string;
  readonly result: PickerItem[];
}
