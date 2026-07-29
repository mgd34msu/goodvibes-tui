// ---------------------------------------------------------------------------
// workstream-draft-store.test.ts — durable draft journal
//
// Covers the TUI-side draft persistence (runtime/workstream-draft-store.ts):
// save/load round-trip, remove, the never-throw guards on a missing directory /
// malformed file / unsafe id, and the reclaim bounds (age TTL + count cap) that
// keep abandoned proposals from accumulating forever.
//
// NOTE ON FIXTURE TIMESTAMPS: drafts are reaped by age, so fixtures use
// timestamps relative to now. A literal like `createdAt: 1000` is 1970 and
// would (correctly) be reclaimed on the spot.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkstreamDraft } from '../../runtime/workstream-services.ts';
import {
  WORKSTREAM_DRAFT_CAP,
  WORKSTREAM_DRAFT_TTL_MS,
  createWorkstreamDraftStore,
  formatWorkstreamDraftReclaim,
  type WorkstreamDraftReclaim,
} from '../../runtime/workstream-draft-store.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const NOW = Date.now();
/** A draft age that is comfortably inside the retention window. */
const RECENT = NOW - 60_000;
/** A draft age that is comfortably past it. */
const ABANDONED = NOW - (WORKSTREAM_DRAFT_TTL_MS + 60_000);

function draftsDir(root: string): string {
  return join(root, '.goodvibes', 'orchestration', 'drafts');
}

function listDraftFiles(root: string): string[] {
  try {
    return readdirSync(draftsDir(root)).sort();
  } catch {
    return [];
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});
function scratchRoot(): string {
  const dir = makeProjectTempDir('gv-draft-store');
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
    const draft = makeDraft('wsd_aaa', RECENT);
    store.save(draft);

    const loaded = createWorkstreamDraftStore(root).loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(draft);
  });

  test('loadAll returns drafts oldest-first', () => {
    const root = scratchRoot();
    const store = createWorkstreamDraftStore(root);
    store.save(makeDraft('wsd_new', RECENT + 1000));
    store.save(makeDraft('wsd_old', RECENT));
    expect(createWorkstreamDraftStore(root).loadAll().map((d) => d.id)).toEqual(['wsd_old', 'wsd_new']);
  });

  test('remove deletes a draft snapshot', () => {
    const root = scratchRoot();
    const store = createWorkstreamDraftStore(root);
    store.save(makeDraft('wsd_gone', RECENT));
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
    store.save(makeDraft('wsd_good', RECENT));
    const dir = draftsDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'wsd_bad.json'), '{ not valid json', 'utf8');
    writeFileSync(join(dir, 'wsd_wrongshape.json'), JSON.stringify({ id: 'x' }), 'utf8');

    const loaded = store.loadAll();
    expect(loaded.map((d) => d.id)).toEqual(['wsd_good']);
    // A freshly-written malformed file may still be mid-write by another
    // process, so it is skipped but NOT deleted, and nothing is reclaimed.
    expect(listDraftFiles(root)).toHaveLength(3);
    expect(store.lastReclaim).toBeNull();
  });

  test('an unsafe draft id is never written to disk', () => {
    const root = scratchRoot();
    const store = createWorkstreamDraftStore(root);
    store.save(makeDraft('../escape', RECENT));
    expect(listDraftFiles(root)).toHaveLength(0);
  });

  test('a zero-byte snapshot is rejected rather than served', () => {
    const root = scratchRoot();
    const store = createWorkstreamDraftStore(root);
    store.save(makeDraft('wsd_good', RECENT));
    mkdirSync(draftsDir(root), { recursive: true });
    writeFileSync(join(draftsDir(root), 'wsd_torn.json'), '', 'utf8');

    expect(store.loadAll().map((d) => d.id)).toEqual(['wsd_good']);
  });
});

describe('workstream-draft-store reclaim bounds', () => {
  test('an abandoned draft is reaped by the TTL while a fresh one survives', () => {
    const root = scratchRoot();
    const reclaims: WorkstreamDraftReclaim[] = [];
    const store = createWorkstreamDraftStore(root, { onReclaim: (summary) => reclaims.push(summary) });
    store.save(makeDraft('wsd_fresh', RECENT));
    store.save(makeDraft('wsd_abandoned', ABANDONED));

    expect(store.loadAll().map((d) => d.id)).toEqual(['wsd_fresh']);
    // Reaped from disk, not merely filtered out of the returned list.
    expect(listDraftFiles(root)).toEqual(['wsd_fresh.json']);

    // Disclosure carries the right counts.
    expect(reclaims).toHaveLength(1);
    expect(reclaims[0]).toMatchObject({ expired: 1, overCap: 0, unreadable: 0 });
    expect(store.lastReclaim).toMatchObject({ expired: 1 });
    expect(formatWorkstreamDraftReclaim(store.lastReclaim!)).toBe(
      'Workstream drafts: reclaimed 1 abandoned draft file(s).',
    );
  });

  test('the count cap keeps the newest drafts and reclaims the oldest overflow', () => {
    const root = scratchRoot();
    const store = createWorkstreamDraftStore(root, { cap: 3 });
    for (let index = 0; index < 5; index += 1) {
      store.save(makeDraft(`wsd_${index}`, RECENT + index * 1000));
    }

    expect(store.loadAll().map((d) => d.id)).toEqual(['wsd_2', 'wsd_3', 'wsd_4']);
    expect(listDraftFiles(root)).toEqual(['wsd_2.json', 'wsd_3.json', 'wsd_4.json']);
    expect(store.lastReclaim).toMatchObject({ expired: 0, overCap: 2, unreadable: 0 });
  });

  test('the default cap is the documented constant', () => {
    // Guards against the cap quietly drifting: the bound is a stated number.
    expect(WORKSTREAM_DRAFT_CAP).toBe(50);
    expect(WORKSTREAM_DRAFT_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  test('reaping twice is a no-op the second time', () => {
    const root = scratchRoot();
    const reclaims: WorkstreamDraftReclaim[] = [];
    const store = createWorkstreamDraftStore(root, { onReclaim: (summary) => reclaims.push(summary) });
    store.save(makeDraft('wsd_fresh', RECENT));
    store.save(makeDraft('wsd_abandoned', ABANDONED));

    expect(store.loadAll()).toHaveLength(1);
    expect(reclaims).toHaveLength(1);

    expect(store.loadAll().map((d) => d.id)).toEqual(['wsd_fresh']);
    expect(reclaims).toHaveLength(1); // nothing further reclaimed
    expect(store.lastReclaim).toBeNull();
  });

  test('a second store over the same directory sees the same surviving set', () => {
    const root = scratchRoot();
    const first = createWorkstreamDraftStore(root);
    first.save(makeDraft('wsd_fresh', RECENT));
    first.save(makeDraft('wsd_abandoned', ABANDONED));
    expect(first.loadAll()).toHaveLength(1);

    // Concurrent/second process: the file is already gone; unlink races are
    // treated as success and the result converges.
    const second = createWorkstreamDraftStore(root);
    expect(second.loadAll().map((d) => d.id)).toEqual(['wsd_fresh']);
    expect(second.lastReclaim).toBeNull();
  });

  test('an unreadable snapshot older than the TTL is reclaimed and counted', () => {
    const root = scratchRoot();
    const store = createWorkstreamDraftStore(root);
    store.save(makeDraft('wsd_good', RECENT));
    const dir = draftsDir(root);
    const tornPath = join(dir, 'wsd_torn.json');
    writeFileSync(tornPath, '{"id":"wsd_torn","task":"half', 'utf8');
    const staleSeconds = (NOW - (WORKSTREAM_DRAFT_TTL_MS + 60_000)) / 1000;
    utimesSync(tornPath, staleSeconds, staleSeconds);
    expect(statSync(tornPath).mtimeMs).toBeLessThan(NOW - WORKSTREAM_DRAFT_TTL_MS);

    expect(store.loadAll().map((d) => d.id)).toEqual(['wsd_good']);
    expect(listDraftFiles(root)).toEqual(['wsd_good.json']);
    expect(store.lastReclaim).toMatchObject({ expired: 0, overCap: 0, unreadable: 1 });
  });

  test('save keeps reaping during a long session, not only at loadAll', () => {
    const root = scratchRoot();
    const reclaims: WorkstreamDraftReclaim[] = [];
    const store = createWorkstreamDraftStore(root, {
      cap: 2,
      sweepIntervalMs: 0, // reap on every save
      onReclaim: (summary) => reclaims.push(summary),
    });
    store.save(makeDraft('wsd_1', RECENT));
    store.save(makeDraft('wsd_2', RECENT + 1_000));
    expect(listDraftFiles(root)).toEqual(['wsd_1.json', 'wsd_2.json']);
    expect(reclaims).toHaveLength(0);

    // The third save trips the cap and reclaims the oldest with no loadAll in sight.
    store.save(makeDraft('wsd_3', RECENT + 2_000));
    expect(listDraftFiles(root)).toEqual(['wsd_2.json', 'wsd_3.json']);
    expect(reclaims).toHaveLength(1);
    expect(reclaims[0]).toMatchObject({ expired: 0, overCap: 1, unreadable: 0 });
  });

  test('the save-triggered reap is throttled, so saves stay cheap', () => {
    const root = scratchRoot();
    // Default 5-minute throttle: only the first save of the instance reaps, so
    // the cap overflow sits on disk until the next reap point.
    const store = createWorkstreamDraftStore(root, { cap: 2 });
    store.save(makeDraft('wsd_1', RECENT));
    store.save(makeDraft('wsd_2', RECENT + 1_000));
    store.save(makeDraft('wsd_3', RECENT + 2_000));
    expect(listDraftFiles(root)).toHaveLength(3);

    expect(store.loadAll().map((d) => d.id)).toEqual(['wsd_2', 'wsd_3']);
    expect(listDraftFiles(root)).toEqual(['wsd_2.json', 'wsd_3.json']);
  });

  test('a reclaim hook that throws cannot break loadAll', () => {
    const root = scratchRoot();
    const store = createWorkstreamDraftStore(root, {
      onReclaim: () => { throw new Error('hook exploded'); },
    });
    store.save(makeDraft('wsd_fresh', RECENT));
    store.save(makeDraft('wsd_abandoned', ABANDONED));
    expect(() => store.loadAll()).not.toThrow();
    expect(store.loadAll().map((d) => d.id)).toEqual(['wsd_fresh']);
  });
});
