import { describe, test, expect } from 'bun:test';
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk';
import { createMemoryModalSurface, type MemoryModalDeps } from '../../../panels/modals/memory-modal.ts';
import type { MemoryConsolidationGatewayResolution, MemoryConsolidationProposal } from '../../../panels/memory-consolidation-gateway.ts';
import { actionCtx, captureCommands, findAction, open, tabText } from './modal-surface-test-helpers.ts';
import type { ConfigModalSurface, ConfigModalView } from '../../../input/config-modal-types.ts';
import { ConfigModal } from '../../../input/config-modal.ts';
import { renderConfigModal } from '../../../renderer/config-modal.ts';

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
    expect(view.tabs.map((t) => t.id)).toEqual(['all', 'review', 'proposals']);
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

  test('an expired record is labelled [expired] in both tabs; a window-less record carries no label', async () => {
    const expiredRecords = [
      ...RECORDS,
      { id: 'mem-ccc3', scope: 'project', cls: 'fact', summary: 'Expired fact.', tags: [], reviewState: 'fresh', confidence: 50, createdAt: FIXED + 2000, provenance: [], validUntil: FIXED - 1 },
    ];
    const surface = createMemoryModalSurface({ memoryRegistry: { honestSearch: async () => ({ records: expiredRecords }) } });
    const view = await openAsync(surface);
    const all = tabText(view, 'all');
    expect(all).toContain('Expired fact. [expired]');
    expect(all).not.toContain('Ship in batched waves. [expired]');
    expect(all).not.toContain('Ship in batched waves. [pending]');
  });
});

// ---------------------------------------------------------------------------
// Proposals tab — memory.consolidation.receipts read through the injected
// resolveConsolidationGateway seam (memory-consolidation-gateway.ts), never a
// real daemon round-trip in these tests.
// ---------------------------------------------------------------------------

const PROPOSALS: MemoryConsolidationProposal[] = [
  { kind: 'contradiction', ids: ['mem-aaa1'], route: '/recall review', reason: 'Directly contradicts mem-xyz9 on release cadence.' },
  { kind: 'cross-scope-duplicate', ids: ['mem-bbb2', 'mem-ccc3'], route: '/recall review', reason: 'Near-duplicate of a project-scope record.' },
];

/** A resolver whose gateway resolves immediately (available:true) with a fixed proposal set. */
function readyGateway(proposals: MemoryConsolidationProposal[]): () => MemoryConsolidationGatewayResolution {
  return () => ({ available: true, gateway: { fetchReceipts: async () => ({ receipts: [], pendingProposals: proposals }) } });
}

/** A resolver whose gateway rejects fetchReceipts with the given error. */
function failingGateway(error: unknown): () => MemoryConsolidationGatewayResolution {
  return () => ({ available: true, gateway: { fetchReceipts: async () => { throw error; } } });
}

function proposalsTab(view: ConfigModalView) {
  return view.tabs.find((t) => t.id === 'proposals')!;
}

describe('memory modal — Proposals tab', () => {
  test('no resolveConsolidationGateway wired renders the honest "unavailable" state without ever attempting a fetch', async () => {
    const view = await openAsync(createMemoryModalSurface(fixedDeps()));
    const tab = proposalsTab(view);
    expect(tab.rows).toHaveLength(0);
    expect(tab.emptyText).toContain('Pending proposals unavailable');
    expect(tab.emptyText).toContain('No consolidation gateway wired for this session.');
  });

  test('a refused gateway resolution (daemon disabled / no control-plane URL) renders "unavailable" with the resolution\'s own reason', async () => {
    const surface = createMemoryModalSurface({
      ...fixedDeps(),
      resolveConsolidationGateway: () => ({ available: false, reason: 'the daemon is disabled (daemon.enabled=false)' }),
    });
    const view = await openAsync(surface);
    const tab = proposalsTab(view);
    expect(tab.emptyText).toBe('Pending proposals unavailable: the daemon is disabled (daemon.enabled=false)');
  });

  test('a 501 from the daemon (no consolidation scheduler on this runtime) renders "unavailable", not a generic error', async () => {
    const surface = createMemoryModalSurface({
      ...fixedDeps(),
      resolveConsolidationGateway: failingGateway(new GoodVibesSdkError('no scheduler', { status: 501 })),
    });
    const view = await openAsync(surface);
    expect(proposalsTab(view).emptyText).toContain('Pending proposals unavailable');
  });

  test('a 404 from an older daemon (route not wired yet) also renders "unavailable" — the same bucket as 501', async () => {
    const surface = createMemoryModalSurface({
      ...fixedDeps(),
      resolveConsolidationGateway: failingGateway(new GoodVibesSdkError('not found', { status: 404 })),
    });
    const view = await openAsync(surface);
    expect(proposalsTab(view).emptyText).toContain('Pending proposals unavailable');
  });

  test('a generic fetch failure renders a DISTINCT "error" state, not "unavailable" and not silently empty', async () => {
    const surface = createMemoryModalSurface({
      ...fixedDeps(),
      resolveConsolidationGateway: failingGateway(new Error('connection reset')),
    });
    const view = await openAsync(surface);
    const tab = proposalsTab(view);
    expect(tab.emptyText).toContain('Could not fetch pending proposals');
    expect(tab.emptyText).toContain('connection reset');
    expect(tab.emptyText).not.toContain('unavailable');
  });

  test('a successful fetch with zero pending proposals renders the honest "none pending" line — a THIRD distinct state', async () => {
    const surface = createMemoryModalSurface({ ...fixedDeps(), resolveConsolidationGateway: readyGateway([]) });
    const view = await openAsync(surface);
    const tab = proposalsTab(view);
    expect(tab.rows).toHaveLength(0);
    expect(tab.emptyText).toBe('No pending proposals — nothing awaiting judgment right now.');
    expect(tab.header).toEqual(['pending proposals 0']);
  });

  test('a populated fetch lists each proposal\'s kind, reason, and affected record ids', async () => {
    const surface = createMemoryModalSurface({ ...fixedDeps(), resolveConsolidationGateway: readyGateway(PROPOSALS) });
    const view = await openAsync(surface);
    const tab = proposalsTab(view);
    expect(tab.header).toEqual(['pending proposals 2']);
    expect(tab.rows).toHaveLength(2);
    expect(tab.rows[0]!.label).toContain('[contradiction]');
    expect(tab.rows[0]!.label).toContain('Directly contradicts mem-xyz9 on release cadence.');
    expect(tab.rows[0]!.label).toContain('mem-aaa1');
    expect(tab.rows[1]!.label).toContain('[cross-scope-duplicate]');
    expect(tab.rows[1]!.label).toContain('mem-bbb2, mem-ccc3');
  });

  test('jumping from a selected proposal moves to the Review Queue tab with one of its affected records selected', async () => {
    const surface = createMemoryModalSurface({ ...fixedDeps(), resolveConsolidationGateway: readyGateway(PROPOSALS) });
    await openAsync(surface);
    expect(findAction(surface, 'jumpToReviewQueue')?.enabledFor?.({ id: 'proposal:0', label: '' }, 'proposals')).toBe(true);
    expect(findAction(surface, 'jumpToReviewQueue')?.enabledFor?.({ id: 'proposal:0', label: '' }, 'review')).toBe(false);

    const jumps: Array<[string, string]> = [];
    const statuses: string[] = [];
    surface.onAction?.('jumpToReviewQueue', actionCtx({ id: 'proposal:0', label: '' }, {
      jumpToRow: (tabId, rowId) => jumps.push([tabId, rowId]),
      setStatus: (m) => statuses.push(m),
    }));
    // mem-aaa1 is the contradiction proposal's only id, and IS in RECORDS/reviewRecords.
    expect(jumps).toEqual([['review', 'mem-aaa1']]);
    expect(statuses[0]).toContain('mem-aaa1');
  });

  test('jumping from a proposal whose ids are all outside the review-queue window prints an honest status instead of jumping nowhere', async () => {
    const surface = createMemoryModalSurface({
      ...fixedDeps(),
      resolveConsolidationGateway: readyGateway([
        { kind: 'stale-delete', ids: ['mem-not-in-queue'], route: '/recall review', reason: 'Never referenced; aged past the decay floor.' },
      ]),
    });
    await openAsync(surface);
    const jumps: Array<[string, string]> = [];
    const statuses: string[] = [];
    surface.onAction?.('jumpToReviewQueue', actionCtx({ id: 'proposal:0', label: '' }, {
      jumpToRow: (tabId, rowId) => jumps.push([tabId, rowId]),
      setStatus: (m) => statuses.push(m),
    }));
    expect(jumps).toEqual([]);
    expect(statuses[0]).toContain("None of this proposal's 1 record(s)");
  });
});

// ---------------------------------------------------------------------------
// Review Queue reason correlation (item 3) — a cross-scope-duplicate proposal
// marks its records 'fresh' with NO staleReason, so without correlating
// against the fetched proposals those rows would be bare and unexplained.
// ---------------------------------------------------------------------------

describe('memory modal — Review Queue reason correlation against pending proposals', () => {
  const FRESH_DUPLICATE_RECORDS = [
    ...RECORDS, // mem-bbb2 here already carries its own staleReason
    { id: 'mem-ccc3', scope: 'project', cls: 'fact', summary: 'Near-duplicate fact record.', tags: [], reviewState: 'fresh', confidence: 50, createdAt: FIXED + 2000, provenance: [] },
  ];

  test('a bare "fresh" record named by a cross-scope-duplicate proposal shows that proposal\'s reason', async () => {
    const surface = createMemoryModalSurface({
      memoryRegistry: { honestSearch: async () => ({ records: FRESH_DUPLICATE_RECORDS }) },
      resolveConsolidationGateway: readyGateway(PROPOSALS), // proposal 2 names mem-bbb2 + mem-ccc3
    });
    const view = await openAsync(surface);
    const review = view.tabs.find((t) => t.id === 'review')!;
    const row = review.rows.find((r) => r.id === 'mem-ccc3')!;
    expect(row.label).toContain('Near-duplicate fact record.');
    expect(row.label).toContain('(cross-scope-duplicate: Near-duplicate of a project-scope record.)');
  });

  test('a record that already carries its own staleReason keeps that reason — the matching proposal\'s reason is not appended on top', async () => {
    const surface = createMemoryModalSurface({
      memoryRegistry: { honestSearch: async () => ({ records: FRESH_DUPLICATE_RECORDS }) },
      resolveConsolidationGateway: readyGateway(PROPOSALS), // proposal 2 also names mem-bbb2, which already has a staleReason
    });
    const view = await openAsync(surface);
    const review = view.tabs.find((t) => t.id === 'review')!;
    const row = review.rows.find((r) => r.id === 'mem-bbb2')!;
    expect(row.label).toContain('(stale: needs re-verification)');
    expect(row.label).not.toContain('cross-scope-duplicate');
  });

  test('a record named by no proposal carries no reason suffix at all', async () => {
    const surface = createMemoryModalSurface({
      memoryRegistry: { honestSearch: async () => ({ records: FRESH_DUPLICATE_RECORDS }) },
      resolveConsolidationGateway: readyGateway([]),
    });
    const view = await openAsync(surface);
    const review = view.tabs.find((t) => t.id === 'review')!;
    const row = review.rows.find((r) => r.id === 'mem-ccc3')!;
    expect(row.label).toBe('fresh          50%  Near-duplicate fact record.');
  });
});

// ---------------------------------------------------------------------------
// Modal sizing rule (owner, zero tolerance): a modal must never clip its full
// descriptive text — size to content or scroll, never clip. Rendered through
// the REAL host (ConfigModal + renderConfigModal), at a COMPACT height, with
// realistic (not pathological) proposal reason text long enough to wrap
// across multiple lines within a single row.
// ---------------------------------------------------------------------------

describe('memory modal — Proposals tab at compact height (modal sizing rule)', () => {
  const LONG_REASON = 'Duplicates a project-scope decision already captured with more detail and provenance elsewhere in the store.';

  /**
   * Render the Proposals tab and split the row/list CONTENT from the footer
   * hint bar (the bottom border line, e.g. "d delete · r refresh · v view in
   * revi…"). The footer hints line is a supplementary shortcut legend that
   * ModalFactory deliberately truncates at narrow widths (every modal's
   * footer does this, existing behavior) — the modal sizing rule is about the
   * row/list DESCRIPTIVE TEXT, so the two are asserted on separately.
   */
  async function renderProposalsTab(width: number, height: number): Promise<{ content: string; footer: string }> {
    const surface = createMemoryModalSurface({
      memoryRegistry: { honestSearch: async () => ({ records: RECORDS }) },
      resolveConsolidationGateway: readyGateway([
        { kind: 'cross-scope-duplicate', ids: ['mem-aaa1', 'mem-bbb2'], route: '/recall review', reason: LONG_REASON },
      ]),
    });
    const modal = new ConfigModal();
    modal.open(surface, () => {});
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    modal.syncStructure();
    modal.nextTab(); // all -> review
    modal.nextTab(); // review -> proposals
    const lines = renderConfigModal(modal, width, height);
    modal.close();
    const asText = lines.map((l) => l.map((c) => (c.char === '' ? ' ' : c.char)).join(''));
    return { content: asText.slice(0, -1).join('\n'), footer: asText[asText.length - 1] ?? '' };
  }

  test('a long proposal reason wraps across lines and is never truncated with an ellipsis, at a compact height', async () => {
    const { content } = await renderProposalsTab(90, 14); // compact height (default goldens use 40)
    expect(content).toContain('cross-scope-duplicate');
    // Each word-boundary chunk of the full reason must survive — proving the
    // wrap kept the whole sentence rather than dropping its tail.
    expect(content).toContain('Duplicates a project-scope decision');
    expect(content).toContain('provenance elsewhere in the store.');
    expect(content).toContain('mem-aaa1, mem-bbb2'); // the affected record ids, in full, not elided
    expect(content).not.toContain('…');
  });

  test('the same content at an even narrower width still wraps the row content rather than clipping it', async () => {
    const { content } = await renderProposalsTab(50, 14);
    expect(content).toContain('Duplicates');
    expect(content).toContain('provenance elsewhere in the store.');
    expect(content).not.toContain('…');
  });
});
