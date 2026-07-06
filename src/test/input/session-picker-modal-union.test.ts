/**
 * session-picker-modal-union.test.ts — W3-T2 union-sessions surface.
 *
 * Verifies SessionPickerModal (when constructed with a sessionBroker) and its
 * renderer honestly surface the cross-surface session union alongside the
 * unchanged local saved-session list:
 *  (1) lists cross-surface (non-tui) sessions when adopted + online.
 *  (2) offline union -> honest offline note + local-only rows (never an
 *      empty list, never a silent lie).
 *  (3) stale union (aged past the freshness window) -> stale note rendered.
 *  (4) closed session shown as 'closed'; unknown kind rendered verbatim.
 *
 * Drives the real SessionUnionCache (the SDK's SessionReadFacade
 * implementation) with fake local/wire readers — same style as
 * src/test/runtime/session-union-cache.test.ts — so this is real facade
 * behavior, not a hand-rolled stand-in.
 */
import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import type { SharedSessionRecord } from '@pellux/goodvibes-sdk/platform/control-plane';
import { SessionUnionCache, type LocalSessionReader, type WireSessionReader } from '@pellux/goodvibes-sdk/platform/runtime/session-spine';
import { SessionPickerModal } from '../../input/session-picker-modal.ts';
import { renderSessionPickerModal } from '../../renderer/session-picker-modal.ts';
import { linesToText } from '../setup.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

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

function localReader(rows: SharedSessionRecord[]): LocalSessionReader {
  return {
    listSessions: (limit?: number) => (typeof limit === 'number' ? rows.slice(0, limit) : rows),
    getSession: (id: string) => rows.find((r) => r.id === id) ?? null,
  };
}

function wireReader(behavior: { rows?: readonly SharedSessionRecord[]; reject?: boolean }): WireSessionReader {
  return {
    list: async () => {
      if (behavior.reject) throw new Error('daemon unreachable');
      return behavior.rows ?? [];
    },
  };
}

const noopScheduler = {
  setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
  clearInterval: () => {},
};
const silent = { debug: () => {} };

function makeSessionManager(): { sessionManager: SessionManager; dir: string } {
  const dir = makeProjectTempDir('gv-sess-picker-union-test');
  return { sessionManager: new SessionManager(dir, { surfaceRoot: 'tui' }), dir };
}

describe('SessionPickerModal — cross-surface union (W3-T2)', () => {
  test('backward compatible: no sessionBroker -> mode stays local, no cross-surface claim', () => {
    const { sessionManager, dir } = makeSessionManager();
    try {
      const modal = new SessionPickerModal(sessionManager);
      modal.open();
      expect(modal.crossSurfaceView.mode).toBe('local');
      expect(modal.crossSurfaceSessions).toEqual([]);
      const lines = renderSessionPickerModal(modal, 100);
      expect(linesToText(lines).join('\n')).not.toContain('Cross-surface sessions');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(1) adopted + online: lists cross-surface (non-tui) sessions in the union', async () => {
    const { sessionManager, dir } = makeSessionManager();
    try {
      const local = localReader([record('local-1')]);
      const wire = wireReader({ rows: [record('webui-1', { kind: 'webui', title: 'From webui' })] });
      const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
      cache.activate(wire);
      await cache.refresh();

      const modal = new SessionPickerModal(sessionManager, cache);
      modal.open();

      expect(modal.crossSurfaceView.mode).toBe('adopted');
      expect(modal.crossSurfaceView.online).toBe(true);
      const ids = modal.crossSurfaceSessions.map((r) => r.id).sort();
      expect(ids).toEqual(['local-1', 'webui-1']);

      const text = linesToText(renderSessionPickerModal(modal, 100)).join('\n');
      expect(text).toContain('Cross-surface sessions');
      expect(text).toContain('From webui');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(2) adopted + offline: honest offline note + local-only rows, never empty, never a lie', async () => {
    const { sessionManager, dir } = makeSessionManager();
    try {
      const local = localReader([record('local-1')]);
      const wire = wireReader({ reject: true });
      const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
      cache.activate(wire); // refresh kicked internally; await once more to settle deterministically
      await cache.refresh();

      const modal = new SessionPickerModal(sessionManager, cache);
      modal.open();

      expect(modal.crossSurfaceView.online).toBe(false);
      expect(modal.crossSurfaceView.offlineNote).toBe('cross-surface view offline');
      // Never an empty list on offline — local rows are still honestly served.
      expect(modal.crossSurfaceSessions.map((r) => r.id)).toEqual(['local-1']);

      const text = linesToText(renderSessionPickerModal(modal, 100)).join('\n');
      expect(text).toContain('cross-surface view offline');
      expect(text).toContain('showing local sessions only');
      expect(text).toContain('local-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(3) adopted + online but aged past the freshness window: renders the stale note', async () => {
    const { sessionManager, dir } = makeSessionManager();
    try {
      const wire = wireReader({ rows: [record('wire-1')] });
      // Real Date.now() clock (default) with a staleAfterMs of 0: any time that
      // elapses between the refresh settling and the crossSurfaceView read
      // (guaranteed > 0ms, since both are separate async ticks) reads as aged,
      // while `online` stays true — the exact "confirmed live, but old" state
      // the note exists for. The renderer computes elapsed time off the real
      // wall clock (lastSyncAt is a real epoch ms), so assert the note's SHAPE
      // rather than an exact age to avoid timing flakiness.
      const cache = new SessionUnionCache({
        local: localReader([]),
        staleAfterMs: 0,
        scheduler: noopScheduler,
        log: silent,
      });
      cache.activate(wire);
      await cache.refresh();
      // Guarantee real elapsed time > 0ms before reading crossSurfaceView so
      // `aged` (now() - lastSyncAt > staleAfterMs) is deterministically true.
      await new Promise((resolve) => setTimeout(resolve, 5));

      const modal = new SessionPickerModal(sessionManager, cache);
      modal.open();

      expect(modal.crossSurfaceView.online).toBe(true);
      expect(modal.crossSurfaceView.stale).toBe(true);

      const text = linesToText(renderSessionPickerModal(modal, 100)).join('\n');
      expect(text).toMatch(/Union view may be stale, last synced \d+s ago/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(4) closed session badged "closed"; unknown kind rendered verbatim (parity with webui)', async () => {
    const { sessionManager, dir } = makeSessionManager();
    try {
      const local = localReader([
        record('closed-1', { status: 'closed', title: 'Closed session' }),
        record('mystery-1', { kind: 'from-the-future' as SharedSessionRecord['kind'], title: 'Mystery kind' }),
      ]);
      const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
      cache.markEmbedded();

      const modal = new SessionPickerModal(sessionManager, cache);
      modal.open();

      const text = linesToText(renderSessionPickerModal(modal, 100)).join('\n');
      expect(text).toContain('Closed session');
      expect(text).toContain('closed');
      expect(text).toContain('Mystery kind');
      // The unknown kind must be shown verbatim, not dropped or replaced.
      expect(text).toContain('from-the-future');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('true-empty state: embedded mode with no sessions reads "No sessions yet.", not a silent blank', () => {
    const { sessionManager, dir } = makeSessionManager();
    try {
      const cache = new SessionUnionCache({ local: localReader([]), scheduler: noopScheduler, log: silent });
      cache.markEmbedded();
      const modal = new SessionPickerModal(sessionManager, cache);
      modal.open();

      const text = linesToText(renderSessionPickerModal(modal, 100)).join('\n');
      expect(text).toContain('No sessions yet.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
