import type { ProviderRuntimeMetadata } from './interface.ts';
import { getCostFromCatalog } from './model-catalog.ts';
import { getProviderRegistry, type ModelDefinition } from './registry.ts';

export interface ProviderModelSnapshot {
  readonly id: string;
  readonly registryKey: string;
  readonly displayName: string;
  readonly selectable: boolean;
  readonly contextWindow: number;
  readonly tier?: string;
  readonly pricing?: {
    readonly inputPerMillionTokens: number;
    readonly outputPerMillionTokens: number;
    readonly currency: 'USD';
  };
}

export interface ProviderRuntimeSnapshot {
  readonly providerId: string;
  readonly active: boolean;
  readonly modelCount: number;
  readonly runtime: ProviderRuntimeMetadata;
  readonly models: readonly ProviderModelSnapshot[];
}

export interface ProviderUsageSnapshot {
  readonly providerId: string;
  readonly active: boolean;
  readonly currentModelId?: string;
  readonly pricingSource: 'catalog' | 'provider' | 'none';
  readonly models: readonly ProviderModelSnapshot[];
  readonly usage: NonNullable<ProviderRuntimeMetadata['usage']>;
}

function toModelSnapshot(model: ModelDefinition): ProviderModelSnapshot {
  const cost = getCostFromCatalog(model.id);
  return {
    id: model.id,
    registryKey: model.registryKey,
    displayName: model.displayName,
    selectable: model.selectable,
    contextWindow: model.contextWindow,
    ...(model.tier ? { tier: model.tier } : {}),
    ...(cost
      ? {
          pricing: {
            inputPerMillionTokens: cost.input,
            outputPerMillionTokens: cost.output,
            currency: 'USD' as const,
          },
        }
      : {}),
  };
}

async function buildSnapshotForProvider(providerId: string): Promise<ProviderRuntimeSnapshot | null> {
  const providerRegistry = getProviderRegistry();
  let provider;
  try {
    provider = providerRegistry.getRegistered(providerId);
  } catch {
    return null;
  }
  const runtime = provider.describeRuntime
    ? await provider.describeRuntime()
    : {
        auth: { mode: 'none', configured: false, detail: 'Provider does not expose runtime metadata.' },
        models: { models: provider.models },
        usage: { streaming: true, toolCalling: true, parallelTools: false },
      } satisfies ProviderRuntimeMetadata;
  const currentModel = providerRegistry.getCurrentModel();
  const models = providerRegistry
    .listModels()
    .filter((model) => model.provider === providerId)
    .map(toModelSnapshot);
  return {
    providerId,
    active: currentModel.provider === providerId,
    modelCount: models.length,
    runtime,
    models,
  };
}

export async function listProviderRuntimeSnapshots(): Promise<readonly ProviderRuntimeSnapshot[]> {
  const providerRegistry = getProviderRegistry();
  const snapshots = await Promise.all(providerRegistry.listProviders().map((provider) => buildSnapshotForProvider(provider.name)));
  return snapshots.filter((snapshot): snapshot is ProviderRuntimeSnapshot => snapshot != null);
}

export async function getProviderRuntimeSnapshot(providerId: string): Promise<ProviderRuntimeSnapshot | null> {
  return buildSnapshotForProvider(providerId);
}

export async function getProviderUsageSnapshot(providerId: string): Promise<ProviderUsageSnapshot | null> {
  const providerRegistry = getProviderRegistry();
  const snapshot = await buildSnapshotForProvider(providerId);
  if (!snapshot) return null;
  const currentModel = providerRegistry.getCurrentModel();
  const usage = snapshot.runtime.usage ?? {
    streaming: true,
    toolCalling: true,
    parallelTools: false,
  };
  return {
    providerId,
    active: snapshot.active,
    ...(currentModel.provider === providerId ? { currentModelId: currentModel.id } : {}),
    pricingSource: snapshot.models.some((model) => model.pricing) ? 'catalog' : (usage.cost?.source ?? 'none'),
    models: snapshot.models,
    usage,
  };
}
