import { describe, test, expect } from 'bun:test';
import { bindKnowledgeModal, knowledgeModalGoldenSurface, type KnowledgeModalDeps } from '../../../panels/modals/knowledge-modal.ts';
import { EMPTY_VIEW } from '../../../panels/modals/modal-surface.ts';
import type { ModalConfig } from '../../../renderer/modal-factory.ts';

/** Flatten a ModalConfig's text/list/title content into one searchable string. */
function configText(config: ModalConfig): string {
  const parts: string[] = [config.title];
  if (config.search !== undefined) parts.push(config.search);
  for (const section of config.sections) {
    if (section.content) parts.push(section.content);
    for (const item of section.items ?? []) parts.push(item.label);
  }
  for (const hint of config.hints ?? []) parts.push(hint);
  if (config.footer) parts.push(config.footer);
  return parts.join('\n');
}

function fixedDeps(): KnowledgeModalDeps {
  return {
    knowledgeApi: {
      graph: {
        nodes: {
          list: () => [{ id: 'node-1', kind: 'topic', title: 'Release cadence', summary: 'Batched releases.' }],
        },
        issues: {
          list: () => [
            { id: 'issue-1', severity: 'warning', code: 'stale-source', message: 'Recrawl overdue.', status: 'open', sourceId: 'source-1' },
            { id: 'issue-2', severity: 'error', code: 'broken-link', message: 'Link 404s.', status: 'resolved' },
          ],
        },
      },
      sources: {
        list: () => [{ id: 'source-1', sourceType: 'repo', status: 'indexed', title: 'goodvibes-tui', summary: 'Primary repo.' }],
      },
      jobs: {
        schedules: { list: () => [{ id: 'sched-1', label: 'Nightly reindex', enabled: true }] },
      },
    },
  };
}

describe('knowledge modal builder', () => {
  test('browse mode lists sources/nodes/issues with counts and readiness', () => {
    const surface = bindKnowledgeModal(fixedDeps());
    surface.refresh();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('sources 1  nodes 1  issues 2');
    expect(text).toContain('retrieval ready');
    expect(text).toContain('goodvibes-tui');
    expect(text).toContain('Release cadence');
    expect(text).toContain('stale-source');
    expect(text).toContain('Nightly reindex');
    expect(surface.rowIds(EMPTY_VIEW)).toEqual(['source:source-1', 'node:node-1', 'issue:issue-1', 'issue:issue-2']);
  });

  test('search filters the combined browse rows locally (no live API search call)', () => {
    const surface = bindKnowledgeModal(fixedDeps());
    surface.refresh();
    const text = configText(surface.buildConfig({ ...EMPTY_VIEW, query: 'cadence' }));
    expect(text).toContain('Release cadence');
    expect(text).not.toContain('goodvibes-tui');
  });

  test('tab toggles to the open-issue review queue', () => {
    const surface = bindKnowledgeModal(fixedDeps());
    surface.refresh();
    expect(surface.actions.toggleMode!(EMPTY_VIEW)).toEqual({ kind: 'refresh' });
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('Review Queue');
    expect(text).toContain('stale-source');
    expect(text).not.toContain('broken-link'); // resolved issue excluded from the open queue
    expect(surface.rowIds(EMPTY_VIEW)).toEqual(['issue:issue-1']);
  });

  test('review actions route to /knowledge review-issue (no direct API mutation call)', () => {
    const surface = bindKnowledgeModal(fixedDeps());
    surface.refresh();
    surface.actions.toggleMode!(EMPTY_VIEW);
    expect(surface.actions.accept!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/knowledge review-issue issue-1 accept --reviewer tui' });
    expect(surface.actions.resolve!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/knowledge review-issue issue-1 resolve --reviewer tui' });
  });

  test('openMemory cross-opens the memory modal', () => {
    const surface = bindKnowledgeModal(fixedDeps());
    surface.refresh();
    expect(surface.actions.openMemory!(EMPTY_VIEW)).toEqual({ kind: 'openModal', name: 'memory' });
  });

  test('load failure renders an honest error state', () => {
    const surface = bindKnowledgeModal({
      knowledgeApi: {
        graph: {
          nodes: { list: () => { throw new Error('graph unavailable'); } },
          issues: { list: () => [] },
        },
        sources: { list: () => [] },
        jobs: { schedules: { list: () => [] } },
      },
    });
    surface.refresh();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('Knowledge graph load failed');
    expect(text).toContain('graph unavailable');
  });

  test('golden surface renders a deterministic byte-stable config across two calls', () => {
    const a = configText(knowledgeModalGoldenSurface().buildConfig(EMPTY_VIEW));
    const b = configText(knowledgeModalGoldenSurface().buildConfig(EMPTY_VIEW));
    expect(a).toBe(b);
    expect(a).toContain('Release cadence');
    expect(a).toContain('goodvibes-tui');
  });
});
