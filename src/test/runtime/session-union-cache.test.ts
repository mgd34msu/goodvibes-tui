/**
 * session-union-cache.test.ts
 *
 * Unit evidence for the cross-surface read facade. Drives the facade with a
 * fake sync local reader + a fake async wire reader (no real daemon here, the
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
  deriveSpineFooterStatus,
  type LocalSessionReader,
  type SessionReadFacade,
  type WireSessionReader,
} from '@pellux/goodvibes-sdk/platform/runtime/session-spine';

describe('deriveSpineFooterStatus (offline within one union-probe interval)', () => {
  test('not adopted: falls back to the spine client status', () => {
    expect(deriveSpineFooterStatus('online', { mode: 'local', online: false, lastSyncAt: null })).toBe('online');
    expect(deriveSpineFooterStatus('unknown', { mode: 'embedded', online: false, lastSyncAt: null })).toBe('unknown');
  });
  test('adopted, never synced yet: falls back to the spine client status', () => {
    expect(deriveSpineFooterStatus('online', { mode: 'adopted', online: false, lastSyncAt: null })).toBe('online');
  });
  test('adopted + confirmed once + probe now failing: reads offline even if the spine client still says online', () => {
    // The exact bug: daemon died mid-idle, spine client is activity-gated 'online',
    // but the 5s union probe has failed -> footer must say offline.
    expect(deriveSpineFooterStatus('online', { mode: 'adopted', online: false, lastSyncAt: 1_000 })).toBe('offline');
  });
  test('adopted + probe succeeding: reads online (and recovers from a prior offline)', () => {
    expect(deriveSpineFooterStatus('offline', { mode: 'adopted', online: true, lastSyncAt: 2_000 })).toBe('online');
  });
});

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

// A no-op scheduler so activate() never starts a real interval, tests drive
// refresh() deterministically.
const noopScheduler = {
  setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
  clearInterval: () => {},
};

const silent = { debug: () => {} };

describe('SessionUnionCache: honest cross-surface read facade', () => {
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
    await cache.refresh(); // one good sync, cache now holds wire-1

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

  test('onTransition (D4b): fires exactly on a genuine online/offline flip, never on a repeat of the same state', async () => {
    const wire = wireReader({ rows: [record('wire-1')] });
    const cache = new SessionUnionCache({ local: localReader([]), scheduler: noopScheduler, log: silent });
    const transitions: boolean[] = [];
    cache.setOnTransition((online) => transitions.push(online));

    cache.activate(wire.reader); // kicks the first probe internally
    await cache.refresh(); // the in-flight guard collapses this into that SAME first probe: false -> true
    expect(transitions).toEqual([true]);

    await cache.refresh(); // still online: no repeat firing
    expect(transitions).toEqual([true]);

    wire.set({ reject: true });
    await cache.refresh(); // daemon dies mid-idle: true -> false
    expect(transitions).toEqual([true, false]);

    await cache.refresh(); // still offline: no repeat firing
    expect(transitions).toEqual([true, false]);

    wire.set({ rows: [record('wire-1')] });
    await cache.refresh(); // reconnect: false -> true again, stays prompt
    expect(transitions).toEqual([true, false, true]);
  });

  test('refresh() in-flight guard: overlapping calls collapse into the same pending probe (no double-fire)', async () => {
    let listCalls = 0;
    let releaseFirst: (() => void) | null = null;
    const held: WireSessionReader = {
      list: () => new Promise<readonly SharedSessionRecord[]>((resolve) => {
        listCalls += 1;
        releaseFirst = () => resolve([record('wire-1')]);
      }),
    };
    const cache = new SessionUnionCache({ local: localReader([]), scheduler: noopScheduler, log: silent });
    const transitions: boolean[] = [];
    cache.setOnTransition((online) => transitions.push(online));

    cache.activate(held); // kicks refresh() #1, which hangs on the wire until released
    const overlap = cache.refresh(); // refresh() #2, fired while #1 is still pending
    expect(listCalls).toBe(1); // the guard collapsed #2 into #1's SAME in-flight wire call

    releaseFirst!();
    await overlap;
    expect(transitions).toEqual([true]); // exactly one transition, not two
  });

  test('probeTimeoutMs (D4b): a hung wire call bounds refresh() to ~1 probe interval instead of an indefinite wait', async () => {
    let capturedTimeoutFn: (() => void) | null = null;
    const scheduler = {
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
      setTimeout: (fn: () => void) => {
        capturedTimeoutFn = fn;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {},
    };
    // Confirmed online first (an already-adopted, healthy daemon), THEN the wire
    // goes silent, the exact "daemon died mid-idle, socket never errors" case.
    let hang = false;
    const wire: WireSessionReader = {
      list: () => (hang ? new Promise<readonly SharedSessionRecord[]>(() => {}) : Promise.resolve([record('wire-1')])),
    };
    const cache = new SessionUnionCache({ local: localReader([record('local-1')]), scheduler, log: silent });
    const transitions: boolean[] = [];
    cache.setOnTransition((online) => transitions.push(online));

    cache.activate(wire); // first probe resolves promptly: false -> true
    await cache.refresh(); // collapses into (or observes the completion of) that same probe
    expect(cache.crossSurfaceView.online).toBe(true);
    expect(transitions).toEqual([true]);

    hang = true; // the daemon "dies" leaving a stale connection that never responds
    const pending = cache.refresh();
    expect(capturedTimeoutFn).not.toBeNull(); // the bounded probe registered its timeout

    // Simulate the probe-timeout elapsing before the wire ever responds, this is
    // the one-to-two-probe-interval bound, not a real multi-minute OS-level wait.
    capturedTimeoutFn!();
    await pending;

    expect(cache.crossSurfaceView.online).toBe(false); // degraded honestly, no indefinite hang
    expect(cache.crossSurfaceView.offlineNote).toBe('cross-surface view offline');
    expect(transitions).toEqual([true, false]); // and the flip was reported to the subscriber (-> requestRender)
  });

  describe('generation guard: a superseded reader can never write back after activate()/deactivate() moves on', () => {
    /**
     * Let every pending microtask (the .then chain inside raceWithProbeTimeout
     * plus the awaiting performRefresh) drain before asserting on state that a
     * late, manually-released promise settlement would (or, post-fix, would
     * not) have written. A macrotask boundary (real setTimeout) is used rather
     * than counting `await Promise.resolve()` hops, since the exact microtask
     * depth of a manually-driven Promise chain is an implementation detail.
     */
    function flushMicrotasks(): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, 0));
    }

    /** A wire reader whose list() call hangs until release() is invoked. */
    function heldReader(): { reader: WireSessionReader; release: (result: { rows?: readonly SharedSessionRecord[]; reject?: boolean }) => void } {
      let settle: ((result: { rows?: readonly SharedSessionRecord[]; reject?: boolean }) => void) | null = null;
      return {
        reader: {
          list: () =>
            new Promise<readonly SharedSessionRecord[]>((resolve, reject) => {
              settle = (result) => (result.reject ? reject(new Error('daemon unreachable')) : resolve(result.rows ?? []));
            }),
        },
        release: (result) => settle!(result),
      };
    }

    test('late timeout from a pre-activate() probe writes nothing and fires no transition, even though readerB already went online', async () => {
      const readerA = heldReader();
      const readerB = wireReader({ rows: [record('b-1')] });
      const cache = new SessionUnionCache({ local: localReader([]), scheduler: noopScheduler, log: silent });
      const transitions: boolean[] = [];
      cache.setOnTransition((online) => transitions.push(online));

      cache.activate(readerA.reader); // kicks readerA's probe (gen 1), left hanging
      cache.activate(readerB.reader); // external baseUrl change: gen 2, readerB adopted while A still in flight
      await cache.refresh(); // collapses into (or observes) readerB's own probe: false -> true
      expect(cache.crossSurfaceView.online).toBe(true);
      expect(cache.crossSurfaceView.lastSyncAt).not.toBeNull();
      expect(transitions).toEqual([true]);

      // readerA's stale probe finally times out (simulated as a rejection settling late).
      readerA.release({ reject: true });
      await flushMicrotasks(); // let readerA's stale settlement (post-fix: a no-op) drain

      // Nothing from readerA's late settlement should have been written back:
      // still online, still readerB's rows, no extra transition fired.
      expect(cache.crossSurfaceView.online).toBe(true);
      expect(cache.listSessions().map((r) => r.id)).toEqual(['b-1']);
      expect(transitions).toEqual([true]); // no phantom false flip
    });

    test('late success with stale rows from a pre-activate() probe does not overwrite readerB\'s fresh cache', async () => {
      const readerA = heldReader();
      const readerB = wireReader({ rows: [record('b-1')] });
      const cache = new SessionUnionCache({ local: localReader([]), scheduler: noopScheduler, log: silent });
      const transitions: boolean[] = [];
      cache.setOnTransition((online) => transitions.push(online));

      cache.activate(readerA.reader); // gen 1, left hanging
      cache.activate(readerB.reader); // gen 2, adopted while A still in flight
      await cache.refresh(); // readerB's probe: false -> true
      expect(cache.listSessions().map((r) => r.id)).toEqual(['b-1']);
      expect(transitions).toEqual([true]);

      // readerA's stale probe finally resolves successfully with OLD rows.
      readerA.release({ rows: [record('a-1', { title: 'stale' })] });
      await flushMicrotasks();

      // readerB's fresh cache must survive untouched; readerA's stale row must never appear.
      expect(cache.listSessions().map((r) => r.id)).toEqual(['b-1']);
      expect(transitions).toEqual([true]); // no repeat/extra transition from the discarded settlement
    });

    test('deactivate() mid-probe invalidates the write-back: a late-resolving probe from before deactivation writes nothing', async () => {
      const readerA = heldReader();
      const cache = new SessionUnionCache({ local: localReader([record('local-1')]), scheduler: noopScheduler, log: silent });
      const transitions: boolean[] = [];
      cache.setOnTransition((online) => transitions.push(online));

      cache.activate(readerA.reader); // gen 1, probe left hanging
      cache.deactivate('daemon mode changed'); // gen 2, back to local before the probe ever settled
      expect(cache.getMode()).toBe('local');

      readerA.release({ rows: [record('wire-1')] }); // the stale probe resolves after the fact
      await flushMicrotasks();

      // Still local/dormant, no cross-surface claim, no phantom transition.
      expect(cache.getMode()).toBe('local');
      expect(cache.listSessions().map((r) => r.id)).toEqual(['local-1']);
      expect(cache.crossSurfaceView).toEqual({ mode: 'local', online: false, stale: false, lastSyncAt: null, offlineNote: null });
      expect(transitions).toEqual([]);
    });

    test('normal single-adoption refresh is unaffected by the generation guard', async () => {
      const local = localReader([record('local-1')]);
      const wire = wireReader({ rows: [record('wire-1')] });
      let clock = 1_000;
      const cache = new SessionUnionCache({ local, now: () => clock, scheduler: noopScheduler, log: silent });
      const transitions: boolean[] = [];
      cache.setOnTransition((online) => transitions.push(online));

      cache.activate(wire.reader);
      await cache.refresh();
      expect(cache.crossSurfaceView).toMatchObject({ mode: 'adopted', online: true, stale: false, lastSyncAt: 1_000 });
      expect(cache.listSessions().map((r) => r.id).sort()).toEqual(['local-1', 'wire-1']);
      expect(transitions).toEqual([true]);

      clock = 2_000;
      wire.set({ reject: true });
      await cache.refresh();
      expect(cache.crossSurfaceView.online).toBe(false);
      expect(transitions).toEqual([true, false]);
    });
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
