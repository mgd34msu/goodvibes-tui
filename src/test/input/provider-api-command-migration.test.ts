import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscoveredServer } from '@pellux/goodvibes-sdk/platform/discovery';
import { HelperModel } from '@pellux/goodvibes-sdk/platform/config';
import type { CommandContext } from '../../input/command-registry.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerLocalProviderRuntimeCommands } from '../../input/commands/local-provider-runtime.ts';
import { registerLocalRuntimeCommands } from '../../input/commands/local-runtime.ts';
import type {
  ProviderApi,
  ProviderApiBenchmarkRecord,
  ProviderApiCatalogRefreshResult,
  ProviderApiFavoritesSnapshot,
  ProviderApiLiveModelRefreshReport,
  ProviderApiModelRecord,
  ProviderApiRuntimeQuery,
  ProviderApiRuntimeQueryResult,
} from '@pellux/goodvibes-sdk/platform/providers';
import { UNKNOWN_MODEL_PRICING } from '@pellux/goodvibes-sdk/platform/providers';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function failOnAccess(label: string): never {
  throw new Error(`unexpected raw access: ${label}`);
}

function createModelRecord(input: {
  modelId: string;
  providerId: string;
  registryKey?: string;
  displayName?: string;
  multimodal?: boolean;
  current?: boolean;
}): ProviderApiModelRecord {
  return {
    modelId: input.modelId,
    providerId: input.providerId,
    registryKey: input.registryKey ?? `${input.providerId}:${input.modelId}`,
    displayName: input.displayName ?? input.modelId,
    description: `${input.modelId} description`,
    selectable: true,
    current: input.current ?? false,
    capabilities: {
      toolCalling: true,
      codeEditing: true,
      reasoning: true,
      multimodal: input.multimodal ?? true,
    },
    contextWindow: 128_000,
    favorite: {
      pinned: false,
      recent: false,
    },
    routing: {
      kind: 'direct',
      failoverStrategy: 'none',
    },
  };
}

function createProviderApiStub(overrides: Partial<ProviderApi> = {}): ProviderApi {
  const currentModel = createModelRecord({
    modelId: 'gpt-4o',
    providerId: 'openai',
    current: true,
  });
  return {
    listProviderIds: () => ['anthropic', 'openai'],
    getCurrentModel: async () => currentModel,
    listModels: async () => [currentModel],
    selectModel: async () => currentModel,
    registerDiscoveredProviders: async (_servers: readonly DiscoveredServer[]) => {},
    refreshCatalog: async (): Promise<ProviderApiCatalogRefreshResult> => ({
      modelCount: 1,
      providerCount: 1,
    }),
    refreshLiveModelDiscovery: async (): Promise<readonly ProviderApiLiveModelRefreshReport[]> => [],
    refreshBenchmarks: async () => 1,
    refreshModelLimits: async () => 1,
    getFavorites: async (): Promise<ProviderApiFavoritesSnapshot> => ({
      pinned: [],
      recent: [],
    }),
    pinModel: async () => ({
      pinned: [],
      recent: [],
    }),
    unpinModel: async () => ({
      pinned: [],
      recent: [],
    }),
    recordModelUsage: async () => ({
      pinned: [],
      recent: [],
    }),
    listBenchmarks: async (): Promise<readonly ProviderApiBenchmarkRecord[]> => [],
    queryRuntimeMetadata: async (_query: ProviderApiRuntimeQuery): Promise<ProviderApiRuntimeQueryResult> => ({
      scope: 'all',
      snapshots: [],
    }),
    createHelperModel: (configManager) => new HelperModel({
      configManager,
      providerRegistry: {
        resolveModelPricing: () => UNKNOWN_MODEL_PRICING,
        getCurrentModel: () => ({
          id: 'gpt-4o',
          provider: 'openai',
          registryKey: 'openai:gpt-4o',
          displayName: 'GPT-4o',
          description: 'stub',
          capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
          contextWindow: 128_000,
          selectable: true,
          tier: 'standard',
        }),
        getForModel: () => ({
          name: 'openai',
          models: ['gpt-4o'],
          chat: async () => ({
            content: '',
            toolCalls: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: 'completed',
          }),
        }),
      },
    }),
    ...overrides,
  };
}

function createCommandContext(options: {
  providerApi: ProviderApi;
  workingDirectory?: string;
  submitInput?: CommandContext['submitInput'];
}): {
  readonly context: CommandContext;
  readonly printed: string[];
  readonly configWrites: Array<{ key: string; value: unknown }>;
} {
  const printed: string[] = [];
  const configWrites: Array<{ key: string; value: unknown }> = [];
  const root = options.workingDirectory ?? makeProjectTempDir('gv-provider-api-command');
  const context: CommandContext = {
    session: {
      conversationManager: {} as never,
      runtime: {
        model: 'openai:gpt-4o',
        provider: 'openai',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: 'medium',
        sessionId: 'sess-provider-api-command',
      },
    },
    provider: {
      providerRegistry: new Proxy({}, {
        get: (_target, property) => failOnAccess(`provider.providerRegistry.${String(property)}`),
      }) as never,
      favoritesStore: new Proxy({}, {
        get: (_target, property) => failOnAccess(`provider.favoritesStore.${String(property)}`),
      }) as never,
      benchmarkStore: new Proxy({}, {
        get: (_target, property) => failOnAccess(`provider.benchmarkStore.${String(property)}`),
      }) as never,
    },
    workspace: {
      shellPaths: createShellPathService({
        workingDirectory: root,
        homeDirectory: root,
      }),
    },
    platform: {
      config: {} as never,
      configManager: {
        set: (key: string, value: unknown) => {
          configWrites.push({ key, value });
        },
        getWorkingDirectory: () => root,
      } as never,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
    },
    clients: {
      providerApi: options.providerApi,
    },
    renderRequest: () => {},
    submitInput: options.submitInput,
    print: (text: string) => {
      printed.push(text);
    },
    exit: () => {},
  };

  return { context, printed, configWrites };
}

describe('provider command provider-api migration', () => {
  test('/provider switches providers through providerApi without raw registry access', async () => {
    const registry = new CommandRegistry();
    registerLocalProviderRuntimeCommands(registry);
    const selected = createModelRecord({
      modelId: 'claude-sonnet',
      providerId: 'anthropic',
      current: true,
    });
    const queries: Array<Parameters<ProviderApi['listModels']>[0]> = [];
    const { context, printed, configWrites } = createCommandContext({
      providerApi: createProviderApiStub({
        listProviderIds: () => ['anthropic', 'openai'],
        listModels: async (query) => {
          queries.push(query ?? {});
          return query?.providerId === 'anthropic' ? [selected] : [];
        },
        selectModel: async (modelRef) => {
          expect(modelRef).toBe('anthropic:claude-sonnet');
          return selected;
        },
      }),
    });

    await registry.execute('provider', ['anthropic'], context);

    expect(queries).toEqual([{ providerId: 'anthropic', selectableOnly: true }]);
    expect(context.session.runtime.provider).toBe('anthropic');
    expect(context.session.runtime.model).toBe('anthropic:claude-sonnet');
    expect(configWrites).toEqual([
      { key: 'provider.model', value: 'anthropic:claude-sonnet' },
    ]);
    expect(printed.join('\n')).toContain('Switched to provider: anthropic (model: claude-sonnet)');
  });

  test('refresh-models, pin, and unpin route through providerApi without raw stores', async () => {
    const registry = new CommandRegistry();
    registerLocalRuntimeCommands(registry);
    const pinned = new Set<string>();
    const pinCalls: string[] = [];
    const unpinCalls: string[] = [];
    const { context, printed } = createCommandContext({
      providerApi: createProviderApiStub({
        refreshCatalog: async () => ({ modelCount: 42, providerCount: 7 }),
        refreshBenchmarks: async () => 18,
        refreshModelLimits: async () => 11,
        getFavorites: async () => ({
          pinned: [...pinned].map((modelId) => ({
            modelId,
            available: true,
            providerId: 'openai',
            registryKey: `openai:${modelId}`,
            displayName: modelId,
          })),
          recent: [],
        }),
        pinModel: async (modelRef) => {
          pinCalls.push(modelRef);
          pinned.add('gpt-4o');
          return {
            pinned: [{
              modelId: 'gpt-4o',
              available: true,
              providerId: 'openai',
              registryKey: 'openai:gpt-4o',
              displayName: 'gpt-4o',
            }],
            recent: [],
          };
        },
        unpinModel: async (modelRef) => {
          unpinCalls.push(modelRef);
          pinned.delete('gpt-4o');
          return { pinned: [], recent: [] };
        },
      }),
    });

    await registry.execute('refresh-models', [], context);
    await registry.execute('pin', ['openai:gpt-4o'], context);
    await registry.execute('unpin', ['openai:gpt-4o'], context);

    expect(pinCalls).toEqual(['openai:gpt-4o']);
    expect(unpinCalls).toEqual(['openai:gpt-4o']);
    expect(printed.join('\n')).toContain('Model catalog refreshed: 42 models from 7 providers');
    expect(printed.join('\n')).toContain('Benchmarks refreshed: 18 model records available.');
    expect(printed.join('\n')).toContain('Token limits refreshed: 11 models updated.');
    expect(printed.join('\n')).toContain('Pinned: openai:gpt-4o');
    expect(printed.join('\n')).toContain('Unpinned: openai:gpt-4o');
  });

  test('/image checks multimodal support through providerApi before submitting content', async () => {
    const registry = new CommandRegistry();
    registerLocalRuntimeCommands(registry);
    const root = makeProjectTempDir('gv-provider-api-image');
    const imagePath = join(root, 'fixture.png');
    writeFileSync(imagePath, 'not-a-real-png');
    const submitted: Array<{ text: string; content?: unknown[] }> = [];
    const { context, printed } = createCommandContext({
      workingDirectory: root,
      submitInput: (text, content) => {
        submitted.push({ text, content });
      },
      providerApi: createProviderApiStub({
        getCurrentModel: async () => createModelRecord({
          modelId: 'claude-sonnet',
          providerId: 'anthropic',
          displayName: 'Claude Sonnet',
          multimodal: false,
          current: true,
        }),
      }),
    });

    await registry.execute('image', [imagePath, 'inspect this'], context);

    expect(printed.join('\n')).toContain('Warning: Claude Sonnet does not support image input.');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.text).toBe('inspect this');
  });
});
