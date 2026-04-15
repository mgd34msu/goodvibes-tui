import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { CONFIG_SCHEMA } from '../../config/index.ts';
import type { ConfigKey } from '../../config/index.ts';

export type SyncSurface = 'profiles' | 'managed' | 'settings-sync';
export type SyncDirection = 'export' | 'import' | 'apply' | 'pull' | 'push' | 'rollback';
export type SettingsSource = 'default' | 'local' | 'synced' | 'managed';

export interface SettingsSyncEvent {
  readonly surface: SyncSurface;
  readonly direction: SyncDirection;
  readonly path: string;
  readonly timestamp: number;
  readonly detail: string;
}

export interface ManagedSettingLock {
  readonly key: ConfigKey;
  readonly source: string;
  readonly reason: string;
  readonly updatedAt: number;
}

export interface SettingsLayerRecord {
  readonly key: ConfigKey;
  readonly value: unknown;
  readonly source: Exclude<SettingsSource, 'default' | 'local'>;
  readonly sourceLabel: string;
  readonly detail: string;
  readonly path?: string;
  readonly updatedAt: number;
  readonly locked?: boolean;
}

export interface SettingsConflictRecord {
  readonly key: ConfigKey;
  readonly localValue: unknown;
  readonly incomingValue: unknown;
  readonly source: Exclude<SettingsSource, 'default' | 'local'>;
  readonly path: string;
  readonly updatedAt: number;
}

export type SettingsConflictResolution = 'local' | 'synced';

export interface ManagedBundleChange {
  readonly key: ConfigKey;
  readonly previousValue: unknown;
  readonly nextValue: unknown;
  readonly changed: boolean;
  readonly locked: boolean;
  readonly source: string;
  readonly reason: string;
}

export interface StagedManagedBundle {
  readonly id: string;
  readonly profileName: string;
  readonly path: string;
  readonly importedAt: number;
  readonly changeCount: number;
  readonly risk: 'low' | 'medium' | 'high';
  readonly changes: readonly ManagedBundleChange[];
}

export interface ManagedRollbackRecord {
  readonly token: string;
  readonly profileName: string;
  readonly path: string;
  readonly appliedAt: number;
  readonly restoredKeys: readonly ConfigKey[];
  readonly previousValues: Readonly<Partial<Record<ConfigKey, unknown>>>;
}

export interface SettingsControlPlaneStore {
  readonly version: 2;
  readonly events: ReadonlyArray<SettingsSyncEvent>;
  readonly managedLocks: ReadonlyArray<ManagedSettingLock>;
  readonly failures: ReadonlyArray<{
    readonly surface: SyncSurface;
    readonly message: string;
    readonly timestamp: number;
  }>;
  readonly syncedSettings: ReadonlyArray<SettingsLayerRecord>;
  readonly managedSettings: ReadonlyArray<SettingsLayerRecord>;
  readonly conflicts: ReadonlyArray<SettingsConflictRecord>;
  readonly stagedManagedBundle?: StagedManagedBundle;
  readonly rollbackHistory: ReadonlyArray<ManagedRollbackRecord>;
}

export interface ResolvedSettingEntry {
  readonly key: ConfigKey;
  readonly category: string;
  readonly effectiveValue: unknown;
  readonly effectiveSource: SettingsSource;
  readonly defaultValue: unknown;
  readonly localValue: unknown;
  readonly syncedValue?: unknown;
  readonly managedValue?: unknown;
  readonly overriddenSources: readonly SettingsSource[];
  readonly locked: boolean;
  readonly lockReason?: string;
  readonly sourceLabel?: string;
  readonly updatedAt?: number;
  readonly conflict: boolean;
}

export interface SettingsControlPlaneSnapshot {
  readonly liveKeyCount: number;
  readonly profileCount: number;
  readonly managedLockCount: number;
  readonly resolvedCounts: Readonly<Record<SettingsSource, number>>;
  readonly lastSync?: SettingsSyncEvent;
  readonly recentEvents: ReadonlyArray<SettingsSyncEvent>;
  readonly recentFailures: SettingsControlPlaneStore['failures'];
  readonly managedLocks: ReadonlyArray<ManagedSettingLock>;
  readonly conflicts: ReadonlyArray<SettingsConflictRecord>;
  readonly stagedManagedBundle?: StagedManagedBundle;
  readonly rollbackHistory: ReadonlyArray<ManagedRollbackRecord>;
  readonly resolvedEntries: ReadonlyArray<ResolvedSettingEntry>;
}

export interface ResolvedSettingLookup {
  readonly entry: ResolvedSettingEntry;
  readonly lock?: ManagedSettingLock;
  readonly syncedLayer?: SettingsLayerRecord;
  readonly managedLayer?: SettingsLayerRecord;
}

export interface SettingsSyncBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly source: 'settings-sync';
  readonly settings: Record<string, unknown>;
}

export function getConfigControlPlaneDir(configManager: ConfigManager): string {
  return configManager.getControlPlaneConfigDir();
}

function getSettingsControlPath(configDir: string): string {
  return join(configDir, 'settings-sync.json');
}

export function defaultStore(): SettingsControlPlaneStore {
  return {
    version: 2,
    events: [],
    managedLocks: [],
    failures: [],
    syncedSettings: [],
    managedSettings: [],
    conflicts: [],
    rollbackHistory: [],
  };
}

function migrateStore(raw: unknown): SettingsControlPlaneStore {
  if (!raw || typeof raw !== 'object') return defaultStore();
  const store = raw as Partial<SettingsControlPlaneStore> & { version?: number };
  if (store.version === 2) {
    return {
      ...defaultStore(),
      ...store,
      events: Array.isArray(store.events) ? store.events : [],
      managedLocks: Array.isArray(store.managedLocks) ? store.managedLocks : [],
      failures: Array.isArray(store.failures) ? store.failures : [],
      syncedSettings: Array.isArray(store.syncedSettings) ? store.syncedSettings : [],
      managedSettings: Array.isArray(store.managedSettings) ? store.managedSettings : [],
      conflicts: Array.isArray(store.conflicts) ? store.conflicts : [],
      rollbackHistory: Array.isArray(store.rollbackHistory) ? store.rollbackHistory : [],
    };
  }
  return {
    ...defaultStore(),
    events: Array.isArray(store.events) ? store.events : [],
    managedLocks: Array.isArray(store.managedLocks) ? store.managedLocks : [],
    failures: Array.isArray(store.failures) ? store.failures : [],
  };
}

export function readStore(configDir: string): SettingsControlPlaneStore {
  try {
    return migrateStore(JSON.parse(readFileSync(getSettingsControlPath(configDir), 'utf-8')));
  } catch {
    return defaultStore();
  }
}

export function writeStore(store: SettingsControlPlaneStore, configDir: string): void {
  const path = getSettingsControlPath(configDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
}

export function trimStore(store: SettingsControlPlaneStore): SettingsControlPlaneStore {
  return {
    ...store,
    events: store.events.slice(-60),
    failures: store.failures.slice(-20),
    conflicts: store.conflicts.slice(-40),
    rollbackHistory: store.rollbackHistory.slice(-20),
  };
}

export function configSnapshot(configManager: ConfigManager): Record<ConfigKey, unknown> {
  const snapshot = {} as Record<ConfigKey, unknown>;
  for (const entry of CONFIG_SCHEMA) {
    snapshot[entry.key] = structuredClone(configManager.get(entry.key));
  }
  return snapshot;
}

export function sourcePriority(source: SettingsSource): number {
  switch (source) {
    case 'managed': return 3;
    case 'synced': return 2;
    case 'local': return 1;
    case 'default': return 0;
  }
}

export function inferRisk(changes: readonly ManagedBundleChange[]): 'low' | 'medium' | 'high' {
  if (changes.some((change) => change.key.startsWith('danger.') || change.key.startsWith('permissions.') || change.key.startsWith('sandbox.'))) {
    return 'high';
  }
  if (changes.some((change) => change.key.startsWith('provider.') || change.key.startsWith('storage.') || change.key.startsWith('orchestration.'))) {
    return 'medium';
  }
  return 'low';
}

export function makeRollbackToken(): string {
  return `managed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function toLayerRecord(
  key: ConfigKey,
  value: unknown,
  source: Exclude<SettingsSource, 'default' | 'local'>,
  sourceLabel: string,
  detail: string,
  path?: string,
  locked?: boolean,
): SettingsLayerRecord {
  return {
    key,
    value: structuredClone(value),
    source,
    sourceLabel,
    detail,
    ...(path ? { path } : {}),
    updatedAt: Date.now(),
    ...(locked ? { locked: true } : {}),
  };
}
