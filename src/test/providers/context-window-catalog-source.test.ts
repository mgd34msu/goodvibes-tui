/**
 * /context window and /status name where the window came from, end to end
 * through the SDK registry.
 *
 * Live incident (abacusai): the provider file written by the old
 * `/provider add` says `contextWindow: 8192` for every model; the models.dev
 * catalog lists route-llm under `abacus` at 128000. The status line read
 * 8.2k. Now the catalog figure replaces the guess and both reports say so.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderRegistry, describeContextWindowSource } from '@pellux/goodvibes-sdk/platform/providers';
import { handleContextWindowSubcommand } from '../../input/commands/context-window.ts';
import { formatStatusReport } from '../../shell/status-report.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type RegistryOptions = ConstructorParameters<typeof ProviderRegistry>[0];

function makeRegistry(root: string): ProviderRegistry {
  return new ProviderRegistry({
    configManager: { get: () => undefined, getCategory: () => ({}), getControlPlaneConfigDir: () => root } as unknown as RegistryOptions['configManager'],
    subscriptionManager: { get: () => null, getPending: () => null, saveSubscription: async () => {}, resolveAccessToken: async () => null } as unknown as RegistryOptions['subscriptionManager'],
    capabilityRegistry: { getCapability: () => ({}), getRouteExplanation: () => ({ accepted: true }), invalidate: () => {}, setModelFactsSource: () => {} } as unknown as RegistryOptions['capabilityRegistry'],
    cacheHitTracker: { record: () => {} } as unknown as RegistryOptions['cacheHitTracker'],
    favoritesStore: { load: async () => ({ pinned: [], history: [] }) } as unknown as RegistryOptions['favoritesStore'],
    benchmarkStore: { getBenchmarks: () => undefined, getTopBenchmarkModelIds: () => [] } as unknown as RegistryOptions['benchmarkStore'],
    secretsManager: {} as unknown as RegistryOptions['secretsManager'],
    serviceRegistry: {} as unknown as RegistryOptions['serviceRegistry'],
    featureFlags: null,
    runtimeBus: null,
  });
}

function catalogEntry(providerId: string, id: string, contextWindow: number) {
  return { id, name: id, provider: providerId, providerId, providerEnvVars: [], pricing: null, tier: 'paid', contextWindow };
}

const CAPS = { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false };

let root = '';

beforeEach(() => {
  root = makeProjectTempDir('gv-ctxwin-catalog-source');
  writeFileSync(join(root, 'model-catalog.json'), JSON.stringify({
    version: 4,
    fetchedAt: Date.now(),
    ttlMs: 86_400_000,
    models: [
      catalogEntry('abacus', 'route-llm', 128_000),
      catalogEntry('zhipu', 'glm-9', 200_000),
      catalogEntry('deepinfra', 'glm-9', 200_000),
      catalogEntry('together', 'glm-9', 200_000),
      catalogEntry('fireworks', 'glm-9', 200_000),
    ],
  }));
  mkdirSync(join(root, 'providers'), { recursive: true });
  writeFileSync(join(root, 'providers', 'abacusai.json'), JSON.stringify({
    name: 'abacusai',
    displayName: 'abacusai',
    type: 'openai-compat',
    baseURL: 'https://routellm.abacus.ai/v1',
    models: ['route-llm', 'glm-9', 'flux_pro'].map((id) => ({ id, displayName: id, contextWindow: 8192, capabilities: CAPS })),
  }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function registryOn(registryKey: string): Promise<ProviderRegistry> {
  const registry = makeRegistry(root);
  registry.initCatalog();
  await registry.loadCustomProviders();
  registry.setCurrentModel(registryKey);
  return registry;
}

function contextWindowText(registry: ProviderRegistry): string {
  const ctx = { provider: { providerRegistry: registry }, print: () => {}, renderRequest: () => {} } as unknown as CommandContext;
  return handleContextWindowSubcommand([], ctx);
}

function statusText(registry: ProviderRegistry): string {
  const serving = registry.getCurrentModel();
  return formatStatusReport({
    workingDirectory: '/proj',
    model: serving.displayName,
    provider: serving.provider,
    toolCount: 0,
    usage: { input: 39_038, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: null,
    contextTokens: 39_038,
    contextWindow: registry.getKnownContextWindowForModel(serving) ?? 0,
    contextWindowSource: describeContextWindowSource(serving),
    compactFraction: 0.8,
    autoApprove: false,
    keepAwake: false,
    microphone: null,
    runningAgents: 0,
    runningProcesses: 0,
  });
}

describe('the window source, end to end through the SDK registry', () => {
  test('abacusai route-llm: 128,000 from the catalog, not the guessed 8,192', async () => {
    const registry = await registryOn('abacusai:route-llm');
    const window = contextWindowText(registry);
    expect(window).toContain('resolved: 128,000 tokens');
    expect(window).toContain('source:   catalog: abacus');
    expect(window).not.toContain('8,192');
    const status = statusText(registry);
    expect(status).toMatch(/used +39\.0k \/ 128\.0k \(30%\)/);
    expect(status).toMatch(/window from +catalog: abacus/);
  });

  test('a model its own provider does not list: the consensus names its count', async () => {
    const registry = await registryOn('abacusai:glm-9');
    expect(contextWindowText(registry)).toContain('source:   consensus of 4 providers');
    expect(statusText(registry)).toMatch(/window from +consensus of 4 providers/);
  });

  test('a model nobody lists: unknown, with the family default named as a guess', async () => {
    const registry = await registryOn('abacusai:flux_pro');
    const window = contextWindowText(registry);
    expect(window).toContain('resolved: unknown (no catalog provider lists this model; the family default of 128,000 tokens is a guess)');
    expect(window).toContain('source:   family default');
    const status = statusText(registry);
    expect(status).toMatch(/used +39\.0k \/ unknown/);
    expect(status).toMatch(/window from +family default/);
  });

  test('a user override wins and says so', async () => {
    const registry = await registryOn('abacusai:route-llm');
    registry.setModelContextCap('abacusai:route-llm', 64_000);
    expect(contextWindowText(registry)).toContain('source:   user override');
    expect(statusText(registry)).toMatch(/window from +user override/);
  });
});
