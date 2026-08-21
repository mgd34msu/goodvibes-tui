/**
 * session-spine-daemon-integration.test.ts
 *
 * Acceptance evidence: drives the TUI's SessionSpineClient against a REAL
 * bootDaemon instance (isolated home directory, ephemeral port) over a real
 * HttpTransport, no mocked wire. Proves: register-on-create is visible in
 * `sessions.list` with kind 'tui' and the right project; heartbeat advances
 * the participant's lastSeenAt; close is honest (status flips to 'closed');
 * and the legacy-fold path imports a fixture store into the same daemon.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '@pellux/goodvibes-sdk/platform/daemon';
import { createHttpTransport } from '@/runtime/index.ts';
import { foldLegacySpineStore, SessionSpineClient, TUI_SPINE_PARTICIPANT } from '@pellux/goodvibes-sdk/platform/runtime/session-spine';
import { createTuiSpineTransport, type SpineSessionsClient } from '../../runtime/session-spine-transport.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const TOKEN = 'spine-integration-token';

/**
 * Ceiling for a single poll, and per-test budget for the whole file.
 *
 * Both are ceilings, not targets. Every test here boots a REAL daemon on a real
 * socket and talks to it over real HTTP; a fast host finishes in tens of
 * milliseconds and pays nothing for the headroom, because every wait below
 * returns the instant its condition holds. The previous numbers were an idle
 * machine's numbers: a 2 s poll ceiling and bun's implicit 5 s per-test default,
 * against work that legitimately includes process boot and socket setup. On a
 * loaded host these tests failed with "this test timed out after 5000ms" while
 * the daemon was still coming up perfectly normally, the whole file takes
 * ~33 s there, so a 5 s budget for one of its tests was never realistic.
 */
const WAIT_CEILING_MS = 30_000;
const TEST_BUDGET_MS = 120_000;

async function waitFor<T>(
  fn: () => Promise<T | undefined | null>,
  what = 'unlabelled condition',
  timeoutMs = WAIT_CEILING_MS,
  intervalMs = 20,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null) return value;
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > timeoutMs) {
      throw new Error(`waitFor: ${what} never became true; waited ${elapsedMs}ms (ceiling ${timeoutMs}ms)`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

interface Harness {
  readonly daemon: BootedDaemon;
  readonly homeDirectory: string;
  readonly workingDir: string;
  readonly sessionsClient: SpineSessionsClient;
  readonly listSessions: () => Promise<readonly { readonly id: string; readonly kind: string; readonly project: string; readonly status: string; readonly participants: readonly { readonly lastSeenAt: number }[] }[]>;
  readonly getSession: (id: string) => Promise<{ readonly id: string; readonly status: string } | null>;
}

async function startHarness(): Promise<Harness> {
  const homeDirectory = makeProjectTempDir('goodvibes-spine-daemon-home');
  const workingDir = makeProjectTempDir('goodvibes-spine-daemon-project');
  const daemon = await bootDaemon({ homeDirectory, workingDir, port: 0, token: TOKEN });
  const transport = createHttpTransport({ baseUrl: daemon.url, authToken: TOKEN });
  const sessionsClient: SpineSessionsClient = {
    register: (input) => transport.operator.sessions.register(input),
    close: (sessionId) => transport.operator.sessions.close(sessionId),
  };
  return {
    daemon,
    homeDirectory,
    workingDir,
    sessionsClient,
    listSessions: () => transport.operator.sessions.list(200) as unknown as Promise<readonly { readonly id: string; readonly kind: string; readonly project: string; readonly status: string; readonly participants: readonly { readonly lastSeenAt: number }[] }[]>,
    getSession: (id) => transport.operator.sessions.get(id) as unknown as Promise<{ readonly id: string; readonly status: string } | null>,
  };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.daemon.stop();
  rmSync(harness.homeDirectory, { recursive: true, force: true });
  rmSync(harness.workingDir, { recursive: true, force: true });
}

describe('SessionSpineClient against a real bootDaemon (isolated home, ephemeral port)', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await stopHarness(harness);
    harness = null;
  });

  test('register-on-create is visible in sessions.list with kind tui and the right project', async () => {
    harness = await startHarness();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui',log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiSpineTransport(harness.sessionsClient));

    client.register({ sessionId: 'tui-create-1', project: harness.workingDir, title: 'Terminal UI session' });

    const record = await waitFor(async () => {
      const sessions = await harness!.listSessions();
      return sessions.find((s) => s.id === 'tui-create-1') ?? null;
    }, 'session tui-create-1 appears in sessions.list');

    expect(record.kind).toBe('tui');
    expect(record.project).toBe(harness.workingDir);
    expect(record.status).toBe('active');
    client.dispose();
  }, TEST_BUDGET_MS);

  test('heartbeat advances the participant lastSeenAt on the daemon record', async () => {
    harness = await startHarness();
    let clock = 1_000_000;
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui',now: () => clock, heartbeatMinIntervalMs: 500, log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiSpineTransport(harness.sessionsClient));

    client.register({ sessionId: 'tui-heartbeat-1', project: harness.workingDir, title: 'T' });
    const initial = await waitFor(async () => {
      const sessions = await harness!.listSessions();
      return sessions.find((s) => s.id === 'tui-heartbeat-1') ?? null;
    }, 'session tui-heartbeat-1 appears in sessions.list');
    const initialLastSeen = initial.participants[0]?.lastSeenAt ?? 0;

    clock += 10_000; // past the heartbeat window
    client.heartbeat('tui-heartbeat-1');

    const advanced = await waitFor(async () => {
      const sessions = await harness!.listSessions();
      const rec = sessions.find((s) => s.id === 'tui-heartbeat-1');
      const lastSeen = rec?.participants[0]?.lastSeenAt ?? 0;
      return lastSeen > initialLastSeen ? rec : null;
    }, 'the participant lastSeenAt advances past its first value');

    expect((advanced!.participants[0]?.lastSeenAt ?? 0)).toBeGreaterThan(initialLastSeen);
    client.dispose();
  }, TEST_BUDGET_MS);

  test('close is honest: the daemon record flips to status closed', async () => {
    harness = await startHarness();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui',log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiSpineTransport(harness.sessionsClient));

    client.register({ sessionId: 'tui-close-1', project: harness.workingDir, title: 'T' });
    await waitFor(async () => {
      const sessions = await harness!.listSessions();
      return sessions.find((s) => s.id === 'tui-close-1') ?? null;
    }, 'session tui-close-1 appears in sessions.list');

    client.close('tui-close-1');

    const closed = await waitFor(async () => {
      const session = await harness!.getSession('tui-close-1');
      return session?.status === 'closed' ? session : null;
    }, 'session tui-close-1 reaches status closed');

    expect(closed?.status).toBe('closed');
    client.dispose();
  }, TEST_BUDGET_MS);

  test('legacy fold: a fixture store is imported into the daemon (open session active, closed session stays closed)', async () => {
    harness = await startHarness();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui',log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiSpineTransport(harness.sessionsClient));

    const storePath = join(harness.workingDir, 'legacy-sessions.json');
    writeFileSync(storePath, JSON.stringify({
      sessions: {
        'legacy-open-1': { id: 'legacy-open-1', kind: 'tui', title: 'Legacy open', status: 'active' },
        'legacy-closed-1': { id: 'legacy-closed-1', kind: 'tui', title: 'Legacy closed', status: 'closed' },
      },
    }));
    const markerPath = `${storePath}.spine-migrated`;

    const result = foldLegacySpineStore(client, { storePath, markerPath, project: harness.workingDir });
    expect(result).toEqual({ folded: 2, skipped: false });

    const openRecord = await waitFor(async () => {
      const sessions = await harness!.listSessions();
      return sessions.find((s) => s.id === 'legacy-open-1') ?? null;
    }, 'folded session legacy-open-1 appears in sessions.list');
    expect(openRecord.status).toBe('active');

    const closedRecord = await waitFor(async () => {
      const session = await harness!.getSession('legacy-closed-1');
      return session?.status === 'closed' ? session : null;
    }, 'folded session legacy-closed-1 stays closed');
    expect(closedRecord?.status).toBe('closed');

    // Idempotent, a second fold call with the marker present folds nothing.
    const second = foldLegacySpineStore(client, { storePath, markerPath, project: harness.workingDir });
    expect(second).toEqual({ folded: 0, skipped: true });
    client.dispose();
  }, TEST_BUDGET_MS);
});
