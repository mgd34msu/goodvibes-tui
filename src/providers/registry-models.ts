import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers/registry-types';
import { splitModelRegistryKey, withRegistryKey } from '@pellux/goodvibes-sdk/platform/providers/registry-helpers';

export function getProviderLookupCandidates(
  providerName: string,
  aliases: Readonly<Record<string, string>>,
): string[] {
  const candidates = new Set<string>([providerName]);
  const directAlias = aliases[providerName];
  if (directAlias) candidates.add(directAlias);
  for (const [catalogName, registeredName] of Object.entries(aliases)) {
    if (registeredName === providerName) candidates.add(catalogName);
    if (directAlias && registeredName === directAlias) candidates.add(catalogName);
  }
  return [...candidates];
}

export function findModelDefinition(
  modelId: string,
  registry: readonly ModelDefinition[],
): ModelDefinition | undefined {
  if (modelId.includes(':')) {
    return registry.find((model) => model.registryKey === modelId) ?? registry.find((model) => model.id === modelId);
  }
  return registry.find((model) => model.id === modelId);
}

export function findModelDefinitionForProvider(
  modelId: string,
  providerName: string,
  registry: readonly ModelDefinition[],
  aliases: Readonly<Record<string, string>>,
): ModelDefinition | undefined {
  const providerCandidates = new Set(getProviderLookupCandidates(providerName, aliases));
  const resolvedModelId = modelId.includes(':') ? splitModelRegistryKey(modelId).resolvedModelId : modelId;
  const registryMatch = modelId.includes(':')
    ? findModelDefinition(modelId, registry)
    : undefined;

  if (registryMatch && providerCandidates.has(registryMatch.provider)) {
    return registryMatch;
  }

  return registry.find((model) => model.id === resolvedModelId && providerCandidates.has(model.provider));
}

export function buildModelRegistry(input: {
  readonly customModels: readonly ModelDefinition[];
  readonly runtimeModels: readonly ModelDefinition[];
  readonly syntheticModels: readonly ModelDefinition[];
  readonly catalogModels: readonly ModelDefinition[];
  readonly discoveredModels: readonly ModelDefinition[];
  readonly suppressedCatalogIds: ReadonlySet<string>;
}): ModelDefinition[] {
  const catalogFiltered = input.catalogModels.filter(
    (builtin) =>
      !input.customModels.some((model) => model.id === builtin.id) &&
      !input.runtimeModels.some((model) => model.id === builtin.id) &&
      !input.suppressedCatalogIds.has(builtin.id) &&
      !builtin.id.startsWith('hf:'),
  );

  const discoveredFiltered = input.discoveredModels.filter(
    (discovered) =>
      !input.catalogModels.some((model) => model.id === discovered.id) &&
      !input.customModels.some((model) => model.id === discovered.id) &&
      !input.runtimeModels.some((model) => model.id === discovered.id),
  );

  return [
    ...input.customModels.map(withRegistryKey),
    ...input.runtimeModels.map(withRegistryKey),
    ...input.syntheticModels.map(withRegistryKey),
    ...catalogFiltered.map(withRegistryKey),
    ...discoveredFiltered.map(withRegistryKey),
  ];
}
