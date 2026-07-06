/**
 * session-union-cache-daemon-integration.test.ts
 *
 * Acceptance evidence: drives the SessionUnionCache against a REAL
 * bootDaemon over a real HttpTransport (no mocked wire), mirroring the startup-latency test's
 * integration harness. Proves the adopted-mode union genuinely includes a
 * session that exists ONLY on the daemon (registered by a different surface),
 * which the local broker alone would miss — and that losing the daemon degrades
 * the served rows to local-only honestly.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '@pellux/goodvibes-sdk/platform/daemon';
import { createHttpTransport } from '@/runtime/index.ts';
import type { SharedSessionRecord } from '@pellux/goodvibes-sdk/platform/control-plane';
import { SessionUnionCache, type LocalSessionReader } from '@pellux/goodvibes-sdk/platform/runtime/session-spine';

const TOKEN = 'union-integration-token';

// No-op scheduler: the test drives refresh() by hand for determinism.
const noopScheduler = {
  setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
  clearInterval: () => {},
};
const silent = { debug: () => {} };

interface Harness {
  readonly daemon: BootedDaemon;
  readonly homeDirectory: string;
  readonly workingDir: string;
  readonly wireList: (limit?: number) => Promise<readonly SharedSessionRecord[]>;
  readonly registerWireSession: (id: string) => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'goodvibes-union-daemon-home-'));
  const workingDir = mkdtempSync(join(tmpdir(), 'goodvibes-union-daemon-project-'));
  const daemon = await bootDaemon({ homeDirectory, workingDir, port: 0, token: TOKEN });
  const transport = createHttpTransport({ baseUrl: daemon.url, authToken: TOKEN });
  return {
    daemon,
    homeDirectory,
    workingDir,
    wireList: (limit) => transport.operator.sessions.list(limit),
    registerWireSession: async (id) => {
      // Register a session on the daemon as if from another surface (companion).
      await transport.operator.sessions.register({
        sessionId: id,
        project: workingDir,
        title: id,
        participant: { surfaceKind: 'companion', surfaceId: 'surface:companion', displayName: 'Companion', lastSeenAt: Date.now() },
      });
    },
  };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.daemon.stop();
  rmSync(harness.homeDirectory, { recursive: true, force: true });
  rmSync(harness.workingDir, { recursive: true, force: true });
}

describe('SessionUnionCache against a real bootDaemon (adopted-mode union)', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await stopHarness(harness);
    harness = null;
  });

  test('adopted union includes a daemon-hosted session the local broker never saw', async () => {
    harness = await startHarness();
    await harness.registerWireSession('companion-session-1');

    // The local broker only knows THIS surface's own session.
    const local: LocalSessionReader = {
      listSessions: () => [{ id: 'tui-local-1', kind: 'tui', project: harness!.workingDir, title: 'tui-local-1', status: 'active', createdAt: 1, updatedAt: 1, participants: [] } as SharedSessionRecord],
      getSession: (id) => (id === 'tui-local-1' ? ({ id: 'tui-local-1' } as SharedSessionRecord) : null),
    };

    const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
    cache.activate({ list: (limit) => harness!.wireList(limit) });
    await cache.refresh();

    const ids = cache.listSessions().map((r) => r.id).sort();
    expect(ids).toContain('tui-local-1'); // local surface's own session
    expect(ids).toContain('companion-session-1'); // cross-surface session, ONLY on the daemon
    expect(cache.getSession('companion-session-1')?.id).toBe('companion-session-1');
    expect(cache.crossSurfaceView).toMatchObject({ mode: 'adopted', online: true, offlineNote: null });

    cache.dispose();
  });

  test('bootstrap wiring shape: selfSessionIds drops this surface\'s own wire mirror — no +1 phantom (D-TUI-1)', async () => {
    harness = await startHarness();
    // Another surface's session on the daemon.
    await harness.registerWireSession('companion-session-3');
    // This surface mirrors its OWN session to the wire under a DIFFERENT id
    // than the local broker uses — the divergence the replay exposed.
    await harness.registerWireSession('tui-wire-mirror-3');

    const local: LocalSessionReader = {
      listSessions: () => [{ id: 'tui-local-3', kind: 'tui', project: harness!.workingDir, title: 'tui-local-3', status: 'active', createdAt: 1, updatedAt: 1, participants: [] } as SharedSessionRecord],
      getSession: (id) => (id === 'tui-local-3' ? ({ id: 'tui-local-3' } as SharedSessionRecord) : null),
    };
    // Same wiring shape as bootstrap-core.ts: the spine client's mirrored ids
    // feed selfSessionIds so the local record stays authoritative for self.
    const mirrored = new Set(['tui-wire-mirror-3']);
    const cache = new SessionUnionCache({
      local,
      selfSessionIds: () => mirrored,
      scheduler: noopScheduler,
      log: silent,
    });
    cache.activate({ list: (limit) => harness!.wireList(limit) });
    await cache.refresh();

    const ids = cache.listSessions().map((r) => r.id).sort();
    expect(ids).toContain('tui-local-3'); // self, from the local broker
    expect(ids).toContain('companion-session-3'); // genuine cross-surface row
    expect(ids).not.toContain('tui-wire-mirror-3'); // self's wire mirror deduped
    // Exactly 2 rows: no +1 phantom of ourselves.
    expect(ids).toHaveLength(2);
    cache.dispose();
  });

  test('losing the daemon degrades the union to local-only rows + honest offline note', async () => {
    harness = await startHarness();
    await harness.registerWireSession('companion-session-2');

    const local: LocalSessionReader = {
      listSessions: () => [{ id: 'tui-local-2', kind: 'tui', project: harness!.workingDir, title: 'tui-local-2', status: 'active', createdAt: 1, updatedAt: 1, participants: [] } as SharedSessionRecord],
      getSession: (id) => (id === 'tui-local-2' ? ({ id: 'tui-local-2' } as SharedSessionRecord) : null),
    };
    const cache = new SessionUnionCache({ local, scheduler: noopScheduler, log: silent });
    cache.activate({ list: (limit) => harness!.wireList(limit) });
    await cache.refresh();
    expect(cache.listSessions().map((r) => r.id)).toContain('companion-session-2');

    // Kill the daemon, then refresh: the wire rejects.
    await harness.daemon.stop();
    await cache.refresh();

    expect(cache.listSessions().map((r) => r.id)).toEqual(['tui-local-2']); // no phantom cross-surface row
    expect(cache.crossSurfaceView.offlineNote).toBe('cross-surface view offline');
    expect(cache.crossSurfaceView.stale).toBe(true);
    cache.dispose();
  });
});
