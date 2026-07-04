import { describe, test, expect } from 'bun:test';
import { createMemoryModalSurface, type MemoryModalDeps } from '../../../panels/modals/memory-modal.ts';
import { actionCtx, captureCommands, findAction, open, tabText } from './modal-surface-test-helpers.ts';

const FIXED = 1735689600000;
function fixedDeps(): MemoryModalDeps {
  const records = [
    { id: 'mem-aaa1', scope: 'project', cls: 'decision', summary: 'Ship in batched waves.', detail: 'No per-change release tags.', tags: ['release'], reviewState: 'reviewed', confidence: 90, createdAt: FIXED, provenance: [{ kind: 'session', ref: 'sess-1' }] },
    { id: 'mem-bbb2', scope: 'session', cls: 'risk', summary: 'Modal mutations must route to commands.', tags: ['charter'], reviewState: 'stale', confidence: 35, staleReason: 'needs re-verification', createdAt: FIXED + 1000, provenance: [] },
  ];
  return { memoryRegistry: { search: () => records, reviewQueue: () => records.filter((r) => r.reviewState !== 'reviewed') } };
}

describe('memory modal surface', () => {
  test('surface identity', () => { expect(createMemoryModalSurface({}).name).toBe('memory-modal'); });

  test('unconfigured registry renders the honest "not configured" degraded state', () => {
    const view = open(createMemoryModalSurface({}));
    expect(view.degraded).toContain('Memory registry not configured for this session.');
    expect(view.degraded).toContain('not wired with a project memory registry at bootstrap');
  });

  test('All Records tab lists records with counts; Review Queue tab narrows to the stale record', () => {
    const view = open(createMemoryModalSurface(fixedDeps()));
    expect(view.tabs.map((t) => t.id)).toEqual(['all', 'review']);
    const all = tabText(view, 'all');
    expect(all).toContain('records 2  review queue 1');
    expect(all).toContain('Ship in batched waves.');
    const review = view.tabs.find((t) => t.id === 'review')!;
    expect(review.rows).toHaveLength(1);
    expect(review.rows[0]!.id).toBe('mem-bbb2');
  });

  test('review actions route to /recall review with computed confidence, gated to the review tab', () => {
    const surface = createMemoryModalSurface(fixedDeps());
    open(surface);
    const row = { id: 'mem-bbb2', label: '' };
    expect(findAction(surface, 'markReviewed')?.enabledFor?.(row, 'all')).toBe(false);
    expect(findAction(surface, 'markReviewed')?.enabledFor?.(row, 'review')).toBe(true);

    const reviewed = captureCommands();
    surface.onAction?.('markReviewed', actionCtx(row, reviewed.extra));
    expect(reviewed.calls).toEqual([['recall', ['review', 'mem-bbb2', 'reviewed', '--confidence', '85', '--by', 'operator']]]);

    const stale = captureCommands();
    surface.onAction?.('markStale', actionCtx(row, stale.extra));
    expect(stale.calls).toEqual([['recall', ['review', 'mem-bbb2', 'stale', '--confidence', '35', '--by', 'operator', '--reason', 'marked stale from the memory panel']]]);

    const contradicted = captureCommands();
    surface.onAction?.('markContradicted', actionCtx(row, contradicted.extra));
    expect(contradicted.calls).toEqual([['recall', ['review', 'mem-bbb2', 'contradicted', '--confidence', '0', '--by', 'operator', '--reason', 'marked contradicted from the memory panel']]]);
  });

  test('delete routes to /recall remove', () => {
    const surface = createMemoryModalSurface(fixedDeps());
    open(surface);
    const cap = captureCommands();
    surface.onAction?.('remove', actionCtx({ id: 'mem-aaa1', label: '' }, cap.extra));
    expect(cap.calls).toEqual([['recall', ['remove', 'mem-aaa1']]]);
  });
});
