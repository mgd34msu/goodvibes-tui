import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeEventBus } from '../../runtime/events/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { WatcherRegistry } from '../../watchers/index.ts';
import { loadWatcherSnapshotFromPath, resolveWatcherStorePath, saveWatcherSnapshotToPath } from '../../watchers/store.ts';

function createTempWatcherStore(): { readonly root: string; readonly storePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-watchers-'));
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
});
