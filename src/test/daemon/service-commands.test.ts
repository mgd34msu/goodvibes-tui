import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isDaemonServiceSubcommand,
  resolveInstalledDaemonBinary,
  runDaemonServiceCli,
  type ManagedServiceActionRunner,
} from '../../daemon/service-commands.ts';

describe('isDaemonServiceSubcommand', () => {
  test('recognizes the three service verbs and nothing else', () => {
    expect(isDaemonServiceSubcommand('install-service')).toBe(true);
    expect(isDaemonServiceSubcommand('uninstall-service')).toBe(true);
    expect(isDaemonServiceSubcommand('service-status')).toBe(true);
    expect(isDaemonServiceSubcommand('serve')).toBe(false);
    expect(isDaemonServiceSubcommand(undefined)).toBe(false);
  });
});

describe('resolveInstalledDaemonBinary', () => {
  test('prefers the GOODVIBES_DAEMON_BINARY env override', () => {
    const resolved = resolveInstalledDaemonBinary({
      env: { GOODVIBES_DAEMON_BINARY: '/opt/gv/goodvibes-daemon' } as NodeJS.ProcessEnv,
    });
    expect(resolved).toBe('/opt/gv/goodvibes-daemon');
  });

  test('locates the packaged bin/goodvibes-daemon launcher relative to the module', () => {
    // Pretend this module lives at <root>/src/daemon/service-commands.ts.
    const moduleUrl = pathToFileURL('/some/pkg/src/daemon/service-commands.ts').href;
    const resolved = resolveInstalledDaemonBinary({
      env: {} as NodeJS.ProcessEnv,
      moduleUrl,
      fileExists: (p) => p === join('/some/pkg', 'bin', 'goodvibes-daemon'),
    });
    expect(resolved).toBe('/some/pkg/bin/goodvibes-daemon');
  });

  test('uses process.execPath when it is the compiled daemon binary', () => {
    const resolved = resolveInstalledDaemonBinary({
      env: {} as NodeJS.ProcessEnv,
      execPath: '/usr/local/bin/goodvibes-daemon',
      fileExists: () => false,
    });
    expect(resolved).toBe('/usr/local/bin/goodvibes-daemon');
  });

  test('falls back to bare goodvibes-daemon (PATH) as a last resort', () => {
    const resolved = resolveInstalledDaemonBinary({
      env: {} as NodeJS.ProcessEnv,
      execPath: '/usr/bin/bun',
      fileExists: () => false,
    });
    expect(resolved).toBe('goodvibes-daemon');
  });
});

/**
 * Coverage for the CLI dispatch onto the SDK's REAL wired
 * `PlatformServiceManager` (rewired here after SDK W3-S5 deleted the old
 * systemd-only `systemd-user-service.ts` shim this module used to call).
 *
 * `service.platform` is forced to 'systemd' via config override so these tests
 * exercise the systemd path on any host (matching what this repo's own Linux
 * dev/CI hosts actually use), independent of `process.platform`. Every
 * filesystem write is scoped to a per-test tempdir passed as both `homeDir`
 * and `workingDirectory`, and every systemctl dispatch goes through an
 * injected `actionRunner` — nothing here ever touches a real
 * `~/.config/systemd/user` entry or invokes a real `systemctl` binary.
 */
describe('runDaemonServiceCli (systemd path, real PlatformServiceManager, stubbed systemctl)', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gv-service-commands-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function recordingRunner(status = 0): { runner: ManagedServiceActionRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: ManagedServiceActionRunner = (command, args) => {
      calls.push([command, ...args]);
      return { status };
    };
    return { runner, calls };
  }

  function baseInput(overrides: Partial<Parameters<typeof runDaemonServiceCli>[0]> = {}) {
    return {
      subcommand: 'install-service' as const,
      binaryPath: '/usr/local/bin/goodvibes-daemon',
      homeDir: dir,
      host: '127.0.0.1',
      port: 3421,
      ...overrides,
    };
  }

  test('install-service writes the systemd unit then enables + starts it', () => {
    const { runner, calls } = recordingRunner();
    const result = runDaemonServiceCli(baseInput({ actionRunner: runner }));

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.status.platform).toBe('systemd');
    const unitPath = join(dir, '.config', 'systemd', 'user', 'goodvibes.service');
    expect(existsSync(unitPath)).toBe(true);
    const contents = readFileSync(unitPath, 'utf-8');
    expect(contents).toContain('ExecStart=/usr/local/bin/goodvibes-daemon --daemon-home');
    expect(contents).toContain('--hostname 127.0.0.1');
    expect(contents).toContain('--port 3421');
    // install() only writes the file; install-service also calls start() to
    // preserve the old shim's "install implies enabled + running" behavior.
    expect(calls).toEqual([['systemctl', '--user', 'enable', '--now', 'goodvibes.service']]);
    expect(result.lines.join('\n')).toContain('installed the systemd service');
  });

  test('install-service surfaces an honest failure when enabling fails, without pretending it started', () => {
    const runner: ManagedServiceActionRunner = () => ({ status: 1, stderr: 'Failed to enable unit' });
    const result = runDaemonServiceCli(baseInput({ actionRunner: runner }));

    expect(result.ok).toBe(true); // the write itself succeeded
    expect(result.status.running).toBe(false);
    expect(result.lines.some((line) => line.includes('could not start it automatically'))).toBe(true);
    expect(result.lines.join('\n')).toContain('Failed to enable unit');
  });

  test('uninstall-service stops the unit then removes the file', () => {
    // Install first so there is something to remove.
    runDaemonServiceCli(baseInput({ actionRunner: recordingRunner().runner }));
    const unitPath = join(dir, '.config', 'systemd', 'user', 'goodvibes.service');
    expect(existsSync(unitPath)).toBe(true);

    const { runner, calls } = recordingRunner();
    const result = runDaemonServiceCli(baseInput({ subcommand: 'uninstall-service', actionRunner: runner }));

    expect(result.ok).toBe(true);
    expect(existsSync(unitPath)).toBe(false);
    expect(calls).toEqual([['systemctl', '--user', 'stop', 'goodvibes.service']]);
    expect(result.lines.join('\n')).toContain('daemon-reload');
  });

  test('uninstall-service reports ok even when stop fails (service was never running)', () => {
    const runner: ManagedServiceActionRunner = () => ({ status: 1, stderr: 'Unit not loaded' });
    const result = runDaemonServiceCli(baseInput({ subcommand: 'uninstall-service', actionRunner: runner }));

    expect(result.ok).toBe(true);
    expect(result.lines.some((line) => line.includes('may not have been running'))).toBe(true);
  });

  test('service-status is read-only and reports not-installed before any install', () => {
    const result = runDaemonServiceCli(baseInput({ subcommand: 'service-status' }));

    expect(result.ok).toBe(true);
    expect(result.status.installed).toBe(false);
    expect(result.status.running).toBe(false);
    expect(result.lines).toContain('installed: false');
  });

  test('service-status after install reports installed:true and includes a caveat about running-state accuracy', () => {
    runDaemonServiceCli(baseInput({ actionRunner: recordingRunner().runner }));
    const result = runDaemonServiceCli(baseInput({ subcommand: 'service-status' }));

    expect(result.status.installed).toBe(true);
    // No pidfile is ever written on the systemd path (only the 'manual'
    // platform's start() tracks a pid), so `running` honestly reports false
    // here and the CLI adds a caveat rather than claiming certainty either way.
    expect(result.status.running).toBe(false);
    expect(result.lines.some((line) => line.includes("only reflects processes this tool started directly"))).toBe(true);
  });
});
