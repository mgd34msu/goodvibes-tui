import { describe, expect, test } from 'bun:test';
import type { DiscoveredServer } from '@pellux/goodvibes-sdk/platform/discovery/index';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { ProviderRuntimeMetadata, LLMProvider, ChatResponse } from '@pellux/goodvibes-sdk/platform/providers/index';
import type { FavoritesData } from '@pellux/goodvibes-sdk/platform/providers/favorites';
import {
  createProviderApi,
  type ProviderApiDependencies,
} from '@pellux/goodvibes-sdk/platform/providers/index';
import type { BenchmarkEntry } from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';
import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers/registry';

function cloneFavorites(data: FavoritesData): FavoritesData {
  return {
    pinned: data.pinned.map((entry) => ({ ...entry })),
    history: data.history.map((entry) => ({ ...entry })),
  };
}

function makeProvider(
  name: string,
  models: string[],
  runtimeMetadata?: ProviderRuntimeMetadata,
): LLMProvider {
  return {
    name,
    models,
    ...(runtimeMetadata ? { describeRuntime: async () => runtimeMetadata } : {}),
    async chat(): Promise<ChatResponse> {
      return {
        content: '',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'end',
      };
    },
  };
}

function createHarness() {
  const models: ModelDefinition[] = [
    {
      id: 'gpt-4o',
      provider: 'openai',
      registryKey: 'openai:gpt-4o',
      displayName: 'GPT-4o',
      description: 'OpenAI flagship model',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
      contextWindow: 128_000,
      selectable: true,
      tier: 'premium',
      reasoningEffort: ['low', 'medium', 'high'],
    },
    {
      id: 'claude-sonnet',
      provider: 'anthropic',
      registryKey: 'anthropic:claude-sonnet',
      displayName: 'Claude Sonnet',
      description: 'Anthropic reasoning model',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
      contextWindow: 200_000,
      selectable: true,
      tier: 'premium',
      reasoningEffort: ['instant', 'medium', 'high'],
    },
    {
      id: 'best-coder',
      provider: 'synthetic',
      registryKey: 'synthetic:best-coder',
      displayName: 'Best Coder',
      description: 'Synthetic failover wrapper',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
      contextWindow: 256_000,
      selectable: true,
      tier: 'standard',
      reasoningEffort: ['instant', 'low', 'medium', 'high'],
    },
  ];

  const providers = new Map<string, LLMProvider>([
    ['openai', makeProvider('openai', ['gpt-4o'], {
      auth: { mode: 'api-key', configured: true, detail: 'OPENAI_API_KEY set' },
      models: { defaultModel: 'gpt-4o', models: ['gpt-4o'] },
      usage: {
        streaming: true,
        toolCalling: true,
        parallelTools: true,
        cost: {
          source: 'catalog',
          currency: 'USD',
          inputPerMillionTokens: 5,
          outputPerMillionTokens: 15,
        },
      },
    })],
    ['anthropic', makeProvider('anthropic', ['claude-sonnet'], {
      auth: { mode: 'oauth', configured: true, detail: 'subscription-backed' },
      models: { defaultModel: 'claude-sonnet', models: ['claude-sonnet'] },
      usage: { streaming: true, toolCalling: true, parallelTools: false },
    })],
    ['synthetic', makeProvider('synthetic', ['best-coder'])],
  ]);

  let currentModel = models[0]!;
  let favoritesState: FavoritesData = {
    pinned: [{ modelId: 'gpt-4o', pinnedAt: '2026-01-01T00:00:00.000Z' }],
    history: [
      { modelId: 'claude-sonnet', lastUsed: '2026-01-03T00:00:00.000Z', count: 2 },
      { modelId: 'gpt-4o', lastUsed: '2026-01-02T00:00:00.000Z', count: 1 },
    ],
  };

  const benchmarkEntries = new Map<string, BenchmarkEntry>([
    ['gpt-4o', {
      modelId: 'gpt-4o',
      name: 'GPT-4o',
      organization: 'OpenAI',
      benchmarks: { swe: 0.86, gpqa: 0.88, aime: 0.82 },
    }],
    ['claude-sonnet', {
      modelId: 'claude-sonnet',
      name: 'Claude Sonnet',
      organization: 'Anthropic',
      benchmarks: { swe: 0.72, gpqa: 0.69, aime: 0.64 },
    }],
  ]);

  const pricing = new Map<string, { input: number; output: number }>([
    ['gpt-4o', { input: 5, output: 15 }],
    ['claude-sonnet', { input: 3, output: 12 }],
    ['best-coder', { input: 4, output: 9 }],
  ]);

  const dependencies: ProviderApiDependencies = {
    providerRegistry: {
      listProviders: () => [...providers.values()],
      listModels: () => [...models],
      getCatalogModelDefinitions: () => models.map((model) => ({
        id: model.id,
        provider: model.provider,
        registryKey: model.registryKey,
        displayName: model.displayName,
        description: model.description,
        capabilities: { ...model.capabilities },
        contextWindow: model.contextWindow,
        selectable: model.selectable,
        tier: model.tier ?? 'standard',
        ...(model.reasoningEffort ? { reasoningEffort: [...model.reasoningEffort] } : {}),
      })),
      get: (providerId: string) => {
        const provider = providers.get(providerId);
        if (!provider) throw new Error(`Unknown provider: ${providerId}`);
        return provider;
      },
      getCurrentModel: () => currentModel,
      getContextWindowForModel: (model: ModelDefinition) => model.contextWindow,
      getForModel: (modelId: string, provider?: string) => {
        const model = models.find((entry) => entry.id === modelId && (!provider || entry.provider === provider));
        if (!model) throw new Error(`Unknown model: ${provider ?? '*'}:${modelId}`);
        const runtimeProvider = providers.get(model.provider);
        if (!runtimeProvider) throw new Error(`Unknown provider: ${model.provider}`);
        return runtimeProvider;
      },
      setCurrentModel: (modelRef: string) => {
        const next = models.find((model) => model.registryKey === modelRef || model.id === modelRef);
        if (!next) throw new Error(`Unknown model: ${modelRef}`);
        currentModel = next;
      },
      getSelectableModels: () => models.filter((model) => model.selectable),
      registerDiscoveredProviders: (_servers: DiscoveredServer[]) => {},
      refreshCatalog: async () => {},
      refreshModelLimits: async () => 2,
      findAlternativeModel: (modelRef: string) => {
        if (modelRef === 'openai:gpt-4o' || modelRef === 'gpt-4o') return models[2] ?? null;
        if (modelRef === 'anthropic:claude-sonnet' || modelRef === 'claude-sonnet') return models[0] ?? null;
        return null;
      },
      getSyntheticModelInfoFromCatalog: (modelId: string) => modelId === 'best-coder'
        ? {
            backendCount: 3,
            keyedBackendCount: 2,
            tier: 'paid',
            bestCompositeScore: 0.91,
          }
        : null,
      describeRuntime: async (providerId: string) => providers.get(providerId)?.describeRuntime
        ? await providers.get(providerId)!.describeRuntime!({
            secretsManager: { listDetailed: async () => [] },
            serviceRegistry: {
              getAll: () => ({}),
              inspect: async () => null,
            },
            subscriptionManager: {
              get: () => null,
              getPending: () => null,
            },
          })
        : null,
      getRegistered: (providerId: string) => {
        const provider = providers.get(providerId);
        if (!provider) throw new Error(`Unknown provider: ${providerId}`);
        return provider;
      },
      getCostFromCatalog: (modelId: string) => pricing.get(modelId) ?? { input: 0, output: 0 },
      has: (id: string) => providers.has(id),
      require: (id: string) => {
        const provider = providers.get(id);
        if (!provider) throw new Error(`Unknown provider: ${id}`);
        return provider;
      },
      tryGet: (id: string) => providers.get(id),
    },
    favoritesStore: {
      load: async () => cloneFavorites(favoritesState),
      pinModel: async (modelId: string) => {
        if (!favoritesState.pinned.some((entry) => entry.modelId === modelId)) {
          favoritesState = {
            ...favoritesState,
            pinned: [...favoritesState.pinned, { modelId, pinnedAt: '2026-02-01T00:00:00.000Z' }],
          };
        }
      },
      unpinModel: async (modelId: string) => {
        favoritesState = {
          ...favoritesState,
          pinned: favoritesState.pinned.filter((entry) => entry.modelId !== modelId),
        };
      },
      recordUsage: async (modelId: string) => {
        const existing = favoritesState.history.find((entry) => entry.modelId === modelId);
        if (existing) {
          existing.count += 1;
          existing.lastUsed = '2026-03-01T00:00:00.000Z';
          return;
        }
        favoritesState = {
          ...favoritesState,
          history: [
            ...favoritesState.history,
            { modelId, lastUsed: '2026-03-01T00:00:00.000Z', count: 1 },
          ],
        };
      },
    },
    benchmarkStore: {
      getBenchmarks: (modelName: string) => benchmarkEntries.get(modelName),
      refreshBenchmarks: async () => {},
    },
  };

  return {
    dependencies,
    api: createProviderApi(dependencies),
  };
}

describe('provider api', () => {
  test('lists provider ids and enriches models with favorites, benchmarks, and routing', async () => {
    const { api } = createHarness();

    expect(api.listProviderIds()).toEqual(['anthropic', 'openai', 'synthetic']);

    const models = await api.listModels();
    expect(models).toHaveLength(3);

    const openAi = models.find((model) => model.registryKey === 'openai:gpt-4o');
    expect(openAi?.current).toBe(true);
    expect(openAi?.favorite.pinned).toBe(true);
    expect(openAi?.favorite.recent).toBe(true);
    expect(openAi?.benchmark?.kind).toBe('catalog');
    expect(openAi?.routing.failoverStrategy).toBe('synthetic-wrapper');
    expect(openAi?.routing.alternative?.registryKey).toBe('synthetic:best-coder');

    const synthetic = models.find((model) => model.registryKey === 'synthetic:best-coder');
    expect(synthetic?.routing.kind).toBe('synthetic');
    expect(synthetic?.routing.failoverStrategy).toBe('intra-synthetic');
    expect(synthetic?.benchmark?.kind).toBe('synthetic');
    expect(synthetic?.benchmark?.compositeScore).toBe(0.91);
  });

  test('selects models by registry key and exposes the new current model', async () => {
    const { api } = createHarness();

    const selected = await api.selectModel('anthropic:claude-sonnet');
    expect(selected.registryKey).toBe('anthropic:claude-sonnet');
    expect(selected.current).toBe(true);
    expect(selected.routing.failoverStrategy).toBe('same-tier-provider');
    expect(selected.routing.alternative?.registryKey).toBe('openai:gpt-4o');

    const current = await api.getCurrentModel();
    expect(current.registryKey).toBe('anthropic:claude-sonnet');
  });

  test('manages favorites and recent usage through resolved model refs', async () => {
    const { api } = createHarness();

    const pinned = await api.pinModel('anthropic:claude-sonnet');
    expect(pinned.pinned.map((entry) => entry.modelId)).toEqual(['gpt-4o', 'claude-sonnet']);

    const usage = await api.recordModelUsage('synthetic:best-coder');
    expect(usage.recent[0]?.modelId).toBe('best-coder');
    expect(usage.recent[0]?.useCount).toBe(1);
    expect(usage.recent[0]?.available).toBe(true);

    const unpinned = await api.unpinModel('gpt-4o');
    expect(unpinned.pinned.map((entry) => entry.modelId)).toEqual(['claude-sonnet']);
  });

  test('lists benchmark records and supports runtime metadata queries', async () => {
    const { api } = createHarness();

    const benchmarks = await api.listBenchmarks({ modelRefs: ['synthetic:best-coder', 'openai:gpt-4o'] });
    expect(benchmarks).toHaveLength(2);
    expect(benchmarks[0]?.registryKey).toBe('synthetic:best-coder');
    expect(benchmarks[1]?.registryKey).toBe('openai:gpt-4o');

    const all = await api.queryRuntimeMetadata({ scope: 'all' });
    expect(all.scope).toBe('all');
    if (all.scope !== 'all') {
      throw new Error(`Expected all scope, received ${all.scope}`);
    }
    expect(all.snapshots).toHaveLength(3);

    const provider = await api.queryRuntimeMetadata({ scope: 'provider', providerId: 'openai' });
    expect(provider.scope).toBe('provider');
    if (provider.scope !== 'provider') {
      throw new Error(`Expected provider scope, received ${provider.scope}`);
    }
    expect(provider.snapshot?.providerId).toBe('openai');
    expect(provider.snapshot?.runtime.auth?.mode).toBe('api-key');

    const usage = await api.queryRuntimeMetadata({ scope: 'usage', providerId: 'openai' });
    expect(usage.scope).toBe('usage');
    if (usage.scope !== 'usage') {
      throw new Error(`Expected usage scope, received ${usage.scope}`);
    }
    expect(usage.snapshot?.providerId).toBe('openai');
    expect(usage.snapshot?.pricingSource).toBe('catalog');
  });

  test('refreshes catalog, benchmarks, and model limits through the provider surface', async () => {
    const { api } = createHarness();

    await expect(api.refreshCatalog()).resolves.toEqual({
      modelCount: 3,
      providerCount: 3,
    });
    await expect(api.refreshBenchmarks()).resolves.toBe(3);
    await expect(api.refreshModelLimits()).resolves.toBe(2);
  });

  test('registers discovered providers and creates helper models through the shaped provider surface', async () => {
    const calls: DiscoveredServer[][] = [];
    const { dependencies } = createHarness();
    const api = createProviderApi({
      ...dependencies,
      providerRegistry: {
        ...dependencies.providerRegistry,
        registerDiscoveredProviders: (servers: DiscoveredServer[]) => {
          calls.push(servers);
        },
      },
    });

    await api.registerDiscoveredProviders([{
      name: 'lm-studio-local',
      host: '127.0.0.1',
      port: 1234,
      baseURL: 'http://127.0.0.1:1234/v1',
      models: ['local-model'],
      serverType: 'lm-studio',
    }]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]?.name).toBe('lm-studio-local');

    const helperConfig = {
      get: () => false,
      getCategory: () => ({}),
    };
    const helper = (api.createHelperModel as (config: unknown) => ReturnType<typeof api.createHelperModel>)(helperConfig);
    await expect(helper.chat('tool_summarize', 'hello', { helperOnly: true })).resolves.toBe('');
  });
});
