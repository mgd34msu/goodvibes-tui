/**
 * GC-TOOL-004 — Runtime budget enforcement tests.
 *
 * Covers per-phase budget checks for time (BUDGET_EXCEEDED_MS),
 * token consumption (BUDGET_EXCEEDED_TOKENS), and cost (BUDGET_EXCEEDED_COST).
 *
 * All tests operate on `budgetPhase` directly to avoid the need for the full
 * PhasedToolExecutor pipeline, then verify integration through the executor
 * for the emit paths.
 */
import { describe, test, expect, mock } from 'bun:test';
import { budgetPhase } from '../../runtime/tools/phases/budget.ts';
import { RuntimeEventBus } from '../../runtime/events/index.ts';
import type { ToolCall, ToolResult } from '@pellux/goodvibes-sdk/platform/types/tools';
import type { ToolRuntimeContext } from '../../runtime/tools/context.ts';
import type { ToolExecutionRecord } from '@pellux/goodvibes-sdk/platform/runtime/tools/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal stub of ToolRuntimeContext for budget phase testing.
 * Only the `budget` and `ids` fields are used by budgetPhase.
 */
function makeContext(
  budget?: ToolRuntimeContext['budget'],
): ToolRuntimeContext {
  return {
    runtime: { getState: () => ({}), subscribe: () => () => {} },
    ids: {
      sessionId: 'test-session',
      conversationId: 'test-conv',
      turnId: 'test-turn',
      toolCallId: 'test-call',
      traceId: 'test-trace',
    },
    tasks: {},
    resources: {
      fileCache: {} as never,
      projectIndex: {} as never,
    },
    provider: {
      providerId: 'test-provider',
      modelId: 'test-model',
      contextWindow: 128_000,
    },
    cancellation: {
      signal: new AbortController().signal,
    },
    executionMode: 'interactive',
    runtimeBus: new RuntimeEventBus(),
    permissionManager: { check: async () => true } as never,
    hookDispatcher: { fire: async () => ({ decision: 'allow' }) } as never,
    budget,
  };
}

/** Minimal stub ToolCall. */
const STUB_CALL: ToolCall = {
  id: 'call-001',
  name: 'stub_tool',
  arguments: {},
};

/** Minimal stub Tool. */
const STUB_TOOL = {
  name: 'stub_tool',
  definition: { name: 'stub_tool', description: '', parameters: {} },
  execute: async () => ({ callId: 'call-001', success: true }),
} as never;

/**
 * Create an execution record with a configurable startedAt offset so we can
 * simulate elapsed time without actual waits.
 */
function makeRecord(
  opts: {
    elapsedMs?: number;
    result?: Partial<ToolResult & Record<string, unknown>>;
  } = {},
): ToolExecutionRecord {
  return {
    callId: 'call-001',
    toolName: 'stub_tool',
    phases: [],
    currentPhase: 'executing',
    startedAt: performance.now() - (opts.elapsedMs ?? 0),
    cancelled: false,
    result: opts.result ? { callId: 'call-001', success: true, ...opts.result } : undefined,
  };
}

// ---------------------------------------------------------------------------
// 1. No budget — fast path (pass-through)
// ---------------------------------------------------------------------------

describe('budgetPhase — no budget configured', () => {
  test('entry: returns success when budget is undefined', async () => {
    const ctx = makeContext(undefined);
    const record = makeRecord({ elapsedMs: 999_999 });
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'entry');
    expect(result.success).toBe(true);
    expect(result.abort).toBeUndefined();
  });

  test('exit: returns success when budget is undefined', async () => {
    const ctx = makeContext(undefined);
    const record = makeRecord({ elapsedMs: 0, result: { tokenCount: 1_000_000 } });
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'exit');
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. BUDGET_EXCEEDED_MS — time budget
// ---------------------------------------------------------------------------

describe('budgetPhase — BUDGET_EXCEEDED_MS', () => {
  test('entry: aborts when elapsed exceeds maxMs', async () => {
    const ctx = makeContext({ maxMs: 100 });
    const record = makeRecord({ elapsedMs: 200 }); // 200ms elapsed > 100ms limit
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'entry');

    expect(result.success).toBe(false);
    expect(result.abort).toBe(true);
    expect(result.budgetExceedReason).toBe('BUDGET_EXCEEDED_MS');
    expect(result.budgetMeta).toBeDefined();
    expect(result.budgetMeta!['limitMs']).toBe(100);
    expect(result.budgetMeta!['elapsedMs']).toBeGreaterThanOrEqual(150);
    expect(result.error).toContain('BUDGET_EXCEEDED_MS');
  });

  test('exit: aborts when elapsed exceeds maxMs (post-execute check)', async () => {
    const ctx = makeContext({ maxMs: 50 });
    const record = makeRecord({ elapsedMs: 300 }); // way over budget
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'exit');

    expect(result.success).toBe(false);
    expect(result.budgetExceedReason).toBe('BUDGET_EXCEEDED_MS');
  });

  test('entry: passes when elapsed is below maxMs', async () => {
    const ctx = makeContext({ maxMs: 10_000 });
    const record = makeRecord({ elapsedMs: 5 }); // well under
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'entry');
    expect(result.success).toBe(true);
    expect(result.budgetExceedReason).toBeUndefined();
  });

  test('entry: phase name is budget-entry on success', async () => {
    const ctx = makeContext({ maxMs: 10_000 });
    const record = makeRecord({ elapsedMs: 0 });
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'entry');
    expect(result.phase).toBe('budget-entry');
  });

  test('exit: phase name is budget-exit on breach', async () => {
    const ctx = makeContext({ maxMs: 10 });
    const record = makeRecord({ elapsedMs: 500 });
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'exit');
    expect(result.phase).toBe('budget-exit');
  });
});

// ---------------------------------------------------------------------------
// 3. BUDGET_EXCEEDED_TOKENS — token budget
// ---------------------------------------------------------------------------

describe('budgetPhase — BUDGET_EXCEEDED_TOKENS', () => {
  test('exit: aborts when result tokenCount exceeds maxTokens', async () => {
    const ctx = makeContext({ maxTokens: 1000 });
    const record = makeRecord({ result: { tokenCount: 2000 } });
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'exit');

    expect(result.success).toBe(false);
    expect(result.abort).toBe(true);
    expect(result.budgetExceedReason).toBe('BUDGET_EXCEEDED_TOKENS');
    expect(result.budgetMeta!['limitTokens']).toBe(1000);
    expect(result.budgetMeta!['usedTokens']).toBe(2000);
    expect(result.error).toContain('BUDGET_EXCEEDED_TOKENS');
  });

  test('exit: passes when tokenCount is within maxTokens', async () => {
    const ctx = makeContext({ maxTokens: 5000 });
    const record = makeRecord({ result: { tokenCount: 500 } });
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'exit');
    expect(result.success).toBe(true);
  });

  test('exit: skips token check when result has no tokenCount', async () => {
    const ctx = makeContext({ maxTokens: 1 }); // tiny limit
    const record = makeRecord({ result: {} }); // no tokenCount annotation
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'exit');
    // Should pass because we can't enforce what we can't measure
    expect(result.success).toBe(true);
  });

  test('entry: never checks token budget (only at exit)', async () => {
    const ctx = makeContext({ maxTokens: 1 });
    // Even with a result annotated on the record at entry, token check skips
    const record = makeRecord({ result: { tokenCount: 999_999 } });
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'entry');
    // Only time check runs at entry; no result yet in real pipeline
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. BUDGET_EXCEEDED_COST — cost budget
// ---------------------------------------------------------------------------

describe('budgetPhase — BUDGET_EXCEEDED_COST', () => {
  test('exit: aborts when result costUsd exceeds maxCostUsd', async () => {
    const ctx = makeContext({ maxCostUsd: 0.01 });
    const record = makeRecord({ result: { costUsd: 0.05 } });
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'exit');

    expect(result.success).toBe(false);
    expect(result.abort).toBe(true);
    expect(result.budgetExceedReason).toBe('BUDGET_EXCEEDED_COST');
    expect(result.budgetMeta!['limitCostUsd']).toBe(0.01);
    expect(result.budgetMeta!['usedCostUsd']).toBe(0.05);
    expect(result.error).toContain('BUDGET_EXCEEDED_COST');
  });

  test('exit: passes when costUsd is within maxCostUsd', async () => {
    const ctx = makeContext({ maxCostUsd: 1.0 });
    const record = makeRecord({ result: { costUsd: 0.001 } });
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'exit');
    expect(result.success).toBe(true);
  });

  test('exit: skips cost check when result has no costUsd', async () => {
    const ctx = makeContext({ maxCostUsd: 0.0001 });
    const record = makeRecord({ result: {} });
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'exit');
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Multi-budget: time checked first
// ---------------------------------------------------------------------------

describe('budgetPhase — multi-budget priority', () => {
  test('exit: time breach takes priority over token breach', async () => {
    const ctx = makeContext({ maxMs: 10, maxTokens: 1, maxCostUsd: 0.0001 });
    const record = makeRecord({
      elapsedMs: 500,
      result: { tokenCount: 999_999, costUsd: 999 },
    });
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'exit');
    // Time is checked first
    expect(result.budgetExceedReason).toBe('BUDGET_EXCEEDED_MS');
  });

  test('exit: token breach reported when time is within budget', async () => {
    const ctx = makeContext({ maxMs: 60_000, maxTokens: 100, maxCostUsd: 999 });
    const record = makeRecord({
      elapsedMs: 10,
      result: { tokenCount: 50_000, costUsd: 0.001 },
    });
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'exit');
    expect(result.budgetExceedReason).toBe('BUDGET_EXCEEDED_TOKENS');
  });

  test('exit: cost breach reported when time and tokens are within budget', async () => {
    const ctx = makeContext({ maxMs: 60_000, maxTokens: 100_000, maxCostUsd: 0.001 });
    const record = makeRecord({
      elapsedMs: 10,
      result: { tokenCount: 50, costUsd: 0.5 },
    });
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'exit');
    expect(result.budgetExceedReason).toBe('BUDGET_EXCEEDED_COST');
  });
});

// ---------------------------------------------------------------------------
// 6. Budget phase is non-throwing (error safety)
// ---------------------------------------------------------------------------

describe('budgetPhase — error safety', () => {
  test('returns a result even when context budget has NaN values', async () => {
    // Passing NaN as maxMs should not throw; comparison will be false
    const ctx = makeContext({ maxMs: NaN });
    const record = makeRecord({ elapsedMs: 9999 });
    // NaN > NaN is false so no breach fires
    const result = await budgetPhase(STUB_CALL, STUB_TOOL, ctx, record, 'entry');
    // Implementation relies on `>` — NaN comparison returns false (no breach)
    expect(result.success).toBe(true);
  });
});
