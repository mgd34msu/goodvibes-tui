import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../config/manager.ts';
import { PlatformServiceManager } from '../../daemon/service-manager.ts';

describe('PlatformServiceManager', () => {
  const originalCwd = process.cwd();
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-service-manager-'));
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  test('installs and uninstalls manual service definitions in the workspace', () => {
    const config = new ConfigManager({ workingDir: root, configDir: join(root, '.goodvibes', 'tui') });
    config.set('service.platform', 'manual');
    config.set('service.autostart', true);
    config.set('service.restartOnFailure', true);
    config.set('service.serviceName', 'goodvibes-test');
    config.set('service.logPath', join(root, '.goodvibes', 'tui', 'service', 'manual-custom.log'));

    const manager = new PlatformServiceManager(config);
    const initial = manager.status();
    expect(initial.platform).toBe('manual');
    expect(initial.installed).toBe(false);
    expect(initial.logPath).toBe(join(root, '.goodvibes', 'tui', 'service', 'manual-custom.log'));

    const installed = manager.install();
    expect(installed.installed).toBe(true);
    expect(installed.path).toContain('.goodvibes');
    expect(installed.contents).toContain('src/daemon/cli.ts');
    expect(installed.commandPreview).toContain('manual-service.txt');

    const removed = manager.uninstall();
    expect(removed.installed).toBe(false);
  });

  test('starts, reports, restarts, and stops manual service processes', async () => {
    const config = new ConfigManager({ workingDir: root, configDir: join(root, '.goodvibes', 'tui') });
    config.set('service.platform', 'manual');
    config.set('service.logPath', join(root, '.goodvibes', 'tui', 'service', 'manual.log'));

    const manager = new PlatformServiceManager(config, {
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
    const config = new ConfigManager({ workingDir: root, configDir: join(root, '.goodvibes', 'tui') });
    config.set('service.platform', 'systemd');
    config.set('service.serviceName', 'gv-ops');
    config.set('service.restartOnFailure', false);
    config.set('service.autostart', true);
    config.set('service.logPath', join(root, '.goodvibes', 'tui', 'service', 'systemd.log'));

    const manager = new PlatformServiceManager(config, {
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

    expect(calls).toEqual([
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'gv-ops.service'] },
      { command: 'systemctl', args: ['--user', 'stop', 'gv-ops.service'] },
      { command: 'systemctl', args: ['--user', 'restart', 'gv-ops.service'] },
    ]);
  });

  test('renders launchd and windows service artifacts with the configured service name', () => {
    const launchdCalls: Array<{ command: string; args: readonly string[] }> = [];
    const launchdConfig = new ConfigManager({ workingDir: root, configDir: join(root, '.goodvibes', 'tui') });
    launchdConfig.set('service.platform', 'launchd');
    launchdConfig.set('service.serviceName', 'dev.goodvibes.launchd');
    const launchdManager = new PlatformServiceManager(launchdConfig, {
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
    expect(launchdCalls).toEqual([
      { command: 'launchctl', args: ['load', launchdInstalled.path] },
      { command: 'launchctl', args: ['unload', launchdInstalled.path] },
      { command: 'launchctl', args: ['load', launchdInstalled.path] },
    ]);

    const windowsCalls: Array<{ command: string; args: readonly string[] }> = [];
    const windowsConfig = new ConfigManager({ workingDir: root, configDir: join(root, '.goodvibes', 'tui') });
    windowsConfig.set('service.platform', 'windows');
    windowsConfig.set('service.serviceName', 'GoodVibesTask');
    const windowsManager = new PlatformServiceManager(windowsConfig, {
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
