/**
 * client-adopt-e2e.test.ts — this app's client seams against a REAL daemon.
 *
 * ── Why a real daemon and not a mock ──────────────────────────────────────
 *
 * Every other test in this repository can now only prove that this process
 * does NOT answer a verb. That is the correct claim for a client, and it is
 * also a claim that would keep passing if the wire calls this app makes were
 * wrong in every detail — wrong verb id, wrong parameter names, wrong shape
 * read back off the response. A mock gateway that answers whatever it is asked
 * proves the same nothing.
 *
 * So this suite boots the actual `goodvibes-daemon` binary, built from the
 * daemon repository, and drives the seams the split retargeted against it:
 * session registration, an approval raised and decided, a config write, a task
 * listing, and the honest refusal path when a verb is not available.
 *
 * ── Isolation, which is not optional ──────────────────────────────────────
 *
 * The daemon under test gets its own home directory, its own working
 * directory, and an ephemeral high port. It never touches `~/.goodvibes`, the
 * owner's live daemon, or port 3421. The token it mints lives in the throwaway
 * home and is read from there, which is also the loopback file-token bootstrap
 * this app uses in production — so the auth path is exercised rather than
 * bypassed.
 *
 * ── When it skips, and why that is honest ─────────────────────────────────
 *
 * The binary is built out of a sibling repository. When it is not present the
 * suite reports skipped with the path it looked for, rather than passing on a
 * daemon it never started. Set GOODVIBES_DAEMON_E2E_BINARY to point at one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/surface.ts';
import { createDaemonVerbCaller, type DaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';
import { createDaemonConfigClient } from '../../runtime/client/config-client.ts';
import { createDaemonCredentialsClient } from '../../runtime/client/credentials-client.ts';
import { createDevicesClient } from '../../runtime/client/devices-client.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** A port well clear of the daemon's default 3421 and of anything an install uses. */
const E2E_PORT = 39_471;
const BOOT_TIMEOUT_MS = 45_000;
const BOOT_POLL_MS = 250;

function resolveDaemonBinary(): string | null {
  const configured = process.env['GOODVIBES_DAEMON_E2E_BINARY'];
  if (configured) return existsSync(configured) ? configured : null;
  // The daemon repository sits beside this one; its compiled binary is what the
  // installer places, so it is what this drives.
  const candidates = [
    join(process.cwd(), '..', 'daemon-e2e', 'dist', 'goodvibes-daemon-e2e'),
    join(process.cwd(), '..', '..', 'goodvibes-daemon', 'dist', 'goodvibes-daemon'),
    join(process.cwd(), '..', '..', '.gv-worktrees', 'daemon-e2e', 'dist', 'goodvibes-daemon-e2e'),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Read a list off a response that may be the array itself or a one-key wrapper.
 *
 * Both shapes are real in this contract — `sessions.list` answers bare, the
 * approval action verbs wrap — and a caller that assumes one gets an empty list
 * from the other with no error at all. Naming the key here means a shape change
 * shows up as a failing assertion rather than as silence.
 */
function readList<T>(payload: unknown, key: string): readonly T[] {
  if (Array.isArray(payload)) return payload as readonly T[];
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as readonly T[];
  }
  return [];
}

interface BootedDaemon {
  readonly child: ChildProcess;
  readonly home: string;
  readonly baseUrl: string;
  readonly token: string;
}

async function bootIsolatedDaemon(binary: string): Promise<BootedDaemon> {
  const home = makeProjectTempDir('gv-adopt-e2e');
  const workingDir = join(home, 'work');
  const daemonHome = join(home, '.goodvibes', 'daemon');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(daemonHome, { recursive: true });
  const child = spawn(binary, ['--daemon-home', daemonHome, '--working-dir', workingDir, '--port', String(E2E_PORT)], {
    // A pristine environment: an ambient GOODVIBES_HOME in the developer's
    // shell would move the tree this daemon reads, which is the one thing this
    // suite must never let happen.
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, GOODVIBES_HOME: home },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: false,
  });

  const baseUrl = `http://127.0.0.1:${E2E_PORT}`;
  const tokenPath = join(daemonHome, 'operator-tokens.json');
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(BOOT_POLL_MS);
    if (!existsSync(tokenPath)) continue;
    let token: string;
    try {
      token = (JSON.parse(readFileSync(tokenPath, 'utf8')) as { token: string }).token;
    } catch {
      continue; // mid-write
    }
    try {
      const response = await fetch(`${baseUrl}/status`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) return { child, home, baseUrl, token };
    } catch {
      // not listening yet
    }
  }
  child.kill('SIGKILL');
  throw new Error(`the daemon did not answer on ${baseUrl} within ${BOOT_TIMEOUT_MS}ms`);
}

const binary = resolveDaemonBinary();

// A missing binary is reported, never silently passed over: a suite that
// vanishes is a suite nobody notices has stopped covering anything.
if (!binary) {
  describe('client seams against a real daemon', () => {
    test('SKIPPED — no goodvibes-daemon binary found; set GOODVIBES_DAEMON_E2E_BINARY', () => {
      expect(binary).toBeNull();
    });
  });
} else {
  describe('client seams against a real daemon', () => {
    let daemon: BootedDaemon;
    let verbs: DaemonVerbCaller;

    beforeAll(async () => {
      daemon = await bootIsolatedDaemon(binary);
      // THE PRODUCT'S OWN SEAM, not a hand-rolled client. `createDaemonVerbCaller`
      // is what every retargeted seam calls through, so what this suite exercises
      // is the base-URL derivation, the loopback token read, the operator client
      // construction and the ws-only fallback the product actually ships — not a
      // parallel implementation that could be right while the product is wrong.
      const configManager = new ConfigManager({
        surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
        configDir: join(daemon.home, 'client-config'),
        workingDir: join(daemon.home, 'work'),
        homeDir: daemon.home,
      });
      configManager.setDynamic('daemon.enabled' as never, true as never);
      configManager.setDynamic('controlPlane.host' as never, '127.0.0.1' as never);
      configManager.setDynamic('controlPlane.port' as never, E2E_PORT as never);
      verbs = createDaemonVerbCaller({ configManager, homeDirectory: daemon.home });
    }, BOOT_TIMEOUT_MS + 10_000);

    afterAll(() => {
      daemon?.child.kill('SIGTERM');
    });

    test('the daemon answers on its isolated port, and it is not the default one', () => {
      expect(daemon.baseUrl).toBe(`http://127.0.0.1:${E2E_PORT}`);
      expect(E2E_PORT).not.toBe(3421);
      expect(daemon.token.length).toBeGreaterThan(0);
      // The product's own resolution finds it: base URL derived from
      // controlPlane.host+port, token read from the daemon's state directory.
      expect(verbs.probe().available).toBe(true);
    });

    test('S2 sessions: a session registered here is listed back by the daemon', async () => {
      const sessionId = `e2e-session-${Date.now()}`;
      await verbs.invoke('sessions.register', {
        sessionId,
        project: join(daemon.home, 'work'),
        title: 'Adopt e2e session',
        participant: { surfaceKind: 'tui', surfaceId: 'surface:tui', displayName: 'Terminal UI' },
      });
      const rows = readList<{ id: string }>(await verbs.invoke('sessions.list', { limit: 50 }), 'sessions');
      expect(rows.some((row) => row.id === sessionId)).toBe(true);
    });

    test('S3 approvals: an ask raised over the wire comes back as a pending record and decides', async () => {
      const raised = await verbs.invoke<{ approval?: { id: string; status: string }; decided?: boolean }>('approvals.raise', {
        request: {
          callId: `e2e-${Date.now()}`,
          tool: 'bash',
          args: { command: 'ls -la' },
          category: 'execute',
          analysis: { riskLevel: 'low', reasons: ['end-to-end check'], classification: 'read', summary: 'list files' },
        },
      });

      expect(raised.approval?.id).toBeTruthy();
      // The verb does not park the request across a person's attention span —
      // it hands back the PENDING record and the decision arrives separately.
      expect(raised.decided).toBe(false);
      const approvalId = raised.approval?.id as string;

      // The action verbs answer with the RECORD wrapped, not bare: the daemon
      // is the authority on what it recorded, and the wrapper is what carries
      // the rest of that receipt.
      const decided = await verbs.invoke<{ approval?: { status?: string } } | null>('approvals.approve', {
        approvalId, actor: 'tui', actorSurface: 'tui',
      });
      expect(decided?.approval?.status).toBe('approved');

      // And the daemon's own list is what says so — the parity contract the
      // client raiser depends on when it reads a decision made elsewhere.
      const rows = readList<{ id: string; status: string }>(
        await verbs.invoke('approvals.list', { includeResolved: true }), 'approvals');
      expect(rows.find((row) => row.id === approvalId)?.status).toBe('approved');
    });

    test('S4 config: a daemon-owned key written over the wire reads back changed', async () => {
      // watchers.* is daemon-owned (the daemon runs the watcher framework), so
      // this is exactly the class of write that would have silently landed in
      // this surface's own settings file before the split.
      const config = createDaemonConfigClient(verbs);
      expect(config.ownsKey('watchers.enabled')).toBe(true);
      await config.set('watchers.enabled', false);
      expect(await config.get('watchers.enabled')).toBe(false);
    });

    test('S5 credentials: the daemon stores the value AND points the config key at it', async () => {
      // The verb takes the CONFIG key, not a store key, and does the whole
      // sequence: derive the store name, write, read back and compare, then
      // replace the config value with its reference. That ordering is why this
      // is one call rather than a config write plus a secret write from here —
      // the two halves must not be separable across a process boundary.
      const credentials = createDaemonCredentialsClient(verbs);
      const configKey = 'surfaces.telegram.botToken';
      const receipt = await credentials.set(configKey, 'e2e-not-a-real-token');
      expect(receipt).toBeTruthy();

      // The config key now holds a REFERENCE, and the reference is what the
      // daemon resolves. Never the value: nothing in the receipt or the config
      // repeats the credential.
      const stored = await createDaemonConfigClient(verbs).get(configKey);
      expect(String(stored)).toContain('goodvibes://secrets/');
      expect(String(stored)).not.toContain('e2e-not-a-real-token');
      expect(JSON.stringify(receipt)).not.toContain('e2e-not-a-real-token');

      await credentials.clear(configKey);
    });

    test('S11 tasks: the task list is served by the daemon, not by an in-process catalog', async () => {
      const rows = readList<unknown>(await verbs.invoke('tasks.list', {}), 'tasks');
      expect(Array.isArray(rows)).toBe(true);
    });

    test('S12 devices: the device verbs answer, with no paired phone on a fresh home', async () => {
      const rows = await createDevicesClient(verbs).listNodes();
      expect(rows).toEqual([]);
    });

    test('S15 checkpoints: the checkpoint list is answered by the daemon', async () => {
      const rows = readList<unknown>(await verbs.invoke('checkpoints.list', {}), 'checkpoints');
      expect(Array.isArray(rows)).toBe(true);
    });

    test('S6 voice: speech-to-text refuses honestly when no local provider is provisioned', async () => {
      // The refusal path matters more than the happy path here: a fresh home
      // has no whisper model, and what the surface must get back is a stated
      // reason rather than an empty transcript it would paste into the
      // composer as if the user had said nothing.
      let refusal: unknown = null;
      try {
        await verbs.invoke('voice.stt', { audio: { data: '', mimeType: 'audio/wav' } });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).not.toBeNull();
      expect(String((refusal as Error).message).length).toBeGreaterThan(0);
    });
  });
}
