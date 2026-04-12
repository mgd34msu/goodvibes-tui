import { existsSync, statSync } from 'node:fs';
import { createDomainDispatch } from '../runtime/store/index.ts';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { WatcherKind, WatcherRecord, WatcherSourceStatus } from '../runtime/store/domains/watchers.ts';
import type { AutomationSourceRecord } from '../automation/sources.ts';
import type { WatcherSourceKind } from '../runtime/events/watchers.ts';
import {
  emitWatcherFailed,
  emitWatcherHeartbeat,
  emitWatcherStarted,
  emitWatcherStopped,
} from '../runtime/emitters/index.ts';
import {
  loadWatcherSnapshotFromPath,
  resolveWatcherStorePath,
  saveWatcherSnapshotToPath,
} from './store.ts';

export interface RegisterWatcherInput {
  readonly id: string;
  readonly label: string;
  readonly kind?: WatcherKind;
  readonly source: AutomationSourceRecord;
  readonly intervalMs?: number;
  readonly metadata?: Record<string, unknown>;
  readonly run?: () => Promise<string | void> | string | void;
}

export interface RegisterPollingWatcherInput {
  readonly id: string;
  readonly label: string;
  readonly source: AutomationSourceRecord;
  readonly intervalMs: number;
  readonly run: () => Promise<string | void> | string | void;
}

export interface WatcherRegistryOptions {
  readonly storePath?: string;
}

interface RegisteredWatcher {
  readonly record: WatcherRecord;
  readonly run: () => Promise<string | void> | string | void;
}

function now(): number {
  return Date.now();
}

function sortWatchers(watchers: Iterable<WatcherRecord>): WatcherRecord[] {
  return [...watchers].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

function toWatcherSourceKind(kind: WatcherKind): WatcherSourceKind {
  switch (kind) {
    case 'webhook':
      return 'webhook';
    case 'filesystem':
      return 'file';
    case 'socket':
      return 'stream';
    case 'integration':
      return 'api';
    case 'manual':
      return 'api';
    case 'polling':
    default:
      return 'poll';
  }
}

function sourceStatusFor(record: WatcherRecord, ts = now()): {
  readonly sourceLagMs?: number;
  readonly sourceStatus: WatcherSourceStatus;
  readonly degradedReason?: string;
  readonly nextState?: WatcherRecord['state'];
} {
  const lastSeenAt = record.lastHeartbeatAt ?? record.source.lastSeenAt ?? record.source.updatedAt ?? record.source.createdAt;
  if (record.state === 'failed') {
    return {
      sourceLagMs: lastSeenAt ? Math.max(0, ts - lastSeenAt) : undefined,
      sourceStatus: 'failed',
      degradedReason: record.lastError ?? 'watcher failed',
      nextState: 'failed',
    };
  }
  if (record.state === 'stopped') {
    return {
      sourceLagMs: lastSeenAt ? Math.max(0, ts - lastSeenAt) : undefined,
      sourceStatus: 'unknown',
    };
  }
  if (!lastSeenAt) {
    return {
      sourceStatus: 'lagging',
      degradedReason: 'watcher has not reported a heartbeat yet',
      nextState: 'degraded',
    };
  }
  const interval = Math.max(1_000, Number(record.intervalMs ?? 0) || 0);
  const lag = Math.max(0, ts - lastSeenAt);
  const staleThreshold = interval > 0 ? interval * 2 : 60_000;
  if (lag >= staleThreshold) {
    return {
      sourceLagMs: lag,
      sourceStatus: 'stale',
      degradedReason: `heartbeat stale by ${lag}ms`,
      nextState: 'degraded',
    };
  }
  if (interval > 0 && lag >= interval) {
    return {
      sourceLagMs: lag,
      sourceStatus: 'lagging',
      degradedReason: `heartbeat lagging by ${lag}ms`,
      nextState: 'degraded',
    };
  }
  return {
    sourceLagMs: lag,
    sourceStatus: record.lastError ? 'degraded' : 'healthy',
    ...(record.lastError ? { degradedReason: record.lastError } : {}),
    nextState: record.state === 'degraded' && !record.lastError ? 'running' : undefined,
  };
}

export class WatcherRegistry {
  private readonly watchers = new Map<string, RegisteredWatcher>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly inFlight = new Set<string>();
  private readonly storePath: string;
  private runtimeDispatch: DomainDispatch | null = null;
  private runtimeBus: RuntimeEventBus | null = null;
  private loaded = false;

  constructor(options: WatcherRegistryOptions = {}) {
    this.storePath = resolveWatcherStorePath(options.storePath);
  }

  attachRuntime(config: {
    readonly runtimeStore?: RuntimeStore | null;
    readonly runtimeBus?: RuntimeEventBus | null;
  }): void {
    if (config.runtimeStore) {
      this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
      for (const watcher of this.watchers.values()) {
        this.runtimeDispatch.syncWatcher(this.normalizeRecord(watcher.record), 'watchers.attach');
      }
    }
    if (config.runtimeBus) {
      this.runtimeBus = config.runtimeBus;
    }
  }

  registerWatcher(input: RegisterWatcherInput): WatcherRecord {
    this.ensureLoaded();
    const existing = this.watchers.get(input.id)?.record;
    const wasRunning = existing?.state === 'running' || existing?.state === 'starting' || existing?.state === 'degraded';
    const timer = this.timers.get(input.id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(input.id);
    }
    const record = this.normalizeRecord({
      id: input.id,
      kind: input.kind ?? existing?.kind ?? 'polling',
      label: input.label,
      state: existing?.state ?? 'stopped',
      source: input.source,
      intervalMs: input.intervalMs ?? existing?.intervalMs,
      lastHeartbeatAt: existing?.lastHeartbeatAt,
      lastCheckpoint: existing?.lastCheckpoint,
      lastError: existing?.lastError,
      sourceLagMs: existing?.sourceLagMs,
      sourceStatus: existing?.sourceStatus,
      degradedReason: existing?.degradedReason,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
    });
    this.watchers.set(record.id, {
      record,
      run: input.run ?? this.buildRunStrategy(record),
    });
    this.persist();
    this.runtimeDispatch?.syncWatcher(record, 'watchers.register');
    if (wasRunning) {
      return this.startWatcher(record.id) ?? record;
    }
    return record;
  }

  registerPollingWatcher(input: RegisterPollingWatcherInput): WatcherRecord {
    return this.registerWatcher({
      id: input.id,
      label: input.label,
      kind: 'polling',
      source: input.source,
      intervalMs: input.intervalMs,
      metadata: {
        ...input.source.metadata,
        runMode: 'polling',
      },
      run: input.run,
    });
  }

  list(): WatcherRecord[] {
    this.ensureLoaded();
    const refreshed: WatcherRecord[] = [];
    let changed = false;
    for (const watcher of this.watchers.values()) {
      const normalized = this.normalizeRecord(watcher.record);
      refreshed.push(normalized);
      if (normalized !== watcher.record) {
        this.watchers.set(normalized.id, { ...watcher, record: normalized });
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
    return sortWatchers(refreshed);
  }

  getWatcher(id: string): WatcherRecord | null {
    this.ensureLoaded();
    const watcher = this.watchers.get(id);
    if (!watcher) return null;
    const normalized = this.normalizeRecord(watcher.record);
    if (normalized !== watcher.record) {
      this.watchers.set(id, { ...watcher, record: normalized });
      this.persist();
      this.runtimeDispatch?.syncWatcher(normalized, 'watchers.refresh');
    }
    return normalized;
  }

  startWatcher(id: string): WatcherRecord | null {
    this.ensureLoaded();
    const watcher = this.watchers.get(id);
    if (!watcher) return null;
    if (this.timers.has(id)) return watcher.record;

    const started: WatcherRecord = this.normalizeRecord({
      ...watcher.record,
      state: 'running',
      lastHeartbeatAt: now(),
      sourceStatus: 'healthy',
      degradedReason: undefined,
      sourceLagMs: 0,
    });
    this.watchers.set(id, { ...watcher, record: started });
    this.persist();
    this.runtimeDispatch?.syncWatcher(started, 'watchers.start');
    if (this.runtimeBus) {
      emitWatcherStarted(this.runtimeBus, {
        sessionId: 'watchers',
        source: 'watcher-registry',
        traceId: id,
      }, {
        watcherId: id,
        sourceKind: toWatcherSourceKind(started.kind),
        name: started.label,
      });
    }

    if (started.kind !== 'manual' && Number(started.intervalMs ?? 0) > 0) {
      const timer = setInterval(() => {
        void this.runWatcher(id);
      }, started.intervalMs ?? 60_000);
      this.timers.set(id, timer);
      void this.runWatcher(id);
    }
    return started;
  }

  stopWatcher(id: string, reason = 'stopped'): WatcherRecord | null {
    this.ensureLoaded();
    const watcher = this.watchers.get(id);
    if (!watcher) return null;
    const timer = this.timers.get(id);
    if (timer) clearInterval(timer);
    this.timers.delete(id);

    const stopped: WatcherRecord = this.normalizeRecord({
      ...watcher.record,
      state: 'stopped',
      sourceStatus: 'unknown',
    });
    this.watchers.set(id, { ...watcher, record: stopped });
    this.persist();
    this.runtimeDispatch?.syncWatcher(stopped, 'watchers.stop');
    if (this.runtimeBus) {
      emitWatcherStopped(this.runtimeBus, {
        sessionId: 'watchers',
        source: 'watcher-registry',
        traceId: id,
      }, {
        watcherId: id,
        sourceKind: toWatcherSourceKind(stopped.kind),
        reason,
      });
    }
    return stopped;
  }

  async runWatcherNow(id: string): Promise<WatcherRecord | null> {
    this.ensureLoaded();
    const watcher = this.watchers.get(id);
    if (!watcher) return null;
    await this.runWatcher(id);
    return this.getWatcher(id);
  }

  removeWatcher(id: string): boolean {
    this.ensureLoaded();
    const watcher = this.watchers.get(id);
    if (!watcher) return false;
    this.stopWatcher(id, 'removed');
    const removed = this.watchers.delete(id);
    if (removed) {
      this.persist();
      this.runtimeDispatch?.syncWatcher({
        ...watcher.record,
        state: 'stopped',
        metadata: {
          ...watcher.record.metadata,
          removed: true,
        },
      }, 'watchers.remove');
    }
    return removed;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    const snapshot = loadWatcherSnapshotFromPath(this.storePath);
    if (snapshot) {
      this.watchers.clear();
      for (const record of snapshot.watchers) {
        const normalized = this.normalizeRecord(record);
        this.watchers.set(normalized.id, {
          record: normalized,
          run: this.buildRunStrategy(normalized),
        });
      }
    }
    this.loaded = true;
    for (const watcher of this.watchers.values()) {
      const normalized = this.normalizeRecord(watcher.record);
      this.watchers.set(normalized.id, {
        ...watcher,
        record: normalized,
        run: watcher.run ?? this.buildRunStrategy(normalized),
      });
      if (
        (normalized.state === 'running' || normalized.state === 'degraded' || normalized.state === 'starting')
        && normalized.kind !== 'manual'
        && Number(normalized.intervalMs ?? 0) > 0
      ) {
        const timer = setInterval(() => {
          void this.runWatcher(normalized.id);
        }, normalized.intervalMs ?? 60_000);
        this.timers.set(normalized.id, timer);
      }
    }
  }

  private normalizeRecord(record: WatcherRecord): WatcherRecord {
    const freshness = sourceStatusFor(record);
    const state = freshness.nextState ?? record.state;
    return {
      ...record,
      state,
      ...(freshness.sourceLagMs !== undefined ? { sourceLagMs: freshness.sourceLagMs } : {}),
      sourceStatus: freshness.sourceStatus,
      ...(freshness.degradedReason ? { degradedReason: freshness.degradedReason } : {}),
    };
  }

  private async runWatcher(id: string): Promise<void> {
    if (this.inFlight.has(id)) return;
    const watcher = this.watchers.get(id);
    if (!watcher) return;
    this.inFlight.add(id);
    try {
      const checkpoint = await watcher.run();
      const updated: WatcherRecord = this.normalizeRecord({
        ...watcher.record,
        state: 'running',
        lastHeartbeatAt: now(),
        lastCheckpoint: checkpoint ? String(checkpoint) : watcher.record.lastCheckpoint,
        lastError: undefined,
        sourceStatus: 'healthy',
        sourceLagMs: 0,
        degradedReason: undefined,
      });
      this.watchers.set(id, { ...watcher, record: updated });
      this.persist();
      this.runtimeDispatch?.syncWatcher(updated, 'watchers.heartbeat');
      if (this.runtimeBus) {
        emitWatcherHeartbeat(this.runtimeBus, {
          sessionId: 'watchers',
          source: 'watcher-registry',
          traceId: id,
        }, {
          watcherId: id,
          sourceKind: toWatcherSourceKind(updated.kind),
          seenAt: updated.lastHeartbeatAt ?? now(),
          checkpoint: updated.lastCheckpoint ?? '',
        });
      }
    } catch (error) {
      const failed: WatcherRecord = this.normalizeRecord({
        ...watcher.record,
        state: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
        sourceStatus: 'failed',
        degradedReason: error instanceof Error ? error.message : String(error),
      });
      this.watchers.set(id, { ...watcher, record: failed });
      this.persist();
      this.runtimeDispatch?.syncWatcher(failed, 'watchers.failed');
      if (this.runtimeBus) {
        emitWatcherFailed(this.runtimeBus, {
          sessionId: 'watchers',
          source: 'watcher-registry',
          traceId: id,
        }, {
          watcherId: id,
          sourceKind: toWatcherSourceKind(failed.kind),
          error: failed.lastError ?? 'watcher failed',
          retryable: true,
        });
      }
    } finally {
      this.inFlight.delete(id);
    }
  }

  private buildRunStrategy(record: WatcherRecord): () => Promise<string | void> | string | void {
    const metadata = record.metadata ?? {};
    const sourceMetadata = record.source.metadata ?? {};
    const merged = { ...sourceMetadata, ...metadata };

    if (typeof merged.run === 'string' && merged.run.trim().length > 0) {
      return () => merged.run as string;
    }

    if (record.kind === 'filesystem') {
      const path = typeof merged.path === 'string' ? merged.path : typeof merged.filePath === 'string' ? merged.filePath : '';
      return () => {
        if (!path) return `${record.id}:filesystem-no-path`;
        if (!existsSync(path)) return `${path}:missing`;
        const stat = statSync(path);
        return `${path}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
      };
    }

    if (record.kind === 'webhook') {
      const url = typeof merged.url === 'string' ? merged.url : '';
      return async () => {
        if (!url) return `${record.id}:webhook-no-url`;
        const response = await fetch(url, {
          method: typeof merged.method === 'string' ? merged.method.toUpperCase() : 'GET',
          headers: typeof merged.headers === 'object' && merged.headers !== null
            ? Object.fromEntries(Object.entries(merged.headers).filter(([, value]) => typeof value === 'string')) as Record<string, string>
            : undefined,
        });
        const text = await response.text().catch(() => '');
        return `${response.status}:${text.slice(0, 120)}`;
      };
    }

    if (record.kind === 'integration') {
      return () => `integration:${record.source.id}:${record.label}`;
    }

    if (record.kind === 'socket') {
      return () => `socket:${typeof merged.address === 'string' ? merged.address : record.label}`;
    }

    if (record.kind === 'manual') {
      return () => `${record.label}:${new Date().toISOString()}`;
    }

    const url = typeof merged.url === 'string' ? merged.url : typeof merged.endpoint === 'string' ? merged.endpoint : '';
    if (url) {
      return async () => {
        const response = await fetch(url, {
          method: typeof merged.method === 'string' ? merged.method.toUpperCase() : 'GET',
          headers: typeof merged.headers === 'object' && merged.headers !== null
            ? Object.fromEntries(Object.entries(merged.headers).filter(([, value]) => typeof value === 'string')) as Record<string, string>
            : undefined,
        });
        const text = await response.text().catch(() => '');
        return `${response.status}:${text.slice(0, 120)}`;
      };
    }

    return () => `${record.id}:${record.kind}:${Date.now()}`;
  }

  private persist(): void {
    saveWatcherSnapshotToPath(
      sortWatchers([...this.watchers.values()].map((entry) => entry.record)),
      this.storePath,
    );
    for (const watcher of this.watchers.values()) {
      this.runtimeDispatch?.syncWatcher(watcher.record, 'watchers.persist');
    }
  }
}
