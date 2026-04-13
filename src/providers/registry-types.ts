import type { LLMProvider, ProviderRuntimeMetadataDeps } from './interface.ts';
import type { ProviderCapabilityRegistry } from './capabilities.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { SubscriptionManager } from '../config/subscriptions.ts';
import type { CacheHitTracker } from './cache-strategy.ts';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.ts';
import type { FavoritesStore } from './favorites.ts';
import type { BenchmarkStore } from './model-benchmarks.ts';
import type { ModelLimitsService } from './model-limits.ts';

/** Model capability tier — controls system prompt verbosity. */
export type ModelTier = 'free' | 'standard' | 'premium' | 'subscription';

/** Per-model token limits for output, tool results, tool calls, and reasoning. */
export interface TokenLimits {
  maxOutputTokens?: number;
  maxToolResultTokens?: number;
  maxToolCalls?: number;
  maxReasoningTokens?: number;
}

/** Provenance of a resolved context window value. */
export type ContextWindowProvenance = 'provider_api' | 'configured_cap' | 'fallback';

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
  contextWindowProvenance?: ContextWindowProvenance;
  selectable: boolean;
  reasoningEffort?: string[];
  tier?: ModelTier;
  tokenLimits?: TokenLimits;
}

export interface RuntimeProviderRegistration {
  readonly provider: LLMProvider;
  readonly models?: readonly ModelDefinition[];
  readonly suppressCatalogModels?: readonly string[];
  readonly replace?: boolean;
}

export interface ProviderRegistryOptions {
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory' | 'getControlPlaneConfigDir'>;
  readonly subscriptionManager: Pick<SubscriptionManager, 'get' | 'getPending' | 'saveSubscription' | 'resolveAccessToken'>;
  readonly secretsManager: ProviderRuntimeMetadataDeps['secretsManager'];
  readonly serviceRegistry: ProviderRuntimeMetadataDeps['serviceRegistry'];
  readonly capabilityRegistry: ProviderCapabilityRegistry;
  readonly cacheHitTracker: CacheHitTracker;
  readonly favoritesStore: Pick<FavoritesStore, 'load'>;
  readonly benchmarkStore: Pick<BenchmarkStore, 'getBenchmarks' | 'getTopBenchmarkModelIds'>;
  readonly modelLimitsService?: ModelLimitsService;
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null;
  readonly runtimeBus?: RuntimeEventBus | null;
}
