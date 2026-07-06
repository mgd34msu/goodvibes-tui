import { describe, test, expect } from 'bun:test';
import { createMemoryModalSurface, type MemoryModalDeps } from '../../../panels/modals/memory-modal.ts';
import { actionCtx, captureCommands, findAction, open, tabText } from './modal-surface-test-helpers.ts';
import type { ConfigModalSurface, ConfigModalView } from '../../../input/config-modal-types.ts';

const FIXED = 1735689600000;

/** The fixed record set every honestSearch-backed test in this file shares. */
const RECORDS = [
  { id: 'mem-aaa1', scope: 'project', cls: 'decision', summary: 'Ship in batched waves.', detail: 'No per-change release tags.', tags: ['release'], reviewState: 'reviewed', confidence: 90, createdAt: FIXED, provenance: [{ kind: 'session', ref: 'sess-1' }] },
  { id: 'mem-bbb2', scope: 'session', cls: 'risk', summary: 'Modal mutations must route to commands.', tags: ['charter'], reviewState: 'stale', confidence: 35, staleReason: 'needs re-verification', createdAt: FIXED + 1000, provenance: [] },
];

function fixedDeps(): MemoryModalDeps {
  return { memoryRegistry: { honestSearch: async () => ({ records: RECORDS }) } };
}

/** Flush the microtask queue so an async onOpen refresh (honestSearch) has resolved. */
const flushMicrotasks = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

/** Open a surface backed by an async `honestSearch` and wait for the initial refresh to land. */
async function openAsync(surface: ConfigModalSurface): Promise<ConfigModalView> {
  surface.onOpen?.(() => {});
  await flushMicrotasks();
  return surface.buildView();
}

describe('memory modal surface', () => {
  test('surface identity', () => { expect(createMemoryModalSurface({}).name).toBe('memory-modal'); });

  test('unconfigured registry renders the honest "not configured" degraded state', () => {
    const view = open(createMemoryModalSurface({}));
    expect(view.degraded).toContain('Memory registry not configured for this session.');
    expect(view.degraded).toContain('not wired with a project memory registry at bootstrap');
  });

  test('All Records tab lists both records; Review Queue tab ranks the stale record above the reviewed one', async () => {
    const view = await openAsync(createMemoryModalSurface(fixedDeps()));
    expect(view.tabs.map((t) => t.id)).toEqual(['all', 'review']);
    const all = tabText(view, 'all');
    // Both are review candidates (the SDK's isReviewCandidate covers all four
    // review states, not just flagged ones) — ranked, not filtered down.
    expect(all).toContain('records 2  review queue 2');
    expect(all).toContain('Ship in batched waves.');
    const review = view.tabs.find((t) => t.id === 'review')!;
    expect(review.rows).toHaveLength(2);
    expect(review.rows[0]!.id).toBe('mem-bbb2'); // stale, lower confidence: ranks first
    expect(review.rows[1]!.id).toBe('mem-aaa1'); // reviewed, high confidence: ranks last
  });

  test('a client-mode wire failure surfaces plainly as a degraded state, not a silent empty list', async () => {
    const surface = createMemoryModalSurface({
      memoryRegistry: { honestSearch: async () => { throw new Error('daemon unreachable'); } },
    });
    const view = await openAsync(surface);
    expect(view.degraded).toContain('Failed to reach memory over the wire');
    expect(view.degraded).toContain('daemon unreachable');
  });

  test('an index-unavailable search fallback is stated in the view, not silently dropped', async () => {
    const surface = createMemoryModalSurface({
      memoryRegistry: { honestSearch: async () => ({ records: RECORDS, indexUnavailableReason: 'semantic index offline' }) },
    });
    const view = await openAsync(surface);
    expect(view.degraded).toBe('semantic index offline');
  });

  test('review actions route to /recall review with computed confidence, gated to the review tab', async () => {
    const surface = createMemoryModalSurface(fixedDeps());
    await openAsync(surface);
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

  test('delete routes to /recall remove', async () => {
    const surface = createMemoryModalSurface(fixedDeps());
    await openAsync(surface);
    const cap = captureCommands();
    surface.onAction?.('remove', actionCtx({ id: 'mem-aaa1', label: '' }, cap.extra));
    expect(cap.calls).toEqual([['recall', ['remove', 'mem-aaa1']]]);
  });
});
