import { describe, expect, test } from 'bun:test';
import {
  attemptGroupDependencyStatus,
  dependentsHeldByGroup,
  renderDependentHoldLines,
  resolveGroupSourceId,
  type AttemptGraphItem,
} from '../../input/commands/workstream-attempt-dependents.ts';

// A non-leaf best-of-N group "build" (source id 'build') with two siblings, and
// a dependent "deploy" that dependsOn ['build'].
function graph(overrides: Partial<Record<string, Partial<AttemptGraphItem>>> = {}): AttemptGraphItem[] {
  const base: Record<string, AttemptGraphItem> = {
    'build#0': { id: 'build#0', title: 'Build (attempt 1)', state: 'held-merge', attemptSourceId: 'build' },
    'build#1': { id: 'build#1', title: 'Build (attempt 2)', state: 'held-merge', attemptSourceId: 'build' },
    deploy: { id: 'deploy', title: 'Deploy', state: 'blocked-dependency', dependsOn: ['build'] },
  };
  for (const [k, patch] of Object.entries(overrides)) base[k] = { ...base[k]!, ...patch };
  return Object.values(base);
}

describe('attemptGroupDependencyStatus', () => {
  test('waiting while siblings are held and no winner picked', () => {
    expect(attemptGroupDependencyStatus(graph(), 'build')).toBe('waiting');
  });

  test('waiting when a winner is picked but not yet merged', () => {
    const items = graph({ 'build#0': { attemptWinner: true, mergeState: 'clean' } });
    expect(attemptGroupDependencyStatus(items, 'build')).toBe('waiting');
  });

  test('satisfied once the winner is merged', () => {
    const items = graph({ 'build#0': { attemptWinner: true, mergeState: 'merged' } });
    expect(attemptGroupDependencyStatus(items, 'build')).toBe('satisfied');
  });

  test('failed when every sibling failed', () => {
    const items = graph({ 'build#0': { state: 'failed' }, 'build#1': { state: 'failed' } });
    expect(attemptGroupDependencyStatus(items, 'build')).toBe('failed');
  });

  test('not-a-group for an unknown source id', () => {
    expect(attemptGroupDependencyStatus(graph(), 'nope')).toBe('not-a-group');
  });
});

describe('resolveGroupSourceId / dependentsHeldByGroup', () => {
  test('resolves the source id from a candidate item id', () => {
    expect(resolveGroupSourceId(graph(), ['build#0', 'build#1'])).toBe('build');
  });

  test('lists dependents held until the winner is picked and merged', () => {
    const holds = dependentsHeldByGroup(graph(), 'build');
    expect(holds).toHaveLength(1);
    expect(holds[0]!.title).toBe('Deploy');
    expect(holds[0]!.descriptor).toContain('held until the winner is picked and merged');
  });

  test('dependents read as released once the winner has merged', () => {
    const items = graph({ 'build#0': { attemptWinner: true, mergeState: 'merged' } });
    expect(dependentsHeldByGroup(items, 'build')[0]!.descriptor).toContain('released');
  });
});

describe('renderDependentHoldLines', () => {
  test('renders a dependent-hold block for a non-leaf group', () => {
    const lines = renderDependentHoldLines(graph(), ['build#0', 'build#1']);
    expect(lines[0]).toContain('1 dependent(s) held until the winner is picked and merged');
    expect(lines).toContain('      - "Deploy"');
  });

  test('renders nothing for a leaf group (no dependents)', () => {
    const leaf: AttemptGraphItem[] = [
      { id: 'x#0', title: 'X (attempt 1)', state: 'held-merge', attemptSourceId: 'x' },
      { id: 'x#1', title: 'X (attempt 2)', state: 'held-merge', attemptSourceId: 'x' },
    ];
    expect(renderDependentHoldLines(leaf, ['x#0', 'x#1'])).toEqual([]);
  });
});
