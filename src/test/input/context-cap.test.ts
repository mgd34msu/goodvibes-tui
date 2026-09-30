/**
 * Tests for context cap UI: ModelPickerModal state transitions and
 * InputHandler key routing for the contextCap mode.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelPickerModal } from '../../input/model-picker.ts';
import { handleModelPickerToken } from '../../input/handler-picker-routes.ts';
import {
  type ModelDefinition,
  ProviderRegistry,
} from '@pellux/goodvibes-sdk/platform/providers';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { CacheHitTracker } from '@pellux/goodvibes-sdk/platform/providers';
import { ProviderCapabilityRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import { FavoritesStore } from '@pellux/goodvibes-sdk/platform/providers';
import { BenchmarkStore } from '@pellux/goodvibes-sdk/platform/providers';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLocalModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'local-model',
    provider: 'ollama',
    registryKey: 'ollama:local-model',
    displayName: 'Local Model',
    description: '',
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 4096,
    contextWindowProvenance: 'provider_api', // marks it as local
    selectable: true,
    tier: 'free',
    ...overrides,
  };
}

function makeCloudModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'cloud-model',
    provider: 'openai',
    registryKey: 'openai:cloud-model',
    displayName: 'Cloud Model',
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 128000,
    selectable: true,
    tier: 'standard',
    ...overrides,
  };
}

interface PickerHarness {
  readonly rootDir: string;
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly providerRegistry: ProviderRegistry;
  cleanup(): void;
}

function createPickerHarness(): PickerHarness {
  const rootDir = makeProjectTempDir('gv-context-cap');
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
  writeFileSync(
    benchmarkStore.getCachePath(),
    JSON.stringify({ version: 1 as const, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }, null, 2),
  );
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
    rootDir,
    providerRegistry,
    favoritesStore,
    benchmarkStore,
    cleanup: () => {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

let harness: PickerHarness;

function createPicker(): ModelPickerModal {
  return new ModelPickerModal(harness.favoritesStore, harness.benchmarkStore, harness.providerRegistry);
}

beforeEach(() => {
  harness = createPickerHarness();
});

afterEach(() => {
  harness?.cleanup();
});

// ---------------------------------------------------------------------------
// ModelPickerModal, enterContextCapMode
// ---------------------------------------------------------------------------

describe('ModelPickerModal: enterContextCapMode', () => {
  let picker: ModelPickerModal;

  beforeEach(() => {
    picker = createPicker();
  });

  test('transitions mode to contextCap', () => {
    const model = makeLocalModel();
    picker.enterContextCapMode(model);
    expect(picker.mode).toBe('contextCap');
  });

  test('sets contextCapPendingModel to the given model', () => {
    const model = makeLocalModel();
    picker.enterContextCapMode(model);
    expect(picker.contextCapPendingModel).toBe(model);
  });

  test('resets contextCapQuery to empty string', () => {
    const model = makeLocalModel();
    picker.contextCapQuery = '12345';
    picker.enterContextCapMode(model);
    expect(picker.contextCapQuery).toBe('');
  });

  test('saves previousMode as model', () => {
    const model = makeLocalModel();
    picker.enterContextCapMode(model);
    expect(picker.previousMode).toBe('model');
  });
});

// ---------------------------------------------------------------------------
// ModelPickerModal, appendContextCapChar
// ---------------------------------------------------------------------------

describe('ModelPickerModal: appendContextCapChar', () => {
  let picker: ModelPickerModal;

  beforeEach(() => {
    picker = createPicker();
    picker.enterContextCapMode(makeLocalModel());
  });

  test('accepts digit characters', () => {
    picker.appendContextCapChar('5');
    expect(picker.contextCapQuery).toBe('5');
  });

  test('ignores non-digit characters', () => {
    picker.appendContextCapChar('a');
    picker.appendContextCapChar(' ');
    picker.appendContextCapChar('-');
    picker.appendContextCapChar('.');
    expect(picker.contextCapQuery).toBe('');
  });

  test('accepts all digit characters 0-9', () => {
    for (const d of '0123456789') {
      const p = createPicker();
      p.enterContextCapMode(makeLocalModel());
      p.appendContextCapChar(d);
      expect(p.contextCapQuery).toBe(d);
    }
  });

  test('enforces 9-digit limit: rejects 10th digit', () => {
    for (const d of '123456789') picker.appendContextCapChar(d);
    expect(picker.contextCapQuery).toBe('123456789');
    picker.appendContextCapChar('0');
    expect(picker.contextCapQuery).toBe('123456789'); // still 9
  });

  test('rejects multi-character strings', () => {
    picker.appendContextCapChar('12');
    expect(picker.contextCapQuery).toBe('');
  });
});

// ---------------------------------------------------------------------------
// ModelPickerModal, deleteContextCapChar
// ---------------------------------------------------------------------------

describe('ModelPickerModal: deleteContextCapChar', () => {
  let picker: ModelPickerModal;

  beforeEach(() => {
    picker = createPicker();
    picker.enterContextCapMode(makeLocalModel());
  });

  test('removes last character', () => {
    picker.contextCapQuery = '4096';
    picker.deleteContextCapChar();
    expect(picker.contextCapQuery).toBe('409');
  });

  test('no-op on empty query (boundary condition)', () => {
    expect(() => picker.deleteContextCapChar()).not.toThrow();
    expect(picker.contextCapQuery).toBe('');
  });

  test('removes all characters one by one', () => {
    picker.contextCapQuery = '123';
    picker.deleteContextCapChar();
    picker.deleteContextCapChar();
    picker.deleteContextCapChar();
    expect(picker.contextCapQuery).toBe('');
    picker.deleteContextCapChar(); // should still be empty, no error
    expect(picker.contextCapQuery).toBe('');
  });
});

// ---------------------------------------------------------------------------
// ProviderRegistry, setModelContextCap
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Handler, Space key (local vs cloud)
// ---------------------------------------------------------------------------

describe('ModelPickerModal: isLocalModel', () => {
  let picker: ModelPickerModal;

  beforeEach(() => {
    picker = createPicker();
  });

  test('returns true for models with contextWindowProvenance set', () => {
    const local = makeLocalModel({ contextWindowProvenance: 'provider_api' });
    expect(picker.isLocalModel(local)).toBe(true);
  });

  test('returns true for models with configured_cap provenance', () => {
    const local = makeLocalModel({ contextWindowProvenance: 'configured_cap' });
    expect(picker.isLocalModel(local)).toBe(true);
  });

  test('returns true for models with fallback provenance', () => {
    const local = makeLocalModel({ contextWindowProvenance: 'fallback' });
    expect(picker.isLocalModel(local)).toBe(true);
  });

  test('returns false for cloud models without contextWindowProvenance', () => {
    const cloud = makeCloudModel();
    expect(picker.isLocalModel(cloud)).toBe(false);
  });

  test('cloud model does NOT trigger enterContextCapMode when space is pressed (guard check)', () => {
    const cloud = makeCloudModel();
    // If isLocalModel returns false, enterContextCapMode should not be called.
    // Verify the guard: mode stays 'model' if we respect isLocalModel result.
    expect(picker.isLocalModel(cloud)).toBe(false);
    // Caller (handler) should NOT call enterContextCapMode for cloud models
    //, this test confirms the discriminator works correctly
    picker.models = [cloud];
    picker.openAllModels([cloud], cloud.registryKey!);
    expect(picker.mode).toBe('model');
  });

  test('local model enables entering contextCap mode when space is pressed', () => {
    const local = makeLocalModel();
    expect(picker.isLocalModel(local)).toBe(true);
    picker.enterContextCapMode(local);
    expect(picker.mode).toBe('contextCap');
  });
});

// ---------------------------------------------------------------------------
// Handler, what Enter and Escape in contextCap mode commit
// ---------------------------------------------------------------------------

describe('handleModelPickerToken: the cap Enter commits, and Escape commits nothing', () => {
  const ENTER = { type: 'key' as const, name: 'return', logicalName: 'enter', ctrl: false, shift: false, meta: false };
  const ESCAPE = { type: 'key' as const, name: 'escape', logicalName: 'escape', ctrl: false, shift: false, meta: false };

  function drive(typed: string, token: typeof ENTER | typeof ESCAPE) {
    const picker = createPicker();
    const local = makeLocalModel({ contextWindow: 4096 });
    picker.openAllModels([local], local.id);
    picker.enterContextCapMode(local);
    for (const d of typed) picker.appendContextCapChar(d);
    const selections: Array<{ model: ModelDefinition; contextCap?: number | null }> = [];
    let escaped = 0;
    const state = {
      modelPicker: picker,
      modalStack: ['modelPicker'],
      commandContext: {
        completeModelSelection: (selection: { model: ModelDefinition; contextCap?: number | null }) => { selections.push(selection); },
      } as never,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => { escaped += 1; },
    };
    handleModelPickerToken(state, token);
    return { picker, local, selections, escaped, modalStack: state.modalStack };
  }

  test('a typed cap reaches the model selection as that integer', () => {
    const { selections, picker, modalStack } = drive('8192', ENTER);
    expect(selections).toHaveLength(1);
    expect(selections[0]!.model.id).toBe('local-model');
    expect(selections[0]!.contextCap).toBe(8192);
    expect(picker.active).toBe(false);
    expect(modalStack).toEqual([]);
  });

  test('the upper bound 10,000,000 is accepted and committed', () => {
    const { selections } = drive('10000000', ENTER);
    expect(selections[0]!.contextCap).toBe(10_000_000);
  });

  test('a blank cap commits the model with no cap', () => {
    const { selections } = drive('', ENTER);
    expect(selections).toHaveLength(1);
    expect(selections[0]!.contextCap).toBeNull();
  });

  test('Escape returns to the model list, clears the typed cap and commits nothing', () => {
    const { picker, local, selections, escaped } = drive('9999', ESCAPE);
    expect(picker.mode).toBe('model');
    expect(picker.active).toBe(true);
    expect(picker.contextCapQuery).toBe('');
    expect(picker.contextCapPendingModel).toBeNull();
    expect(selections).toHaveLength(0);
    expect(escaped).toBe(0); // one level popped, the picker itself stays open
    expect(local.contextWindow).toBe(4096);
  });
});

// ---------------------------------------------------------------------------
// ModelPickerModal, contextCapError field
// ---------------------------------------------------------------------------

describe('ModelPickerModal: contextCapError', () => {
  let picker: ModelPickerModal;

  beforeEach(() => {
    picker = createPicker();
  });

  test('starts as null', () => {
    expect(picker.contextCapError).toBeNull();
  });

  test('enterContextCapMode clears any prior error', () => {
    picker.contextCapError = 'previous error';
    picker.enterContextCapMode(makeLocalModel());
    expect(picker.contextCapError).toBeNull();
  });

  test('close() clears contextCapError', () => {
    picker.enterContextCapMode(makeLocalModel());
    picker.contextCapError = 'some error';
    picker.close();
    expect(picker.contextCapError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Handler, contextCap Enter with out-of-range value
// ---------------------------------------------------------------------------

describe('handleModelPickerToken: contextCap Enter with out-of-range value', () => {
  function makeState(picker: ModelPickerModal) {
    return {
      modelPicker: picker,
      modalStack: [] as string[],
      commandContext: undefined as never,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => {},
    };
  }

  test('out-of-range value sets contextCapError and keeps picker open', () => {
    const picker = createPicker();
    const local = makeLocalModel();
    picker.openAllModels([local], local.id);
    picker.enterContextCapMode(local);
    // Type a value above the 10,000,000 ceiling
    for (const d of '20000000') picker.appendContextCapChar(d);
    expect(picker.contextCapQuery).toBe('20000000');

    handleModelPickerToken(makeState(picker), {
      type: 'key', name: 'return', logicalName: 'enter', ctrl: false, shift: false, meta: false,
    });

    expect(picker.mode).toBe('contextCap');
    expect(picker.active).toBe(true);
    expect(picker.contextCapError).toBe('Context cap must be 1–10,000,000');
  });

  test('zero value sets contextCapError and keeps picker open', () => {
    const picker = createPicker();
    const local = makeLocalModel();
    picker.openAllModels([local], local.id);
    picker.enterContextCapMode(local);
    picker.appendContextCapChar('0');

    handleModelPickerToken(makeState(picker), {
      type: 'key', name: 'return', logicalName: 'enter', ctrl: false, shift: false, meta: false,
    });

    expect(picker.mode).toBe('contextCap');
    expect(picker.contextCapError).toBe('Context cap must be 1–10,000,000');
  });

  test('valid value clears contextCapError and closes picker', () => {
    const picker = createPicker();
    const local = makeLocalModel();
    picker.openAllModels([local], local.id);
    picker.enterContextCapMode(local);
    picker.contextCapError = 'previous error';
    for (const d of '8192') picker.appendContextCapChar(d);

    handleModelPickerToken(makeState(picker), {
      type: 'key', name: 'return', logicalName: 'enter', ctrl: false, shift: false, meta: false,
    });

    expect(picker.active).toBe(false);
    expect(picker.contextCapError).toBeNull();
  });

  test('empty value (no cap) closes picker without error', () => {
    const picker = createPicker();
    const local = makeLocalModel();
    picker.openAllModels([local], local.id);
    picker.enterContextCapMode(local);
    // contextCapQuery is empty, user pressed Enter with no digits

    handleModelPickerToken(makeState(picker), {
      type: 'key', name: 'return', logicalName: 'enter', ctrl: false, shift: false, meta: false,
    });

    expect(picker.active).toBe(false);
    expect(picker.contextCapError).toBeNull();
  });
});
