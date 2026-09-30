/**
 * Tests for /context window, parsing, status text, and the set/clear/show
 * subcommand flows against a stub provider registry.
 */
import { describe, test, expect } from 'bun:test';
import {
  parseContextWindowSize,
  buildContextWindowStatusText,
  handleContextWindowSubcommand,
} from '../../input/commands/context-window.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers';

// ---------------------------------------------------------------------------
// parseContextWindowSize
// ---------------------------------------------------------------------------

describe('parseContextWindowSize', () => {
  test('plain token counts', () => {
    expect(parseContextWindowSize('120000')).toBe(120_000);
    expect(parseContextWindowSize('1')).toBe(1);
  });
  test('k suffix (thousands), case-insensitive, decimals allowed', () => {
    expect(parseContextWindowSize('200k')).toBe(200_000);
    expect(parseContextWindowSize('200K')).toBe(200_000);
    expect(parseContextWindowSize('12.5k')).toBe(12_500);
  });
  test('m suffix (millions)', () => {
    expect(parseContextWindowSize('1m')).toBe(1_000_000);
    expect(parseContextWindowSize('2M')).toBe(2_000_000);
  });
  test('upper bound: 10m accepted, above rejected', () => {
    expect(parseContextWindowSize('10m')).toBe(10_000_000);
    expect(parseContextWindowSize('10000001')).toBeNull();
    expect(parseContextWindowSize('11m')).toBeNull();
  });
  test('rejects zero, negatives, junk, and empty', () => {
    expect(parseContextWindowSize('0')).toBeNull();
    expect(parseContextWindowSize('-5')).toBeNull();
    expect(parseContextWindowSize('abc')).toBeNull();
    expect(parseContextWindowSize('200kb')).toBeNull();
    expect(parseContextWindowSize('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stub registry + ctx
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'fable-5',
    provider: 'anthropic',
    registryKey: 'anthropic:fable-5',
    displayName: 'Fable 5',
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 200_000,
    selectable: true,
    tier: 'standard',
    ...overrides,
  };
}

interface Harness {
  ctx: CommandContext;
  printed: string[];
  calls: { set: Array<[string, number]>; cleared: string[] };
}

function makeHarness(opts: { override?: number | null; observed?: number | null; model?: ModelDefinition } = {}): Harness {
  const printed: string[] = [];
  const calls: Harness['calls'] = { set: [], cleared: [] };
  let override = opts.override ?? null;
  let observed = opts.observed ?? null;
  const baseModel = opts.model ?? makeModel();

  const providerRegistry = {
    getCurrentModel: () => {
      if (override !== null) return { ...baseModel, contextWindow: override, contextWindowProvenance: 'configured_cap' as const, contextWindowOrigin: { kind: 'user_override' as const } };
      if (observed !== null && observed < baseModel.contextWindow) {
        return { ...baseModel, contextWindow: observed, contextWindowProvenance: 'observed_limit' as const };
      }
      return baseModel;
    },
    getContextWindowForModel: (m: ModelDefinition) => m.contextWindow,
    getKnownContextWindowForModel: (m: ModelDefinition) => m.contextWindow,
    getModelContextCap: () => override,
    getObservedContextWindow: () => observed,
    setModelContextCap: (key: string, cap: number) => { calls.set.push([key, cap]); override = cap; },
    clearModelContextCap: (key: string) => {
      const existed = override !== null || observed !== null;
      calls.cleared.push(key);
      override = null;
      observed = null;
      return existed;
    },
  };

  const ctx = {
    provider: { providerRegistry },
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
  } as unknown as CommandContext;

  return { ctx, printed, calls };
}

// ---------------------------------------------------------------------------
// handleContextWindowSubcommand
// ---------------------------------------------------------------------------

describe('handleContextWindowSubcommand', () => {
  test('no args shows resolved window, provenance, and no override', () => {
    const h = makeHarness();
    const out = handleContextWindowSubcommand([], h.ctx);
    expect(out).toContain('Fable 5');
    expect(out).toContain('200,000 tokens');
    expect(out).toContain('none (automatic)');
    expect(h.printed).toHaveLength(1);
  });

  test('no args with an active override labels it as a user override', () => {
    const h = makeHarness({ override: 150_000 });
    const out = handleContextWindowSubcommand([], h.ctx);
    expect(out).toContain('source:   user override');
    expect(out).toContain('150,000 tokens');
  });

  test('no args with a learned limit shows it and labels the provenance', () => {
    const h = makeHarness({ observed: 150_000 });
    const out = handleContextWindowSubcommand([], h.ctx);
    expect(out).toContain('learned from a provider rejection');
    expect(out).toContain('learned limit: 150,000 tokens');
  });

  test('clear with only a learned limit reports cleared', () => {
    const h = makeHarness({ observed: 250_000 });
    const out = handleContextWindowSubcommand(['clear'], h.ctx);
    expect(out).toContain('cleared');
  });

  test('setting a size calls setModelContextCap with the parsed value', () => {
    const h = makeHarness();
    const out = handleContextWindowSubcommand(['150k'], h.ctx);
    expect(h.calls.set).toEqual([['anthropic:fable-5', 150_000]]);
    expect(out).toContain('set to 150,000 tokens');
  });

  test('clear with an active override reports the restored automatic window', () => {
    const h = makeHarness({ override: 100_000 });
    const out = handleContextWindowSubcommand(['clear'], h.ctx);
    expect(h.calls.cleared).toEqual(['anthropic:fable-5']);
    expect(out).toContain('cleared');
    expect(out).toContain('200,000');
  });

  test('clear without an override says nothing was set', () => {
    const h = makeHarness();
    const out = handleContextWindowSubcommand(['clear'], h.ctx);
    expect(out).toContain('no custom context window');
  });

  test("'auto' behaves as clear", () => {
    const h = makeHarness({ override: 100_000 });
    handleContextWindowSubcommand(['auto'], h.ctx);
    expect(h.calls.cleared).toHaveLength(1);
  });

  test('invalid size prints guidance and sets nothing', () => {
    const h = makeHarness();
    const out = handleContextWindowSubcommand(['banana'], h.ctx);
    expect(h.calls.set).toHaveLength(0);
    expect(out).toContain("Invalid size 'banana'");
    expect(out).toContain('200k');
  });
});

// ---------------------------------------------------------------------------
// buildContextWindowStatusText provenance labels
// ---------------------------------------------------------------------------

describe('buildContextWindowStatusText provenance labels', () => {
  test.each([
    [{ contextWindowProvenance: 'configured_cap', contextWindowOrigin: { kind: 'user_override' } }, 'source:   user override'],
    [{ contextWindowProvenance: 'configured_cap', contextWindowOrigin: { kind: 'provider_file' } }, 'source:   provider file'],
    [{ contextWindowProvenance: 'provider_api' }, 'source:   reported by the provider'],
    [{ contextWindowProvenance: 'catalog', contextWindowOrigin: { kind: 'catalog', catalogProviderId: 'abacus' } }, 'source:   catalog: abacus'],
    [{ contextWindowProvenance: 'catalog', contextWindowOrigin: { kind: 'consensus', providers: 4, agreeing: 4 } }, 'source:   consensus of 4 providers'],
  ] as const)('%o → %s', (overrides, label) => {
    const model = makeModel(overrides as Partial<ModelDefinition>);
    expect(buildContextWindowStatusText(model, 100_000, null)).toContain(label);
  });

  test('missing provenance → model catalog', () => {
    expect(buildContextWindowStatusText(makeModel(), 100_000, null)).toContain('source:   model catalog');
  });

  test('a family default reads as unknown and names itself a guess', () => {
    const model = makeModel({ contextWindow: 128_000, contextWindowProvenance: 'fallback', contextWindowOrigin: { kind: 'family_default' } });
    const text = buildContextWindowStatusText(model, null, null);
    expect(text).toContain('resolved: unknown (no catalog provider lists this model; the family default of 128,000 tokens is a guess)');
    expect(text).toContain('source:   family default');
  });

  test('a disproven window keeps its own explanation and no source line', () => {
    const model = makeModel({ contextWindow: 150_000, contextWindowProvenance: 'accepted_floor' });
    const text = buildContextWindowStatusText(model, null, null);
    expect(text).toContain('unknown (the provider accepted 150,000 tokens, more than the stated window)');
    expect(text).not.toContain('source:');
  });
});
