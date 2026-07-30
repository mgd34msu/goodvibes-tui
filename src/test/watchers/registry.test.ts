import { describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeEventBus, createFeatureFlagManager, deriveFeatureStates } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { WatcherRegistry } from '@pellux/goodvibes-sdk/platform/watchers';
import { loadWatcherSnapshotFromPath, resolveWatcherStorePath, saveWatcherSnapshotToPath } from '@pellux/goodvibes-sdk/platform/watchers';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function createTempWatcherStore(): { readonly root: string; readonly storePath: string } {
  const root = makeProjectTempDir('goodvibes-watchers');
  return {
    root,
    storePath: join(root, 'watchers.json'),
  };
}

describe('WatcherRegistry', () => {
  test('requires an explicit watcher store path', () => {
    expect(() => resolveWatcherStorePath()).toThrow('Watcher store requires an explicit storePath');
  });

  test('persists filesystem watchers across restart', async () => {
    const { root, storePath } = createTempWatcherStore();
    const filePath = join(root, 'source.txt');
    writeFileSync(filePath, 'alpha\n', 'utf-8');

    let registry: WatcherRegistry | undefined;
    let restarted: WatcherRegistry | undefined;

    try {
      registry = new WatcherRegistry({ storePath });
      registry.attachRuntime({
        runtimeBus: new RuntimeEventBus(),
        runtimeStore: createRuntimeStore(),
      });

      registry.registerWatcher({
        id: 'watcher-filesystem',
        label: 'filesystem',
        kind: 'filesystem',
        source: {
          id: 'source-filesystem',
          kind: 'hook',
          label: 'filesystem',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
          metadata: {},
        },
        intervalMs: 60_000,
        metadata: {
          path: filePath,
        },
      });

      const started = registry.startWatcher('watcher-filesystem');
      expect(started?.kind).toBe('filesystem');
      expect(started?.state).toBe('running');

      await new Promise((resolve) => setTimeout(resolve, 25));

      const persisted = loadWatcherSnapshotFromPath(storePath);
      expect(persisted?.watchers.some((record) => record.id === 'watcher-filesystem' && record.kind === 'filesystem')).toBe(true);

      restarted = new WatcherRegistry({ storePath });
      restarted.attachRuntime({
        runtimeBus: new RuntimeEventBus(),
        runtimeStore: createRuntimeStore(),
      });
      const restored = restarted.getWatcher('watcher-filesystem');

      expect(restored?.kind).toBe('filesystem');
      expect(restored?.state).toBe('running');
      expect(restored?.sourceStatus).toBe('healthy');
      expect(typeof restored?.lastCheckpoint).toBe('string');
      expect(restored?.lastCheckpoint?.startsWith(`${filePath}:`)).toBe(true);

      restarted.stopWatcher('watcher-filesystem', 'test-complete');
    } finally {
      restarted?.stopWatcher('watcher-filesystem', 'test-complete');
      registry?.stopWatcher('watcher-filesystem', 'test-complete');
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports stale watcher sources as degraded on reload', () => {
    const { root, storePath } = createTempWatcherStore();
    const staleAt = Date.now() - 5 * 60_000;
    saveWatcherSnapshotToPath([
      {
        id: 'watcher-stale',
        kind: 'polling',
        label: 'stale',
        state: 'running',
        source: {
          id: 'source-stale',
          kind: 'watcher',
          label: 'stale',
          enabled: true,
          createdAt: staleAt,
          updatedAt: staleAt,
          lastSeenAt: staleAt,
          metadata: {},
        },
        intervalMs: 60_000,
        lastHeartbeatAt: staleAt,
        lastCheckpoint: 'checkpoint-old',
        metadata: {},
      },
    ], storePath);

    let registry: WatcherRegistry | undefined;

    try {
      registry = new WatcherRegistry({ storePath });
      registry.attachRuntime({
        runtimeBus: new RuntimeEventBus(),
        runtimeStore: createRuntimeStore(),
      });

      const watcher = registry.list()[0];
      expect(watcher?.id).toBe('watcher-stale');
      expect(watcher?.state).toBe('degraded');
      expect(watcher?.sourceStatus).toBe('stale');
      expect(watcher?.sourceLagMs).toBeGreaterThanOrEqual(5 * 60_000);
      expect(watcher?.degradedReason).toContain('heartbeat');
    } finally {
      registry?.stopWatcher('watcher-stale', 'test-complete');
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('registers polling watchers and records heartbeats', async () => {
    const { root, storePath } = createTempWatcherStore();
    let registry: WatcherRegistry | undefined;

    try {
      registry = new WatcherRegistry({ storePath });
      registry.attachRuntime({
        runtimeBus: new RuntimeEventBus(),
        runtimeStore: createRuntimeStore(),
      });

      registry.registerPollingWatcher({
        id: 'watcher-1',
        label: 'heartbeat',
        source: {
          id: 'source-1',
          kind: 'watcher',
          label: 'heartbeat',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
          metadata: {},
        },
        intervalMs: 10,
        run: () => 'checkpoint-1',
      });

      registry.startWatcher('watcher-1');
      await new Promise((resolve) => setTimeout(resolve, 25));

      const running = registry.list()[0];
      expect(running?.state).toBe('running');
      expect(running?.lastCheckpoint).toBe('checkpoint-1');
      expect(running?.lastHeartbeatAt).toBeGreaterThan(0);

      registry.stopWatcher('watcher-1', 'test-complete');
      expect(registry.list()[0]?.state).toBe('stopped');

      const rerun = await registry.runWatcherNow('watcher-1');
      expect(rerun?.lastCheckpoint).toBe('checkpoint-1');

      const removed = registry.removeWatcher('watcher-1');
      expect(removed).toBe(true);
      expect(registry.list()).toHaveLength(0);
    } finally {
      registry?.stopWatcher('watcher-1', 'test-complete');
      rmSync(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // watchers.enabled, driven to BOTH values through the real gate.
  //
  // This setting used to configure nothing: services.ts built its
  // WatcherRegistry without a featureFlags manager, and isFeatureGateEnabled
  // is permissive when no manager is wired, so a composition root that
  // omitted featureFlags did not disable the registry when watchers.enabled
  // was turned off — registerWatcher/startWatcher/etc. kept working either
  // way. services.ts now threads featureFlags, the same shape as the
  // RouteBindingManager fix.
  //
  // The mutation check for this row: remove that argument and the "off" half
  // of the first test below fails, because the registry falls back to
  // permissive and registers the watcher anyway.
  // -------------------------------------------------------------------------

  function registryWithGate(root: string, storePath: string, enabled: boolean): WatcherRegistry {
    const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'tui') });
    configManager.set('watchers.enabled', enabled);
    const featureFlags = createFeatureFlagManager();
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    // Constructed exactly as runtime/services.ts constructs it.
    return new WatcherRegistry({ storePath, featureFlags });
  }

  test('watchers.enabled false turns the watcher registry off, and it says so', () => {
    const { root, storePath } = createTempWatcherStore();
    try {
      const registry = registryWithGate(root, storePath, false);
      registry.attachRuntime({ runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore() });
      expect(registry.list()).toEqual([]);
      // A register call REFUSES rather than silently doing nothing, and the
      // refusal names the setting so the reason is diagnosable from the
      // message alone.
      let refusal = '';
      try {
        registry.registerPollingWatcher({
          id: 'watcher-gate',
          label: 'gate-test',
          source: {
            id: 'source-gate', kind: 'watcher', label: 'gate-test', enabled: true, createdAt: 1, updatedAt: 1, metadata: {},
          },
          intervalMs: 60_000,
          run: () => 'checkpoint',
        });
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      expect(refusal).toContain('watchers.enabled');
      expect(registry.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('watchers.enabled true registers a watcher, and is the shipped default', () => {
    const { root, storePath } = createTempWatcherStore();
    try {
      const registry = registryWithGate(root, storePath, true);
      registry.attachRuntime({ runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore() });
      registry.registerPollingWatcher({
        id: 'watcher-gate',
        label: 'gate-test',
        source: {
          id: 'source-gate', kind: 'watcher', label: 'gate-test', enabled: true, createdAt: 1, updatedAt: 1, metadata: {},
        },
        intervalMs: 60_000,
        run: () => 'checkpoint',
      });
      expect(registry.list()).toHaveLength(1);
      registry.stopWatcher('watcher-gate', 'test-complete');

      // The default half: with the key never written, effective behaviour
      // matches true. A genuinely fresh root — ConfigManager's project tier
      // is keyed by workingDir/surfaceRoot regardless of configDir, so reusing
      // `root` here would read back the write above instead of the real default.
      const { root: unsetRoot } = createTempWatcherStore();
      const unsetConfig = new ConfigManager({ surfaceRoot: 'tui', workingDir: unsetRoot, homeDir: unsetRoot, configDir: join(unsetRoot, '.goodvibes', 'unset') });
      expect(unsetConfig.get('watchers.enabled')).toBe(true);
      const flags = createFeatureFlagManager();
      flags.loadFromConfig({ flags: deriveFeatureStates(unsetConfig) });
      const unsetStorePath = join(unsetRoot, 'watchers-unset.json');
      const unsetRegistry = new WatcherRegistry({ storePath: unsetStorePath, featureFlags: flags });
      unsetRegistry.attachRuntime({ runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore() });
      unsetRegistry.registerPollingWatcher({
        id: 'watcher-gate-unset',
        label: 'gate-test-unset',
        source: {
          id: 'source-gate-unset', kind: 'watcher', label: 'gate-test-unset', enabled: true, createdAt: 1, updatedAt: 1, metadata: {},
        },
        intervalMs: 60_000,
        run: () => 'checkpoint',
      });
      expect(unsetRegistry.list()).toHaveLength(1);
      unsetRegistry.stopWatcher('watcher-gate-unset', 'test-complete');
      rmSync(unsetRoot, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
