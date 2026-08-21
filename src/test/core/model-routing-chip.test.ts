// ---------------------------------------------------------------------------
// model-routing-chip.test.ts
// The never-silent routing-chip decision: report every real model change, with
// the fallback log's own reason when one correlates and "reason unknown" only
// when nothing explains it. Silence is reserved for non-changes, the failover
// path suppresses its own two switches at the listener (stream-event-wiring).
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
  test('matches entries recorded as registry keys, not just bare provider ids', () => {
    // The SDK's agent-orchestrator fallback records provider-qualified route
    // labels in this same log. Reading only the bare form is what printed
    // "(reason unknown)" for a failover whose reason was sitting right there.
    const keyed: FallbackTransitionLike[] = [
      { from: 'abacusai:route-llm', to: 'openai-subscriber:gpt-5.6-sol', reason: 'stream timeout', ts: NOW - 500 },
    ];
    expect(findRecentFallbackReason(keyed, 'abacusai', 'openai-subscriber', NOW)).toBe('stream timeout');
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

  test('quotes the fallback log\'s reason instead of claiming the reason is unknown', () => {
    const c = change({ registryKey: 'anthropic:claude-b', provider: 'anthropic', previous: { registryKey: 'openai:gpt', provider: 'openai' } });
    const log: FallbackTransitionLike[] = [{ from: 'openai', to: 'anthropic', reason: 'timeout', ts: NOW - 100 }];
    expect(buildRoutingChip(c, log, NOW)).toBe(`${ROUTING_CHIP_PREFIX} model changed: openai:gpt → anthropic:claude-b (failover: timeout)`);
  });

  test('quotes the reason for a registry-key-shaped log entry (the owner\'s abacusai → openai-subscriber case)', () => {
    const c = change({
      registryKey: 'openai-subscriber:gpt-5.6-sol', provider: 'openai-subscriber',
      previous: { registryKey: 'abacusai:route-llm', provider: 'abacusai' },
    });
    const log: FallbackTransitionLike[] = [
      { from: 'abacusai:route-llm', to: 'openai-subscriber:gpt-5.6-sol', reason: 'HTTP 429', ts: NOW - 200 },
    ];
    const chip = buildRoutingChip(c, log, NOW);
    expect(chip).toBe(`${ROUTING_CHIP_PREFIX} model changed: abacusai:route-llm → openai-subscriber:gpt-5.6-sol (failover: HTTP 429)`);
    expect(chip).not.toContain('reason unknown');
  });

  test('emits when a fallback-log entry exists but is stale (not this change)', () => {
    const c = change({ provider: 'anthropic', previous: { registryKey: 'openai:gpt', provider: 'openai' } });
    const log: FallbackTransitionLike[] = [{ from: 'openai', to: 'anthropic', reason: 'timeout', ts: NOW - 60_000 }];
    expect(buildRoutingChip(c, log, NOW)).toContain('reason unknown');
  });
});
