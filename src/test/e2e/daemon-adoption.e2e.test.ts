/**
 * (b) With a GoodVibes daemon already answering on the configured port, the
 * built TUI adopts it: the daemon's own session list gains the TUI's session
 * for this workspace, and the TUI reports its session spine online. The TUI
 * never starts a daemon of its own (it is adopt-only).
 *
 * The daemon is the SDK's fully composed one (bootDaemon), on the isolated
 * home and the pinned port, sharing one bearer token with the TUI.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '@pellux/goodvibes-sdk/daemon';
import { inputAreaVisible, launchTui, makeHome, screenText, startStubModel, waitFor, type TuiSession } from './harness.ts';

const TOKEN = 'e2e-shared-daemon-token';

const model = startStubModel(() => ({ text: 'unused' }));
let tui: TuiSession | null = null;
let daemon: BootedDaemon | null = null;
afterAll(async () => { tui?.stop(); await daemon?.stop(); model.stop(); });

interface DaemonSession { readonly kind: string; readonly project: string; readonly surfaceKinds: readonly string[] }

async function daemonSessions(url: string): Promise<DaemonSession[]> {
  const response = await fetch(`${url}/api/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!response.ok) return [];
  return ((await response.json()) as { sessions: DaemonSession[] }).sessions;
}

describe('daemon adoption', () => {
  test('a running daemon on the configured port is adopted, not replaced', async () => {
    const home = await makeHome(model);
    daemon = await bootDaemon({
      homeDirectory: home.home,
      workingDir: home.workspace,
      daemonHomeDir: join(home.home, '.goodvibes', 'daemon'),
      host: '127.0.0.1',
      port: home.daemonPort,
      token: TOKEN,
      hasOverriddenHome: true,
    });
    expect(daemon.port).toBe(home.daemonPort);
    expect(await daemonSessions(daemon.url)).toEqual([]);

    tui = launchTui(home, { cols: 120, rows: 40, env: { GOODVIBES_DAEMON_TOKEN: TOKEN } });
    await tui.waitForScreen('the input area', inputAreaVisible, 45_000);

    const sessions = await waitFor('the TUI session on the daemon', async () => {
      const list = await daemonSessions(daemon!.url);
      return list.some((session) => session.kind === 'tui' && session.project === home.workspace) ? list : false;
    }, 30_000);
    expect(sessions.filter((session) => session.kind === 'tui')).toHaveLength(1);

    tui.type('/status');
    tui.key('Enter');
    const status = await tui.waitForScreen('the status view', (s) => /spine\s+\S/.test(s), 20_000);
    expect(screenText(status)).toMatch(/spine online/);
  }, 120_000);
});
