// ---------------------------------------------------------------------------
// workstream-draft-edits.test.ts — pure plan-review-gate item edits
//
// Unit-level coverage of the pure spec mutations behind /workstream's
// edit-item / remove-item / move-item (see runtime/workstream-draft-edits.ts).
// No engine, no I/O — just spec-in, spec-or-error-out.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { CreateWorkstreamInput } from '@pellux/goodvibes-sdk/platform/orchestration';
import { editItemBrief, moveItemInSpec, removeItemFromSpec, resolveItemIndex } from '../../runtime/workstream-draft-edits.ts';

function specOf(items: CreateWorkstreamInput['items']): CreateWorkstreamInput {
  return {
    title: 'demo',
    phases: [{ role: 'engineer', capacity: 1, kind: 'engineer', gate: { scope: 'scoped', gates: [] } }],
    items,
  };
}

const THREE = specOf([
  { id: 'item-a', title: 'alpha', task: 'do alpha' },
  { id: 'item-b', title: 'beta', task: 'do beta', dependsOn: ['item-a'] },
  { id: 'item-c', title: 'gamma', task: 'do gamma', dependsOn: ['item-a', 'item-b'] },
]);

describe('resolveItemIndex', () => {
  test('resolves a 1-based ordinal within range', () => {
    expect(resolveItemIndex(THREE.items, '2')).toBe(1);
  });
  test('resolves a unique id prefix', () => {
    expect(resolveItemIndex(THREE.items, 'item-c')).toBe(2);
  });
  test('an out-of-range ordinal is unresolved (undefined), not clamped', () => {
    expect(resolveItemIndex(THREE.items, '0')).toBeUndefined();
    expect(resolveItemIndex(THREE.items, '4')).toBeUndefined();
  });
  test('an unmatched reference is undefined', () => {
    expect(resolveItemIndex(THREE.items, 'zzz')).toBeUndefined();
  });
});

describe('editItemBrief', () => {
  test('rewrites the target item task and leaves title + siblings intact', () => {
    const res = editItemBrief(THREE, '1', 'do alpha differently');
    expect('spec' in res).toBe(true);
    if ('spec' in res) {
      expect(res.spec.items[0]!.task).toBe('do alpha differently');
      expect(res.spec.items[0]!.title).toBe('alpha');
      expect(res.spec.items[1]!.task).toBe('do beta');
    }
  });
  test('refuses an empty brief', () => {
    const res = editItemBrief(THREE, '1', '   ');
    expect(res).toEqual({ error: 'A new brief cannot be empty.' });
  });
  test('refuses an unresolvable reference', () => {
    const res = editItemBrief(THREE, '9', 'x');
    expect('error' in res).toBe(true);
  });
  test('does not mutate the input spec', () => {
    editItemBrief(THREE, '1', 'changed');
    expect(THREE.items[0]!.task).toBe('do alpha');
  });
});

describe('removeItemFromSpec', () => {
  test('drops the item and strips its id from every sibling dependsOn', () => {
    const res = removeItemFromSpec(THREE, '1'); // remove item-a
    expect('spec' in res).toBe(true);
    if ('spec' in res) {
      expect(res.spec.items.map((i) => i.id)).toEqual(['item-b', 'item-c']);
      expect(res.spec.items[0]!.dependsOn ?? []).toEqual([]); // was ['item-a']
      expect(res.spec.items[1]!.dependsOn).toEqual(['item-b']); // item-a stripped, item-b kept
    }
  });
  test('refuses to remove the last item', () => {
    const single = specOf([{ id: 'x', title: 'only', task: 'only' }]);
    const res = removeItemFromSpec(single, '1');
    expect(res).toEqual({ error: 'Cannot remove the last item — a workstream needs at least one.' });
  });
});

describe('moveItemInSpec', () => {
  test('moves an item to a new authoring position without touching dependencies', () => {
    const res = moveItemInSpec(THREE, '3', 1); // gamma to front
    expect('spec' in res).toBe(true);
    if ('spec' in res) {
      expect(res.spec.items.map((i) => i.id)).toEqual(['item-c', 'item-a', 'item-b']);
      expect(res.spec.items[0]!.dependsOn).toEqual(['item-a', 'item-b']); // deps unchanged
    }
  });
  test('refuses an out-of-range position', () => {
    const res = moveItemInSpec(THREE, '1', 9);
    expect('error' in res).toBe(true);
  });
});
