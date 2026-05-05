import type { Line } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import {
  buildDetailBlock,
  buildGuidanceLine,
  buildPanelListRow,
  buildPanelLine,
  buildStatusPill,
  buildSummaryBlock,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
} from './polish.ts';
import { getSettingsControlPlaneSnapshot } from '@/runtime/index.ts';
import type { ConfigManager } from '../config/index.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  dim: '#475569',
  info: '#38bdf8',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
} as const;

type ResolvedEntry = ReturnType<typeof getSettingsControlPlaneSnapshot>['resolvedEntries'][number];

export class SettingsSyncPanel extends ScrollableListPanel<ResolvedEntry> {
  public constructor(private readonly configManager: ConfigManager) {
    super('settings-sync', 'Settings Sync', 'S', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  protected getItems(): readonly ResolvedEntry[] {
    return getSettingsControlPlaneSnapshot(this.configManager).resolvedEntries;
  }

  protected renderItem(entry: ResolvedEntry, _index: number, selected: boolean, width: number): Line {
    return buildPanelListRow(width, [
      { text: entry.key.padEnd(32), fg: C.value },
      { text: ` ${entry.effectiveSource}`.padEnd(11), fg: entry.effectiveSource === 'managed' ? C.warn : entry.effectiveSource === 'synced' ? C.ok : entry.effectiveSource === 'local' ? C.info : C.dim },
      { text: `${String(entry.effectiveValue)}`.slice(0, Math.max(0, width - 47)), fg: entry.locked ? C.warn : C.dim },
    ], C, { selected });
  }

  protected override getEmptyStateMessage(): string {
    return ' No resolved settings entries.';
  }

  public render(width: number, height: number): Line[] {
    const snapshot = getSettingsControlPlaneSnapshot(this.configManager);

    const postureLines: Line[] = [
      buildPanelLine(width, [[' resolved keys ', C.label], [String(snapshot.resolvedEntries.length), C.value], ['  conflicts ', C.label], ...buildStatusPill(snapshot.conflicts.length > 0 ? 'bad' : 'good', String(snapshot.conflicts.length)), ['  failures ', C.label], ...buildStatusPill(snapshot.recentFailures.length > 0 ? 'warn' : 'good', String(snapshot.recentFailures.length))]),
      buildPanelLine(width, [[' managed locks ', C.label], [String(snapshot.managedLockCount), snapshot.managedLockCount > 0 ? C.warn : C.dim], ['  staged bundle ', C.label], [snapshot.stagedManagedBundle ? snapshot.stagedManagedBundle.profileName : 'none', snapshot.stagedManagedBundle ? C.info : C.dim]]),
      buildGuidanceLine(width, '/settingssync conflicts', 'review conflicting synced values before they silently shape effective configuration', C),
      buildGuidanceLine(width, '/managed review', 'inspect staged managed changes, risk posture, and rollback records', C),
    ];

    const headerLines: Line[] = [
      ...buildSummaryBlock(width, 'Settings posture', postureLines, C),
      buildPanelLine(width, [[' local typed config ', C.label], [String(snapshot.liveKeyCount), C.value], ['  saved profiles ', C.label], [String(snapshot.profileCount), C.info], ['  managed locks ', C.label], [String(snapshot.managedLockCount), snapshot.managedLockCount > 0 ? C.warn : C.dim]]),
      buildPanelLine(width, [[' effective local ', C.label], [String(snapshot.resolvedCounts.local), C.info], ['  synced ', C.label], [String(snapshot.resolvedCounts.synced), snapshot.resolvedCounts.synced > 0 ? C.ok : C.dim], ['  managed ', C.label], [String(snapshot.resolvedCounts.managed), snapshot.resolvedCounts.managed > 0 ? C.warn : C.dim]]),
      buildPanelLine(width, [[' last sync ', C.label], [snapshot.lastSync ? `${snapshot.lastSync.surface}/${snapshot.lastSync.direction}` : 'none', snapshot.lastSync ? C.ok : C.dim], ['  when ', C.label], [snapshot.lastSync ? new Date(snapshot.lastSync.timestamp).toLocaleString() : 'n/a', C.dim]]),
      // Staged Bundle
      ...(snapshot.stagedManagedBundle
        ? [
            buildPanelLine(width, [[' profile ', C.label], [snapshot.stagedManagedBundle.profileName, C.value], ['  risk ', C.label], [snapshot.stagedManagedBundle.risk, snapshot.stagedManagedBundle.risk === 'high' ? C.error : snapshot.stagedManagedBundle.risk === 'medium' ? C.warn : C.ok], ['  changes ', C.label], [String(snapshot.stagedManagedBundle.changeCount), C.info]]),
            buildPanelLine(width, [[' path ', C.label], [snapshot.stagedManagedBundle.path.slice(0, Math.max(0, width - 9)), C.dim]]),
          ]
        : [buildPanelLine(width, [[' No staged managed settings bundle.', C.dim]])]),
      // Recent Events
      ...(snapshot.recentEvents.length > 0
        ? snapshot.recentEvents.map((event) => buildPanelLine(width, [[` ${event.surface}/${event.direction}`.padEnd(18), C.info], [` ${event.detail}`.slice(0, Math.max(0, width - 20)), C.dim]]))
        : [buildPanelLine(width, [[' No sync or managed-setting events recorded yet.', C.dim]])]),
      // Managed Locks
      ...(snapshot.managedLocks.length > 0
        ? snapshot.managedLocks.slice(0, 10).map((lock) => buildPanelLine(width, [[` ${lock.key}`.padEnd(30), C.value], [` source=${lock.source}`.padEnd(24), C.info], [` ${lock.reason}`.slice(0, Math.max(0, width - 56)), C.dim]]))
        : [buildPanelLine(width, [[' No managed locks are currently active.', C.dim]])]),
      // Failures
      ...(snapshot.recentFailures.length > 0
        ? snapshot.recentFailures.map((failure) => buildPanelLine(width, [[` ${failure.surface}`.padEnd(10), C.error], [` ${failure.message}`.slice(0, Math.max(0, width - 12)), C.dim]]))
        : [buildPanelLine(width, [[' No recent sync or managed-setting failures.', C.dim]])]),
      // Conflicts
      ...(snapshot.conflicts.length > 0
        ? snapshot.conflicts.map((conflict) => buildPanelLine(width, [[` ${conflict.key}`.padEnd(30), C.value], [` ${conflict.source}`.padEnd(10), C.warn], [` resolve: /settingssync resolve ${conflict.key} local|synced`.slice(0, Math.max(0, width - 42)), C.dim]]))
        : [buildPanelLine(width, [[' No settings conflicts detected.', C.dim]])]),
      // Rollback History
      ...(snapshot.rollbackHistory.length > 0
        ? snapshot.rollbackHistory.map((entry) => buildPanelLine(width, [[` ${entry.token}`.padEnd(18), C.info], [` ${entry.profileName}`.padEnd(18), C.value], [` restored=${String(entry.restoredKeys.length).padEnd(4)}`, C.warn], [` ${new Date(entry.appliedAt).toLocaleString()}`.slice(0, Math.max(0, width - 46)), C.dim]]))
        : [buildPanelLine(width, [[' No managed rollback records yet.', C.dim]])]),
    ];

    this.clampSelection();
    const selectedEntry = snapshot.resolvedEntries[this.selectedIndex];
    const footerLines: Line[] = [
      ...(selectedEntry
        ? buildDetailBlock(width, 'Selected setting', [
            buildPanelLine(width, [[' key ', C.label], [selectedEntry.key, C.value], ['  category ', C.label], [selectedEntry.category, C.info]]),
            buildPanelLine(width, [[' effective ', C.label], [selectedEntry.effectiveSource, selectedEntry.effectiveSource === 'managed' ? C.warn : selectedEntry.effectiveSource === 'synced' ? C.ok : selectedEntry.effectiveSource === 'local' ? C.info : C.dim], ['  locked ', C.label], [selectedEntry.locked ? 'yes' : 'no', selectedEntry.locked ? C.warn : C.dim], ['  conflict ', C.label], [selectedEntry.conflict ? 'yes' : 'no', selectedEntry.conflict ? C.error : C.good]]),
            buildPanelLine(width, [[' source ', C.label], [(selectedEntry.sourceLabel ?? 'local/default').slice(0, Math.max(0, width - 10)), C.dim]]),
            buildPanelLine(width, [[' overrides ', C.label], [(selectedEntry.overriddenSources.length > 0 ? selectedEntry.overriddenSources.join(', ') : 'none').slice(0, Math.max(0, width - 13)), C.dim]]),
            buildPanelLine(width, [[' local ', C.label], [String(selectedEntry.localValue).slice(0, Math.max(0, width - 9)), C.dim]]),
            buildPanelLine(width, [[' synced ', C.label], [String(selectedEntry.syncedValue ?? '(unset)').slice(0, Math.max(0, width - 10)), C.ok]]),
            buildPanelLine(width, [[' managed ', C.label], [String(selectedEntry.managedValue ?? '(unset)').slice(0, Math.max(0, width - 11)), C.warn]]),
          ], C)
        : []),
      buildPanelLine(width, [[' ↑/↓ browse  /settingssync show <key>  /settingssync resolve <key> <local|synced>  /managed apply-staged [key...] ', C.dim]]),
    ];

    return this.renderList(width, height, {
      title: 'Settings Sync',
      header: headerLines,
      footer: footerLines,
    });
  }
}
