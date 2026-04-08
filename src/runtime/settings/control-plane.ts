import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ConfigManager } from '../../config/manager.ts';
import { CONFIG_SCHEMA } from '../../config/index.ts';
import type { ConfigKey } from '../../config/index.ts';
import { getProfileManager } from '../../profiles/manager.ts';
import type { ManagedSettingsBundle } from '../sandbox/types.ts';

type SyncSurface = 'profiles' | 'managed' | 'settings-sync';
type SyncDirection = 'export' | 'import' | 'apply' | 'pull' | 'push' | 'rollback';
type SettingsSource = 'default' | 'local' | 'synced' | 'managed';

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

interface SettingsControlPlaneStore {
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

function getConfigControlPlaneDir(configManager?: ConfigManager): string | undefined {
  const candidate = configManager as ConfigManager & { getControlPlaneConfigDir?: () => string } | undefined;
  return typeof candidate?.getControlPlaneConfigDir === 'function'
    ? candidate.getControlPlaneConfigDir()
    : undefined;
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

function getSettingsControlPath(configDir?: string): string {
  const explicitDir = configDir?.trim();
  if (explicitDir) return join(explicitDir, 'settings-sync.json');
  const runtime = globalThis as typeof globalThis & { __gvTestConfigDir?: string };
  const testConfigDir = runtime.__gvTestConfigDir?.trim();
  if (testConfigDir) return join(testConfigDir, 'settings-sync.json');
  return join(homedir(), '.goodvibes', 'tui', 'settings-sync.json');
}

function defaultStore(): SettingsControlPlaneStore {
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

function readStore(configDir?: string): SettingsControlPlaneStore {
  try {
    return migrateStore(JSON.parse(readFileSync(getSettingsControlPath(configDir), 'utf-8')));
  } catch {
    return defaultStore();
  }
}

function writeStore(store: SettingsControlPlaneStore, configDir?: string): void {
  const path = getSettingsControlPath(configDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
}

function trimStore(store: SettingsControlPlaneStore): SettingsControlPlaneStore {
  return {
    ...store,
    events: store.events.slice(-60),
    failures: store.failures.slice(-20),
    conflicts: store.conflicts.slice(-40),
    rollbackHistory: store.rollbackHistory.slice(-20),
  };
}

function configSnapshot(configManager: ConfigManager): Record<ConfigKey, unknown> {
  const snapshot = {} as Record<ConfigKey, unknown>;
  for (const entry of CONFIG_SCHEMA) {
    snapshot[entry.key] = structuredClone(configManager.get(entry.key));
  }
  return snapshot;
}

function sourcePriority(source: SettingsSource): number {
  switch (source) {
    case 'managed': return 3;
    case 'synced': return 2;
    case 'local': return 1;
    case 'default': return 0;
  }
}

function inferRisk(changes: readonly ManagedBundleChange[]): 'low' | 'medium' | 'high' {
  if (changes.some((change) => change.key.startsWith('danger.') || change.key.startsWith('permissions.') || change.key.startsWith('sandbox.'))) {
    return 'high';
  }
  if (changes.some((change) => change.key.startsWith('provider.') || change.key.startsWith('storage.') || change.key.startsWith('orchestration.'))) {
    return 'medium';
  }
  return 'low';
}

function makeRollbackToken(): string {
  return `managed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toLayerRecord(
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
    path,
    updatedAt: Date.now(),
    locked,
  };
}

export function recordSettingsSyncEvent(event: SettingsSyncEvent): void {
  const store = readStore();
  writeStore(trimStore({ ...store, events: [...store.events, event] }));
}

export function recordSettingsSyncFailure(surface: SyncSurface, message: string): void {
  const store = readStore();
  writeStore(trimStore({
    ...store,
    failures: [...store.failures, { surface, message, timestamp: Date.now() }],
  }));
}

export function isManagedSettingLocked(key: ConfigKey, configDir?: string): boolean {
  return readStore(configDir).managedLocks.some((entry) => entry.key === key);
}

export function getManagedSettingLock(key: ConfigKey, configDir?: string): ManagedSettingLock | null {
  return readStore(configDir).managedLocks.find((entry) => entry.key === key) ?? null;
}

export function setManagedSettingLock(key: ConfigKey, source: string, reason: string, configDir?: string): void {
  const store = readStore(configDir);
  const nextLocks = store.managedLocks.filter((entry) => entry.key !== key);
  nextLocks.push({ key, source, reason, updatedAt: Date.now() });
  const nextManaged = store.managedSettings.map((entry) => entry.key === key
    ? { ...entry, locked: true, sourceLabel: source, detail: reason, updatedAt: Date.now() }
    : entry);
  writeStore(trimStore({
    ...store,
    managedLocks: nextLocks.sort((a, b) => a.key.localeCompare(b.key)),
    managedSettings: nextManaged,
  }), configDir);
}

export function clearManagedSettingLock(key: ConfigKey, configDir?: string): boolean {
  const store = readStore(configDir);
  const nextLocks = store.managedLocks.filter((entry) => entry.key !== key);
  if (nextLocks.length === store.managedLocks.length) return false;
  const nextManaged = store.managedSettings.map((entry) => entry.key === key
    ? { ...entry, locked: false }
    : entry);
  writeStore(trimStore({ ...store, managedLocks: nextLocks, managedSettings: nextManaged }), configDir);
  return true;
}

export function resetSettingsControlPlaneForTesting(configDir?: string): void {
  writeStore(defaultStore(), configDir);
}

export function exportSettingsSyncBundle(configManager: ConfigManager): SettingsSyncBundle {
  return {
    version: 1,
    exportedAt: Date.now(),
    source: 'settings-sync',
    settings: configSnapshot(configManager),
  };
}

export function applySettingsSyncBundle(
  configManager: ConfigManager,
  bundle: SettingsSyncBundle,
  path: string,
): { appliedCount: number; conflictCount: number } {
  const before = configSnapshot(configManager);
  const store = readStore(getConfigControlPlaneDir(configManager));
  const nextSynced: SettingsLayerRecord[] = [...store.syncedSettings];
  const nextConflicts = store.conflicts.filter((entry) => entry.source !== 'synced');
  let appliedCount = 0;
  let conflictCount = 0;
  for (const [rawKey, nextValue] of Object.entries(bundle.settings)) {
    const schema = CONFIG_SCHEMA.find((entry) => entry.key === rawKey);
    if (!schema) continue;
    const key = rawKey as ConfigKey;
    const previousValue = before[key];
    if (JSON.stringify(previousValue) !== JSON.stringify(nextValue)) {
      conflictCount++;
      nextConflicts.push({
        key,
        localValue: structuredClone(previousValue),
        incomingValue: structuredClone(nextValue),
        source: 'synced',
        path,
        updatedAt: Date.now(),
      });
    }
    configManager.setDynamic(key, nextValue, { bypassManagedLock: true });
    const filtered = nextSynced.filter((entry) => entry.key !== key);
    filtered.push(toLayerRecord(key, nextValue, 'synced', 'settings-sync', `Pulled from ${path}`, path, false));
    nextSynced.splice(0, nextSynced.length, ...filtered);
    appliedCount++;
  }
  writeStore(trimStore({
    ...store,
    syncedSettings: nextSynced.sort((a, b) => a.key.localeCompare(b.key)),
    conflicts: nextConflicts.sort((a, b) => a.key.localeCompare(b.key)),
    events: [...store.events, {
      surface: 'settings-sync',
      direction: 'pull',
      path,
      timestamp: Date.now(),
      detail: `${appliedCount} settings pulled`,
    }],
  }), getConfigControlPlaneDir(configManager));
  return { appliedCount, conflictCount };
}

export function resolveSettingsSyncConflict(
  configManager: ConfigManager,
  key: ConfigKey,
  resolution: SettingsConflictResolution,
): boolean {
  const configDir = getConfigControlPlaneDir(configManager);
  const store = readStore(configDir);
  const conflict = store.conflicts.find((entry) => entry.key === key && entry.source === 'synced');
  if (!conflict) return false;

  const nextConflicts = store.conflicts.filter((entry) => !(entry.key === key && entry.source === 'synced'));
  let nextSynced = store.syncedSettings.filter((entry) => entry.key !== key);

  if (resolution === 'local') {
    configManager.setDynamic(key, structuredClone(conflict.localValue), { bypassManagedLock: true });
  } else {
    configManager.setDynamic(key, structuredClone(conflict.incomingValue), { bypassManagedLock: true });
    nextSynced = [
      ...nextSynced,
      toLayerRecord(
        key,
        conflict.incomingValue,
        'synced',
        'settings-sync',
        `Resolved synced conflict from ${conflict.path}`,
        conflict.path,
        false,
      ),
    ].sort((a, b) => a.key.localeCompare(b.key));
  }

  writeStore(trimStore({
    ...store,
    conflicts: nextConflicts.sort((a, b) => a.key.localeCompare(b.key)),
    syncedSettings: nextSynced,
    events: [...store.events, {
      surface: 'settings-sync',
      direction: 'apply',
      path: conflict.path,
      timestamp: Date.now(),
      detail: `Conflict resolved for ${key} using ${resolution} value`,
    }],
  }), configDir);
  return true;
}

export function stageManagedSettingsBundle(
  configManager: ConfigManager,
  bundle: ManagedSettingsBundle,
  path: string,
): StagedManagedBundle {
  const current = configSnapshot(configManager);
  const changes: ManagedBundleChange[] = [];
  for (const [rawKey, nextValue] of Object.entries(bundle.settings)) {
    const schema = CONFIG_SCHEMA.find((entry) => entry.key === rawKey);
    if (!schema) continue;
    const key = rawKey as ConfigKey;
    const previousValue = current[key];
    changes.push({
      key,
      previousValue: structuredClone(previousValue),
      nextValue: structuredClone(nextValue),
      changed: JSON.stringify(previousValue) !== JSON.stringify(nextValue),
      locked: true,
      source: `managed:${bundle.profileName}`,
      reason: `Managed bundle ${bundle.profileName}`,
    });
  }
  const stage: StagedManagedBundle = {
    id: makeRollbackToken(),
    profileName: bundle.profileName,
    path,
    importedAt: Date.now(),
    changeCount: changes.filter((entry) => entry.changed).length,
    risk: inferRisk(changes),
    changes,
  };
  const store = readStore(getConfigControlPlaneDir(configManager));
  writeStore(trimStore({
    ...store,
    stagedManagedBundle: stage,
    events: [...store.events, {
      surface: 'managed',
      direction: 'import',
      path,
      timestamp: Date.now(),
      detail: `${stage.changeCount} managed settings staged from ${bundle.profileName}`,
    }],
  }), getConfigControlPlaneDir(configManager));
  return stage;
}

export function applyStagedManagedBundle(
  configManager: ConfigManager,
  selectedKeys?: readonly ConfigKey[],
): { rollbackToken: string; appliedCount: number; remainingCount: number } {
  const store = readStore(getConfigControlPlaneDir(configManager));
  const stage = store.stagedManagedBundle;
  if (!stage) {
    throw new Error('No staged managed settings bundle is available.');
  }
  const selectedSet = selectedKeys && selectedKeys.length > 0
    ? new Set(selectedKeys)
    : null;
  const stagedChanges = selectedSet
    ? stage.changes.filter((change) => selectedSet.has(change.key))
    : [...stage.changes];
  if (stagedChanges.length === 0) {
    throw new Error('No staged managed settings matched the requested keys.');
  }
  const remainingChanges = stage.changes.filter((change) => !stagedChanges.some((candidate) => candidate.key === change.key));
  const previousValues: Partial<Record<ConfigKey, unknown>> = {};
  const nextManaged = store.managedSettings.filter((entry) => !stagedChanges.some((change) => change.key === entry.key));
  const nextLocks = store.managedLocks.filter((entry) => !stagedChanges.some((change) => change.key === entry.key));
  const restoredKeys: ConfigKey[] = [];
  const rollbackToken = makeRollbackToken();
  for (const change of stagedChanges) {
    previousValues[change.key] = structuredClone(change.previousValue);
    configManager.setDynamic(change.key, change.nextValue, { bypassManagedLock: true });
    nextManaged.push(toLayerRecord(
      change.key,
      change.nextValue,
      'managed',
      change.source,
      change.reason,
      stage.path,
      true,
    ));
    nextLocks.push({
      key: change.key,
      source: change.source,
      reason: change.reason,
      updatedAt: Date.now(),
    });
    if (change.changed) restoredKeys.push(change.key);
  }
  const nextStage = remainingChanges.length > 0
    ? {
        ...stage,
        changeCount: remainingChanges.filter((entry) => entry.changed).length,
        risk: inferRisk(remainingChanges),
        changes: remainingChanges,
      }
    : undefined;
  writeStore(trimStore({
    ...store,
    managedSettings: nextManaged.sort((a, b) => a.key.localeCompare(b.key)),
    managedLocks: nextLocks.sort((a, b) => a.key.localeCompare(b.key)),
    stagedManagedBundle: nextStage,
    rollbackHistory: [
      ...store.rollbackHistory,
      {
        token: rollbackToken,
        profileName: stage.profileName,
        path: stage.path,
        appliedAt: Date.now(),
        restoredKeys,
        previousValues,
      },
    ],
    events: [...store.events, {
      surface: 'managed',
      direction: 'apply',
      path: stage.path,
      timestamp: Date.now(),
      detail: `${restoredKeys.length} managed settings applied from ${stage.profileName}${remainingChanges.length > 0 ? ` (${remainingChanges.length} still staged)` : ''}`,
    }],
  }), getConfigControlPlaneDir(configManager));
  return { rollbackToken, appliedCount: restoredKeys.length, remainingCount: remainingChanges.length };
}

export function rollbackManagedApply(configManager: ConfigManager, token: string): number {
  const store = readStore(getConfigControlPlaneDir(configManager));
  const record = store.rollbackHistory.find((entry) => entry.token === token);
  if (!record) throw new Error(`Unknown managed rollback token: ${token}`);
  let restored = 0;
  const nextManaged = store.managedSettings.filter((entry) => !record.restoredKeys.includes(entry.key));
  const nextLocks = store.managedLocks.filter((entry) => !record.restoredKeys.includes(entry.key));
  for (const key of record.restoredKeys) {
    const previousValue = record.previousValues[key];
    if (previousValue !== undefined) {
      configManager.setDynamic(key, structuredClone(previousValue), { bypassManagedLock: true });
      restored++;
      continue;
    }
    const schema = CONFIG_SCHEMA.find((entry) => entry.key === key);
    if (!schema) continue;
    configManager.setDynamic(key, structuredClone(schema.default), { bypassManagedLock: true });
    restored++;
  }
  writeStore(trimStore({
    ...store,
    managedSettings: nextManaged,
    managedLocks: nextLocks,
    events: [...store.events, {
      surface: 'managed',
      direction: 'rollback',
      path: record.path,
      timestamp: Date.now(),
      detail: `${restored} managed settings rolled back from ${record.profileName}`,
    }],
  }), getConfigControlPlaneDir(configManager));
  return restored;
}

function buildResolvedEntries(configManager: ConfigManager, store: SettingsControlPlaneStore): ResolvedSettingEntry[] {
  const conflictKeys = new Set(store.conflicts.map((entry) => entry.key));
  return CONFIG_SCHEMA.map((setting) => {
    const localValue = structuredClone(configManager.get(setting.key));
    const syncedEntry = store.syncedSettings.find((entry) => entry.key === setting.key);
    const managedEntry = store.managedSettings.find((entry) => entry.key === setting.key);
    const overriddenSources: SettingsSource[] = [];
    let effectiveSource: SettingsSource = 'default';
    let effectiveValue: unknown = structuredClone(setting.default);
    let sourceLabel: string | undefined;
    let updatedAt: number | undefined;
    let lockReason: string | undefined;
    if (managedEntry) {
      effectiveSource = 'managed';
      effectiveValue = structuredClone(managedEntry.value);
      overriddenSources.push('local');
      if (syncedEntry) overriddenSources.push('synced');
      sourceLabel = managedEntry.sourceLabel;
      updatedAt = managedEntry.updatedAt;
      lockReason = managedEntry.detail;
    } else if (syncedEntry) {
      effectiveSource = 'synced';
      effectiveValue = structuredClone(syncedEntry.value);
      overriddenSources.push('local');
      sourceLabel = syncedEntry.sourceLabel;
      updatedAt = syncedEntry.updatedAt;
    } else if (JSON.stringify(localValue) !== JSON.stringify(setting.default)) {
      effectiveSource = 'local';
      effectiveValue = localValue;
    }
    const locked = store.managedLocks.some((entry) => entry.key === setting.key);
    return {
      key: setting.key,
      category: setting.key.split('.')[0] ?? 'general',
      effectiveValue,
      effectiveSource,
      defaultValue: structuredClone(setting.default),
      localValue,
      syncedValue: syncedEntry?.value,
      managedValue: managedEntry?.value,
      overriddenSources: overriddenSources.sort((a, b) => sourcePriority(b) - sourcePriority(a)),
      locked,
      lockReason,
      sourceLabel,
      updatedAt,
      conflict: conflictKeys.has(setting.key),
    };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

export function getSettingsControlPlaneSnapshot(configManager: ConfigManager): SettingsControlPlaneSnapshot {
  const store = readStore(getConfigControlPlaneDir(configManager));
  const resolvedEntries = buildResolvedEntries(configManager, store);
  const resolvedCounts: Record<SettingsSource, number> = {
    default: 0,
    local: 0,
    synced: 0,
    managed: 0,
  };
  for (const entry of resolvedEntries) resolvedCounts[entry.effectiveSource]++;
  return {
    liveKeyCount: CONFIG_SCHEMA.length,
    profileCount: getProfileManager().list().length,
    managedLockCount: store.managedLocks.length,
    resolvedCounts,
    lastSync: store.events[store.events.length - 1],
    recentEvents: store.events.slice(-8).reverse(),
    recentFailures: store.failures.slice(-6).reverse(),
    managedLocks: store.managedLocks,
    conflicts: store.conflicts.slice(-10).reverse(),
    stagedManagedBundle: store.stagedManagedBundle,
    rollbackHistory: store.rollbackHistory.slice(-8).reverse(),
    resolvedEntries,
  };
}

export function getResolvedSettingLookup(
  configManager: ConfigManager,
  key: ConfigKey,
): ResolvedSettingLookup | null {
  const store = readStore(getConfigControlPlaneDir(configManager));
  const entry = buildResolvedEntries(configManager, store).find((candidate) => candidate.key === key);
  if (!entry) return null;
  return {
    entry,
    lock: store.managedLocks.find((candidate) => candidate.key === key),
    syncedLayer: store.syncedSettings.find((candidate) => candidate.key === key),
    managedLayer: store.managedSettings.find((candidate) => candidate.key === key),
  };
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '(unset)';
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatResolvedSettingReview(
  configManager: ConfigManager,
  key: ConfigKey,
): string {
  const lookup = getResolvedSettingLookup(configManager, key);
  if (!lookup) {
    return `Unknown config key: ${key}`;
  }
  const { entry, lock, syncedLayer, managedLayer } = lookup;
  const lines = [
    'Resolved Setting Review',
    `  key: ${entry.key}`,
    `  category: ${entry.category}`,
    `  effective source: ${entry.effectiveSource}`,
    `  effective value: ${formatValue(entry.effectiveValue)}`,
    `  default value: ${formatValue(entry.defaultValue)}`,
    `  local value: ${formatValue(entry.localValue)}`,
    `  synced value: ${formatValue(entry.syncedValue)}`,
    `  managed value: ${formatValue(entry.managedValue)}`,
    `  overridden: ${entry.overriddenSources.length > 0 ? entry.overriddenSources.join(', ') : 'none'}`,
    `  locked: ${entry.locked ? 'yes' : 'no'}`,
    `  conflict: ${entry.conflict ? 'yes' : 'no'}`,
  ];
  if (entry.sourceLabel) lines.push(`  source label: ${entry.sourceLabel}`);
  if (entry.lockReason) lines.push(`  lock reason: ${entry.lockReason}`);
  if (entry.updatedAt) lines.push(`  updated: ${new Date(entry.updatedAt).toISOString()}`);
  if (lock) {
    lines.push('  live lock:');
    lines.push(`    source: ${lock.source}`);
    lines.push(`    reason: ${lock.reason}`);
    lines.push(`    updated: ${new Date(lock.updatedAt).toISOString()}`);
  }
  if (syncedLayer) {
    lines.push('  synced layer:');
    lines.push(`    source: ${syncedLayer.sourceLabel}`);
    lines.push(`    detail: ${syncedLayer.detail}`);
    if (syncedLayer.path) lines.push(`    path: ${syncedLayer.path}`);
  }
  if (managedLayer) {
    lines.push('  managed layer:');
    lines.push(`    source: ${managedLayer.sourceLabel}`);
    lines.push(`    detail: ${managedLayer.detail}`);
    if (managedLayer.path) lines.push(`    path: ${managedLayer.path}`);
  }
  return lines.join('\n');
}

export function formatStagedManagedBundleReview(configManager: ConfigManager): string {
  const snapshot = getSettingsControlPlaneSnapshot(configManager);
  const stage = snapshot.stagedManagedBundle;
  if (!stage) return 'No staged managed settings bundle is available.';
  const lines = [
    'Staged Managed Bundle Review',
    `  profileName: ${stage.profileName}`,
    `  importedAt: ${new Date(stage.importedAt).toISOString()}`,
    `  risk: ${stage.risk}`,
    `  changeCount: ${stage.changeCount}/${stage.changes.length}`,
    `  path: ${stage.path}`,
  ];
  for (const change of stage.changes.slice(0, 20)) {
    lines.push(`  ${change.key}`);
    lines.push(`    changed: ${change.changed ? 'yes' : 'no'}`);
    lines.push(`    previous: ${formatValue(change.previousValue)}`);
    lines.push(`    next: ${formatValue(change.nextValue)}`);
    lines.push(`    lock: ${change.source}  ${change.reason}`);
  }
  if (stage.changes.length > 20) {
    lines.push(`  ... ${stage.changes.length - 20} more change(s)`);
  }
  return lines.join('\n');
}

export function inspectManagedSettingsBundle(
  configManager: ConfigManager,
  bundle: ManagedSettingsBundle,
  path: string,
): string {
  const stage = stageManagedSettingsBundle(configManager, bundle, path);
  const changePreview = stage.changes.slice(0, 8).map((change) =>
    `  ${change.key}  ${change.changed ? 'change' : 'same'}  source=${change.source}`);
  return [
    'Managed Settings Review',
    `  profileName: ${bundle.profileName}`,
    `  importedAt: ${new Date(stage.importedAt).toISOString()}`,
    `  changes: ${stage.changeCount}/${stage.changes.length}`,
    `  risk: ${stage.risk}`,
    ...changePreview,
  ].join('\n');
}

export function inspectSettingsSyncBundle(bundle: SettingsSyncBundle): string {
  return [
    'Settings Sync Bundle',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  settings: ${Object.keys(bundle.settings).length}`,
  ].join('\n');
}

export function formatSettingsControlPlaneReview(configManager: ConfigManager): string[] {
  const snapshot = getSettingsControlPlaneSnapshot(configManager);
  const lines = [
    'Settings Sync Review',
    `  live keys: ${snapshot.liveKeyCount}`,
    `  saved profiles: ${snapshot.profileCount}`,
    `  managed locks: ${snapshot.managedLockCount}`,
    `  effective managed: ${snapshot.resolvedCounts.managed}`,
    `  effective synced: ${snapshot.resolvedCounts.synced}`,
    `  effective local: ${snapshot.resolvedCounts.local}`,
    `  defaulted: ${snapshot.resolvedCounts.default}`,
    `  last sync: ${snapshot.lastSync ? `${snapshot.lastSync.surface}/${snapshot.lastSync.direction} at ${new Date(snapshot.lastSync.timestamp).toISOString()}` : 'none'}`,
  ];
  if (snapshot.stagedManagedBundle) {
    lines.push(
      `  staged managed bundle: ${snapshot.stagedManagedBundle.profileName}`,
      `    changes=${snapshot.stagedManagedBundle.changeCount} risk=${snapshot.stagedManagedBundle.risk} path=${snapshot.stagedManagedBundle.path}`,
    );
  }
  if (snapshot.conflicts.length > 0) {
    lines.push('  conflicts:');
    for (const conflict of snapshot.conflicts.slice(0, 8)) {
      lines.push(`    ${conflict.key}  source=${conflict.source}  path=${conflict.path}`);
    }
  }
  if (snapshot.managedLocks.length > 0) {
    lines.push('  managed locks:');
    for (const lock of snapshot.managedLocks.slice(0, 10)) {
      lines.push(`    ${lock.key}  source=${lock.source}  ${lock.reason}`);
    }
  }
  if (snapshot.recentFailures.length > 0) {
    lines.push('  recent failures:');
    for (const failure of snapshot.recentFailures) {
      lines.push(`    ${failure.surface}  ${failure.message}`);
    }
  }
  return lines;
}
