/**
 * Daemon update lifecycle (src/daemon/lifecycle.ts):
 *  - the shim that keeps the SDK facade's version-blind internal auto-updater
 *    stopped (and proves the facade's real lifecycle class still has the
 *    shape the shim relies on — the canary that fails if an sdk upgrade
 *    changes it);
 *  - the standalone daemon's correctly-versioned update loop: refuses
 *    non-binary installs and honors the update.* gates, with the updater
 *    seam injected so no timers or network are ever real.
 *
 * Versions here are injected fixtures — never the live build VERSION.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { startDaemonAutoUpdate, suppressVersionBlindFacadeAutoUpdater } from '../../daemon/lifecycle.ts';

function makeConfigManager(): ConfigManager {
  const root = mkdtempSync(join(tmpdir(), 'gv-daemon-lifecycle-'));
  const workingDir = join(root, 'workspace');
  const homeDir = join(root, 'home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  return new ConfigManager({ workingDir, homeDir, surfaceRoot: 'tui' });
}

describe('suppressVersionBlindFacadeAutoUpdater', () => {
  test('stops a live updater, nulls it, and shadows startAutoUpdater so a restart cycle cannot revive it', () => {
    let stops = 0;
    let starts = 0;
    const lifecycle = {
      autoUpdater: { stop: () => { stops += 1; } } as { stop(): void } | null,
      startAutoUpdater: () => { starts += 1; },
    };
    const daemon = { lifecycle };
    expect(suppressVersionBlindFacadeAutoUpdater(daemon)).toBe(true);
    expect(stops).toBe(1);
    expect(lifecycle.autoUpdater).toBeNull();
    // A facade-internal restart cycle calls startAutoUpdater again — the
    // shadow must keep the version-blind loop dead.
    lifecycle.startAutoUpdater();
    expect(starts).toBe(0);
  });

  test('answers false — the revisit signal — when the facade exposes no lifecycle', () => {
    expect(suppressVersionBlindFacadeAutoUpdater({})).toBe(false);
  });

  test('canary: the real sdk facade lifecycle still has the shape the shim relies on', async () => {
    // Construct a real (never started) DaemonServer. If the sdk renames or
    // privatizes the lifecycle members, this test names the break before a
    // release ships with the version-blind loop re-enabled.
    const facadeModule = await import('@pellux/goodvibes-sdk/platform/daemon/auto-updater');
    expect(typeof facadeModule.DaemonAutoUpdater.prototype.stop).toBe('function');
    const { DaemonServer } = await import('@pellux/goodvibes-sdk/platform/daemon');
    const root = mkdtempSync(join(tmpdir(), 'gv-lifecycle-canary-'));
    const workingDir = join(root, 'workspace');
    const homeDir = join(root, 'home');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const configManager = new ConfigManager({ workingDir, homeDir, surfaceRoot: 'tui' });
    const daemon = new DaemonServer({ configManager, workingDir, homeDirectory: homeDir }) as unknown as {
      lifecycle?: { autoUpdater?: unknown; startAutoUpdater?: unknown } | null;
    };
    expect(daemon.lifecycle && typeof daemon.lifecycle === 'object').toBe(true);
    expect(typeof Object.getPrototypeOf(daemon.lifecycle).startAutoUpdater).toBe('function');
    expect(suppressVersionBlindFacadeAutoUpdater(daemon as object)).toBe(true);
    // After the shim, the (shadowed) startAutoUpdater must be inert even
    // though onStarted() would normally arm the version-blind loop.
    (daemon.lifecycle as { startAutoUpdater: () => void }).startAutoUpdater();
    expect((daemon.lifecycle as { autoUpdater?: unknown }).autoUpdater ?? null).toBeNull();
  });
});

describe('startDaemonAutoUpdate', () => {
  const baseOptions = (configManager: ConfigManager) => ({
    configManager,
    isIdle: () => true,
    homeDirectory: '/tmp/gv-lifecycle-home',
    workingDirectory: '/tmp/gv-lifecycle-work',
    currentVersion: '1.2.3',
  });

  test('refuses a source install (bun interpreter) with the honest reason', () => {
    const configManager = makeConfigManager();
    const handle = startDaemonAutoUpdate({
      ...baseOptions(configManager),
      execPath: '/usr/bin/bun',
      createUpdater: () => { throw new Error('must not construct an updater for a source install'); },
    });
    expect(handle.started).toBe(false);
    expect(handle.reason).toBe('not a compiled binary install (detected: source); self-update never swaps a source install');
  });

  test('refuses a package-managed install with the honest reason', () => {
    const configManager = makeConfigManager();
    const handle = startDaemonAutoUpdate({
      ...baseOptions(configManager),
      execPath: '/home/user/.bun/install/global/node_modules/@pellux/goodvibes-tui/bin/goodvibes-daemon',
      createUpdater: () => { throw new Error('must not construct an updater for a package install'); },
    });
    expect(handle.started).toBe(false);
    expect(handle.reason).toBe('not a compiled binary install (detected: bun-global-package); self-update never swaps a bun-global-package install');
  });

  test('honors update.auto=false', () => {
    const configManager = makeConfigManager();
    configManager.set('update.auto', false);
    const handle = startDaemonAutoUpdate({
      ...baseOptions(configManager),
      execPath: '/usr/local/bin/goodvibes-daemon',
      createUpdater: () => { throw new Error('must not construct an updater when update.auto is off'); },
    });
    expect(handle.started).toBe(false);
    expect(handle.reason).toBe('update.auto is off');
  });

  test('a binary install with update.auto on starts the loop fed the injected version and the configured cadence', () => {
    const configManager = makeConfigManager();
    configManager.set('update.intervalMinutes', 30);
    let captured: { currentVersion: string; releasesLatestUrl: string; checkIntervalMs?: number | undefined; execPath: string } | null = null;
    let startCalls = 0;
    let stopCalls = 0;
    const handle = startDaemonAutoUpdate({
      ...baseOptions(configManager),
      execPath: '/usr/local/bin/goodvibes-daemon',
      createUpdater: (options) => {
        captured = options;
        return { start: () => { startCalls += 1; }, stop: () => { stopCalls += 1; } };
      },
    });
    expect(handle.started).toBe(true);
    expect(handle.reason).toBe('');
    expect(startCalls).toBe(1);
    expect(captured!.currentVersion).toBe('1.2.3');
    expect(captured!.execPath).toBe('/usr/local/bin/goodvibes-daemon');
    expect(captured!.releasesLatestUrl).toBe('https://github.com/mgd34msu/goodvibes-tui/releases/latest');
    expect(captured!.checkIntervalMs).toBe(30 * 60 * 1000);
    handle.stop();
    expect(stopCalls).toBe(1);
  });
});
