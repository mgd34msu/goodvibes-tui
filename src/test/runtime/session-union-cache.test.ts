/**
 * session-union-cache.test.ts
 *
 * S3d unit evidence for the cross-surface read facade. Drives the facade with a
 * fake sync local reader + a fake async wire reader (no real daemon here — the
 * daemon-integration test covers the real wire) to prove the honesty contract:
 *  - embedded/local passthrough,
 *  - adopted-online union (deduped, local wins),
 *  - adopted-offline degrades to local-only rows + an honest offline note with
 *    NO phantom wire rows and a `stale` flag,
 *  - a panel-consumer stand-in renders exactly what a panel would.
 */
import { describe, expect, test } from 'bun:test';
import type { SharedSessionRecord } from '@pellux/goodvibes-sdk/platform/control-plane';
import {
  SessionUnionCache,
  type LocalSessionReader,
  type SessionReadFacade,
  type WireSessionReader,
} from '../../runtime/session-union-cache.ts';

function record(id: string, over: Partial<SharedSessionRecord> = {}): SharedSessionRecord {
  return {
    id,
    kind: 'tui',
    project: '/proj',
    title: id,
    status: 'active',
    createdAt: 1_000,
    updatedAt: 1_000,
    participants: [],
    ...over,
  } as SharedSessionRecord;
}

/** A fake in-process broker read source. */
function localReader(rows: SharedSessionRecord[]): LocalSessionReader {
  return {
    listSessions: (limit?: number) => (typeof limit === 'number' ? rows.slice(0, limit) : rows),
    getSession: (id: string) => rows.find((r) => r.id === id) ?? null,
  };
}

/** A wire reader whose behavior is controlled per call (resolve rows, or reject). */
function wireReader(behavior: { rows?: readonly SharedSessionRecord[]; reject?: boolean }): {
  reader: WireSessionReader;
  set: (next: { rows?: readonly SharedSessionRecord[]; reject?: boolean }) => void;
} {
  let state = behavior;
  return {
    reader: {
      list: async () => {
        if (state.reject) throw new Error('daemon unreachable');
        return state.rows ?? [];
      },
    },
    set: (next) => { state = next; },
  };
}

// A no-op scheduler so activate() never starts a real interval — tests drive
// refresh() deterministically.
const noopScheduler = {
  setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
  clearInterval: () => {},
};

const silent = { debug: () => {} };

describe('SessionUnionCache — honest cross-surface read facade', () => {
  test('local/dormant mode: pure passthrough, no cross-surface claim', () => {
    const cache = new SessionUnionCache({ local: localReader([record('local-1')]), scheduler: noopScheduler, log: silent });
    expect(cache.getMode()).toBe('local');
    expect(cache.listSessions().map((r) => r.id)).toEqual(['local-1']);
    expect(cache.crossSurfaceView).toEqual({ mode: 'local', online: false, stale: false, lastSyncAt: null, offlineNote: null });
  });

  test('embedded mode: passthrough to the local broker (it IS the truth), no offline note', () => {
    const cache = new SessionUnionCache({ local: localReader([record('local-1'), record('local-2')]), scheduler: noopScheduler, log: silent });
    cache.markEmbedded();
    expect(cache.getMode()).toBe('embedded');
    expect(cache.listSessions().map((r) => r.id).sort()).toEqual(['local-1', 'local-2']);
    expect(cache.crossSurfaceView.offlineNote).toBeNull();
    expect(cache.crossSurfaceView.online).toBe(false);
    expect(cache.crossSurfaceView.stale).toBe(false);
  });

  test('adopted-online: serves the deduped union, local wins for its own id', async () => {
    const local = localReader([record('shared-1', { title: 'local-title' }), record('local-only')]);
    const wire = wireReader({ rows: [record('shared-1', { title: 'wire-title' }), record('wire-only')] });
    let clock = 5_000;
    const cache = new SessionUnionCache({ local, now: () => clock, scheduler: noopScheduler, log: silent });
    cache.activate(wire.reader);
    await cache.refresh();

    const union = cache.listSessions();
    expect(union.map((r) => r.id).sort()).toEqual(['local-only', 'shared-1', 'wire-only']);
    // Local wins the dedupe for the shared id.
    expect(union.find((r) => r.id === 'shared-1')?.title).toBe('local-title');
    // getSession falls through to the wire cache for wire-only ids.
    expect(cache.getSession('wire-only')?.id).toBe('wire-only');
    expect(cache.getSession('local-only')?.id).toBe('local-only');

    const view = cache.crossSurfaceView;
    expect(view).toMatchObject({ mode: 'adopted', online: true, stale: false, lastSyncAt: 5_000, offlineNote: null });
  });

  test('adopted-offline (daemon down): local-only rows + honest note, NO phantom wire rows, stale flag set', async () => {
    const local = localReader([record('local-1')]);
    const wire = wireReader({ rows: [record('wire-1')] });
    const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
    cache.activate(wire.reader);
    await cache.refresh(); // one good sync — cache now holds wire-1

    expect(cache.listSessions().map((r) => r.id).sort()).toEqual(['local-1', 'wire-1']);

    // Daemon dies mid-session: next refresh rejects.
    wire.set({ reject: true });
    await cache.refresh();

    const rows = cache.listSessions().map((r) => r.id);
    expect(rows).toEqual(['local-1']); // NO phantom 'wire-1' presented as live
    expect(cache.getSession('wire-1')).toBeNull(); // and no stale getSession hit
    const view = cache.crossSurfaceView;
    expect(view.online).toBe(false);
    expect(view.stale).toBe(true);
    expect(view.offlineNote).toBe('cross-surface view offline');
  });

  test('adopted-but-never-synced: honest until first success (local-only + note, stale)', () => {
    const local = localReader([record('local-1')]);
    const wire = wireReader({ rows: [record('wire-1')] });
    const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
    cache.activate(wire.reader); // refresh() kicked but not awaited here
    expect(cache.listSessions().map((r) => r.id)).toEqual(['local-1']);
    expect(cache.crossSurfaceView.offlineNote).toBe('cross-surface view offline');
    expect(cache.crossSurfaceView.stale).toBe(true);
  });

  test('staleness by age: online but past the freshness window reads stale', async () => {
    const wire = wireReader({ rows: [record('wire-1')] });
    let clock = 0;
    const cache = new SessionUnionCache({ local: localReader([]), now: () => clock, staleAfterMs: 1_000, scheduler: noopScheduler, log: silent });
    cache.activate(wire.reader);
    clock = 10_000;
    await cache.refresh();
    expect(cache.crossSurfaceView.stale).toBe(false); // just synced at t=10_000
    clock = 12_000; // 2s later, past the 1s window
    expect(cache.crossSurfaceView.stale).toBe(true);
    expect(cache.crossSurfaceView.online).toBe(true); // still nominally online, just aged
  });

  test('deactivate/markEmbedded drop the wire union and return to passthrough honesty', async () => {
    const wire = wireReader({ rows: [record('wire-1')] });
    const cache = new SessionUnionCache({ local: localReader([record('local-1')]), scheduler: noopScheduler, log: silent });
    cache.activate(wire.reader);
    await cache.refresh();
    expect(cache.listSessions().length).toBe(2);
    cache.deactivate('daemon mode changed');
    expect(cache.getMode()).toBe('local');
    expect(cache.listSessions().map((r) => r.id)).toEqual(['local-1']);
    expect(cache.crossSurfaceView.offlineNote).toBeNull();
  });

  test('panel-consumer stand-in: renders union rows online, and local rows + offline note when down', async () => {
    // A minimal render exactly as a control-plane panel would: read the sync
    // listSessions() surface + the crossSurfaceView note off the facade type.
    function renderPanel(facade: SessionReadFacade): { ids: string[]; note: string | null } {
      return { ids: facade.listSessions().map((r) => r.id).sort(), note: facade.crossSurfaceView.offlineNote };
    }
    const local = localReader([record('local-1')]);
    const wire = wireReader({ rows: [record('wire-1')] });
    const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
    cache.activate(wire.reader);
    await cache.refresh();
    expect(renderPanel(cache)).toEqual({ ids: ['local-1', 'wire-1'], note: null });

    wire.set({ reject: true });
    await cache.refresh();
    expect(renderPanel(cache)).toEqual({ ids: ['local-1'], note: 'cross-surface view offline' });
  });
});
