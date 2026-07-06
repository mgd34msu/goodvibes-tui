import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import {
  buildInstallResultLines,
  isDaemonServiceSubcommand,
  resolveInstalledDaemonBinary,
  runDaemonServiceCli,
  type ManagedServiceActionRunner,
} from '../../daemon/service-commands.ts';

describe('isDaemonServiceSubcommand', () => {
  test('recognizes the four service verbs and nothing else', () => {
    expect(isDaemonServiceSubcommand('install-service')).toBe(true);
    expect(isDaemonServiceSubcommand('uninstall-service')).toBe(true);
    expect(isDaemonServiceSubcommand('service-status')).toBe(true);
    expect(isDaemonServiceSubcommand('migrate-service')).toBe(true);
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

  test('install-service writes the systemd unit then enables + starts it', async () => {
    const { runner, calls } = recordingRunner();
    const result = await runDaemonServiceCli(baseInput({ actionRunner: runner }));

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
    // The SDK's status() now also issues read-only `is-active` probes for the
    // new unit through the same runner — filter those out of the action check.
    const actions = calls.filter((c) => !c.includes('is-active'));
    expect(actions).toEqual([['systemctl', '--user', 'enable', '--now', 'goodvibes.service']]);
    for (const probe of calls.filter((c) => c.includes('is-active'))) {
      expect(probe).toEqual(['systemctl', '--user', 'is-active', 'goodvibes.service']);
    }
    expect(result.lines.join('\n')).toContain('installed the systemd service');
  });

  test('install-service surfaces an honest failure when enabling fails, without pretending it started', async () => {
    const runner: ManagedServiceActionRunner = () => ({ status: 1, stderr: 'Failed to enable unit' });
    const result = await runDaemonServiceCli(baseInput({ actionRunner: runner }));

    expect(result.ok).toBe(true); // the write itself succeeded
    expect(result.status.running).toBe(false);
    expect(result.lines.some((line) => line.includes('could not start it automatically'))).toBe(true);
    expect(result.lines.join('\n')).toContain('Failed to enable unit');
  });

  test('uninstall-service stops the unit then removes the file', async () => {
    // Install first so there is something to remove.
    await runDaemonServiceCli(baseInput({ actionRunner: recordingRunner().runner }));
    const unitPath = join(dir, '.config', 'systemd', 'user', 'goodvibes.service');
    expect(existsSync(unitPath)).toBe(true);

    const { runner, calls } = recordingRunner();
    const result = await runDaemonServiceCli(baseInput({ subcommand: 'uninstall-service', actionRunner: runner }));

    expect(result.ok).toBe(true);
    expect(existsSync(unitPath)).toBe(false);
    expect(calls.filter((c) => !c.includes('is-active'))).toEqual([
      ['systemctl', '--user', 'stop', 'goodvibes.service'],
    ]);
    expect(result.lines.join('\n')).toContain('daemon-reload');
  });

  test('uninstall-service reports ok even when stop fails (service was never running)', async () => {
    const runner: ManagedServiceActionRunner = () => ({ status: 1, stderr: 'Unit not loaded' });
    const result = await runDaemonServiceCli(baseInput({ subcommand: 'uninstall-service', actionRunner: runner }));

    expect(result.ok).toBe(true);
    expect(result.lines.some((line) => line.includes('may not have been running'))).toBe(true);
  });

  test('service-status is read-only and reports not-installed before any install', async () => {
    const result = await runDaemonServiceCli(baseInput({ subcommand: 'service-status' }));

    expect(result.ok).toBe(true);
    expect(result.status.installed).toBe(false);
    expect(result.status.running).toBe(false);
    expect(result.lines).toContain('installed: false');
  });

  test('service-status after install reports installed:true and includes a caveat about running-state accuracy', async () => {
    await runDaemonServiceCli(baseInput({ actionRunner: recordingRunner().runner }));
    const result = await runDaemonServiceCli(baseInput({ subcommand: 'service-status' }));

    expect(result.status.installed).toBe(true);
    // No pidfile is ever written on the systemd path (only the 'manual'
    // platform's start() tracks a pid), so `running` honestly reports false
    // here and the CLI adds a caveat rather than claiming certainty either way.
    expect(result.status.running).toBe(false);
    // W3 Finding 4: the old wording asserted HOW `running` was computed
    // ("only reflects processes this tool started directly") — true for the
    // pid-file-only check this (currently linked) SDK build still uses, but
    // stale once the parallel SDK batch makes status().running query systemd
    // honestly via `is-active`. The caveat now just offers the escape hatch
    // without asserting a mechanism, so it stays true either way.
    expect(result.lines.some((line) => line.includes('verify directly'))).toBe(true);
  });
});

/**
 * W3 Finding 4: legacy-unit detection (`goodvibes-daemon.service`, the prior
 * D7a command's literal unit name — distinct from this module's tracked
 * `goodvibes.service`). Both the file-existence check and the `is-active`
 * query are fully faked here: `legacyUnitFileExists` never touches the real
 * `~/.config/systemd/user`, and the `is-active` query goes through the same
 * injected `actionRunner` used above — this suite never touches, stops, or
 * modifies a real running service.
 */
describe('runDaemonServiceCli — legacy unit detection (W3 Finding 4)', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gv-service-commands-legacy-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function baseInput(overrides: Partial<Parameters<typeof runDaemonServiceCli>[0]> = {}) {
    return {
      subcommand: 'service-status' as const,
      binaryPath: '/usr/local/bin/goodvibes-daemon',
      homeDir: dir,
      host: '127.0.0.1',
      port: 3421,
      ...overrides,
    };
  }

  function fakeRunner(status: number, stdout: string): { runner: ManagedServiceActionRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: ManagedServiceActionRunner = (command, args) => {
      calls.push([command, ...args]);
      return { status, stdout };
    };
    return { runner, calls };
  }

  describe('service-status', () => {
    test('legacy unit absent: no legacy note, is-active never queried', async () => {
      const { runner, calls } = fakeRunner(0, 'active');
      const result = await runDaemonServiceCli(baseInput({ legacyUnitFileExists: () => false, actionRunner: runner }));

      expect(result.ok).toBe(true);
      expect(result.lines.join('\n')).not.toContain('goodvibes-daemon.service');
      // The legacy unit must never be probed; the SDK's status() may issue
      // read-only is-active probes for the NEW unit through the same runner.
      expect(calls.some((c) => c.includes('goodvibes-daemon.service'))).toBe(false);
    });

    test('legacy unit present + active: reports it honestly as RUNNING with a migration hint', async () => {
      const { runner, calls } = fakeRunner(0, 'active');
      const result = await runDaemonServiceCli(baseInput({ legacyUnitFileExists: () => true, actionRunner: runner }));

      expect(result.ok).toBe(true);
      const text = result.lines.join('\n');
      expect(text).toContain('legacy name goodvibes-daemon.service');
      expect(text).toContain('installed and RUNNING');
      expect(text).toContain('will not touch the legacy one automatically');
      expect(calls).toContainEqual(['systemctl', '--user', 'is-active', 'goodvibes-daemon.service']);
      // Any other runner traffic must be read-only status probes of the new unit.
      for (const other of calls.filter((c) => !c.includes('goodvibes-daemon.service'))) {
        expect(other).toEqual(['systemctl', '--user', 'is-active', 'goodvibes.service']);
      }
    });

    test('legacy unit present + inactive: reports it honestly as not currently active', async () => {
      const { runner } = fakeRunner(3, 'inactive');
      const result = await runDaemonServiceCli(baseInput({ legacyUnitFileExists: () => true, actionRunner: runner }));

      const text = result.lines.join('\n');
      expect(text).toContain('goodvibes-daemon.service');
      expect(text).toContain('not currently active');
      expect(text).not.toContain('RUNNING');
    });
  });

  describe('install-service', () => {
    test('legacy unit present: refuses rather than risk a second daemon, never writes the new unit', async () => {
      const { runner, calls } = fakeRunner(0, 'active');
      const result = await runDaemonServiceCli(baseInput({ subcommand: 'install-service', legacyUnitFileExists: () => true, actionRunner: runner }));

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).toContain('legacy name goodvibes-daemon.service');
      expect(existsSync(join(dir, '.config', 'systemd', 'user', 'goodvibes.service'))).toBe(false);
      // Only read-only is-active queries ran — no install/enable dispatched.
      expect(calls).toContainEqual(['systemctl', '--user', 'is-active', 'goodvibes-daemon.service']);
      expect(calls.some((c) => c.includes('enable') || c.includes('start'))).toBe(false);
    });

    test('legacy unit present but inactive: still refuses (an inactive unit can still be enabled and collide later)', async () => {
      const { runner } = fakeRunner(3, 'inactive');
      const result = await runDaemonServiceCli(baseInput({ subcommand: 'install-service', legacyUnitFileExists: () => true, actionRunner: runner }));

      expect(result.ok).toBe(false);
      expect(existsSync(join(dir, '.config', 'systemd', 'user', 'goodvibes.service'))).toBe(false);
    });

    test('legacy unit absent: installs normally', async () => {
      const { runner } = fakeRunner(0, 'active');
      const result = await runDaemonServiceCli(baseInput({ subcommand: 'install-service', legacyUnitFileExists: () => false, actionRunner: runner }));

      expect(result.ok).toBe(true);
      expect(existsSync(join(dir, '.config', 'systemd', 'user', 'goodvibes.service'))).toBe(true);
    });
  });

  describe('uninstall-service', () => {
    test('legacy unit present: mentions it is untouched, still uninstalls the tracked unit', async () => {
      // Install the TRACKED unit first (legacy absent at install time) so there is something to remove.
      await runDaemonServiceCli(baseInput({ subcommand: 'install-service', legacyUnitFileExists: () => false, actionRunner: fakeRunner(0, 'active').runner }));
      const trackedPath = join(dir, '.config', 'systemd', 'user', 'goodvibes.service');
      expect(existsSync(trackedPath)).toBe(true);

      const { runner } = fakeRunner(0, 'active');
      const result = await runDaemonServiceCli(baseInput({ subcommand: 'uninstall-service', legacyUnitFileExists: () => true, actionRunner: runner }));

      expect(result.ok).toBe(true);
      expect(existsSync(trackedPath)).toBe(false);
      const text = result.lines.join('\n');
      expect(text).toContain('legacy name goodvibes-daemon.service');
      expect(text).toContain('will not touch the legacy one automatically');
    });

    test('legacy unit absent: no legacy note', async () => {
      await runDaemonServiceCli(baseInput({ subcommand: 'install-service', legacyUnitFileExists: () => false, actionRunner: fakeRunner(0, 'active').runner }));
      const result = await runDaemonServiceCli(baseInput({ subcommand: 'uninstall-service', legacyUnitFileExists: () => false, actionRunner: fakeRunner(0, 'active').runner }));

      expect(result.ok).toBe(true);
      expect(result.lines.join('\n')).not.toContain('goodvibes-daemon.service');
    });
  });
});

/**
 * W4-D1: the guided, consented `migrate-service` takeover of the legacy
 * `goodvibes-daemon.service` unit. Every step (legacy stop/disable/remove,
 * daemon-reload) goes through the SAME injected `actionRunner`/
 * `legacyUnitFileRemove`/`legacyUnitFileExists`/`portProbe` seams the rest of
 * this suite uses — this describe block never touches a real port, a real
 * systemd unit, or a real filesystem path outside the per-test tempdir.
 */
describe('runDaemonServiceCli — migrate-service (W4-D1)', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gv-service-commands-migrate-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function baseInput(overrides: Partial<Parameters<typeof runDaemonServiceCli>[0]> = {}) {
    return {
      subcommand: 'migrate-service' as const,
      binaryPath: '/usr/local/bin/goodvibes-daemon',
      homeDir: dir,
      host: '127.0.0.1',
      port: 3421,
      ...overrides,
    };
  }

  /**
   * A single fake systemctl runner covering both the tracked ('goodvibes')
   * and legacy ('goodvibes-daemon') unit names, so tests can assert full call
   * ordering across new-unit-up and legacy-unit-down. `isActiveState` controls
   * what `systemctl --user is-active goodvibes.service` reports for the NEW
   * unit — this is how tests make the post-start health check honestly pass
   * or fail without touching a real systemd.
   */
  function fakeMigrationRunner(options: {
    readonly isActiveState?: 'active' | 'inactive';
    readonly enableFails?: boolean;
  } = {}): { runner: ManagedServiceActionRunner; calls: string[][] } {
    const { isActiveState = 'active', enableFails = false } = options;
    const calls: string[][] = [];
    const runner: ManagedServiceActionRunner = (command, args) => {
      calls.push([command, ...args]);
      if (args[1] === 'is-active') {
        const unit = args[2] ?? '';
        // The legacy unit is only ever probed by detectLegacyUnit's own
        // up-front check (fed via legacyUnitFileExists in these tests, not
        // this runner) — if migrate-service's post-start health check ever
        // queried the LEGACY name instead of the tracked one, this would
        // wrongly report it healthy, so keep the two names' liveness distinct.
        if (unit === 'goodvibes-daemon.service') return { status: 0, stdout: 'active' };
        return isActiveState === 'active' ? { status: 0, stdout: 'active' } : { status: 3, stdout: 'inactive' };
      }
      if (args[1] === 'enable' && enableFails) {
        return { status: 1, stderr: 'Failed to enable unit: access denied' };
      }
      return { status: 0 };
    };
    return { runner, calls };
  }

  describe('legacy unit absent', () => {
    test('port free: reports nothing to migrate, touches no actionRunner call', async () => {
      const { runner, calls } = fakeMigrationRunner();
      const result = await runDaemonServiceCli(
        baseInput({ legacyUnitFileExists: () => false, actionRunner: runner, portProbe: () => false }),
      );

      expect(result.ok).toBe(true);
      expect(result.lines.join('\n')).toContain('nothing to migrate');
      expect(result.lines.join('\n')).toContain('Run install-service');
      // Purely informational — no systemctl action was needed to answer this.
      expect(calls.some((c) => c.includes('stop') || c.includes('disable') || c.includes('enable'))).toBe(false);
    });

    test('port occupied by an unrecognized process: adopt-or-warn, never attempts to kill it', async () => {
      const { runner, calls } = fakeMigrationRunner();
      const result = await runDaemonServiceCli(
        baseInput({ legacyUnitFileExists: () => false, actionRunner: runner, portProbe: () => true }),
      );

      expect(result.ok).toBe(false);
      const text = result.lines.join('\n');
      expect(text).toContain("doesn't manage");
      expect(text).toContain('will not attempt to kill');
      // No stop/disable/kill-shaped action was ever dispatched for this case.
      expect(calls.some((c) => c.includes('stop') || c.includes('disable') || c.includes('kill'))).toBe(false);
    });

    test('portProbe receives the configured host and port', async () => {
      const probed: Array<{ host: string; port: number }> = [];
      await runDaemonServiceCli(
        baseInput({
          legacyUnitFileExists: () => false,
          actionRunner: fakeMigrationRunner().runner,
          host: '10.0.0.5',
          port: 4444,
          portProbe: (host, port) => {
            probed.push({ host, port });
            return false;
          },
        }),
      );
      expect(probed).toEqual([{ host: '10.0.0.5', port: 4444 }]);
    });
  });

  describe('legacy unit present, migration declined (no confirmMigration)', () => {
    test('prints the exact plan and changes nothing', async () => {
      const { runner, calls } = fakeMigrationRunner();
      const result = await runDaemonServiceCli(
        baseInput({ legacyUnitFileExists: () => true, actionRunner: runner }),
      );

      expect(result.ok).toBe(true);
      const text = result.lines.join('\n');
      expect(text).toContain('legacy name goodvibes-daemon.service');
      expect(text).toContain('dry run');
      expect(text).toContain('install and start the new goodvibes.service unit');
      expect(text).toContain('stop, disable, and remove the legacy');
      expect(text).toContain('Nothing has been changed');
      expect(existsSync(join(dir, '.config', 'systemd', 'user', 'goodvibes.service'))).toBe(false);
      // The only tracked-unit traffic allowed here is a read-only status
      // probe (used to confirm this host is even on the systemd path before
      // printing the plan) — never a mutating action.
      const trackedCalls = calls.filter((c) => !c.includes('goodvibes-daemon.service'));
      for (const call of trackedCalls) expect(call).toEqual(['systemctl', '--user', 'is-active', 'goodvibes.service']);
      expect(calls.some((c) => c.includes('enable') || c.includes('stop') || c.includes('disable'))).toBe(false);
    });
  });

  describe('legacy unit present, migration confirmed', () => {
    test('new unit installed + verified healthy strictly BEFORE the legacy unit is stopped/disabled/removed', async () => {
      const { runner, calls } = fakeMigrationRunner({ isActiveState: 'active' });
      const removedPaths: string[] = [];
      const result = await runDaemonServiceCli(
        baseInput({
          legacyUnitFileExists: () => true,
          actionRunner: runner,
          confirmMigration: true,
          legacyUnitFileRemove: (p) => removedPaths.push(p),
        }),
      );

      expect(result.ok).toBe(true);
      const newUnitPath = join(dir, '.config', 'systemd', 'user', 'goodvibes.service');
      expect(existsSync(newUnitPath)).toBe(true);

      const legacyName = 'goodvibes-daemon.service';
      const firstLegacyMutationIndex = calls.findIndex(
        (c) => c.includes(legacyName) && (c.includes('stop') || c.includes('disable')),
      );
      const newUnitEnableIndex = calls.findIndex((c) => c.includes('enable') && c.includes('goodvibes.service'));
      expect(newUnitEnableIndex).toBeGreaterThanOrEqual(0);
      expect(firstLegacyMutationIndex).toBeGreaterThan(newUnitEnableIndex);

      expect(calls).toContainEqual(['systemctl', '--user', 'stop', legacyName]);
      expect(calls).toContainEqual(['systemctl', '--user', 'disable', legacyName]);
      expect(calls).toContainEqual(['systemctl', '--user', 'daemon-reload']);
      expect(removedPaths).toEqual([join(dir, '.config', 'systemd', 'user', 'goodvibes-daemon.service')]);

      const text = result.lines.join('\n');
      expect(text).toContain('migrated');
      expect(text).toContain('installed, enabled, and running');
      expect(text).toContain('stopped, disabled, and removed');
    });

    test('new unit installs but does not come up healthy: rolls back the new unit, legacy left running untouched', async () => {
      const { runner, calls } = fakeMigrationRunner({ isActiveState: 'inactive', enableFails: true });
      const result = await runDaemonServiceCli(
        baseInput({ legacyUnitFileExists: () => true, actionRunner: runner, confirmMigration: true }),
      );

      expect(result.ok).toBe(false);
      const newUnitPath = join(dir, '.config', 'systemd', 'user', 'goodvibes.service');
      // Rolled back: the written unit file was removed again.
      expect(existsSync(newUnitPath)).toBe(false);
      const text = result.lines.join('\n');
      expect(text).toContain('did not come up healthy');
      expect(text).toContain('rolled back');
      expect(text).toContain('legacy');
      expect(text).toContain('never touched');
      expect(text).toContain('should still be running as before');
      // Never reached the legacy stop/disable/remove step.
      expect(calls.some((c) => c.includes('goodvibes-daemon.service') && (c.includes('stop') || c.includes('disable')))).toBe(false);
    });

    test('legacy stop/disable report non-zero exit: still removes the unit file and reports an honest note, not a false clean success', async () => {
      const calls: string[][] = [];
      const runner: ManagedServiceActionRunner = (command, args) => {
        calls.push([command, ...args]);
        if (args[1] === 'is-active') return { status: 0, stdout: 'active' };
        if (args[2] === 'goodvibes-daemon.service' && (args[1] === 'stop' || args[1] === 'disable')) {
          return { status: 1, stderr: 'Unit not loaded.' };
        }
        return { status: 0 };
      };
      const result = await runDaemonServiceCli(
        baseInput({ legacyUnitFileExists: () => true, actionRunner: runner, confirmMigration: true }),
      );

      expect(result.ok).toBe(true);
      const text = result.lines.join('\n');
      expect(text).toContain('non-zero exit');
      expect(text).toContain('it may already have been stopped');
      expect(text).toContain('it may already have been disabled');
    });

    test('on a non-systemd platform, refuses the migrate and touches nothing', async () => {
      const configManager = new ConfigManager({ workingDir: dir, homeDir: dir, surfaceRoot: 'tui' });
      configManager.setDynamic('service.platform', 'windows');
      const { runner, calls } = fakeMigrationRunner();
      const result = await runDaemonServiceCli(
        baseInput({ legacyUnitFileExists: () => true, actionRunner: runner, confirmMigration: true, configManager }),
      );

      expect(result.ok).toBe(false);
      expect(result.lines.join('\n')).toContain('not systemd');
      expect(calls.some((c) => c.includes('enable') || c.includes('stop') || c.includes('disable'))).toBe(false);
    });
  });
});

describe('buildInstallResultLines — "suggested follow-ups" gating (W3 Finding 4 friction fix)', () => {
  function fakeStatus(overrides: Partial<Parameters<typeof buildInstallResultLines>[0]> = {}): Parameters<typeof buildInstallResultLines>[0] {
    return {
      platform: 'systemd',
      path: '/home/user/.config/systemd/user/goodvibes.service',
      installed: true,
      autostart: true,
      running: false,
      commandPreview: '/usr/local/bin/goodvibes-daemon',
      suggestedCommands: ['systemctl --user daemon-reload', 'systemctl --user enable --now goodvibes.service', 'systemctl --user status goodvibes.service'],
      lastAction: 'install',
      ...overrides,
    };
  }

  test('running: true — "service is enabled and running", no "suggested follow-ups" block (it already started)', () => {
    const lines = buildInstallResultLines(fakeStatus({ running: true }));

    expect(lines).toContain('service is enabled and running');
    expect(lines.some((line) => line.includes('suggested follow-ups'))).toBe(false);
  });

  test('running: false — keeps the "suggested follow-ups" block, no false claim that it is running', () => {
    const lines = buildInstallResultLines(fakeStatus({ running: false }));

    expect(lines).not.toContain('service is enabled and running');
    expect(lines.some((line) => line.includes('suggested follow-ups'))).toBe(true);
    expect(lines.some((line) => line.includes('systemctl --user daemon-reload'))).toBe(true);
  });
});
