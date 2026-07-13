import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { PlatformServiceManager } from '@pellux/goodvibes-sdk/platform/daemon';

describe('PlatformServiceManager', () => {
  let root = '';
  const testTmpRoot = join(import.meta.dir, '../../../.tmp-tests');

  beforeEach(() => {
    mkdirSync(testTmpRoot, { recursive: true });
    root = mkdtempSync(join(testTmpRoot, 'gv-service-manager-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('installs and uninstalls manual service definitions in the workspace', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui',  workingDir: root, configDir: join(root, '.goodvibes', 'tui') });
    config.set('service.platform', 'manual');
    config.set('service.autostart', true);
    config.set('service.restartOnFailure', true);
    config.set('service.serviceName', 'goodvibes-test');
    config.set('service.logPath', '.goodvibes/tui/service/manual-custom.log');

    const manager = new PlatformServiceManager(config, {
      workingDirectory: root,
      homeDirectory: root,
      surfaceRoot: 'tui',
    });
    const initial = manager.status();
    expect(initial.platform).toBe('manual');
    expect(initial.installed).toBe(false);
    expect(initial.logPath).toBe(join(root, '.goodvibes', 'tui', 'service', 'manual-custom.log'));

    const installed = manager.install();
    expect(installed.installed).toBe(true);
    expect(installed.path).toBe(join(root, '.goodvibes', 'tui', 'service', 'manual-service.txt'));
    expect(installed.contents).toContain('src/daemon/cli.ts');
    expect(installed.commandPreview).toContain('manual-service.txt');

    const removed = manager.uninstall();
    expect(removed.installed).toBe(false);
  });

  test('starts, reports, restarts, and stops manual service processes', async () => {
    const config = new ConfigManager({ surfaceRoot: 'tui',  workingDir: root, configDir: join(root, '.goodvibes', 'tui') });
    config.set('service.platform', 'manual');
    config.set('service.logPath', join(root, '.goodvibes', 'tui', 'service', 'manual.log'));

    const manager = new PlatformServiceManager(config, {
      workingDirectory: root,
      homeDirectory: root,
      surfaceRoot: 'tui',
      definitionOverride: {
        name: 'test-daemon',
        description: 'test daemon',
        workingDirectory: root,
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        env: {},
        restartOnFailure: false,
      },
    });

    const installed = manager.install();
    expect(installed.logPath).toBe(join(root, '.goodvibes', 'tui', 'service', 'manual.log'));
    const started = manager.start();
    expect(started.running).toBe(true);
    expect(typeof started.pid).toBe('number');
    expect(started.logPath).toBe(join(root, '.goodvibes', 'tui', 'service', 'manual.log'));

    const restarted = manager.restart();
    expect(restarted.running).toBe(true);
    expect(typeof restarted.pid).toBe('number');

    const stopped = manager.stop();
    expect(stopped.running).toBe(false);
  });

  test('renders and runs platform commands using the configured service name', () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const config = new ConfigManager({ surfaceRoot: 'tui',  workingDir: root, configDir: join(root, '.goodvibes', 'tui') });
    config.set('service.platform', 'systemd');
    config.set('service.serviceName', 'gv-ops');
    config.set('service.restartOnFailure', false);
    config.set('service.autostart', true);
    config.set('service.logPath', join(root, '.goodvibes', 'tui', 'service', 'systemd.log'));

    const manager = new PlatformServiceManager(config, {
      workingDirectory: root,
      homeDirectory: root,
      surfaceRoot: 'tui',
      actionRunner: (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    const installed = manager.install();
    expect(installed.path.endsWith('gv-ops.service')).toBe(true);
    expect(installed.contents).toContain('Restart=no');
    expect(installed.contents).toContain('ExecStart=');
    expect(installed.logPath).toBe(join(root, '.goodvibes', 'tui', 'service', 'systemd.log'));

    manager.start();
    manager.stop();
    manager.restart();

    // The SDK's status() now honestly queries `systemctl --user is-active`
    // (through the same injected runner), and install() enforces the unit's
    // survival contract via loginctl (show-user probe, enable-linger when
    // lingering is off) so the user unit outlives logout. Filter both out
    // and assert the mutating systemctl action sequence separately.
    const statusQueries = calls.filter((c) => c.args.includes('is-active'));
    const lingerCalls = calls.filter((c) => c.command === 'loginctl');
    for (const call of lingerCalls) {
      expect(['show-user', 'enable-linger']).toContain(call.args[0]!);
    }
    // `systemctl --version` is the SDK's read-only capability probe.
    const actions = calls.filter((c) => !c.args.includes('is-active') && !c.args.includes('--version') && c.command !== 'loginctl');
    expect(actions).toEqual([
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'gv-ops.service'] },
      { command: 'systemctl', args: ['--user', 'stop', 'gv-ops.service'] },
      { command: 'systemctl', args: ['--user', 'restart', 'gv-ops.service'] },
    ]);
    for (const query of statusQueries) {
      expect(query).toEqual({ command: 'systemctl', args: ['--user', 'is-active', 'gv-ops.service'] });
    }
  });

  test('renders launchd and windows service artifacts with the configured service name', () => {
    const launchdCalls: Array<{ command: string; args: readonly string[] }> = [];
    const launchdConfig = new ConfigManager({ surfaceRoot: 'tui',  workingDir: root, configDir: join(root, '.goodvibes', 'tui') });
    launchdConfig.set('service.platform', 'launchd');
    launchdConfig.set('service.serviceName', 'dev.goodvibes.launchd');
    const launchdManager = new PlatformServiceManager(launchdConfig, {
      workingDirectory: root,
      homeDirectory: root,
      surfaceRoot: 'tui',
      actionRunner: (command, args) => {
        launchdCalls.push({ command, args });
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const launchdInstalled = launchdManager.install();
    expect(launchdInstalled.path.endsWith('dev.goodvibes.launchd.plist')).toBe(true);
    expect(launchdInstalled.contents).toContain('<key>Label</key>');
    expect(launchdInstalled.contents).toContain('<string>dev.goodvibes.launchd</string>');
    launchdManager.start();
    launchdManager.stop();
    launchdManager.restart();
    // restart() has no native launchd verb, so it dispatches an honest
    // unload-then-load pair (the unload is best-effort — the agent may not be
    // loaded yet) rather than a bare `load`, matching suggestedCommands()'
    // human-facing `launchctl unload <path> || true` / `launchctl load <path>`.
    // Filter out the SDK status()'s read-only `launchctl list` probes, same
    // rationale as the systemd case above.
    const launchdActions = launchdCalls.filter((c) => c.args[0] !== 'list');
    expect(launchdActions).toEqual([
      { command: 'launchctl', args: ['load', launchdInstalled.path] },
      { command: 'launchctl', args: ['unload', launchdInstalled.path] },
      { command: 'launchctl', args: ['unload', launchdInstalled.path] },
      { command: 'launchctl', args: ['load', launchdInstalled.path] },
    ]);

    const windowsCalls: Array<{ command: string; args: readonly string[] }> = [];
    const windowsConfig = new ConfigManager({ surfaceRoot: 'tui',  workingDir: root, configDir: join(root, '.goodvibes', 'tui') });
    windowsConfig.set('service.platform', 'windows');
    windowsConfig.set('service.serviceName', 'GoodVibesTask');
    const windowsManager = new PlatformServiceManager(windowsConfig, {
      workingDirectory: root,
      homeDirectory: root,
      surfaceRoot: 'tui',
      actionRunner: (command, args) => {
        windowsCalls.push({ command, args });
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    const windowsInstalled = windowsManager.install();
    expect(windowsInstalled.contents).toContain('schtasks /Create /SC ONLOGON /TN "GoodVibesTask"');
    windowsManager.start();
    windowsManager.stop();
    windowsManager.restart();

    expect(windowsCalls).toEqual([
      { command: 'schtasks', args: ['/Run', '/TN', 'GoodVibesTask'] },
      { command: 'schtasks', args: ['/End', '/TN', 'GoodVibesTask'] },
      { command: 'schtasks', args: ['/Run', '/TN', 'GoodVibesTask'] },
    ]);
  });
});
