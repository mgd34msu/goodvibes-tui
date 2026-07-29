import { describe, test, expect, beforeEach } from 'bun:test';
import {
  ProviderCapabilityRegistry,
  RouteRejectionCode,
  type RouteRejectionDetail,
  type ProviderCapability,
  type RequestProfile,
} from '@pellux/goodvibes-sdk/platform/providers';
import type { LLMProvider } from '@pellux/goodvibes-sdk/platform/providers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a full ProviderCapability with overrides for test convenience. */
function makeCapability(overrides: Partial<ProviderCapability> = {}): ProviderCapability {
  return {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
    caching: 'none',
    ...overrides,
  };
}

type ProviderWithCapabilities = Pick<LLMProvider, 'capabilities'>;
type ProviderCapabilityRegistryTestAccess = {
  _collectRejections(capability: ProviderCapability, profile: RequestProfile): RouteRejectionDetail[];
};

// ---------------------------------------------------------------------------
// ProviderCapabilityRegistry — merge order
// ---------------------------------------------------------------------------

describe('ProviderCapabilityRegistry.getCapability — merge order', () => {
  let registry: ProviderCapabilityRegistry;

  beforeEach(() => {
    registry = new ProviderCapabilityRegistry();
  });

  test('unknown provider falls back to GLOBAL_DEFAULTS', () => {
    const cap = registry.getCapability('unknown-provider', 'unknown-model');
    // GLOBAL_DEFAULTS values
    expect(cap.streaming).toBe(true);
    expect(cap.toolCalling).toBe(true);
    expect(cap.parallelTools).toBe(false);
    expect(cap.jsonMode).toBe(false);
    expect(cap.reasoningControls).toBe(false);
    expect(cap.maxContextTokens).toBe(32_768);
    expect(cap.maxOutputTokens).toBe(4_096);
    expect(cap.timeoutMs).toBe(120_000);
  });

  test('known provider applies PROVIDER_DEFAULTS over GLOBAL_DEFAULTS', () => {
    // anthropic has parallelTools: true in PROVIDER_DEFAULTS, GLOBAL_DEFAULTS has false
    const cap = registry.getCapability('anthropic', 'claude-3-haiku-20240307');
    expect(cap.parallelTools).toBe(true);
  });

  test('self-declared provider capability overrides PROVIDER_DEFAULTS', () => {
    const selfDeclared: ProviderWithCapabilities = {
      capabilities: { toolCalling: false } as Partial<ProviderCapability>,
    };
    // anthropic has toolCalling: true — self-declared false should win
    const cap = registry.getCapability('anthropic', 'claude-3-haiku-20240307', selfDeclared);
    expect(cap.toolCalling).toBe(false);
  });

  test('MODEL_OVERRIDES take precedence over self-declared capabilities', () => {
    // What this test is for is PRECEDENCE. It used to pin the override's literal
    // numbers (maxOutputTokens: 32_000), which made it a second copy of the sdk's
    // model table and went stale the moment that model's output ceiling was
    // raised — a red test that said nothing about precedence. So the override's
    // own answer is read first, and the self-declared call is compared to it.
    const overridden = registry.getCapability('anthropic', 'claude-opus-4-5');
    expect(overridden.reasoningControls).toBe(true);
    expect(overridden.maxOutputTokens).toBeGreaterThan(1);

    const selfDeclared = {
      capabilities: { reasoningControls: false, maxOutputTokens: 1 } as Partial<ProviderCapability>,
    };
    const cap = registry.getCapability('anthropic', 'claude-opus-4-5', selfDeclared);
    expect(cap.reasoningControls).toBe(true);
    expect(cap.maxOutputTokens).toBe(overridden.maxOutputTokens);
    expect(cap.maxOutputTokens).not.toBe(1);
  });

  test('result is frozen (immutable)', () => {
    const cap = registry.getCapability('anthropic', 'some-model');
    expect(Object.isFrozen(cap)).toBe(true);
  });

  test('subsequent calls return cached result (same reference)', () => {
    const cap1 = registry.getCapability('anthropic', 'claude-3-haiku-20240307');
    const cap2 = registry.getCapability('anthropic', 'claude-3-haiku-20240307');
    expect(cap1).toBe(cap2);
  });

  test('invalidate() clears the cache', () => {
    const cap1 = registry.getCapability('anthropic', 'claude-3-haiku-20240307');
    registry.invalidate();
    const cap2 = registry.getCapability('anthropic', 'claude-3-haiku-20240307');
    // Different reference after invalidation
    expect(cap1).not.toBe(cap2);
    // But same values
    expect(cap1.streaming).toBe(cap2.streaming);
  });
});

// ---------------------------------------------------------------------------
// ProviderCapabilityRegistry — canHandle
// ---------------------------------------------------------------------------

describe('ProviderCapabilityRegistry.canHandle', () => {
  let registry: ProviderCapabilityRegistry;

  beforeEach(() => {
    registry = new ProviderCapabilityRegistry();
  });

  test('returns true when all requirements are met', () => {
    const cap = makeCapability();
    const profile: RequestProfile = {
      requiresStreaming: true,
      requiresToolCalling: true,
    };
    expect(registry.canHandle(cap, profile)).toBe(true);
  });

  test('returns true for empty profile (no requirements)', () => {
    const cap = makeCapability();
    expect(registry.canHandle(cap, {})).toBe(true);
  });

  test('returns false when streaming required but not supported', () => {
    const cap = makeCapability({ streaming: false });
    expect(registry.canHandle(cap, { requiresStreaming: true })).toBe(false);
  });

  test('returns false when tool calling required but not supported', () => {
    const cap = makeCapability({ toolCalling: false });
    expect(registry.canHandle(cap, { requiresToolCalling: true })).toBe(false);
  });

  test('returns false when parallel tools required but not supported', () => {
    const cap = makeCapability({ parallelTools: false });
    expect(registry.canHandle(cap, { requiresParallelTools: true })).toBe(false);
  });

  test('returns false when JSON mode required but not supported', () => {
    const cap = makeCapability({ jsonMode: false });
    expect(registry.canHandle(cap, { requiresJsonMode: true })).toBe(false);
  });

  test('returns false when reasoning controls required but not supported', () => {
    const cap = makeCapability({ reasoningControls: false });
    expect(registry.canHandle(cap, { requiresReasoningControls: true })).toBe(false);
  });

  test('returns false when context window too small', () => {
    const cap = makeCapability({ maxContextTokens: 32_768 });
    expect(registry.canHandle(cap, { minContextTokens: 100_000 })).toBe(false);
  });

  test('returns false when output capacity too small', () => {
    const cap = makeCapability({ maxOutputTokens: 4_096 });
    expect(registry.canHandle(cap, { minOutputTokens: 8_000 })).toBe(false);
  });

  test('returns true when exact token limits met', () => {
    const cap = makeCapability({ maxContextTokens: 32_768, maxOutputTokens: 8_192 });
    expect(registry.canHandle(cap, { minContextTokens: 32_768, minOutputTokens: 8_192 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ProviderCapabilityRegistry — getRouteExplanation
// ---------------------------------------------------------------------------

describe('ProviderCapabilityRegistry.getRouteExplanation', () => {
  let registry: ProviderCapabilityRegistry;

  beforeEach(() => {
    registry = new ProviderCapabilityRegistry();
  });

  test('returns accepted=true with correct shape when route is valid', () => {
    // anthropic supports all standard capabilities
    const result = registry.getRouteExplanation('anthropic', 'claude-3-haiku-20240307', {
      requiresStreaming: true,
      requiresToolCalling: true,
    });
    expect(result.accepted).toBe(true);
    expect(result.providerId).toBe('anthropic');
    expect(result.modelId).toBe('claude-3-haiku-20240307');
    expect(result.summary).toContain('accepted');
    expect(result.capability).toBeDefined();
    if (result.accepted) {
      // Discriminated union: no rejections field on accepted branch
      expect('rejections' in result).toBe(false);
    }
  });

  test('returns accepted=false with rejection list when route is invalid', () => {
    const result = registry.getRouteExplanation('unknown-provider', 'unknown-model', {
      requiresStreaming: true,
      requiresParallelTools: true, // GLOBAL_DEFAULTS has parallelTools: false
      requiresJsonMode: true,      // GLOBAL_DEFAULTS has jsonMode: false
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.rejections.length).toBeGreaterThanOrEqual(2);
      expect(result.summary).toContain('rejected');
    }
  });

  test('never throws regardless of inputs', () => {
    expect(() =>
      registry.getRouteExplanation('', '', { requiresStreaming: true })
    ).not.toThrow();
    expect(() =>
      registry.getRouteExplanation('nonexistent', 'nonexistent', {
        minContextTokens: Number.MAX_SAFE_INTEGER,
      })
    ).not.toThrow();
  });

  // -- Each rejection code branch --

  test('NO_STREAMING rejection code produced correctly', () => {
    // Use a model with streaming override would require custom setup; use GLOBAL_DEFAULTS path
    // Patch: create a registry and pass a provider with streaming: false
    const reg = new ProviderCapabilityRegistry();
    // We test via canHandle rejection collection indirectly: any provider whose
    // resolved capability has streaming=false will produce this code
    const cap = makeCapability({ streaming: false });
    const rejections = (reg as unknown as ProviderCapabilityRegistryTestAccess)._collectRejections(cap, { requiresStreaming: true });
    expect(rejections).toHaveLength(1);
    expect(rejections[0].code).toBe(RouteRejectionCode.NO_STREAMING);
    expect(rejections[0].actual).toBe(false);
    expect(rejections[0].required).toBe(true);
  });

  test('NO_TOOL_CALLING rejection code produced correctly', () => {
    const reg = new ProviderCapabilityRegistry();
    const cap = makeCapability({ toolCalling: false });
    const rejections = (reg as unknown as ProviderCapabilityRegistryTestAccess)._collectRejections(cap, { requiresToolCalling: true });
    expect(rejections).toHaveLength(1);
    expect(rejections[0].code).toBe(RouteRejectionCode.NO_TOOL_CALLING);
  });

  test('NO_PARALLEL_TOOLS rejection code produced correctly', () => {
    const reg = new ProviderCapabilityRegistry();
    const cap = makeCapability({ parallelTools: false });
    const rejections = (reg as unknown as ProviderCapabilityRegistryTestAccess)._collectRejections(cap, { requiresParallelTools: true });
    expect(rejections).toHaveLength(1);
    expect(rejections[0].code).toBe(RouteRejectionCode.NO_PARALLEL_TOOLS);
  });

  test('NO_JSON_MODE rejection code produced correctly', () => {
    const reg = new ProviderCapabilityRegistry();
    const cap = makeCapability({ jsonMode: false });
    const rejections = (reg as unknown as ProviderCapabilityRegistryTestAccess)._collectRejections(cap, { requiresJsonMode: true });
    expect(rejections).toHaveLength(1);
    expect(rejections[0].code).toBe(RouteRejectionCode.NO_JSON_MODE);
  });

  test('NO_REASONING_CONTROLS rejection code produced correctly', () => {
    const reg = new ProviderCapabilityRegistry();
    const cap = makeCapability({ reasoningControls: false });
    const rejections = (reg as unknown as ProviderCapabilityRegistryTestAccess)._collectRejections(cap, { requiresReasoningControls: true });
    expect(rejections).toHaveLength(1);
    expect(rejections[0].code).toBe(RouteRejectionCode.NO_REASONING_CONTROLS);
  });

  test('CONTEXT_TOO_SMALL rejection code produced correctly', () => {
    const reg = new ProviderCapabilityRegistry();
    const cap = makeCapability({ maxContextTokens: 32_768 });
    const rejections = (reg as unknown as ProviderCapabilityRegistryTestAccess)._collectRejections(cap, { minContextTokens: 100_000 });
    expect(rejections).toHaveLength(1);
    expect(rejections[0].code).toBe(RouteRejectionCode.CONTEXT_TOO_SMALL);
    expect(rejections[0].actual).toBe(32_768);
    expect(rejections[0].required).toBe(100_000);
  });

  test('OUTPUT_TOO_SMALL rejection code produced correctly', () => {
    const reg = new ProviderCapabilityRegistry();
    const cap = makeCapability({ maxOutputTokens: 4_096 });
    const rejections = (reg as unknown as ProviderCapabilityRegistryTestAccess)._collectRejections(cap, { minOutputTokens: 8_000 });
    expect(rejections).toHaveLength(1);
    expect(rejections[0].code).toBe(RouteRejectionCode.OUTPUT_TOO_SMALL);
    expect(rejections[0].actual).toBe(4_096);
    expect(rejections[0].required).toBe(8_000);
  });

  test('multiple rejections accumulate correctly', () => {
    const reg = new ProviderCapabilityRegistry();
    const cap = makeCapability({
      parallelTools: false,
      jsonMode: false,
      maxOutputTokens: 1_000,
    });
    const rejections = (reg as unknown as ProviderCapabilityRegistryTestAccess)._collectRejections(cap, {
      requiresParallelTools: true,
      requiresJsonMode: true,
      minOutputTokens: 8_000,
    });
    expect(rejections).toHaveLength(3);
    const codes = rejections.map((r: { code: string }) => r.code);
    expect(codes).toContain(RouteRejectionCode.NO_PARALLEL_TOOLS);
    expect(codes).toContain(RouteRejectionCode.NO_JSON_MODE);
    expect(codes).toContain(RouteRejectionCode.OUTPUT_TOO_SMALL);
  });
});
