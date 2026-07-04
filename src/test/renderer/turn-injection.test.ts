/**
 * Per-turn knowledge injection record rendering tests (Wave-5 W5.2, wo803).
 *
 * Covers the honest states TurnInjectionRecord can be in: populated
 * (injected something), empty (nothing cleared the relevance floor, or the
 * single highest-scoring record exceeded budget), fallback-lexical embedding
 * backend, and the "no records at all yet" state for buildTurnInjectionsText.
 */
import { describe, expect, test } from 'bun:test';
import { buildTurnInjectionsText, formatTurnInjectionEntry, type TurnInjectionEntry } from '../../renderer/turn-injection.ts';

function makeEntry(overrides: Partial<TurnInjectionEntry> = {}): TurnInjectionEntry {
  return {
    turn: 1,
    query: 'fix the flaky retry test',
    candidatesConsidered: 3,
    injectedIds: [],
    droppedForBudget: [],
    tokenCost: 0,
    budgetTokens: 800,
    relevanceFloor: 95,
    ingestModes: [],
    embeddingBackend: 'available',
    ...overrides,
  };
}

describe('formatTurnInjectionEntry', () => {
  test('populated: renders injected ids, token cost, and budget', () => {
    const entry = makeEntry({
      injectedIds: ['mem-1', 'mem-2'],
      tokenCost: 340,
      ingestModes: ['keyword', 'semantic'],
    });
    const line = formatTurnInjectionEntry(entry);
    expect(line).toContain('turn 1');
    expect(line).toContain('mem-1');
    expect(line).toContain('mem-2');
    expect(line).toContain('340');
    expect(line).toContain('800');
    expect(line).not.toContain('nothing injected');
  });

  test('populated: lists ids dropped for budget alongside the ones that were kept', () => {
    const entry = makeEntry({
      injectedIds: ['mem-1'],
      droppedForBudget: ['mem-2', 'mem-3'],
      tokenCost: 120,
    });
    const line = formatTurnInjectionEntry(entry);
    expect(line).toContain('dropped for budget');
    expect(line).toContain('mem-2');
    expect(line).toContain('mem-3');
  });

  test('honest empty state: nothing cleared the relevance floor', () => {
    const entry = makeEntry({
      injectedIds: [],
      candidatesConsidered: 5,
      reason: 'no records cleared relevance floor',
    });
    const line = formatTurnInjectionEntry(entry);
    expect(line).toContain('nothing injected this turn — nothing cleared the relevance floor');
    expect(line).toContain('considered 5');
    expect(line).toContain('floor 95');
  });

  test('honest empty state: single highest-scoring record exceeded budget', () => {
    const entry = makeEntry({
      injectedIds: [],
      reason: 'single highest-scoring record exceeds budget',
    });
    const line = formatTurnInjectionEntry(entry);
    expect(line).toContain('nothing injected this turn');
    expect(line).toContain('single highest-scoring record exceeds budget');
  });

  test('fallback-lexical embedding backend is tagged on both populated and empty entries', () => {
    const populated = formatTurnInjectionEntry(makeEntry({ injectedIds: ['mem-1'], embeddingBackend: 'fallback-lexical' }));
    const empty = formatTurnInjectionEntry(makeEntry({ embeddingBackend: 'fallback-lexical', reason: 'no records cleared relevance floor' }));
    expect(populated).toContain('[lexical fallback]');
    expect(empty).toContain('[lexical fallback]');
  });

  test('available embedding backend is not tagged (no noise on the common case)', () => {
    const line = formatTurnInjectionEntry(makeEntry({ injectedIds: ['mem-1'], embeddingBackend: 'available' }));
    expect(line).not.toContain('lexical');
  });
});

describe('buildTurnInjectionsText', () => {
  test('honest empty state when no records exist yet for this agent (flag off, no turns, or no budget headroom)', () => {
    const text = buildTurnInjectionsText('agent-1', []);
    expect(text).toContain('agent-1');
    expect(text).toContain('No per-turn injection records');
    expect(text).toContain('disabled');
    expect(text).not.toContain('turn 1');
  });

  test('renders every entry, most-recent-turn first', () => {
    const entries: TurnInjectionEntry[] = [
      makeEntry({ turn: 1, injectedIds: ['mem-1'], tokenCost: 100 }),
      makeEntry({ turn: 2, injectedIds: [], reason: 'no records cleared relevance floor' }),
      makeEntry({ turn: 3, injectedIds: ['mem-2'], tokenCost: 200 }),
    ];
    const text = buildTurnInjectionsText('agent-1', entries);
    const lines = text.split('\n');
    const turn3Index = lines.findIndex((l) => l.includes('turn 3'));
    const turn2Index = lines.findIndex((l) => l.includes('turn 2'));
    const turn1Index = lines.findIndex((l) => l.includes('turn 1'));
    expect(turn3Index).toBeGreaterThan(-1);
    expect(turn3Index).toBeLessThan(turn2Index);
    expect(turn2Index).toBeLessThan(turn1Index);
    expect(text).toContain('(3, most recent first)');
  });
});
