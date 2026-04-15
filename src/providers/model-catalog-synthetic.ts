import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { BenchmarkEntry } from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';
import { compositeScore } from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';
import type { CatalogModel } from './model-catalog.ts';
import type { SyntheticBackend, CanonicalModel, SyntheticTier } from './synthetic.ts';

export interface MinimalModelDefinition {
  id: string;
  provider: string;
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
  selectable: boolean;
  tier: 'free' | 'standard' | 'premium' | 'subscription';
  reasoningEffort?: string[];
}

export interface SyntheticModelInfo {
  backendCount: number;
  keyedBackendCount: number;
  tier: SyntheticTier;
  bestCompositeScore: number | null;
}

const MAX_FAMILY_UNIQUE_NAMES = 20;

export function nameToSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hasConfiguredEnvVar(envVars: readonly string[]): boolean {
  return envVars.some((envVar) => {
    const value = process.env[envVar];
    return typeof value === 'string' && value.length > 0;
  });
}

export function normalizeModelName(name: string): string {
  let normalized = name.toLowerCase();
  normalized = normalized.replace(/\b(instruct|chat|latest|preview|free|turbo|fast|base|pt|online|standard|default|it|bf16|fp8|fp16|awq|gptq|gguf|bnb|qlora|lora)\b/g, ' ');
  normalized = normalized.replace(/\b(?:(0[1-9]|[12][0-9]|3[01])(0[1-9]|1[0-2])|(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01]))\b/g, ' ');
  normalized = normalized.replace(/\b(?:20[2-3][0-9](?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])|20[2-3][0-9](?:0[1-9]|1[0-2])|[2-3][0-9](?:0[1-9]|1[0-2]))\b/g, ' ');
  return nameToSlug(normalized);
}

export function buildSyntheticCanonicalModels(models: readonly CatalogModel[]): CanonicalModel[] {
  const byFamily = new Map<string, CatalogModel[]>();
  for (const model of models) {
    if (!model.family) continue;
    const bucket = byFamily.get(model.family);
    if (bucket) {
      bucket.push(model);
    } else {
      byFamily.set(model.family, [model]);
    }
  }

  const canonicalGroups = new Map<string, CatalogModel[]>();
  for (const [family, group] of byFamily) {
    const uniqueNames = new Set(group.map((model) => normalizeModelName(model.name)));
    const isBroad = uniqueNames.size > MAX_FAMILY_UNIQUE_NAMES;
    if (isBroad) {
      const byName = new Map<string, CatalogModel[]>();
      for (const model of group) {
        const key = normalizeModelName(model.name);
        const bucket = byName.get(key);
        if (bucket) {
          bucket.push(model);
        } else {
          byName.set(key, [model]);
        }
      }
      for (const [slug, nameGroup] of byName) {
        const canonicalId = canonicalGroups.has(slug) ? `${family}-${slug}` : slug;
        const existing = canonicalGroups.get(canonicalId);
        if (existing) {
          existing.push(...nameGroup);
        } else {
          canonicalGroups.set(canonicalId, [...nameGroup]);
        }
      }
      continue;
    }

    const existing = canonicalGroups.get(family);
    if (existing) {
      existing.push(...group);
    } else {
      canonicalGroups.set(family, [...group]);
    }
  }

  const canonical: CanonicalModel[] = [];
  for (const [canonicalId, group] of canonicalGroups) {
    const allBackends: SyntheticBackend[] = group.map((model) => ({
      providerName: model.providerId,
      modelId: model.id,
      registryKey: `${model.providerId}:${model.id}`,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      envVars: model.providerEnvVars.length > 0 ? model.providerEnvVars : undefined,
    }));

    const keyedBackends = allBackends.filter((backend) => {
      const vars = backend.envVars;
      if (!vars || vars.length === 0) return true;
      return hasConfiguredEnvVar(vars);
    });
    const distinctProviders = new Set(keyedBackends.map((backend) => backend.providerName)).size;
    if (distinctProviders < 2) continue;

    const tierPriority: Record<SyntheticTier, number> = { free: 2, subscription: 1, paid: 0 };
    const tier = group.reduce((best, model) =>
      (tierPriority[model.tier] ?? 0) > (tierPriority[best] ?? 0) ? model.tier : best, group[0].tier);

    canonical.push({
      id: canonicalId,
      tier,
      backends: allBackends,
      backendCount: allBackends.length,
      keyedBackendCount: distinctProviders,
    });
  }

  return canonical;
}

export function getSyntheticModelInfo(
  modelId: string,
  canonicalModels: readonly CanonicalModel[],
  getBenchmarks: (modelName: string) => BenchmarkEntry | undefined,
): SyntheticModelInfo | null {
  const canonical = canonicalModels.find((model) => model.id === modelId);
  if (!canonical) return null;

  let bestCompositeScore: number | null = null;
  for (const backend of canonical.backends) {
    const benchmark = getBenchmarks(backend.modelId);
    if (!benchmark) continue;
    const score = compositeScore(benchmark.benchmarks);
    if (score != null && (bestCompositeScore == null || score > bestCompositeScore)) {
      bestCompositeScore = score;
    }
  }

  return {
    backendCount: canonical.backendCount,
    keyedBackendCount: canonical.keyedBackendCount,
    tier: canonical.tier,
    bestCompositeScore,
  };
}

export function getSyntheticBackendModelIds(canonicalModels: readonly CanonicalModel[]): Set<string> {
  return new Set(canonicalModels.flatMap((canonical) => canonical.backends.map((backend) => backend.modelId)));
}

export function getSyntheticModelDefinitions(
  models: readonly CatalogModel[],
  canonicalModels: readonly CanonicalModel[],
): MinimalModelDefinition[] {
  const definitions = canonicalModels.map((canonical): MinimalModelDefinition => {
    const bestBackend = canonical.backends.reduce(
      (best, backend) => ((backend.contextWindow ?? 0) > (best.contextWindow ?? 0) ? backend : best),
      canonical.backends[0]!,
    );
    const catalogMatch = models.find((model) => canonical.backends.some((backend) => backend.modelId === model.id));
    const displayName = catalogMatch?.name ?? canonical.id;
    const hasReasoning = catalogMatch?.reasoning === true;

    return {
      id: canonical.id,
      provider: 'synthetic',
      registryKey: `synthetic:${canonical.id}`,
      displayName,
      description: `Synthetic failover model — ${canonical.backendCount} provider${canonical.backendCount !== 1 ? 's' : ''} available`,
      capabilities: {
        toolCalling: true,
        codeEditing: true,
        reasoning: hasReasoning,
        multimodal: false,
      },
      contextWindow: bestBackend?.contextWindow ?? 128_000,
      selectable: true,
      tier: canonical.tier === 'free' ? 'free' : canonical.tier === 'subscription' ? 'subscription' : 'standard',
      ...(hasReasoning ? { reasoningEffort: ['instant', 'low', 'medium', 'high'] } : {}),
    };
  });

  logger.debug('[model-catalog] getSyntheticModelDefinitions', {
    count: definitions.length,
    sampleIds: definitions.slice(0, 20).map((definition) => definition.id),
  });
  return definitions;
}
