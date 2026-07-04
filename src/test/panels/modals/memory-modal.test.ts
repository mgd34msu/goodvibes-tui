import { describe, test, expect } from 'bun:test';
import { bindMemoryModal, memoryModalGoldenSurface, type MemoryModalDeps } from '../../../panels/modals/memory-modal.ts';
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

const FIXED_CREATED_AT = 1735689600000; // 2025-01-01T00:00:00.000Z

function fixedDeps(): MemoryModalDeps {
  const records = [
    {
      id: 'mem-aaa1',
      scope: 'project',
      cls: 'decision',
      summary: 'Ship in batched waves.',
      detail: 'No per-change release tags.',
      tags: ['release'],
      reviewState: 'reviewed',
      confidence: 90,
      createdAt: FIXED_CREATED_AT,
      provenance: [{ kind: 'session', ref: 'sess-1' }],
    },
    {
      id: 'mem-bbb2',
      scope: 'session',
      cls: 'risk',
      summary: 'Modal mutations must route to commands.',
      tags: ['charter'],
      reviewState: 'stale',
      confidence: 35,
      staleReason: 'needs re-verification',
      createdAt: FIXED_CREATED_AT + 1000,
      provenance: [],
    },
  ];
  return {
    memoryRegistry: {
      search: () => records,
      reviewQueue: () => records.filter((r) => r.reviewState !== 'reviewed'),
    },
  };
}

describe('memory modal builder', () => {
  test('unconfigured registry renders the honest "not configured" empty state', () => {
    const surface = bindMemoryModal({});
    surface.refresh();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('Memory registry not configured for this session.');
    expect(text).toContain('not wired with a project memory registry at bootstrap');
    expect(surface.rowIds(EMPTY_VIEW)).toHaveLength(0);
  });

  test('all mode lists records with counts and selected detail', () => {
    const surface = bindMemoryModal(fixedDeps());
    surface.refresh();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('records 2  review queue 1');
    expect(text).toContain('Ship in batched waves.');
    expect(text).toContain('Modal mutations must route to commands.');
    expect(text).toContain('provenance: session:sess-1');
    expect(surface.rowIds(EMPTY_VIEW)).toEqual(['mem-aaa1', 'mem-bbb2']);
  });

  test('search filters records by summary/detail/class/scope/tags', () => {
    const surface = bindMemoryModal(fixedDeps());
    surface.refresh();
    const text = configText(surface.buildConfig({ ...EMPTY_VIEW, query: 'charter' }));
    expect(text).toContain('Modal mutations must route to commands.');
    expect(text).not.toContain('Ship in batched waves.');
  });

  test('tab toggles to the review queue (stale record only)', () => {
    const surface = bindMemoryModal(fixedDeps());
    surface.refresh();
    expect(surface.actions.toggleMode!(EMPTY_VIEW)).toEqual({ kind: 'refresh' });
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('Review Queue');
    expect(surface.rowIds(EMPTY_VIEW)).toEqual(['mem-bbb2']);
  });

  test('review actions route to /recall review with computed confidence (no direct registry mutation)', () => {
    const surface = bindMemoryModal(fixedDeps());
    surface.refresh();
    surface.actions.toggleMode!(EMPTY_VIEW); // -> review mode, selects mem-bbb2 (confidence 35)
    expect(surface.actions.markReviewed!(EMPTY_VIEW)).toEqual({
      kind: 'runCommand',
      command: '/recall review mem-bbb2 reviewed --confidence 85 --by operator',
    });
    expect(surface.actions.markStale!(EMPTY_VIEW)).toEqual({
      kind: 'runCommand',
      command: '/recall review mem-bbb2 stale --confidence 35 --by operator --reason "marked stale from the memory panel"',
    });
    expect(surface.actions.markContradicted!(EMPTY_VIEW)).toEqual({
      kind: 'runCommand',
      command: '/recall review mem-bbb2 contradicted --confidence 0 --by operator --reason "marked contradicted from the memory panel"',
    });
  });

  test('delete routes to /recall remove', () => {
    const surface = bindMemoryModal(fixedDeps());
    surface.refresh();
    expect(surface.actions.remove!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/recall remove mem-aaa1' });
  });

  test('golden surface renders a deterministic byte-stable config across two calls', () => {
    const a = configText(memoryModalGoldenSurface().buildConfig(EMPTY_VIEW));
    const b = configText(memoryModalGoldenSurface().buildConfig(EMPTY_VIEW));
    expect(a).toBe(b);
    expect(a).toContain('Wave-6 batches panel retirements');
  });
});
