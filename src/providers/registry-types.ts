import type { LLMProvider, ProviderRuntimeMetadataDeps } from '@pellux/goodvibes-sdk/platform/providers/interface';
import type { ProviderCapabilityRegistry } from '@pellux/goodvibes-sdk/platform/providers/capabilities';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import type { CacheHitTracker } from '@pellux/goodvibes-sdk/platform/providers/cache-strategy';
import type { FeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/index';
import type { FavoritesStore } from '@pellux/goodvibes-sdk/platform/providers/favorites';
import type { BenchmarkStore } from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';
import type { ModelLimitsService } from '@pellux/goodvibes-sdk/platform/providers/model-limits';

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
