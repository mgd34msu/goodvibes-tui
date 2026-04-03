/**
 * G00: Context window routing tests.
 *
 * Proves that getContextWindowForModel uses the resolved context window
 * with correct priority: provider_api > OpenRouter cache > static registry.
 */
import { describe, test, expect } from 'bun:test';
import type { ModelDefinition } from '../../providers/registry.ts';
import { getContextWindowForModel } from '../../providers/model-limits.ts';
import { resolveContextWindow } from '../../providers/local-context-ingestion.ts';

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// provider_api provenance is highest priority in getContextWindowForModel
// ---------------------------------------------------------------------------

describe('getContextWindowForModel — provider_api provenance', () => {
  test('uses contextWindow directly when provenance is provider_api', () => {
    const model = makeModel({
      contextWindow: 131_072,
      contextWindowProvenance: 'provider_api',
    });
    // Even without OpenRouter cache, the provider_api value should be used.
    const result = getContextWindowForModel(model);
    expect(result).toBe(131_072);
  });

  test('uses contextWindow directly when provenance is provider_api (large context)', () => {
    const model = makeModel({
      contextWindow: 1_048_576,
      contextWindowProvenance: 'provider_api',
    });
    const result = getContextWindowForModel(model);
    expect(result).toBe(1_048_576);
  });

  test('falls through to contextWindow when no provenance and no OpenRouter cache', () => {
    const model = makeModel({
      contextWindow: 16_384,
      // No contextWindowProvenance
    });
    // Without OpenRouter cache loaded, falls back to static value.
    const result = getContextWindowForModel(model);
    expect(result).toBe(16_384);
  });
});

// ---------------------------------------------------------------------------
// configured_cap and fallback provenance
// ---------------------------------------------------------------------------

describe('getContextWindowForModel — configured_cap and fallback', () => {
  test('configured_cap falls through to OpenRouter/registry path (not provider_api shortcut)', () => {
    const model = makeModel({
      contextWindow: 65_536,
      contextWindowProvenance: 'configured_cap',
    });
    // configured_cap does NOT trigger the provider_api shortcut.
    // It goes through the normal OpenRouter -> static path.
    // Since there is no OpenRouter cache in unit tests, falls back to contextWindow.
    const result = getContextWindowForModel(model);
    expect(result).toBe(65_536);
  });

  test('fallback provenance falls through to registry value', () => {
    const model = makeModel({
      contextWindow: 8_192,
      contextWindowProvenance: 'fallback',
    });
    const result = getContextWindowForModel(model);
    expect(result).toBe(8_192);
  });
});

// ---------------------------------------------------------------------------
// resolveContextWindow integration: correct model building
// ---------------------------------------------------------------------------

describe('resolveContextWindow + ModelDefinition integration', () => {
  test('building a ModelDefinition with provider_api provenance sets correct contextWindow', () => {
    const apiContextLength = 200_000;
    const configuredContextWindow = 32_768;

    const resolved = resolveContextWindow('llama-3', apiContextLength, configuredContextWindow);
    expect(resolved.provenance).toBe('provider_api');

    const model = makeModel({
      contextWindow: resolved.tokens,
      contextWindowProvenance: resolved.provenance,
    });

    // getContextWindowForModel should return the API-reported value
    const effective = getContextWindowForModel(model);
    expect(effective).toBe(200_000);
  });

  test('building with fallback provenance still yields non-zero context window', () => {
    const resolved = resolveContextWindow('unknown-local-model', null, 0);
    expect(resolved.provenance).toBe('fallback');
    expect(resolved.tokens).toBeGreaterThan(0);

    const model = makeModel({
      contextWindow: resolved.tokens,
      contextWindowProvenance: resolved.provenance,
    });

    const effective = getContextWindowForModel(model);
    expect(effective).toBeGreaterThan(0);
  });
});
