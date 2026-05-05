/**
 * ProviderOptimizer unit tests.
 *
 * Tests routing mode transitions, pinning, selectRoute enabled/disabled
 * behaviour, bounded fallback log trimming, testFallback, and
 * explainCurrentRoute. A fake clock is injected so timestamps are
 * deterministic.
 */

import { describe, test, expect } from 'bun:test';
import type { ProviderRegistry, ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers';
import type { LLMProvider } from '@pellux/goodvibes-sdk/platform/providers';
import { ProviderCapabilityRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import { ProviderOptimizer } from '@pellux/goodvibes-sdk/platform/providers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    tick: (ms = 1) => { t += ms; },
    now: () => t,
    get: () => t,
  };
}

function makeModelDefinition(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'test-model',
    provider: 'test-provider',
    registryKey: 'test-provider:test-model',
    displayName: 'Test Model',
    description: 'Test model',
    capabilities: {
      toolCalling: false,
      codeEditing: false,
      reasoning: false,
      multimodal: false,
    },
    contextWindow: 8_192,
    selectable: true,
    ...overrides,
  };
}

type TestRegistry = Pick<ProviderRegistry, 'getCurrentModel' | 'getSelectableModels' | 'explainRoute'>;

function makeProviderStub(model: ModelDefinition): LLMProvider {
  return {
    name: model.provider,
    models: [model.id],
    async chat() {
      throw new Error('not used in optimizer tests');
    },
  };
}

function makeOptimizer(options: {
  enabled?: boolean;
  clock?: () => number;
  models?: ModelDefinition[];
  currentModelIndex?: number;
} = {}) {
  const models = options.models ?? [];
  const currentModelIndex = options.currentModelIndex ?? 0;
  const capabilityRegistry = new ProviderCapabilityRegistry();
  const registry: TestRegistry = {
    getCurrentModel: () => {
      if (models.length === 0) {
        return makeModelDefinition({
          id: 'none',
          provider: 'none',
          registryKey: 'none:none',
          displayName: 'None',
          description: 'No selectable models',
          selectable: false,
        });
      }
      return models[Math.min(currentModelIndex, models.length - 1)]!;
    },
    getSelectableModels: () => models.filter((model) => model.selectable),
    explainRoute: (modelId, profile) => {
      const def = models.find((model) => model.registryKey === modelId || model.id === modelId);
      if (def) {
        return capabilityRegistry.getRouteExplanation(def.provider, def.id, profile, {
          ...makeProviderStub(def),
        });
      }
      return capabilityRegistry.getRouteExplanation('unknown', modelId, profile);
    },
  };
  const c = options.clock ?? (() => 0);
  return new ProviderOptimizer(registry, capabilityRegistry, options.enabled ?? false, c);
}

// ---------------------------------------------------------------------------
// Mode transitions
// ---------------------------------------------------------------------------

describe('ProviderOptimizer — mode transitions', () => {
  test('starts in manual mode', () => {
    const opt = makeOptimizer();
    expect(opt.mode).toBe('manual');
  });

  test('setMode auto', () => {
    const opt = makeOptimizer();
    opt.setMode('auto');
    expect(opt.mode).toBe('auto');
  });

  test('setMode manual', () => {
    const opt = makeOptimizer();
    opt.setMode('auto');
    opt.setMode('manual');
    expect(opt.mode).toBe('manual');
  });

  test('setMode pinned without pin clears target', () => {
    const opt = makeOptimizer();
    opt.pin('anthropic', 'claude-opus-4-5');
    expect(opt.pinnedTarget).not.toBeNull();
    opt.setMode('manual'); // non-pinned mode clears pin
    expect(opt.pinnedTarget).toBeNull();
    expect(opt.mode).toBe('manual');
  });

  test('setMode pinned preserves existing pin state', () => {
    const opt = makeOptimizer();
    opt.pin('anthropic', 'claude-opus-4-5');
    // pin() already sets mode to pinned — setting it again keeps pin
    opt.setMode('pinned');
    expect(opt.mode).toBe('pinned');
    expect(opt.pinnedTarget).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pin / Unpin
// ---------------------------------------------------------------------------

describe('ProviderOptimizer — pin / unpin', () => {
  test('pin sets mode to pinned', () => {
    const opt = makeOptimizer();
    opt.pin('openai', 'gpt-4o');
    expect(opt.mode).toBe('pinned');
    expect(opt.pinnedTarget).toEqual({ providerId: 'openai', modelId: 'gpt-4o' });
  });

  test('pin overwrites previous pin', () => {
    const opt = makeOptimizer();
    opt.pin('openai', 'gpt-4o');
    opt.pin('anthropic', 'claude-opus-4-5');
    expect(opt.pinnedTarget).toEqual({ providerId: 'anthropic', modelId: 'claude-opus-4-5' });
  });

  test('unpin clears target and returns to manual', () => {
    const opt = makeOptimizer();
    opt.pin('openai', 'gpt-4o');
    opt.unpin();
    expect(opt.mode).toBe('manual');
    expect(opt.pinnedTarget).toBeNull();
  });

  test('pinnedTarget null when never pinned', () => {
    const opt = makeOptimizer();
    expect(opt.pinnedTarget).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// selectRoute — disabled (returns null)
// ---------------------------------------------------------------------------

describe('ProviderOptimizer — selectRoute disabled', () => {
  test('returns null when disabled regardless of mode', () => {
    const opt = makeOptimizer({ enabled: false });
    expect(opt.selectRoute({})).toBeNull();
  });

  test('setEnabled(false) disables after enable', () => {
    const opt = makeOptimizer({ enabled: true });
    opt.setEnabled(false);
    expect(opt.enabled).toBe(false);
    expect(opt.selectRoute({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// selectRoute — enabled (exercises capability registry)
// ---------------------------------------------------------------------------

describe('ProviderOptimizer — selectRoute enabled', () => {
  test('returns a RouteDecision when enabled with no candidates', () => {
    const clock = makeClock();
    const opt = makeOptimizer({ enabled: true, clock: clock.now });
    // No models in registry → fallback explanation with decidedAt from clock
    const decision = opt.selectRoute({});
    // With empty registry we get a decision with providerId 'none'
    expect(decision).not.toBeNull();
    if (decision !== null) {
      expect(decision.pinned).toBe(false);
      expect(decision.decidedAt).toBe(1_000_000);
      expect(decision.providerId).toBe('none');
    }
  });

  test('pinned mode returns pinned target in decision', () => {
    const clock = makeClock(2_000_000);
    const opt = makeOptimizer({ enabled: true, clock: clock.now });
    opt.pin('test-provider', 'test-model');
    const decision = opt.selectRoute({});
    expect(decision).not.toBeNull();
    if (decision !== null) {
      expect(decision.pinned).toBe(true);
      expect(decision.providerId).toBe('test-provider');
      expect(decision.modelId).toBe('test-model');
      expect(decision.decidedAt).toBe(2_000_000);
    }
  });

  test('decidedAt uses injected clock, not wall time', () => {
    const clock = makeClock(9_000_000);
    const opt = makeOptimizer({ enabled: true, clock: clock.now });
    const decision = opt.selectRoute({});
    expect(decision?.decidedAt).toBe(9_000_000);
  });
});

// ---------------------------------------------------------------------------
// Bounded fallback log trimming
// ---------------------------------------------------------------------------

describe('ProviderOptimizer — fallback log bounded at 200 entries', () => {
  test('log grows up to 200', () => {
    const opt = makeOptimizer();
    for (let i = 0; i < 200; i++) {
      opt.recordFallbackTransition(`a${i}`, `b${i}`, 'test');
    }
    expect(opt.fallbackLog.length).toBe(200);
  });

  test('log trims oldest entries when exceeding 200', () => {
    const clock = makeClock();
    const opt = makeOptimizer({ clock: clock.now });
    for (let i = 0; i < 210; i++) {
      clock.tick(1);
      opt.recordFallbackTransition(`provider-${i}`, 'fallback', `reason-${i}`);
    }
    expect(opt.fallbackLog.length).toBe(200);
    // Oldest entries (0-9) should be gone; entry 10 should be first
    expect(opt.fallbackLog[0].reason).toBe('reason-10');
    expect(opt.fallbackLog[199].reason).toBe('reason-209');
  });

  test('clearFallbackLog empties the log', () => {
    const opt = makeOptimizer();
    opt.recordFallbackTransition('a', 'b', 'reason');
    opt.clearFallbackLog();
    expect(opt.fallbackLog.length).toBe(0);
  });

  test('recordFallbackTransition captures all fields', () => {
    const clock = makeClock(5_000);
    const opt = makeOptimizer({ clock: clock.now });
    opt.recordFallbackTransition('provider-a', 'provider-b', 'timeout');
    const entry = opt.fallbackLog[0];
    expect(entry.from).toBe('provider-a');
    expect(entry.to).toBe('provider-b');
    expect(entry.reason).toBe('timeout');
    expect(entry.ts).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// testFallback
// ---------------------------------------------------------------------------

describe('ProviderOptimizer — testFallback', () => {
  test('returns FallbackTestResult with empty registry', () => {
    const clock = makeClock(3_000_000);
    const opt = makeOptimizer({ clock: clock.now });
    const result = opt.testFallback({});
    expect(result.totalCount).toBe(0);
    expect(result.viableCount).toBe(0);
    expect(result.chain).toHaveLength(0);
    expect(result.testedAt).toBe(3_000_000);
  });

  test('testedAt uses injected clock', () => {
    const clock = makeClock(7_777_777);
    const opt = makeOptimizer({ clock: clock.now });
    const result = opt.testFallback();
    expect(result.testedAt).toBe(7_777_777);
  });

  test('works regardless of enabled state', () => {
    // testFallback is always operational
    const opt = makeOptimizer();
    const resultOff = opt.testFallback();
    opt.setEnabled(true);
    const resultOn = opt.testFallback();
    expect(resultOff.totalCount).toBe(resultOn.totalCount);
  });
});

// ---------------------------------------------------------------------------
// explainCurrentRoute
// ---------------------------------------------------------------------------

describe('ProviderOptimizer — explainCurrentRoute', () => {
  test('returns a RouteExplanation for the current model', () => {
    const opt = makeOptimizer({
      models: [makeModelDefinition()],
    });
    // explainCurrentRoute always works regardless of enabled state;
    // it reads the current model from the provider registry.
    const expl = opt.explainCurrentRoute();
    expect(typeof expl.providerId).toBe('string');
    expect(typeof expl.modelId).toBe('string');
    expect(typeof expl.accepted).toBe('boolean');
    expect(typeof expl.summary).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// setEnabled
// ---------------------------------------------------------------------------

describe('ProviderOptimizer — setEnabled', () => {
  test('starts disabled when constructed with false', () => {
    const opt = makeOptimizer();
    expect(opt.enabled).toBe(false);
  });

  test('starts enabled when constructed with true', () => {
    const opt = makeOptimizer({ enabled: true });
    expect(opt.enabled).toBe(true);
  });

  test('setEnabled toggles state', () => {
    const opt = makeOptimizer();
    opt.setEnabled(true);
    expect(opt.enabled).toBe(true);
    opt.setEnabled(false);
    expect(opt.enabled).toBe(false);
  });
});
