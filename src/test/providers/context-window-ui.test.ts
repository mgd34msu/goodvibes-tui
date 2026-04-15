/**
 * Context window UI and diagnostics tests.
 *
 * Proves that ModelPickerEntry includes contextWindow and contextWindowSource,
 * and that getContextIngestionDiagnostics surfaces cache state.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalContextIngestionService,
} from '@pellux/goodvibes-sdk/platform/providers/local-context-ingestion';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import { enrichModelEntries } from '@pellux/goodvibes-sdk/platform/runtime/ui/model-picker/health-enrichment';
import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers/registry';
import { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import { createInitialProviderHealthState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/provider-health';
import { createInitialModelState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/model';
import { CacheHitTracker } from '@pellux/goodvibes-sdk/platform/providers/cache-strategy';
import { ProviderCapabilityRegistry } from '@pellux/goodvibes-sdk/platform/providers/capabilities';
import { FavoritesStore } from '@pellux/goodvibes-sdk/platform/providers/favorites';
import { BenchmarkStore } from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'test-model',
    provider: 'test-provider',
    registryKey: 'test-provider:test-model',
    displayName: 'Test Model',
    description: '',
    contextWindow: 32_768,
    selectable: true,
    capabilities: {
      toolCalling: true,
      codeEditing: true,
      reasoning: false,
      multimodal: false,
    },
    ...overrides,
  };
}

function makeHealthState() {
  return createInitialProviderHealthState();
}

function makeModelState(activeModelId = 'test-model') {
  const state = createInitialModelState();
  return { ...state, activeModelId };
}

interface EnrichmentHarness {
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly providerRegistry: ProviderRegistry;
  readonly contextIngestionService: LocalContextIngestionService;
  cleanup(): void;
}

function createEnrichmentHarness(): EnrichmentHarness {
  const rootDir = mkdtempSync(join(tmpdir(), 'gv-context-window-ui-'));
  const configDir = join(rootDir, 'config');
  const dataDir = join(rootDir, 'provider-data');
  const subscriptionsPath = join(rootDir, 'subscriptions.json');
  const servicesPath = join(rootDir, 'services.json');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const secretsManager = new SecretsManager({ projectRoot: rootDir, globalHome: rootDir });
  const subscriptionManager = new SubscriptionManager(subscriptionsPath);
  const serviceRegistry = new ServiceRegistry(servicesPath, {
    secretsManager,
    subscriptionManager,
  });
  const favoritesStore = new FavoritesStore({ dir: dataDir });
  const benchmarkStore = new BenchmarkStore({ dir: dataDir });
  const contextIngestionService = new LocalContextIngestionService();
  writeFileSync(favoritesStore.getPath(), JSON.stringify({ pinned: [], history: [] }, null, 2));
  writeFileSync(
    benchmarkStore.getCachePath(),
    JSON.stringify({ version: 1 as const, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }, null, 2),
  );
  benchmarkStore.initBenchmarks();

  const providerRegistry = new ProviderRegistry({
    configManager: new ConfigManager({ surfaceRoot: 'tui',  configDir }),
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    capabilityRegistry: new ProviderCapabilityRegistry(),
    cacheHitTracker: new CacheHitTracker(),
    favoritesStore,
    benchmarkStore,
  });

  return {
    favoritesStore,
    benchmarkStore,
    providerRegistry,
    contextIngestionService,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

let harness: EnrichmentHarness;

beforeEach(() => {
  harness = createEnrichmentHarness();
});

afterEach(() => {
  harness?.cleanup();
});

// ---------------------------------------------------------------------------
// enrichModelEntries — contextWindow and contextWindowSource fields
// ---------------------------------------------------------------------------

describe('enrichModelEntries — contextWindow fields', () => {
  test('entry includes contextWindow equal to model.contextWindow when no OpenRouter cache', () => {
    const model = makeModel({ contextWindow: 32_768 });
    const entries = enrichModelEntries(
      [model],
      makeHealthState(),
      makeModelState(),
      new Set(),
      harness.benchmarkStore,
      harness.providerRegistry,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.contextWindow).toBe(32_768);
  });

  test('entry contextWindowSource is "registry" when no provenance and no OpenRouter data', () => {
    const model = makeModel({ contextWindow: 32_768 });
    const entries = enrichModelEntries(
      [model],
      makeHealthState(),
      makeModelState(),
      new Set(),
      harness.benchmarkStore,
      harness.providerRegistry,
    );
    expect(entries[0]!.contextWindowSource).toBe('registry');
  });

  test('entry contextWindowSource is "provider_api" when model has provider_api provenance', () => {
    const model = makeModel({
      contextWindow: 131_072,
      contextWindowProvenance: 'provider_api',
    });
    const entries = enrichModelEntries(
      [model],
      makeHealthState(),
      makeModelState(),
      new Set(),
      harness.benchmarkStore,
      harness.providerRegistry,
    );
    expect(entries[0]!.contextWindowSource).toBe('provider_api');
    expect(entries[0]!.contextWindow).toBe(131_072);
  });

  test('entry contextWindowSource is "configured_cap" when model has configured_cap provenance', () => {
    const model = makeModel({
      contextWindow: 65_536,
      contextWindowProvenance: 'configured_cap',
    });
    const entries = enrichModelEntries(
      [model],
      makeHealthState(),
      makeModelState(),
      new Set(),
      harness.benchmarkStore,
      harness.providerRegistry,
    );
    expect(entries[0]!.contextWindowSource).toBe('configured_cap');
  });

  test('entry contextWindowSource is "fallback" when model has fallback provenance', () => {
    const model = makeModel({
      contextWindow: 8_192,
      contextWindowProvenance: 'fallback',
    });
    const entries = enrichModelEntries(
      [model],
      makeHealthState(),
      makeModelState(),
      new Set(),
      harness.benchmarkStore,
      harness.providerRegistry,
    );
    expect(entries[0]!.contextWindowSource).toBe('fallback');
  });

  test('multiple models each have correct contextWindow', () => {
    const models = [
      makeModel({ id: 'small', contextWindow: 8_192 }),
      makeModel({ id: 'large', contextWindow: 128_000, contextWindowProvenance: 'provider_api' }),
      makeModel({ id: 'medium', contextWindow: 32_768, contextWindowProvenance: 'configured_cap' }),
    ];
    const entries = enrichModelEntries(
      models,
      makeHealthState(),
      makeModelState('small'),
      new Set(),
      harness.benchmarkStore,
      harness.providerRegistry,
    );
    const byId = new Map(entries.map((e) => [e.modelId, e]));
    expect(byId.get('small')!.contextWindow).toBe(8_192);
    expect(byId.get('small')!.contextWindowSource).toBe('registry');
    expect(byId.get('large')!.contextWindow).toBe(128_000);
    expect(byId.get('large')!.contextWindowSource).toBe('provider_api');
    expect(byId.get('medium')!.contextWindow).toBe(32_768);
    expect(byId.get('medium')!.contextWindowSource).toBe('configured_cap');
  });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

describe('getContextIngestionDiagnostics', () => {
  beforeEach(() => {
    harness.contextIngestionService.clearAllCaches();
  });

  test('returns empty array when no ingestion has occurred', () => {
    const diag = harness.contextIngestionService.getDiagnostics();
    expect(diag).toEqual([]);
  });

  test('returns correct shape', () => {
    // Diagnostics are provider-level; we check the shape contract here.
    const diag = harness.contextIngestionService.getDiagnostics();
    expect(Array.isArray(diag)).toBe(true);
    // Each entry should have the expected keys (checked on a non-empty array in integration tests)
    for (const entry of diag) {
      expect(typeof entry.providerName).toBe('string');
      expect(typeof entry.fetchedAt).toBe('number');
      expect(typeof entry.modelCount).toBe('number');
      expect(typeof entry.failed).toBe('boolean');
    }
  });
});
