/**
 * Auto-compact helper tests — TASK-058.
 *
 * Validates:
 *  1. No compact when threshold is 0 (defensive guard for null/missing config; SDK schema
 *     range is [10, 100] with default 80 — 0 is not a valid SDK schema value).
 *  2. No compact when usage is below threshold.
 *  3. Compact fires and posts transcript notice when usage ≥ threshold.
 *  4. Error during compact is caught and routed — does not throw.
 *  5. Threshold value from config drives the enable/disable boundary.
 */
import { describe, test, expect, mock } from 'bun:test';
import { maybeAutoCompact } from '../../core/context-auto-compact.ts';
import type { AutoCompactDeps } from '../../core/context-auto-compact.ts';

function makeConfigManager(threshold: number): AutoCompactDeps['configManager'] {
  return { get: (key: string) => (key === 'behavior.autoCompactThreshold' ? threshold : undefined) };
}

function makeDeps(overrides: Partial<AutoCompactDeps> = {}): AutoCompactDeps & { routeCalls: string[]; compactContexts: Array<{ compactionCount: number; lineageEntries: string[] }> } {
  const routeCalls: string[] = [];
  const compactContexts: Array<{ compactionCount: number; lineageEntries: string[] }> = [];
  const compactFn = mock(async (...args: unknown[]) => { compactContexts.push(args[4] as { compactionCount: number; lineageEntries: string[] }); });
  return {
    configManager: makeConfigManager(80),
    conversation: { compact: compactFn, getMessagesForLLM: () => [], getSessionMemoryStore: () => null, getSessionLineageTracker: () => ({ getCompactionCount: () => 3, getEntries: () => ['lineage-1', 'lineage-2', 'lineage-3'] }) } as unknown as AutoCompactDeps['conversation'],
    providerRegistry: {} as AutoCompactDeps['providerRegistry'],
    systemMessageRouter: {
      routeSystemMessage: (msg: string) => { routeCalls.push(msg); },
    } as AutoCompactDeps['systemMessageRouter'],
    model: 'claude-sonnet',
    provider: 'anthropic',
    lastInputTokens: 85_000,
    contextWindow: 100_000,
    routeCalls,
    compactContexts,
    ...overrides,
  };
}

describe('maybeAutoCompact', () => {
  test('does nothing when threshold is 0 (defensive guard — SDK schema range is [10, 100], default 80)', async () => {
    // A real ConfigManager would reject 0 via schema validation (ConfigError).
    // This test exercises the runtime guard in maybeAutoCompact for the case
    // where the config value is null/missing and falls back to 0.
    const deps = makeDeps({ configManager: makeConfigManager(0) });
    await maybeAutoCompact(deps);
    expect(deps.conversation.compact).not.toHaveBeenCalled();
    expect(deps.routeCalls).toHaveLength(0);
  });

  test('does nothing when usage is below threshold', async () => {
    // 70% used, threshold 80
    const deps = makeDeps({ lastInputTokens: 70_000, contextWindow: 100_000 });
    await maybeAutoCompact(deps);
    expect(deps.conversation.compact).not.toHaveBeenCalled();
    expect(deps.routeCalls).toHaveLength(0);
  });

  test('does nothing when contextWindow is 0', async () => {
    const deps = makeDeps({ contextWindow: 0 });
    await maybeAutoCompact(deps);
    expect(deps.conversation.compact).not.toHaveBeenCalled();
    expect(deps.routeCalls).toHaveLength(0);
  });

  test('compacts and posts transcript notice when usage >= threshold', async () => {
    // 85% used, threshold 80
    const deps = makeDeps({ lastInputTokens: 85_000, contextWindow: 100_000 });
    await maybeAutoCompact(deps);
    expect(deps.conversation.compact).toHaveBeenCalledTimes(1);
    // Before notice (high priority) should mention auto-compacting
    expect(deps.routeCalls.some((m) => m.includes('Auto-compact'))).toBe(true);
    // After notice (low priority) should confirm completion
    expect(deps.routeCalls.some((m) => m.includes('complete'))).toBe(true);
    // Real lineage counters flow into the CompactionContext (not hardcoded 0/[]).
    expect(deps.compactContexts[0]?.compactionCount).toBe(3);
    expect(deps.compactContexts[0]?.lineageEntries).toEqual(['lineage-1', 'lineage-2', 'lineage-3']);
  });

  test('posts error notice and does not throw when compact fails', async () => {
    const compactFn = mock(async () => { throw new Error('compact-error'); });
    const deps = makeDeps({
      conversation: { compact: compactFn, getMessagesForLLM: () => [], getSessionMemoryStore: () => null } as unknown as AutoCompactDeps['conversation'],
    });
    await expect(maybeAutoCompact(deps)).resolves.toBeUndefined();
    expect(deps.routeCalls.some((m) => m.includes('failed'))).toBe(true);
  });

  test('threshold value is respected (config drives enable/disable)', async () => {
    const deps90 = makeDeps({ configManager: makeConfigManager(90), lastInputTokens: 85_000, contextWindow: 100_000 });
    await maybeAutoCompact(deps90);
    // 85% < 90% threshold — should NOT compact
    expect(deps90.conversation.compact).not.toHaveBeenCalled();

    const deps80 = makeDeps({ configManager: makeConfigManager(80), lastInputTokens: 85_000, contextWindow: 100_000 });
    await maybeAutoCompact(deps80);
    // 85% >= 80% threshold — SHOULD compact
    expect(deps80.conversation.compact).toHaveBeenCalledTimes(1);
  });
});
