// ---------------------------------------------------------------------------
// workstream-draft-store.test.ts — durable draft journal
//
// Covers the TUI-side draft persistence (runtime/workstream-draft-store.ts):
// save/load round-trip, remove, and the never-throw guards on a missing
// directory / malformed file / unsafe id.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkstreamDraft } from '../../runtime/workstream-services.ts';
import { createWorkstreamDraftStore } from '../../runtime/workstream-draft-store.ts';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});
function scratchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-draft-store-'));
  tempDirs.push(dir);
  return dir;
}

function makeDraft(id: string, createdAt: number): WorkstreamDraft {
  return {
    id,
    task: `task for ${id}`,
    spec: {
      title: id,
      phases: [{ role: 'engineer', capacity: 1, kind: 'engineer', gate: { scope: 'scoped', gates: [] } }],
      items: [{ id: `${id}-item`, title: 'do it', task: 'do it' }],
    },
    gate: { decompose: false, strategy: 'single', reasonCode: 'AUTO_FALLBACK_SINGLE' },
    proposal: { id: 'pp', task: id, strategy: 'cohort', rationale: '', phases: [], workItems: [], createdAt, source: 'single-item-fallback' },
    provenance: { kind: 'heuristic-configured', itemCount: 1 },
    approved: false,
    createdAt,
  };
}

describe('workstream-draft-store', () => {
  test('save then loadAll round-trips a draft losslessly', () => {
    const root = scratchRoot();
    const store = createWorkstreamDraftStore(root);
    const draft = makeDraft('wsd_aaa', 1000);
    store.save(draft);

    const loaded = createWorkstreamDraftStore(root).loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(draft);
  });

  test('loadAll returns drafts oldest-first', () => {
    const root = scratchRoot();
    const store = createWorkstreamDraftStore(root);
    store.save(makeDraft('wsd_new', 2000));
    store.save(makeDraft('wsd_old', 1000));
    expect(createWorkstreamDraftStore(root).loadAll().map((d) => d.id)).toEqual(['wsd_old', 'wsd_new']);
  });

  test('remove deletes a draft snapshot', () => {
    const root = scratchRoot();
    const store = createWorkstreamDraftStore(root);
    store.save(makeDraft('wsd_gone', 1));
    store.remove('wsd_gone');
    expect(store.loadAll()).toHaveLength(0);
  });

  test('loadAll on a never-created directory returns [] without throwing', () => {
    const store = createWorkstreamDraftStore(join(scratchRoot(), 'does-not-exist-yet'));
    expect(store.loadAll()).toEqual([]);
  });

  test('a malformed snapshot file is skipped, not fatal', () => {
    const root = scratchRoot();
    const store = createWorkstreamDraftStore(root);
    store.save(makeDraft('wsd_good', 1));
    const dir = join(root, '.goodvibes', 'orchestration', 'drafts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'wsd_bad.json'), '{ not valid json', 'utf8');
    writeFileSync(join(dir, 'wsd_wrongshape.json'), JSON.stringify({ id: 'x' }), 'utf8');

    const loaded = store.loadAll();
    expect(loaded.map((d) => d.id)).toEqual(['wsd_good']);
  });

  test('an unsafe draft id is never written to disk', () => {
    const root = scratchRoot();
    const store = createWorkstreamDraftStore(root);
    store.save(makeDraft('../escape', 1));
    let files: string[] = [];
    try {
      files = readdirSync(join(root, '.goodvibes', 'orchestration', 'drafts'));
    } catch {
      files = [];
    }
    expect(files).toHaveLength(0);
  });
});
