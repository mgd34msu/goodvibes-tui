// ---------------------------------------------------------------------------
// model-routing-chip.test.ts
// The never-silent routing-chip decision: emit old→new (reason unknown) for a
// real model change, but stay silent for a no-op change or one already narrated
// by the richer [Failover] line (correlated via the fallback log).
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import {
  buildRoutingChip,
  findRecentFallbackReason,
  ROUTING_CHIP_PREFIX,
  type FallbackTransitionLike,
  type ModelChangedLike,
} from '../../core/model-routing-chip.ts';

const NOW = 1_700_000_000_000;

function change(overrides: Partial<ModelChangedLike> = {}): ModelChangedLike {
  return {
    registryKey: 'anthropic:claude-b',
    provider: 'anthropic',
    previous: { registryKey: 'anthropic:claude-a', provider: 'anthropic' },
    ...overrides,
  };
}

describe('findRecentFallbackReason', () => {
  const log: FallbackTransitionLike[] = [
    { from: 'openai', to: 'anthropic', reason: 'rate limited', ts: NOW - 1_000 },
  ];
  test('returns the reason for a recent matching transition', () => {
    expect(findRecentFallbackReason(log, 'openai', 'anthropic', NOW)).toBe('rate limited');
  });
  test('returns null when the transition is too old', () => {
    expect(findRecentFallbackReason(log, 'openai', 'anthropic', NOW + 10_000)).toBeNull();
  });
  test('returns null when from/to do not match', () => {
    expect(findRecentFallbackReason(log, 'openai', 'google', NOW)).toBeNull();
  });
});

describe('buildRoutingChip', () => {
  test('emits an honest old→new (reason unknown) notice for a real change with no fallback correlation', () => {
    const chip = buildRoutingChip(change(), [], NOW);
    expect(chip).toBe(`${ROUTING_CHIP_PREFIX} model changed: anthropic:claude-a → anthropic:claude-b (reason unknown)`);
  });

  test('stays silent when there is no previous model (initial selection)', () => {
    expect(buildRoutingChip(change({ previous: undefined }), [], NOW)).toBeNull();
  });

  test('stays silent for a no-op change (same registry key)', () => {
    expect(buildRoutingChip(change({ registryKey: 'anthropic:claude-a' }), [], NOW)).toBeNull();
  });

  test('stays silent when the change was a failover already narrated by [Failover]', () => {
    const c = change({ registryKey: 'anthropic:claude-b', provider: 'anthropic', previous: { registryKey: 'openai:gpt', provider: 'openai' } });
    const log: FallbackTransitionLike[] = [{ from: 'openai', to: 'anthropic', reason: 'timeout', ts: NOW - 100 }];
    expect(buildRoutingChip(c, log, NOW)).toBeNull();
  });

  test('emits when a fallback-log entry exists but is stale (not this change)', () => {
    const c = change({ provider: 'anthropic', previous: { registryKey: 'openai:gpt', provider: 'openai' } });
    const log: FallbackTransitionLike[] = [{ from: 'openai', to: 'anthropic', reason: 'timeout', ts: NOW - 60_000 }];
    expect(buildRoutingChip(c, log, NOW)).toContain('reason unknown');
  });
});
