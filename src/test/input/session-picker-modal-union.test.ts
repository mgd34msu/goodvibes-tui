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

  test('(5) idle-reaped closed session badged "reaped", distinct from a deliberately-closed one badged "closed" (W4/#A2)', async () => {
    const { sessionManager, dir } = makeSessionManager();
    try {
      const local = localReader([
        record('reaped-1', { status: 'closed', title: 'Reaped session', metadata: { closeReason: 'idle-reaped' } }),
        record('closed-1', { status: 'closed', title: 'User-closed session', metadata: { closeReason: 'user' } }),
        record('legacy-1', { status: 'closed', title: 'Legacy closed session' }),
      ]);
      const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
      cache.markEmbedded();

      const modal = new SessionPickerModal(sessionManager, cache);
      modal.open();

      const text = linesToText(renderSessionPickerModal(modal, 100)).join('\n');
      expect(text).toContain('Reaped session');
      expect(text).toContain('reaped');
      expect(text).toContain('User-closed session');
      expect(text).toContain('Legacy closed session');
      // Deliberately-closed and pre-feature (no metadata) records still read
      // "closed" — only the idle-reaped one gets the distinct badge.
      const reapedLine = linesToText(renderSessionPickerModal(modal, 100)).find((line) => line.includes('Reaped session'));
      const userClosedLine = linesToText(renderSessionPickerModal(modal, 100)).find((line) => line.includes('User-closed session'));
      const legacyLine = linesToText(renderSessionPickerModal(modal, 100)).find((line) => line.includes('Legacy closed session'));
      expect(reapedLine).toContain('reaped');
      expect(reapedLine).not.toContain('· closed ·');
      expect(userClosedLine).toContain('· closed ·');
      expect(legacyLine).toContain('· closed ·');
      // Wave-4 UX-lens note: 'reaped' is jargon with no on-screen explanation
      // — a plain-language hint must render alongside the badge (the webui
      // pairs its own 'reaped' badge with an equivalent tooltip).
      expect(text).toContain('reaped = closed by the idle sweep — reopens on next activity');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(6) no reaped rows visible: the plain-language "reaped" hint is absent (never speculative noise)', async () => {
    const { sessionManager, dir } = makeSessionManager();
    try {
      const local = localReader([
        record('closed-1', { status: 'closed', title: 'Closed session' }),
        record('active-1', { title: 'Active session' }),
      ]);
      const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
      cache.markEmbedded();

      const modal = new SessionPickerModal(sessionManager, cache);
      modal.open();

      const text = linesToText(renderSessionPickerModal(modal, 100)).join('\n');
      expect(text).toContain('Closed session');
      expect(text).not.toContain('reaped = closed by the idle sweep');
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

// ---------------------------------------------------------------------------
// W3 Finding 1: the union section's row budget must actually hold once the
// local list has enough sessions to want more rows than metrics.contentRows
// reserves for it. Drives the renderer directly (not through SessionManager
// disk I/O) since only the local list's *length* matters here, matching the
// reviewer's repro at /tmp/.../scratchpad/repro.ts.
// ---------------------------------------------------------------------------
describe('SessionPickerModal — cross-surface budget reservation (W3 Finding 1)', () => {
  function fakeLocalSessions(n: number): SessionPickerModal['sessions'] {
    return Array.from({ length: n }, (_, i) => ({
      name: `local-session-${i + 1}`,
      timestamp: Date.now() - i * 1000,
      messageCount: i + 1,
      filePath: `/x/local-${i + 1}.jsonl`,
    })) as unknown as SessionPickerModal['sessions'];
  }

  function fakeUnionRecords(n: number): SharedSessionRecord[] {
    return Array.from({ length: n }, (_, i) => record(`webui-${i + 1}`, { kind: 'webui', title: `webui-session-${i + 1}` }));
  }

  function makeUnionModal(localCount: number, crossRecords: SharedSessionRecord[]): SessionPickerModal {
    const { sessionManager } = makeSessionManager();
    const modal = new SessionPickerModal(sessionManager);
    modal.active = true;
    modal.sessions = fakeLocalSessions(localCount);
    modal.selectedIndex = 0;
    modal.crossSurfaceSessions = crossRecords;
    modal.crossSurfaceView = { mode: 'adopted', online: true, stale: false, lastSyncAt: Date.now(), offlineNote: null };
    return modal;
  }

  test('local=10, vh=40: all 4 union rows visible under the header (reviewer repro)', () => {
    const modal = makeUnionModal(10, fakeUnionRecords(4));
    const text = linesToText(renderSessionPickerModal(modal, 100, 40)).join('\n');
    expect(text).toContain('Cross-surface sessions');
    for (let i = 1; i <= 4; i++) expect(text).toContain(`webui-session-${i}`);
  });

  test('local=14, vh=40: header AND union rows survive (reviewer repro: header previously vanished too)', () => {
    const modal = makeUnionModal(14, fakeUnionRecords(4));
    const text = linesToText(renderSessionPickerModal(modal, 100, 40)).join('\n');
    expect(text).toContain('Cross-surface sessions');
    for (let i = 1; i <= 4; i++) expect(text).toContain(`webui-session-${i}`);
  });

  test('local=10, vh=50: all 4 union rows visible', () => {
    const modal = makeUnionModal(10, fakeUnionRecords(4));
    const text = linesToText(renderSessionPickerModal(modal, 100, 50)).join('\n');
    expect(text).toContain('Cross-surface sessions');
    for (let i = 1; i <= 4; i++) expect(text).toContain(`webui-session-${i}`);
  });

  test('>5 cross-surface records: the "[showing N of M]" overflow line is visible, not tail-clipped', () => {
    const modal = makeUnionModal(20, fakeUnionRecords(7));
    const text = linesToText(renderSessionPickerModal(modal, 100, 40)).join('\n');
    expect(text).toContain('Cross-surface sessions');
    expect(text).toContain('[showing 5 of 7]');
    for (let i = 1; i <= 5; i++) expect(text).toContain(`webui-session-${i}`);
  });

  test('local-only mode (no sessionBroker wired) is unaffected: visibleRows still equals metrics.contentRows', () => {
    const { sessionManager } = makeSessionManager();
    const modal = new SessionPickerModal(sessionManager);
    modal.active = true;
    modal.sessions = fakeLocalSessions(10);
    modal.selectedIndex = 0;
    // mode stays 'local' (the DORMANT_CROSS_SURFACE_VIEW default) — no broker wired.
    const lines = renderSessionPickerModal(modal, 100, 40);
    const text = linesToText(lines).join('\n');
    expect(text).not.toContain('Cross-surface sessions');
    expect(modal.visibleRows).toBe(9);
  });
});
