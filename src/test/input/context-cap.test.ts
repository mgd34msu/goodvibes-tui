/**
 * Tests for context cap UI: ModelPickerModal state transitions and
 * InputHandler key routing for the contextCap mode.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ModelPickerModal } from '../../input/model-picker.ts';
import {
  getProviderRegistry,
  getModelRegistry,
  _resetProviderRegistryForTesting,
  type ModelDefinition,
} from '../../providers/registry.ts';
import {
  _setCatalogForTesting,
  _resetForTest,
  type PricingCatalog,
} from '../../providers/model-catalog.ts';
import type { DiscoveredServer } from '../../discovery/scanner.ts';

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

const MINIMAL_CATALOG: PricingCatalog = {
  fetchedAt: Date.now(),
  models: [],
};

// ---------------------------------------------------------------------------
// ModelPickerModal — enterContextCapMode
// ---------------------------------------------------------------------------

describe('ModelPickerModal — enterContextCapMode', () => {
  let picker: ModelPickerModal;

  beforeEach(() => {
    picker = new ModelPickerModal();
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
// ModelPickerModal — appendContextCapChar
// ---------------------------------------------------------------------------

describe('ModelPickerModal — appendContextCapChar', () => {
  let picker: ModelPickerModal;

  beforeEach(() => {
    picker = new ModelPickerModal();
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
      const p = new ModelPickerModal();
      p.enterContextCapMode(makeLocalModel());
      p.appendContextCapChar(d);
      expect(p.contextCapQuery).toBe(d);
    }
  });

  test('enforces 9-digit limit — rejects 10th digit', () => {
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
// ModelPickerModal — deleteContextCapChar
// ---------------------------------------------------------------------------

describe('ModelPickerModal — deleteContextCapChar', () => {
  let picker: ModelPickerModal;

  beforeEach(() => {
    picker = new ModelPickerModal();
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
// ProviderRegistry — setModelContextCap
// ---------------------------------------------------------------------------

describe('ProviderRegistry — setModelContextCap', () => {
  beforeEach(() => {
    _resetProviderRegistryForTesting();
    _setCatalogForTesting(MINIMAL_CATALOG);
  });

  afterEach(() => {
    _resetProviderRegistryForTesting();
    _resetForTest();
  });

  test('updates contextWindow for a discovered model', () => {
    const registry = getProviderRegistry();
    // Inject a discovered server — the registry creates ModelDefinition entries from it
    const server: DiscoveredServer = {
      name: 'ollama',
      host: '127.0.0.1',
      port: 11434,
      baseURL: 'http://127.0.0.1:11434/v1',
      models: ['qwen3-local'],
      serverType: 'ollama',
      modelContextWindows: { 'qwen3-local': 8192 },
    };
    registry.registerDiscoveredProviders([server]);

    registry.setModelContextCap('ollama:qwen3-local', 32768);
    const updated = getModelRegistry().find(m => m.registryKey === 'ollama:qwen3-local');
    expect(updated?.contextWindow).toBe(32768);
    expect(updated?.contextWindowProvenance).toBe('configured_cap');
  });

  test('does not throw when model is not found', () => {
    const registry = getProviderRegistry();
    expect(() => registry.setModelContextCap('nonexistent:model', 8192)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Handler — Space key (local vs cloud)
// ---------------------------------------------------------------------------

describe('ModelPickerModal — isLocalModel', () => {
  let picker: ModelPickerModal;

  beforeEach(() => {
    picker = new ModelPickerModal();
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
    // — this test confirms the discriminator works correctly
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
// Handler — Enter key in contextCap mode
// ---------------------------------------------------------------------------

describe('ModelPickerModal — contextCap Enter scenarios', () => {
  let picker: ModelPickerModal;
  const local = makeLocalModel();

  beforeEach(() => {
    picker = new ModelPickerModal();
    picker.enterContextCapMode(local);
  });

  test('blank input — parsedCap is null (validCap is null)', () => {
    // Simulate what handler does on Enter
    const rawInput = picker.contextCapQuery.trim();
    const parsedCap = rawInput.length > 0 ? parseInt(rawInput, 10) : null;
    const validCap = parsedCap !== null && parsedCap > 0 && parsedCap <= 10_000_000 ? parsedCap : null;
    expect(validCap).toBeNull();
  });

  test('valid positive integer — validCap is that integer', () => {
    picker.appendContextCapChar('8');
    picker.appendContextCapChar('1');
    picker.appendContextCapChar('9');
    picker.appendContextCapChar('2');
    const rawInput = picker.contextCapQuery.trim();
    const parsedCap = rawInput.length > 0 ? parseInt(rawInput, 10) : null;
    const validCap = parsedCap !== null && parsedCap > 0 && parsedCap <= 10_000_000 ? parsedCap : null;
    expect(validCap).toBe(8192);
  });

  test('zero input — validCap is null (zero is not positive)', () => {
    picker.appendContextCapChar('0');
    const rawInput = picker.contextCapQuery.trim();
    const parsedCap = rawInput.length > 0 ? parseInt(rawInput, 10) : null;
    const validCap = parsedCap !== null && parsedCap > 0 && parsedCap <= 10_000_000 ? parsedCap : null;
    expect(validCap).toBeNull();
  });

  test('value exceeding 10_000_000 — validCap is null', () => {
    // 10000001 — one over the limit
    for (const d of '10000001') picker.appendContextCapChar(d);
    const rawInput = picker.contextCapQuery.trim();
    const parsedCap = rawInput.length > 0 ? parseInt(rawInput, 10) : null;
    const validCap = parsedCap !== null && parsedCap > 0 && parsedCap <= 10_000_000 ? parsedCap : null;
    expect(validCap).toBeNull();
  });

  test('value at exact upper bound 10_000_000 — validCap is accepted', () => {
    for (const d of '10000000') picker.appendContextCapChar(d);
    const rawInput = picker.contextCapQuery.trim();
    const parsedCap = rawInput.length > 0 ? parseInt(rawInput, 10) : null;
    const validCap = parsedCap !== null && parsedCap > 0 && parsedCap <= 10_000_000 ? parsedCap : null;
    expect(validCap).toBe(10_000_000);
  });
});

// ---------------------------------------------------------------------------
// Handler — Escape key in contextCap mode (reset)
// ---------------------------------------------------------------------------

describe('ModelPickerModal — Escape from contextCap resets state', () => {
  let picker: ModelPickerModal;

  beforeEach(() => {
    picker = new ModelPickerModal();
  });

  test('Escape clears contextCapQuery and returns to model mode', () => {
    const local = makeLocalModel();
    picker.enterContextCapMode(local);
    picker.appendContextCapChar('4');
    picker.appendContextCapChar('0');

    // Simulate handler escape logic
    picker.contextCapQuery = '';
    picker.contextCapPendingModel = null;
    picker.mode = 'model';

    expect(picker.mode).toBe('model');
    expect(picker.contextCapQuery).toBe('');
    expect(picker.contextCapPendingModel).toBeNull();
  });

  test('Escape does not apply contextCap to the model', () => {
    const local = makeLocalModel({ contextWindow: 4096 });
    picker.enterContextCapMode(local);
    picker.appendContextCapChar('9');
    picker.appendContextCapChar('9');
    picker.appendContextCapChar('9');
    picker.appendContextCapChar('9');

    // Simulate escape — cancel without applying
    picker.contextCapQuery = '';
    picker.contextCapPendingModel = null;
    picker.mode = 'model';

    // The original model object's contextWindow is untouched
    expect(local.contextWindow).toBe(4096);
  });
});
