import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  resolveConfiguredServiceName,
  reconcileRedundantLegacyUnit,
  buildManagedDaemonServiceManager,
  legacyUnitPath,
  INSTALLER_UNIT_MARKER,
  LEGACY_SERVICE_UNIT_NAME,
  MANAGED_SERVICE_NAME,
  type ManagedServiceActionRunner as RuntimeActionRunner,
} from '../../runtime/legacy-daemon-migration.ts';
import { resolveRuntimeEndpointBinding } from '../../cli/endpoints.ts';

describe('resolveConfiguredServiceName — config-honest name for pre-manager callers', () => {
  function config(value: unknown): { get(key: string): unknown } {
    return { get: (key: string) => (key === 'service.serviceName' ? value : undefined) };
  }

  test('returns the service.serviceName config value when set', () => {
    expect(resolveConfiguredServiceName(config('my-custom-unit'))).toBe('my-custom-unit');
  });

  test('trims whitespace around a configured value', () => {
    expect(resolveConfiguredServiceName(config('  my-custom-unit  '))).toBe('my-custom-unit');
  });

  test('falls back to the managed default when unset, null, or blank', () => {
    expect(resolveConfiguredServiceName(config(undefined))).toBe('goodvibes');
    expect(resolveConfiguredServiceName(config(null))).toBe('goodvibes');
    expect(resolveConfiguredServiceName(config('   '))).toBe('goodvibes');
  });
});

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
 * `PlatformServiceManager` (rewired here after the SDK deleted the old
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
    // No endpoint flags are baked into ExecStart: the daemon resolves
    // controlPlane.hostMode/host/port from settings at boot, so a config
    // change (or a non-default endpoint) never requires a unit rewrite and
    // can never be silently reverted by one.
    expect(contents).not.toContain('--hostname');
    expect(contents).not.toContain('--port');
    // install() only writes the file; install-service also calls start() to
    // preserve the old shim's "install implies enabled + running" behavior.
    // The SDK's status() now also issues read-only `is-active` probes, and
    // install() enforces the unit's survival contract via loginctl
    // (show-user probe, enable-linger when lingering is off) — filter both
    // out of the mutating action check and pin the linger calls' shape.
    const lingerCalls = calls.filter((c) => c[0] === 'loginctl');
    for (const call of lingerCalls) {
      expect(['show-user', 'enable-linger']).toContain(call[1]!);
    }
    // `systemctl --version` is the SDK's read-only capability probe.
    const actions = calls.filter((c) => !c.includes('is-active') && !c.includes('--version') && c[0] !== 'loginctl');
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
    // An earlier finding: the old wording asserted HOW `running` was computed
    // ("only reflects processes this tool started directly") — true for the
    // pid-file-only check this (currently linked) SDK build still uses, but
    // stale once the parallel SDK batch makes status().running query systemd
    // honestly via `is-active`. The caveat now just offers the escape hatch
    // without asserting a mechanism, so it stays true either way.
    expect(result.lines.some((line) => line.includes('verify directly'))).toBe(true);
  });
});

/**
 * Legacy-unit detection (`goodvibes-daemon.service`, the prior
 * command's literal unit name — distinct from this module's tracked
 * `goodvibes.service`). Both the file-existence check and the `is-active`
 * query are fully faked here: `legacyUnitFileExists` never touches the real
 * `~/.config/systemd/user`, and the `is-active` query goes through the same
 * injected `actionRunner` used above — this suite never touches, stops, or
 * modifies a real running service.
 */
describe('runDaemonServiceCli — install-script unit detection', () => {
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
    test('custom service.serviceName: the install-script unit note names the custom unit, not the hardcoded default', async () => {
      const configManager = new ConfigManager({ workingDir: dir, homeDir: dir, surfaceRoot: 'tui' });
      configManager.setDynamic('service.serviceName', 'my-custom-unit');
      const { runner } = fakeRunner(0, 'active');
      const result = await runDaemonServiceCli(
        baseInput({ legacyUnitFileExists: () => true, actionRunner: runner, configManager }),
      );

      const text = result.lines.join('\n');
      expect(text).toContain('this tool manages my-custom-unit.service');
      expect(text).not.toContain('this tool manages goodvibes.service');
    });

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
      expect(text).toContain('named goodvibes-daemon.service');
      expect(text).toContain('installed and RUNNING');
      expect(text).toContain('will not touch the other unit automatically');
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
    test('custom service.serviceName: refusal message names the custom unit, not the hardcoded default', async () => {
      const configManager = new ConfigManager({ workingDir: dir, homeDir: dir, surfaceRoot: 'tui' });
      configManager.setDynamic('service.serviceName', 'my-custom-unit');
      const { runner } = fakeRunner(0, 'active');
      const result = await runDaemonServiceCli(
        baseInput({ subcommand: 'install-service', legacyUnitFileExists: () => true, actionRunner: runner, configManager }),
      );

      expect(result.ok).toBe(false);
      const text = result.lines.join('\n');
      expect(text).toContain("Installing this tool's my-custom-unit.service alongside it");
      expect(text).not.toContain("Installing this tool's goodvibes.service alongside it");
    });

    test('legacy unit present: refuses rather than risk a second daemon, never writes the new unit', async () => {
      const { runner, calls } = fakeRunner(0, 'active');
      const result = await runDaemonServiceCli(baseInput({ subcommand: 'install-service', legacyUnitFileExists: () => true, actionRunner: runner }));

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).toContain('goodvibes-daemon.service (the unit name the goodvibes install script manages)');
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
    test('custom service.serviceName: the install-script unit note names the custom unit, not the hardcoded default', async () => {
      const configManager = new ConfigManager({ workingDir: dir, homeDir: dir, surfaceRoot: 'tui' });
      configManager.setDynamic('service.serviceName', 'my-custom-unit');
      await runDaemonServiceCli(
        baseInput({ subcommand: 'install-service', legacyUnitFileExists: () => false, actionRunner: fakeRunner(0, 'active').runner, configManager }),
      );
      const { runner } = fakeRunner(0, 'active');
      const result = await runDaemonServiceCli(
        baseInput({ subcommand: 'uninstall-service', legacyUnitFileExists: () => true, actionRunner: runner, configManager }),
      );

      expect(result.ok).toBe(true);
      const text = result.lines.join('\n');
      expect(text).toContain('this tool manages my-custom-unit.service');
      expect(text).not.toContain('this tool manages goodvibes.service');
    });

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
      expect(text).toContain('named goodvibes-daemon.service');
      expect(text).toContain('will not touch the other unit automatically');
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
 * The guided, consented `migrate-service` takeover of the legacy
 * `goodvibes-daemon.service` unit. Every step (legacy stop/disable/remove,
 * daemon-reload) goes through the SAME injected `actionRunner`/
 * `legacyUnitFileRemove`/`legacyUnitFileExists`/`portProbe` seams the rest of
 * this suite uses — this describe block never touches a real port, a real
 * systemd unit, or a real filesystem path outside the per-test tempdir.
 */
describe('runDaemonServiceCli — migrate-service', () => {
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
      expect(text).toContain('named goodvibes-daemon.service');
      expect(text).toContain('dry run');
      expect(text).toContain('install and start the new goodvibes.service unit');
      expect(text).toContain('stop, disable, and remove the install-script');
      expect(text).toContain('Nothing has been changed');
      expect(existsSync(join(dir, '.config', 'systemd', 'user', 'goodvibes.service'))).toBe(false);
      // The only tracked-unit traffic allowed here is a read-only status
      // probe (used to confirm this host is even on the systemd path before
      // printing the plan) — never a mutating action.
      const trackedCalls = calls.filter((c) => !c.includes('goodvibes-daemon.service'));
      for (const call of trackedCalls) expect(call).toEqual(['systemctl', '--user', 'is-active', 'goodvibes.service']);
      expect(calls.some((c) => c.includes('enable') || c.includes('stop') || c.includes('disable'))).toBe(false);
    });

    test('custom (non-colliding) service.serviceName: the plan names the custom unit, not the hardcoded default', async () => {
      const configManager = new ConfigManager({ workingDir: dir, homeDir: dir, surfaceRoot: 'tui' });
      configManager.setDynamic('service.serviceName', 'my-custom-unit');
      const { runner } = fakeMigrationRunner();
      const result = await runDaemonServiceCli(
        baseInput({ legacyUnitFileExists: () => true, actionRunner: runner, configManager }),
      );

      expect(result.ok).toBe(true);
      const text = result.lines.join('\n');
      expect(text).toContain('this tool manages my-custom-unit.service');
      expect(text).toContain('install and start the new my-custom-unit.service unit');
      expect(text).not.toContain('goodvibes.service');
    });
  });

  /**
   * A host whose `service.serviceName` config key is set to the legacy
   * unit's own literal name (`goodvibes-daemon`) makes `PlatformServiceManager`
   * resolve install()/uninstall()'s mutation PATH to the exact legacy unit
   * path (the SDK's `resolveServiceName()` reads that config key ahead of the
   * `defaultServiceName` this module passes, never consulting
   * `definitionOverride.name`). Without a pre-flight guard, `install()` would
   * overwrite the legacy unit file and a failed-health rollback
   * (`uninstall()`) would DELETE it while the engine's own lines still
   * claimed "never touched." These tests drive that exact colliding config
   * and assert the migration aborts before any mutation, on both the
   * confirmed and dry-run paths.
   */
  describe('legacy unit present, service.serviceName config collides with the legacy unit name (F1)', () => {
    function collidingConfigManager(): ConfigManager {
      const configManager = new ConfigManager({ workingDir: dir, homeDir: dir, surfaceRoot: 'tui' });
      configManager.setDynamic('service.serviceName', 'goodvibes-daemon');
      return configManager;
    }

    test('confirmed: aborts before any mutation, the message names the colliding config key and its value', async () => {
      const { runner, calls } = fakeMigrationRunner();
      const result = await runDaemonServiceCli(
        baseInput({
          legacyUnitFileExists: () => true,
          actionRunner: runner,
          confirmMigration: true,
          configManager: collidingConfigManager(),
        }),
      );

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      const text = result.lines.join('\n');
      expect(text).toContain('service.serviceName');
      expect(text).toContain("resolves to 'goodvibes-daemon'");
      expect(text).toContain('goodvibes-daemon.service');
      expect(text).toContain('nothing has been changed');
      // Zero mutating calls anywhere — only read-only is-active probes (from
      // detectLegacyUnit's own check and manager.status()) are allowed.
      expect(calls.some((c) => c.includes('enable') || c.includes('stop') || c.includes('disable'))).toBe(false);
      // Never wrote (or would-be-overwrote) the colliding path.
      expect(existsSync(join(dir, '.config', 'systemd', 'user', 'goodvibes-daemon.service'))).toBe(false);
    });

    test('declined (dry run): also aborts — a colliding config makes even the printed plan unsafe to execute', async () => {
      const { runner, calls } = fakeMigrationRunner();
      const result = await runDaemonServiceCli(
        baseInput({
          legacyUnitFileExists: () => true,
          actionRunner: runner,
          confirmMigration: false,
          configManager: collidingConfigManager(),
        }),
      );

      expect(result.ok).toBe(false);
      const text = result.lines.join('\n');
      expect(text).not.toContain('dry run');
      expect(text).toContain('service.serviceName');
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
      expect(text).toContain('install-script');
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

/**
 * The unattended startup reconcile (`reconcileRedundantLegacyUnit`) — the fix
 * for the production incident where an installer-managed legacy
 * `goodvibes-daemon.service` sat ENABLED alongside the canonical, ENABLED +
 * ACTIVE `goodvibes.service` and nothing ever disabled it. Every side effect
 * goes through injected seams: the `is-active`/MainPID probes and
 * disable/daemon-reload through a fake `actionRunner`, file
 * existence/read/remove and process-liveness/cgroup checks through fakes —
 * this suite never touches a real service or a real ~/.config/systemd/user
 * unit. (The one exception, clearly marked, is the default-runner timeout
 * test, which spawns a deliberately-hanging FAKE systemctl from a scratch dir.)
 */
describe('reconcileRedundantLegacyUnit — auto-retire a redundant install-script unit at startup', () => {
  const HOME = '/home/mike';
  const LEGACY_PATH = legacyUnitPath(HOME);
  const OWN_PID = 999_999;
  const CANONICAL_PID = 4242;

  interface FakeRunnerOptions {
    readonly canonicalActive?: boolean;
    readonly canonicalMainPid?: number;
    readonly legacyMainPid?: number;
    readonly disableStatus?: number | null;
    /** Reply to the post-timeout is-enabled re-inspection. */
    readonly isEnabledReply?: { status: number | null; stdout?: string };
  }

  /** A recording runner answering is-active/MainPID/is-enabled probes and disable/daemon-reload. */
  function fakeReconcileRunner(opts: FakeRunnerOptions = {}): { runner: RuntimeActionRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: RuntimeActionRunner = (command, args) => {
      calls.push([command, ...args]);
      if (args.includes('is-active')) {
        return (opts.canonicalActive ?? true) ? { status: 0, stdout: 'active\n' } : { status: 3, stdout: 'inactive\n' };
      }
      if (args.includes('is-enabled')) {
        return (opts.isEnabledReply ?? { status: 0, stdout: 'enabled\n' }) as ReturnType<RuntimeActionRunner>;
      }
      if (args.includes('MainPID')) {
        const unit = args[args.length - 1] ?? '';
        const pid = unit === `${LEGACY_SERVICE_UNIT_NAME}.service`
          ? (opts.legacyMainPid ?? 0)
          : (opts.canonicalMainPid ?? CANONICAL_PID);
        return { status: 0, stdout: `${pid}\n` };
      }
      if (args.includes('disable')) {
        return { status: opts.disableStatus === undefined ? 0 : opts.disableStatus } as ReturnType<RuntimeActionRunner>;
      }
      return { status: 0 };
    };
    return { runner, calls };
  }

  /** Base input with every guard seam injected to a safe, deterministic answer.
   * The legacy MainPID default (0) plus `processAlive` keyed off the canonical
   * pid model the incident state: canonical serving, legacy enabled-but-idle. */
  function baseReconcileInput(
    overrides: Partial<Parameters<typeof reconcileRedundantLegacyUnit>[0]> = {},
  ): Parameters<typeof reconcileRedundantLegacyUnit>[0] {
    return {
      homeDir: HOME,
      trackedServiceName: MANAGED_SERVICE_NAME,
      legacyUnitFileExists: () => true,
      legacyUnitFileRead: () => `# ${INSTALLER_UNIT_MARKER}\n[Service]\nExecStart=/x/goodvibes-daemon\n`,
      processAlive: () => true,
      ownPid: OWN_PID,
      readOwnCgroup: () => `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${MANAGED_SERVICE_NAME}.service`,
      configuredEndpoint: { host: '127.0.0.1', port: 3421 },
      endpointProbe: () => true,
      ...overrides,
    };
  }

  test('exact incident state: canonical serving, legacy marker-managed and NOT running → disabled, removed, receipt printed', async () => {
    const { runner, calls } = fakeReconcileRunner();
    const removed: string[] = [];
    const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
      legacyUnitFileRemove: (p) => removed.push(p),
      actionRunner: runner,
    }));

    expect(result.action).toBe('removed');
    expect(result.reason).toBe('retired');
    // The legacy unit file was removed via the injected seam.
    expect(removed).toEqual([LEGACY_PATH]);
    // It probed the CANONICAL unit's activeness + MainPID, then disabled the LEGACY one.
    expect(calls).toContainEqual(['systemctl', '--user', 'is-active', `${MANAGED_SERVICE_NAME}.service`]);
    expect(calls).toContainEqual(['systemctl', '--user', 'show', '-p', 'MainPID', '--value', `${MANAGED_SERVICE_NAME}.service`]);
    expect(calls).toContainEqual(['systemctl', '--user', 'disable', '--now', `${LEGACY_SERVICE_UNIT_NAME}.service`]);
    expect(calls).toContainEqual(['systemctl', '--user', 'daemon-reload']);
    // Honest receipt.
    expect(result.lines.join('\n')).toContain(`redundant installer-managed ${LEGACY_SERVICE_UNIT_NAME}.service`);
    expect(result.lines.join('\n')).toContain('disabled and removed');
  });

  test('wrong-port dual-daemon state: a RUNNING legacy daemon is never stopped by the unattended reconcile', async () => {
    // Pins the verifier's wrong-port probe: canonical alive on its own port,
    // legacy MainPID a LIVE process serving the endpoint clients actually
    // resolve. The old guards passed and disable--now'd the daemon clients
    // use; the unattended path must refuse and defer to migrate-service.
    const { runner, calls } = fakeReconcileRunner({ legacyMainPid: 555 });
    const removed: string[] = [];
    const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
      legacyUnitFileRemove: (p) => removed.push(p),
      actionRunner: runner,
    }));

    expect(result.action).toBe('noop');
    expect(result.reason).toBe('legacy-running');
    expect(removed).toEqual([]);
    expect(calls.some((c) => c.includes('disable'))).toBe(false);
    const text = result.lines.join('\n');
    expect(text).toContain('live main process');
    expect(text).toContain('migrate-service');
  });

  test('configured endpoint not answering → refuses: a canonical daemon alive on the WRONG port proves nothing for clients', async () => {
    // Pins the endpoint half of the wrong-port state: legacy idle, canonical
    // alive, but nothing serves what clients resolve from settings.json.
    const { runner, calls } = fakeReconcileRunner();
    const removed: string[] = [];
    const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
      configuredEndpoint: { host: '127.0.0.1', port: 3500 },
      endpointProbe: () => false,
      legacyUnitFileRemove: (p) => removed.push(p),
      actionRunner: runner,
    }));

    expect(result.action).toBe('noop');
    expect(result.reason).toBe('configured-endpoint-unserved');
    expect(removed).toEqual([]);
    expect(calls.some((c) => c.includes('disable'))).toBe(false);
    expect(result.lines.join('\n')).toContain('127.0.0.1:3500');
  });

  test('hand-written legacy unit (no marker) is never removed — a one-line actionable notice instead', async () => {
    const { runner, calls } = fakeReconcileRunner();
    const removed: string[] = [];
    const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
      legacyUnitFileRead: () => '[Service]\nExecStart=/opt/custom/goodvibes-daemon\n',
      legacyUnitFileRemove: (p) => removed.push(p),
      actionRunner: runner,
    }));

    expect(result.action).toBe('notice');
    expect(result.reason).toBe('hand-written');
    expect(removed).toEqual([]); // never removed
    // Never issued a disable for a hand-written unit.
    expect(calls.some((c) => c.includes('disable'))).toBe(false);
    expect(result.lines.join('\n')).toContain('hand-written (no installer marker)');
    expect(result.lines.join('\n')).toContain(`disable --now ${LEGACY_SERVICE_UNIT_NAME}.service`);
  });

  test('an UNREADABLE legacy unit file is reported as unreadable — never misdiagnosed as hand-written', async () => {
    // Reproduces the verifier's chmod-000/root-owned probe: existsSync sees
    // the file, readFileSync throws EACCES. The old code printed "It is
    // hand-written (no installer marker)" — a false provenance claim about a
    // file whose contents (which DO carry the marker) were never read.
    const { runner, calls } = fakeReconcileRunner();
    const removed: string[] = [];
    const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
      legacyUnitFileRead: () => {
        throw Object.assign(new Error(`EACCES: permission denied, open '${LEGACY_PATH}'`), { code: 'EACCES' });
      },
      legacyUnitFileRemove: (p) => removed.push(p),
      actionRunner: runner,
    }));

    expect(result.action).toBe('notice');
    expect(result.reason).toBe('marker-unreadable');
    expect(removed).toEqual([]); // fail closed
    expect(calls.some((c) => c.includes('disable'))).toBe(false);
    expect(result.lines.join('\n')).toContain('could not be read');
    expect(result.lines.join('\n')).not.toContain('hand-written');
  });

  test('canonical NOT active → refuses with a breadcrumb: the legacy unit might be the only daemon', async () => {
    const { runner, calls } = fakeReconcileRunner({ canonicalActive: false });
    const removed: string[] = [];
    const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
      legacyUnitFileRemove: (p) => removed.push(p),
      actionRunner: runner,
    }));

    expect(result.action).toBe('noop');
    expect(result.reason).toBe('canonical-not-active');
    // Refusals carry a line so a persisting two-unit state is never silent.
    expect(result.lines.length).toBeGreaterThan(0);
    expect(removed).toEqual([]);
    expect(calls.some((c) => c.includes('disable'))).toBe(false);
    expect(calls.some((c) => c.includes('daemon-reload'))).toBe(false);
  });

  test("canonical reports active but its MainPID is 0 → refuses ('active' from a Type=simple unit is not proof of serving)", async () => {
    // Reproduces the verifier's crash-loop window: is-active says 'active'
    // (Type=simple reports active from fork onward) while no live main
    // process exists. The old guard authorized disable/remove here.
    const { runner, calls } = fakeReconcileRunner({ canonicalMainPid: 0 });
    const removed: string[] = [];
    const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
      legacyUnitFileRemove: (p) => removed.push(p),
      actionRunner: runner,
    }));

    expect(result.action).toBe('noop');
    expect(result.reason).toBe('canonical-mainpid-not-alive');
    expect(removed).toEqual([]);
    expect(calls.some((c) => c.includes('disable'))).toBe(false);
  });

  test('canonical MainPID resolves but the process is dead → refuses', async () => {
    const { runner, calls } = fakeReconcileRunner({ canonicalMainPid: 777 });
    const removed: string[] = [];
    const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
      processAlive: () => false,
      legacyUnitFileRemove: (p) => removed.push(p),
      actionRunner: runner,
    }));

    expect(result.action).toBe('noop');
    expect(result.reason).toBe('canonical-mainpid-not-alive');
    expect(removed).toEqual([]);
    expect(calls.some((c) => c.includes('disable'))).toBe(false);
  });

  test('refuses to disable the unit supervising THIS process (legacy MainPID == own pid) — never SIGTERMs itself', async () => {
    // Reproduces the verifier's self-kill scenario: the currently-booting
    // daemon was launched BY the legacy unit; `disable --now` on it would
    // SIGTERM this process's own cgroup mid-boot from inside the blocking
    // systemctl call.
    const { runner, calls } = fakeReconcileRunner({ legacyMainPid: OWN_PID });
    const removed: string[] = [];
    const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
      legacyUnitFileRemove: (p) => removed.push(p),
      actionRunner: runner,
    }));

    expect(result.action).toBe('noop');
    expect(result.reason).toBe('self-supervised-by-legacy');
    expect(removed).toEqual([]);
    expect(calls.some((c) => c.includes('disable'))).toBe(false);
    expect(result.lines.join('\n')).toContain('refusing to disable');
  });

  test('refuses when /proc/self/cgroup names the legacy unit, even if the MainPID probe is inconclusive', async () => {
    const { runner, calls } = fakeReconcileRunner({ legacyMainPid: 0 });
    const removed: string[] = [];
    const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
      readOwnCgroup: () => `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${LEGACY_SERVICE_UNIT_NAME}.service`,
      legacyUnitFileRemove: (p) => removed.push(p),
      actionRunner: runner,
    }));

    expect(result.action).toBe('noop');
    expect(result.reason).toBe('self-supervised-by-legacy');
    expect(removed).toEqual([]);
    expect(calls.some((c) => c.includes('disable'))).toBe(false);
  });

  test('a FAILED disable (nonzero exit) leaves the unit file in place and never prints a false success receipt', async () => {
    // Reproduces the verifier's dangling-symlink scenario: disable --now
    // exits non-zero (bus hiccup); the old code removed the unit file anyway
    // and claimed success, leaving an enabled symlink pointing at nothing —
    // unrecoverable by the next reconcile pass (which noops on file-absent).
    const { runner, calls } = fakeReconcileRunner({ disableStatus: 1 });
    const removed: string[] = [];
    const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
      legacyUnitFileRemove: (p) => removed.push(p),
      actionRunner: runner,
    }));

    expect(result.action).toBe('failed');
    expect(result.reason).toBe('disable-failed');
    expect(removed).toEqual([]); // the unit file was NOT removed
    // No daemon-reload after a failed disable — nothing was changed.
    expect(calls.some((c) => c.includes('daemon-reload'))).toBe(false);
    const text = result.lines.join('\n');
    expect(text).toContain('reported failure');
    expect(text).toContain('this tool removed nothing');
    expect(text).not.toContain('disabled and removed');
  });

  test('a TIMED-OUT disable whose re-inspection CONFIRMS the unit is disabled proceeds, saying the stop may still be completing', async () => {
    // Pins the verifier's >5s-stop probe: `disable --now` removes the
    // enablement symlinks synchronously, THEN blocks on the stop job; a
    // client timeout does not undo the disable. The old code printed
    // 'could not disable ... nothing was removed' — false on both counts.
    const { runner } = fakeReconcileRunner({
      disableStatus: null,
      isEnabledReply: { status: 1, stdout: 'disabled\n' },
    });
    const removed: string[] = [];
    const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
      legacyUnitFileRemove: (p) => removed.push(p),
      actionRunner: runner,
    }));

    expect(result.action).toBe('removed');
    expect(result.reason).toBe('retired');
    expect(removed).toEqual([LEGACY_PATH]);
    const text = result.lines.join('\n');
    expect(text).toContain('timed out');
    expect(text).toContain('re-inspection confirms');
    expect(text).toContain('stop may still be completing');
    expect(text).not.toContain('could not disable');
  });

  test('a TIMED-OUT disable whose outcome CANNOT be re-confirmed reports UNKNOWN — never a blanket denial', async () => {
    const { runner } = fakeReconcileRunner({
      disableStatus: null,
      isEnabledReply: { status: null },
    });
    const removed: string[] = [];
    const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
      legacyUnitFileRemove: (p) => removed.push(p),
      actionRunner: runner,
    }));

    expect(result.action).toBe('failed');
    expect(result.reason).toBe('disable-timeout');
    expect(removed).toEqual([]);
    const text = result.lines.join('\n');
    expect(text).toContain('UNKNOWN');
    expect(text).toContain('timed out');
    expect(text).not.toContain('could not disable');
  });

  test('no legacy unit present → noop, and it does not even probe systemd', async () => {
    const { runner, calls } = fakeReconcileRunner();
    const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
      legacyUnitFileExists: () => false,
      actionRunner: runner,
    }));

    expect(result.action).toBe('noop');
    expect(result.reason).toBe('no-legacy-unit');
    expect(result.lines).toEqual([]);
    expect(calls).toEqual([]); // short-circuits before any systemctl call
  });

  test('default runner is hard-timeout-bounded: a hanging systemctl (wedged user bus) degrades to a fast refusal, never a boot hang', async () => {
    // Reproduces the verifier's frozen-event-loop probe: a fake systemctl on
    // PATH that sleeps forever. Without a spawnSync timeout the reconcile
    // blocked the daemon's event loop indefinitely; with it, the probe times
    // out (status null) and the guard refuses within the bound.
    const dir = mkdtempSync(join(tmpdir(), 'gv-reconcile-timeout-'));
    const stub = join(dir, 'systemctl');
    writeFileSync(stub, '#!/bin/sh\nsleep 30\n');
    chmodSync(stub, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${dir}:${previousPath ?? ''}`;
    try {
      const startedAt = Date.now();
      const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
        // No actionRunner: exercises the DEFAULT spawnSync runner against the
        // hanging stub, with a short injected timeout to keep the suite fast.
        systemctlTimeoutMs: 500,
      }));
      const elapsedMs = Date.now() - startedAt;

      expect(result.action).toBe('noop');
      expect(result.reason).toBe('canonical-not-active'); // timed-out probe = not provably active
      expect(elapsedMs).toBeLessThan(10_000); // bounded, not the stub's 30s hang
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('one CUMULATIVE deadline covers the whole pass: once exceeded, remaining calls are skipped with a notice', async () => {
    // Pins the degraded-bus (slow-but-completing) shape: per-call timeouts
    // alone let ~5 sequential calls stack up. With the pass deadline already
    // exhausted, every call is skipped outright and the refusal says so.
    const removed: string[] = [];
    const result = await reconcileRedundantLegacyUnit(baseReconcileInput({
      deadlineMs: 0,
      legacyUnitFileRemove: (p) => removed.push(p),
      // No actionRunner: the deadline wrapper must skip the DEFAULT runner's
      // calls before any child process is spawned.
    }));

    expect(result.action).toBe('noop');
    expect(result.reason).toBe('canonical-not-active');
    expect(removed).toEqual([]);
    expect(result.lines.join('\n')).toContain('time budget');
  });
});

/**
 * Unit-content parity (installer vs product) on a NON-DEFAULT config fixture:
 * both writers must produce the same ExecStart shape — the daemon binary plus
 * `--daemon-home <home>` and NOTHING else. Neither may bake the configured
 * endpoint into the unit: the daemon resolves controlPlane at boot, which is
 * exactly how a hostMode=network / port-3500 host keeps its endpoint across
 * upgrades instead of being silently re-pinned to installer constants.
 */
describe('canonical unit content parity — installer and product agree, endpoint comes from config at boot', () => {
  test('product-written unit on a hostMode=network/port-3500 fixture bakes no endpoint; boot-time resolution yields the configured endpoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-unit-parity-'));
    try {
      const configManager = new ConfigManager({ workingDir: dir, homeDir: dir, surfaceRoot: 'tui' });
      configManager.setDynamic('controlPlane.hostMode', 'network');
      configManager.setDynamic('controlPlane.port', 3500);

      const manager = buildManagedDaemonServiceManager({
        binaryPath: '/usr/local/bin/goodvibes-daemon',
        homeDir: dir,
        host: '0.0.0.0',
        port: 3500,
        configManager,
        actionRunner: () => ({ status: 0 }),
      });
      const installed = manager.install();
      expect(installed.actionError).toBeUndefined();
      const productUnit = readFileSync(join(dir, '.config', 'systemd', 'user', 'goodvibes.service'), 'utf-8');
      const productExec = productUnit.split('\n').find((l) => l.startsWith('ExecStart=')) ?? '';

      // The product unit: binary + --daemon-home only — no endpoint flags, no
      // endpoint VALUES.
      const productArgs = productExec.replace('ExecStart=', '').split(/\s+/).slice(1);
      expect(productArgs).toEqual(['--daemon-home', dir]);
      expect(productUnit).not.toContain('--hostname');
      expect(productUnit).not.toContain('--port');
      expect(productUnit).not.toContain('3500');
      expect(productUnit).not.toContain('0.0.0.0');

      // The endpoint LIVES in config, resolved by the daemon at boot: the
      // boot-time resolution on this fixture is the configured endpoint, for
      // a unit written by either path.
      const bootBinding = resolveRuntimeEndpointBinding(configManager, 'controlPlane');
      expect(bootBinding.host).toBe('0.0.0.0');
      expect(bootBinding.port).toBe(3500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
