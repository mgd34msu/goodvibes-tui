import { describe, test, expect } from 'bun:test';
import { createKnowledgeModalSurface, type KnowledgeModalDeps } from '../../../panels/modals/knowledge-modal.ts';
import { actionCtx, captureCommands, findAction, open, tabText } from './modal-surface-test-helpers.ts';

function fixedDeps(): KnowledgeModalDeps {
  return {
    knowledgeApi: {
      graph: {
        nodes: { list: () => [{ id: 'node-1', kind: 'topic', title: 'Release cadence', summary: 'Batched releases.' }] },
        issues: { list: () => [
          { id: 'issue-1', severity: 'warning', code: 'stale-source', message: 'Recrawl overdue.', status: 'open', sourceId: 'source-1' },
          { id: 'issue-2', severity: 'error', code: 'broken-link', message: 'Link 404s.', status: 'resolved' },
        ] },
      },
      sources: { list: () => [{ id: 'source-1', sourceType: 'repo', status: 'indexed', title: 'goodvibes-tui', summary: 'Primary repo.' }] },
      jobs: { schedules: { list: () => [{ id: 'sched-1', label: 'Nightly reindex', enabled: true }] } },
    },
  };
}

describe('knowledge modal surface', () => {
  test('surface identity', () => { expect(createKnowledgeModalSurface(fixedDeps()).name).toBe('knowledge-modal'); });

  test('Browse tab lists sources/nodes/issues with counts + readiness; Review tab holds the open queue', () => {
    const view = open(createKnowledgeModalSurface(fixedDeps()));
    expect(view.tabs.map((t) => t.id)).toEqual(['browse', 'review']);
    const browse = tabText(view, 'browse');
    expect(browse).toContain('sources 1  nodes 1  issues 2');
    expect(browse).toContain('retrieval ready');
    expect(browse).toContain('goodvibes-tui');
    expect(browse).toContain('Release cadence');
    expect(browse).toContain('Nightly reindex');
    expect(view.tabs[0]!.rows.map((r) => r.id)).toEqual(['source:source-1', 'node:node-1', 'issue:issue-1', 'issue:issue-2', 'sched:title', 'sched:0']);
    const review = view.tabs.find((t) => t.id === 'review')!;
    expect(review.rows.map((r) => r.id)).toEqual(['issue:issue-1']); // resolved issue excluded
  });

  test('review actions route to /knowledge review-issue, gated to the Review tab + issue rows', () => {
    const surface = createKnowledgeModalSurface(fixedDeps());
    open(surface);
    const row = { id: 'issue:issue-1', label: '' };
    expect(findAction(surface, 'accept')?.enabledFor?.(row, 'browse')).toBe(false);
    expect(findAction(surface, 'accept')?.enabledFor?.(row, 'review')).toBe(true);
    const cap = captureCommands();
    surface.onAction?.('accept', actionCtx(row, cap.extra));
    expect(cap.calls).toEqual([['knowledge', ['review-issue', 'issue-1', 'accept', '--reviewer', 'tui']]]);
  });

  test('openMemory cross-opens the memory-modal surface', () => {
    const surface = createKnowledgeModalSurface(fixedDeps());
    open(surface);
    const opened: string[] = [];
    surface.onAction?.('openMemory', actionCtx(null, { openModal: (n) => opened.push(n) }));
    expect(opened).toEqual(['memory-modal']);
  });

  test('load failure renders an honest degraded state', () => {
    const surface = createKnowledgeModalSurface({
      knowledgeApi: {
        graph: { nodes: { list: () => { throw new Error('graph unavailable'); } }, issues: { list: () => [] } },
        sources: { list: () => [] }, jobs: { schedules: { list: () => [] } },
      },
    });
    const view = open(surface);
    expect(view.degraded).toContain('Knowledge graph load failed');
    expect(view.degraded).toContain('graph unavailable');
  });
});
