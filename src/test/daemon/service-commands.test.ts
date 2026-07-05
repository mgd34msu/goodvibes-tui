import { describe, expect, test } from 'bun:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  isDaemonServiceSubcommand,
  resolveInstalledDaemonBinary,
  runDaemonServiceCli,
} from '../../daemon/service-commands.ts';
import type { SystemctlRunner, SystemctlResult } from '@pellux/goodvibes-sdk/platform/daemon';

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

describe('runDaemonServiceCli (stubbed systemctl — never touches the host)', () => {
  function recordingRunner(): { runner: SystemctlRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: SystemctlRunner = (args) => {
      calls.push([...args]);
      return { status: 0 } satisfies SystemctlResult;
    };
    return { runner, calls };
  }

  test('install-service writes the unit and enables it via systemctl', () => {
    const { runner, calls } = recordingRunner();
    const writes: string[] = [];
    const result = runDaemonServiceCli({
      subcommand: 'install-service',
      binaryPath: '/usr/local/bin/goodvibes-daemon',
      homeDir: '/home/tester',
      host: '127.0.0.1',
      port: 3421,
      env: { platform: 'linux', runSystemctl: runner, writeUnitFile: (p) => writes.push(p) },
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(writes).toEqual(['/home/tester/.config/systemd/user/goodvibes-daemon.service']);
    expect(calls).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', '--now', 'goodvibes-daemon.service'],
    ]);
  });

  test('uninstall-service disables + removes; service-status is read-only', () => {
    const { runner: r1, calls: c1 } = recordingRunner();
    const uninstall = runDaemonServiceCli({
      subcommand: 'uninstall-service',
      binaryPath: 'goodvibes-daemon',
      homeDir: '/home/tester',
      host: '127.0.0.1',
      port: 3421,
      env: { platform: 'linux', runSystemctl: r1, removeUnitFile: () => {}, fileExists: () => true },
    });
    expect(uninstall.ok).toBe(true);
    expect(c1[0]).toEqual(['--user', 'disable', '--now', 'goodvibes-daemon.service']);

    const { runner: r2, calls: c2 } = recordingRunner();
    const status = runDaemonServiceCli({
      subcommand: 'service-status',
      binaryPath: 'goodvibes-daemon',
      homeDir: '/home/tester',
      host: '127.0.0.1',
      port: 3421,
      env: { platform: 'linux', runSystemctl: r2, fileExists: () => false },
    });
    expect(status.supported).toBe(true);
    // Only read-only queries, no mutation.
    expect(c2).toEqual([
      ['--user', 'is-enabled', 'goodvibes-daemon.service'],
      ['--user', 'is-active', 'goodvibes-daemon.service'],
    ]);
  });

  test('non-linux install-service reports honest unsupported, clean non-zero exit', () => {
    let touched = false;
    const result = runDaemonServiceCli({
      subcommand: 'install-service',
      binaryPath: 'goodvibes-daemon',
      homeDir: '/Users/tester',
      host: '127.0.0.1',
      port: 3421,
      env: { platform: 'darwin', runSystemctl: () => { touched = true; return { status: 0 }; }, writeUnitFile: () => { touched = true; } },
    });
    expect(result.supported).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(touched).toBe(false);
    expect(result.lines[0]).toContain('not supported yet on darwin');
  });
});
