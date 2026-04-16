/**
 * Tests for renderModelPickerOverlay renderer.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config/service-registry';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import { ModelPickerModal } from '../../input/model-picker.ts';
import { renderModelPickerOverlay } from '../../renderer/model-picker-overlay.ts';
import { lineToString, linesToText } from '../setup.ts';
import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers/registry';
import { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import { CacheHitTracker } from '@pellux/goodvibes-sdk/platform/providers/cache-strategy';
import { ProviderCapabilityRegistry } from '@pellux/goodvibes-sdk/platform/providers/capabilities';
import { FavoritesStore } from '@pellux/goodvibes-sdk/platform/providers/favorites';
import { BenchmarkStore, type BenchmarkEntry } from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';

const W = 120;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  const base: ModelDefinition = {
    id: 'test-model',
    provider: 'test-provider',
    registryKey: 'test-provider:test-model',
    displayName: 'Test Model',
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 8192,
    selectable: true,
    tier: 'free',
    ...overrides,
  };
  // Ensure registryKey reflects provider:id after overrides
  if (!base.registryKey || base.registryKey === 'test-provider:test-model') {
    base.registryKey = `${base.provider}:${base.id}`;
  }
  return base;
}

const MODEL_A = makeModel({ id: 'model-a', displayName: 'Alpha', tier: 'free', provider: 'anthropic', contextWindow: 200_000 });
const MODEL_B = makeModel({ id: 'model-b', displayName: 'Beta', tier: 'premium', provider: 'openai', contextWindow: 128_000,
  capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true } });
const MODEL_C = makeModel({ id: 'model-c', displayName: 'Gamma', tier: 'free', provider: 'anthropic' });

interface PickerHarness {
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly providerRegistry: ProviderRegistry;
  cleanup(): void;
}

function writeBenchmarks(entries: BenchmarkEntry[], benchmarkStore: BenchmarkStore): void {
  writeFileSync(
    benchmarkStore.getCachePath(),
    JSON.stringify({
      version: 1 as const,
      fetchedAt: Date.now(),
      ttlMs: 86_400_000,
      entries,
    }, null, 2),
  );
}

function createPickerHarness(): PickerHarness {
  const rootDir = mkdtempSync(join(tmpdir(), 'gv-model-picker-overlay-'));
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
  writeFileSync(favoritesStore.getPath(), JSON.stringify({ pinned: [], history: [] }, null, 2));
  writeBenchmarks([], benchmarkStore);
  benchmarkStore.initBenchmarks();

  const providerRegistry = new ProviderRegistry({
    configManager: new ConfigManager({ surfaceRoot: 'tui',
      configDir,
      workingDir: rootDir,
      homeDir: rootDir,
    }),
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
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

let harness: PickerHarness;

function makePicker(overrides: Partial<ModelPickerModal> = {}): ModelPickerModal {
  const picker = new ModelPickerModal(harness.favoritesStore, harness.benchmarkStore, harness.providerRegistry);
  picker.active = true;
  picker.mode = 'model';
  picker.models = [MODEL_A, MODEL_B, MODEL_C];
  picker.selectedIndex = 0;
  Object.assign(picker, overrides);
  return picker;
}

beforeEach(() => {
  harness = createPickerHarness();
});

afterEach(() => {
  harness?.cleanup();
});

// ---------------------------------------------------------------------------
// Model mode
// ---------------------------------------------------------------------------

describe('renderModelPickerOverlay — model mode', () => {
  test('returns a non-empty Line[] array', () => {
    const lines = renderModelPickerOverlay(makePicker(), W);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('each line has correct terminal width', () => {
    const lines = renderModelPickerOverlay(makePicker(), W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('title bar contains "Select Model"', () => {
    const lines = renderModelPickerOverlay(makePicker(), W);
    const title = lineToString(lines[0]);
    expect(title).toContain('Select Model');
  });

  test('footer contains Tab filter hint', () => {
    const lines = renderModelPickerOverlay(makePicker(), W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Tab');
    expect(footer).toContain('Filter');
  });

  test('search row shows a cursor only when search is focused', () => {
    const picker = makePicker();
    picker.searchFocused = false;
    const unfocused = lineToString(renderModelPickerOverlay(picker, W)[1]!);
    expect(unfocused).not.toContain('█');

    picker.searchFocused = true;
    const focused = lineToString(renderModelPickerOverlay(picker, W)[1]!);
    expect(focused).toContain('█');
  });

  test('footer shows current filter label', () => {
    const picker = makePicker();
    picker.categoryFilter = 'free';
    const lines = renderModelPickerOverlay(picker, W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Free');
  });

  test('footer shows Paid when filter is paid', () => {
    const picker = makePicker();
    picker.categoryFilter = 'paid';
    const lines = renderModelPickerOverlay(picker, W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Paid');
  });

  test('footer shows Sub when filter is subscription', () => {
    const picker = makePicker();
    picker.categoryFilter = 'subscription';
    const lines = renderModelPickerOverlay(picker, W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Sub');
  });

  test('shows model ids in list', () => {
    const texts = linesToText(renderModelPickerOverlay(makePicker(), W)).join('\n');
    expect(texts).toContain('model-a');
    expect(texts).toContain('model-b');
  });

  test('selected item has arrow indicator', () => {
    const lines = renderModelPickerOverlay(makePicker(), W);
    const hasArrow = lines.some(line => line.some(cell => cell.char === '▸'));
    expect(hasArrow).toBe(true);
  });

  test('provider group headers are present', () => {
    const texts = linesToText(renderModelPickerOverlay(makePicker(), W)).join('\n');
    expect(texts).toContain('anthropic');
    expect(texts).toContain('openai');
  });

  test('empty model list shows helpful message', () => {
    const picker = makePicker({ models: [] } as Partial<ModelPickerModal>);
    picker.models = [];
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('No models');
  });

  test('no-match query shows helpful message', () => {
    const picker = makePicker();
    picker.query = 'zzz-no-match';
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('No models match');
  });

  test('capability panel appears for selected model', () => {
    const picker = makePicker({ selectedIndex: 1 });
    // MODEL_B has reasoning + multimodal
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('Provider:');
    expect(texts).toContain('Context:');
  });

  test('capability panel shows Reasoning for reasoning model', () => {
    const picker = makePicker({ selectedIndex: 1 });
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('Reasoning');
  });

  test('capability panel shows Vision for multimodal model', () => {
    const picker = makePicker({ selectedIndex: 1 });
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('Vision');
  });

  test('null capabilities guard — model without capabilities still renders', () => {
    const picker = makePicker();
    // Simulate missing capabilities
    (picker.models[0] as ModelDefinition & { capabilities: unknown }).capabilities = undefined as unknown as ModelDefinition['capabilities'];
    // Should not throw
    expect(() => renderModelPickerOverlay(picker, W)).not.toThrow();
  });

  test('large context window formatted as M', () => {
    const picker = makePicker({ selectedIndex: 0 });
    // MODEL_A has contextWindow: 200_000
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    // 200k
    expect(texts).toMatch(/200k|Context/);
  });

  test('works at narrow terminal width', () => {
    const narrowW = 60;
    const lines = renderModelPickerOverlay(makePicker(), narrowW);
    for (const line of lines) {
      expect(line.length).toBe(narrowW);
    }
  });

  test('free-tier and pinned model markers keep Unicode glyphs', () => {
    const picker = makePicker();
    picker.pinnedIds.add('model-a');
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('★  model-a');
    expect(texts).toContain('Alpha                                •');
    expect(texts).not.toContain('* model-a');
  });
});

// ---------------------------------------------------------------------------
// Provider mode
// ---------------------------------------------------------------------------

describe('renderModelPickerOverlay — provider mode', () => {
  function makeProviderPicker(): ModelPickerModal {
    const picker = new ModelPickerModal(harness.favoritesStore, harness.benchmarkStore, harness.providerRegistry);
    picker.active = true;
    picker.mode = 'provider';
    picker.providers = ['anthropic', 'openai', 'gemini'];
    picker.selectedIndex = 0;
    return picker;
  }

  test('returns non-empty Line[] in provider mode', () => {
    const lines = renderModelPickerOverlay(makeProviderPicker(), W);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('each line has correct width in provider mode', () => {
    const lines = renderModelPickerOverlay(makeProviderPicker(), W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('title bar contains "Select Provider"', () => {
    const lines = renderModelPickerOverlay(makeProviderPicker(), W);
    const title = lineToString(lines[0]);
    expect(title).toContain('Select Provider');
  });

  test('shows provider names in list', () => {
    const texts = linesToText(renderModelPickerOverlay(makeProviderPicker(), W)).join('\n');
    expect(texts).toContain('anthropic');
    expect(texts).toContain('openai');
    expect(texts).toContain('gemini');
  });

  test('hint text tells user to select provider for models', () => {
    const texts = linesToText(renderModelPickerOverlay(makeProviderPicker(), W)).join('\n');
    expect(texts).toContain('Select a provider');
  });

  test('empty providers list shows helpful message', () => {
    const picker = makeProviderPicker();
    picker.providers = [];
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('No providers');
  });

  test('selected item has arrow indicator', () => {
    const lines = renderModelPickerOverlay(makeProviderPicker(), W);
    const hasArrow = lines.some(line => line.some(cell => cell.char === '▸'));
    expect(hasArrow).toBe(true);
  });

  test('footer does not show Tab filter hint in provider mode', () => {
    const lines = renderModelPickerOverlay(makeProviderPicker(), W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).not.toContain('Tab');
  });

  test('search bar is present in provider mode', () => {
    const texts = linesToText(renderModelPickerOverlay(makeProviderPicker(), W)).join('\n');
    expect(texts).toContain('/ ');
  });

  test('query filters provider list', () => {
    const picker = makeProviderPicker();
    picker.query = 'open';
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('openai');
    expect(texts).not.toContain('anthropic');
    expect(texts).not.toContain('gemini');
  });

  test('configured providers use a Unicode checkmark instead of letter markers', () => {
    const picker = makeProviderPicker();
    picker.configuredProviders = new Set(['openai']);
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('✓ openai');
    expect(texts).not.toContain('y openai');
  });

  test('no-match query shows helpful message', () => {
    const picker = makeProviderPicker();
    picker.query = 'zzz-no-match';
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('No providers match');
  });

  test('each line has correct width in provider mode with query', () => {
    const picker = makeProviderPicker();
    picker.query = 'ant';
    const lines = renderModelPickerOverlay(picker, W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });
});

// ---------------------------------------------------------------------------
// Effort mode
// ---------------------------------------------------------------------------

describe('renderModelPickerOverlay — effort mode', () => {
  function makeEffortPicker(): ModelPickerModal {
    const picker = new ModelPickerModal(harness.favoritesStore, harness.benchmarkStore, harness.providerRegistry);
    picker.active = true;
    picker.mode = 'effort';
    picker.effortLevels = ['low', 'medium', 'high'];
    picker.selectedIndex = 1;
    picker.pendingModel = MODEL_B;
    return picker;
  }

  test('returns non-empty Line[] in effort mode', () => {
    const lines = renderModelPickerOverlay(makeEffortPicker(), W);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('each line has correct width in effort mode', () => {
    const lines = renderModelPickerOverlay(makeEffortPicker(), W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('title bar contains "Select Effort Level"', () => {
    const lines = renderModelPickerOverlay(makeEffortPicker(), W);
    const title = lineToString(lines[0]);
    expect(title).toContain('Select Effort Level');
  });

  test('shows effort level names in list', () => {
    const texts = linesToText(renderModelPickerOverlay(makeEffortPicker(), W)).join('\n');
    expect(texts).toContain('low');
    expect(texts).toContain('medium');
    expect(texts).toContain('high');
  });

  test('shows effort descriptions from shared constant', () => {
    const texts = linesToText(renderModelPickerOverlay(makeEffortPicker(), W)).join('\n');
    expect(texts).toContain('Balanced speed and quality');
  });

  test('shows pending model name in footer area', () => {
    const texts = linesToText(renderModelPickerOverlay(makeEffortPicker(), W)).join('\n');
    expect(texts).toContain('Model:');
    expect(texts).toContain('Beta');
  });

  test('shows "unknown" when pendingModel is null', () => {
    const picker = makeEffortPicker();
    picker.pendingModel = null;
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('unknown');
  });

  test('selected item has arrow indicator', () => {
    const lines = renderModelPickerOverlay(makeEffortPicker(), W);
    const hasArrow = lines.some(line => line.some(cell => cell.char === '▸'));
    expect(hasArrow).toBe(true);
  });

  test('works at narrow terminal width', () => {
    const narrowW = 60;
    const lines = renderModelPickerOverlay(makeEffortPicker(), narrowW);
    for (const line of lines) {
      expect(line.length).toBe(narrowW);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 5: Quality tier badge, pin indicator, filters
// ---------------------------------------------------------------------------

describe('renderModelPickerOverlay — Stage 5 features', () => {
  test('quality tier badge [S]/[A]/[B]/[C] renders for models with benchmark data', () => {
    writeBenchmarks([
      { modelId: 'model-a', name: 'model-a', organization: 'test', benchmarks: { swe: 0.92, gpqa: 0.88 } },
    ], harness.benchmarkStore);
    harness.benchmarkStore.initBenchmarks();
    const picker = makePicker({ selectedIndex: 0 });
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    // S tier threshold: composite >= 0.80; swe=0.92, gpqa=0.88 → composite ≈ 0.90
    expect(texts).toMatch(/\[S\]|\[A\]|\[B\]|\[C\]/);
  });

  test('free indicator renders for free-tier models', () => {
    writeBenchmarks([], harness.benchmarkStore);
    harness.benchmarkStore.initBenchmarks();
    const picker = makePicker({ selectedIndex: 0 });
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('•');
  });

  test('pin star renders for pinned models', () => {
    const picker = makePicker();
    picker.pinnedIds = new Set(['model-a']);
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('▸ ★  model-a');
  });

  test('no pin star when model is not pinned', () => {
    const picker = makePicker();
    picker.pinnedIds = new Set();
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).not.toContain('\u2605');
  });

  test('footer shows Group hint in model mode', () => {
    const picker = makePicker();
    const lines = renderModelPickerOverlay(picker, W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Group');
  });

  test('footer shows current groupBy mode', () => {
    const picker = makePicker();
    picker.groupBy = 'family';
    const lines = renderModelPickerOverlay(picker, W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Group: fam');
  });

  test('paid filter label shows Paid in footer', () => {
    const picker = makePicker();
    picker.categoryFilter = 'paid';
    const lines = renderModelPickerOverlay(picker, W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Paid');
  });

  test('subscription filter label shows Sub in footer', () => {
    const picker = makePicker();
    picker.categoryFilter = 'subscription';
    const lines = renderModelPickerOverlay(picker, W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Sub');
  });

  test('lines maintain correct width when pin/badge columns are added', () => {
    const picker = makePicker();
    picker.pinnedIds = new Set(['model-a']);
    writeBenchmarks([
      { modelId: 'model-a', name: 'model-a', organization: 'test', benchmarks: { swe: 0.9 } },
    ], harness.benchmarkStore);
    harness.benchmarkStore.initBenchmarks();
    const lines = renderModelPickerOverlay(picker, W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });
});
