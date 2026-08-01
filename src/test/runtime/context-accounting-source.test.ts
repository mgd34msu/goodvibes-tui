/**
 * Context-accounting binding tests.
 *
 * The SDK's `context_accounting` tool is always registered on the shared
 * roster, but only reports real data once a consumer binds a
 * ContextAccountingSource onto the RuntimeServices-level
 * ContextAccountingHolder passed into registerAllTools (see
 * bootstrap-core.ts) — otherwise it honestly reports `available: false`.
 * runtime/context-accounting-source.ts builds that source from the live
 * Orchestrator, bound at bootstrap.ts. These tests exercise:
 *
 *  1. createContextAccountingSource() in isolation — token state, compaction
 *     count, and the compaction-activity tracker driven by real runtime-bus
 *     event types (not fabricated).
 *  2. The full path through the REAL tool (createContextAccountingTool +
 *     ContextAccountingHolder from the SDK) — bound source returns real
 *     data, unbound holder returns the honest "not available" message.
 */
import { describe, expect, test } from 'bun:test';
import { createContextAccountingSource } from '../../runtime/context-accounting-source.ts';
import { ContextAccountingHolder, createContextAccountingTool } from '@pellux/goodvibes-sdk/platform/tools';
import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers';
import type { Orchestrator } from '@pellux/goodvibes-sdk/platform/core';

/**
 * TurnInjectionRecord is not exported from the SDK's public entry points;
 * the orchestrator's real getTurnInjections() return type is the source of
 * truth here, so tests borrow it structurally through Orchestrator instead
 * of importing a type the package barrel doesn't expose.
 */
type TurnInjectionRecord = ReturnType<Orchestrator['getTurnInjections']>[number];

function makeFakeOrchestrator(overrides: Partial<{
  injections: readonly TurnInjectionRecord[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  lastInputTokens: number;
}> = {}) {
  const injections = overrides.injections ?? [];
  return {
    getTurnInjections: () => injections,
    usage: overrides.usage ?? { input: 1000, output: 500, cacheRead: 200, cacheWrite: 50 },
    lastInputTokens: overrides.lastInputTokens ?? 1750,
  };
}

function makeFakeModelDefinition(contextWindow: number): ModelDefinition {
  return {
    id: 'fake-model',
    provider: 'fake-provider',
    registryKey: 'fake-provider:fake-model',
    displayName: 'Fake Model',
    description: 'Test double model definition',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow,
    selectable: true,
  };
}

function makeFakeProviderRegistry(contextWindow: number) {
  const model = makeFakeModelDefinition(contextWindow);
  return {
    getCurrentModel: () => model,
    getContextWindowForModel: () => contextWindow,
  };
}

function makeFakeLineageTracker(compactionCount: number) {
  return { getCompactionCount: () => compactionCount };
}

/** A minimal fake runtime bus: records subscribers by event type, lets tests fire them. */
function makeFakeRuntimeBus() {
  const handlers = new Map<string, Array<() => void>>();
  const bus = {
    on: (type: string, cb: () => void) => {
      const list = handlers.get(type) ?? [];
      list.push(cb);
      handlers.set(type, list);
      return () => {
        const idx = list.indexOf(cb);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    fire: (type: string) => {
      for (const cb of handlers.get(type) ?? []) cb();
    },
  };
  return bus;
}

describe('createContextAccountingSource', () => {
  test('getTurnInjections delegates straight to the live Orchestrator', () => {
    const record = { turn: 1, injectedIds: ['mem_1'] } as unknown as TurnInjectionRecord;
    const orchestrator = makeFakeOrchestrator({ injections: [record] });
    const { source } = createContextAccountingSource({
      orchestrator,
      providerRegistry: makeFakeProviderRegistry(100_000),
      sessionLineageTracker: makeFakeLineageTracker(0),
      sessionId: 'sess-1',
    });
    expect(source.getTurnInjections()).toEqual([record]);
  });

  test('getTokenState reports measured usage, lastInputTokens, and the live context window', () => {
    const orchestrator = makeFakeOrchestrator({
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
      lastInputTokens: 999,
    });
    const { source } = createContextAccountingSource({
      orchestrator,
      providerRegistry: makeFakeProviderRegistry(50_000),
      sessionLineageTracker: makeFakeLineageTracker(0),
      sessionId: 'sess-1',
    });
    const state = source.getTokenState();
    expect(state.measured).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
    expect(state.lastInputTokens).toBe(999);
    expect(state.contextWindow).toBe(50_000);
  });

  test('contextWindow is honestly null when the provider registry reports 0/unknown', () => {
    const { source } = createContextAccountingSource({
      orchestrator: makeFakeOrchestrator(),
      providerRegistry: makeFakeProviderRegistry(0),
      sessionLineageTracker: makeFakeLineageTracker(0),
      sessionId: 'sess-1',
    });
    expect(source.getTokenState().contextWindow).toBeNull();
  });

  test('getCompactionState reports the real compaction count from the lineage tracker', () => {
    const { source } = createContextAccountingSource({
      orchestrator: makeFakeOrchestrator(),
      providerRegistry: makeFakeProviderRegistry(100_000),
      sessionLineageTracker: makeFakeLineageTracker(3),
      sessionId: 'sess-1',
    });
    expect(source.getCompactionState().compactionCount).toBe(3);
  });

  test('isCompacting flips true on a real compaction-start event and false on a real end event', () => {
    const bus = makeFakeRuntimeBus();
    const { source } = createContextAccountingSource({
      orchestrator: makeFakeOrchestrator(),
      providerRegistry: makeFakeProviderRegistry(100_000),
      sessionLineageTracker: makeFakeLineageTracker(0),
      runtimeBus: bus,
      sessionId: 'sess-1',
    });
    expect(source.getCompactionState().isCompacting).toBe(false);
    bus.fire('COMPACTION_AUTOCOMPACT');
    expect(source.getCompactionState().isCompacting).toBe(true);
    bus.fire('COMPACTION_RECEIPT');
    expect(source.getCompactionState().isCompacting).toBe(false);
  });

  test('without a runtime bus, isCompacting honestly stays false rather than guessing', () => {
    const { source } = createContextAccountingSource({
      orchestrator: makeFakeOrchestrator(),
      providerRegistry: makeFakeProviderRegistry(100_000),
      sessionLineageTracker: makeFakeLineageTracker(0),
      sessionId: 'sess-1',
    });
    expect(source.getCompactionState().isCompacting).toBe(false);
  });

  test('dispose() unsubscribes the compaction-activity listeners', () => {
    const bus = makeFakeRuntimeBus();
    const { source, dispose } = createContextAccountingSource({
      orchestrator: makeFakeOrchestrator(),
      providerRegistry: makeFakeProviderRegistry(100_000),
      sessionLineageTracker: makeFakeLineageTracker(0),
      runtimeBus: bus,
      sessionId: 'sess-1',
    });
    dispose();
    bus.fire('COMPACTION_AUTOCOMPACT');
    expect(source.getCompactionState().isCompacting).toBe(false);
  });
});

describe('context_accounting tool through the real registry seam', () => {
  test('unbound holder: the tool honestly reports no live session context, never fabricates', async () => {
    const holder = new ContextAccountingHolder();
    const tool = createContextAccountingTool(holder);
    const result = await tool.execute({});
    expect(result.success).toBe(true);
    const parsed = JSON.parse((result as { output: string }).output) as { available: boolean; reason: string };
    expect(parsed.available).toBe(false);
    expect(parsed.reason).toContain('No live session context is bound');
  });

  test('bound holder: the tool returns real turn-injection, token, and compaction data from our source', async () => {
    const holder = new ContextAccountingHolder();
    const record = { turn: 2, injectedIds: ['mem_a', 'mem_b'], injectedSources: ['project'], candidatesConsidered: 5, codeCandidatesConsidered: 0, tokenCost: 120, droppedForBudget: [], embeddingBackend: 'native', codeInjectionSkipped: undefined } as unknown as TurnInjectionRecord;
    const { source } = createContextAccountingSource({
      orchestrator: makeFakeOrchestrator({ injections: [record], lastInputTokens: 42_000 }),
      providerRegistry: makeFakeProviderRegistry(200_000),
      sessionLineageTracker: makeFakeLineageTracker(2),
      sessionId: 'sess-real',
    });
    holder.setSource(source);

    const tool = createContextAccountingTool(holder);
    const result = await tool.execute({});
    expect(result.success).toBe(true);
    const parsed = JSON.parse((result as { output: string }).output) as {
      available: boolean;
      sessionId: string;
      turn: { injectionRingSize: number; latestInjection: { injectedIds: string[] } | null };
      tokenBudget: { lastInputTokens: number; contextWindow: number | null };
      compaction: { isCompacting: boolean; compactionCount: number };
    };
    expect(parsed.available).toBe(true);
    expect(parsed.sessionId).toBe('sess-real');
    expect(parsed.turn.injectionRingSize).toBe(1);
    expect(parsed.turn.latestInjection?.injectedIds).toEqual(['mem_a', 'mem_b']);
    expect(parsed.tokenBudget.lastInputTokens).toBe(42_000);
    expect(parsed.tokenBudget.contextWindow).toBe(200_000);
    expect(parsed.compaction.compactionCount).toBe(2);
    expect(parsed.compaction.isCompacting).toBe(false);
  });
});
