import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import type { ContentPart, LLMProvider } from '@pellux/goodvibes-sdk/platform/providers/interface';
import type { CacheHitTracker } from '@pellux/goodvibes-sdk/platform/providers/cache-strategy';
import type { SessionLineageTracker } from '@pellux/goodvibes-sdk/platform/core/session-lineage';
import type { IdempotencyStore } from '@pellux/goodvibes-sdk/platform/runtime/idempotency/index';
import { estimateTokens } from '@pellux/goodvibes-sdk/platform/core/context-compaction';
import type { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core/adaptive-planner';
import type { ExecutionPlanManager } from '@pellux/goodvibes-sdk/platform/core/execution-plan';
import type { SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core/session-memory';
import type { FavoritesStore } from '@pellux/goodvibes-sdk/platform/providers/favorites';

export type OrchestratorCoreServices = {
  configManager?: Pick<ConfigManager, 'get' | 'getCategory' | 'getWorkingDirectory'>;
  providerRegistry?: ProviderRegistry;
  cacheHitTracker?: Pick<CacheHitTracker, 'getMetrics'>;
  sessionLineageTracker?: SessionLineageTracker;
  idempotencyStore?: IdempotencyStore;
  planManager?: Pick<
    ExecutionPlanManager,
    | 'getActive'
    | 'getSummary'
    | 'getNextItems'
    | 'toMarkdown'
    | 'create'
    | 'save'
    | 'parseFromMarkdown'
    | 'replaceItems'
    | 'load'
    | 'updateItem'
  >;
  adaptivePlanner?: Pick<
    AdaptivePlanner,
    'select' | 'getMode' | 'setMode' | 'explain' | 'override' | 'clearOverride' | 'getOverride' | 'getLatest'
  >;
  sessionMemoryStore?: Pick<SessionMemoryStore, 'list'>;
  favoritesStore?: Pick<FavoritesStore, 'recordUsage'>;
};

export function normalizeUsage(
  usage: Awaited<ReturnType<LLMProvider['chat']>>['usage'],
): Awaited<ReturnType<LLMProvider['chat']>>['usage'] {
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const hasExplicitCacheBreakout = Object.prototype.hasOwnProperty.call(usage, 'cacheWriteTokens');
  const freshInputTokens = hasExplicitCacheBreakout
    ? usage.inputTokens
    : Math.max(0, usage.inputTokens - cacheReadTokens);
  return {
    ...usage,
    inputTokens: freshInputTokens,
  };
}

export function estimateFreshTurnInputTokens(
  lastInputTokens: number,
  currentEstimatedTokens: number,
  text: string,
  content?: ContentPart[],
): number {
  const explicitContentTokens = content?.reduce((sum, part) => {
    if (part.type === 'text') return sum + estimateTextTokens(part.text);
    return sum;
  }, 0) ?? 0;
  const currentTurnPayloadTokens = Math.max(explicitContentTokens, estimateTextTokens(text));

  if (lastInputTokens <= 0) {
    return Math.max(currentEstimatedTokens, currentTurnPayloadTokens);
  }

  const deltaFromPreviousContext = currentEstimatedTokens - lastInputTokens;
  if (deltaFromPreviousContext > 0) {
    return Math.max(deltaFromPreviousContext, currentTurnPayloadTokens);
  }

  if (currentEstimatedTokens < Math.floor(lastInputTokens * 0.8)) {
    return Math.max(currentEstimatedTokens, currentTurnPayloadTokens);
  }

  return currentTurnPayloadTokens;
}

export function getSessionLineageTracker(
  services: OrchestratorCoreServices,
  ownedSessionLineageTracker: SessionLineageTracker,
): SessionLineageTracker {
  return services.sessionLineageTracker ?? ownedSessionLineageTracker;
}

export function getIdempotencyStore(
  services: OrchestratorCoreServices,
  ownedIdempotencyStore: IdempotencyStore,
): IdempotencyStore {
  return services.idempotencyStore ?? ownedIdempotencyStore;
}

export function requireConfigManager(
  services: OrchestratorCoreServices,
): Pick<ConfigManager, 'get' | 'getCategory' | 'getWorkingDirectory'> {
  if (!services.configManager) {
    throw new Error('Orchestrator requires configManager in core services');
  }
  return services.configManager;
}

export function requireProviderRegistry(services: OrchestratorCoreServices): ProviderRegistry {
  if (!services.providerRegistry) {
    throw new Error('Orchestrator requires providerRegistry in core services');
  }
  return services.providerRegistry;
}

export function getCacheHitTracker(
  services: OrchestratorCoreServices,
  ownedCacheHitTracker: Pick<CacheHitTracker, 'getMetrics'>,
): Pick<CacheHitTracker, 'getMetrics'> {
  return services.cacheHitTracker ?? ownedCacheHitTracker;
}

export function createEmitterContext(
  sessionId: string,
  turnId: string,
): import('../runtime/emitters/index.ts').EmitterContext {
  return {
    sessionId,
    traceId: `${sessionId}:${turnId}`,
    source: 'orchestrator',
  };
}

function estimateTextTokens(text: string): number {
  return estimateTokens(text);
}
