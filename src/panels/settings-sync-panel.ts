import type { Line } from '../types/grid.ts';
import { fitDisplay, truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import {
  buildDetailBlock,
  buildGuidanceLine,
  buildKeyboardHints,
  buildPanelListRow,
  buildPanelLine,
  buildStatusPill,
  buildSummaryBlock,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
} from './polish.ts';
import { getSettingsControlPlaneSnapshot } from '@/runtime/index.ts';
import type { ConfigManager } from '../config/index.ts';

// Base chrome only — state colors and text tokens come straight from
// DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

type ResolvedEntry = ReturnType<typeof getSettingsControlPlaneSnapshot>['resolvedEntries'][number];

export class SettingsSyncPanel extends ScrollableListPanel<ResolvedEntry> {
  public constructor(private readonly configManager: ConfigManager) {
    super('settings-sync', 'Settings Sync', 'S', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter settings';
  }

  protected override filterMatches(entry: ResolvedEntry, q: string): boolean {
    return entry.key.toLowerCase().includes(q)
      || String(entry.effectiveSource).toLowerCase().includes(q)
      || String(entry.effectiveValue).toLowerCase().includes(q);
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  protected getItems(): readonly ResolvedEntry[] {
    return getSettingsControlPlaneSnapshot(this.configManager).resolvedEntries;
  }

  protected renderItem(entry: ResolvedEntry, _index: number, selected: boolean, width: number): Line {
    return buildPanelListRow(width, [
      { text: fitDisplay(entry.key, 32).padEnd(32), fg: C.value },
      { text: ` ${entry.effectiveSource}`.padEnd(11), fg: entry.effectiveSource === 'managed' ? C.warn : entry.effectiveSource === 'synced' ? C.good : entry.effectiveSource === 'local' ? C.info : C.dim },
      { text: truncateDisplay(`${String(entry.effectiveValue)}`, Math.max(0, width - 47)), fg: entry.locked ? C.warn : C.dim },
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
      buildGuidanceLine(width, '/settings-sync conflicts', 'review conflicting synced values before they silently shape effective configuration', C),
      buildGuidanceLine(width, '/managed review', 'inspect staged managed changes, risk posture, and rollback records', C),
    ];

    const headerLines: Line[] = [
      ...buildSummaryBlock(width, 'Settings posture', postureLines, C),
      buildPanelLine(width, [[' local typed config ', C.label], [String(snapshot.liveKeyCount), C.value], ['  saved profiles ', C.label], [String(snapshot.profileCount), C.info], ['  managed locks ', C.label], [String(snapshot.managedLockCount), snapshot.managedLockCount > 0 ? C.warn : C.dim]]),
      buildPanelLine(width, [[' effective local ', C.label], [String(snapshot.resolvedCounts.local), C.info], ['  synced ', C.label], [String(snapshot.resolvedCounts.synced), snapshot.resolvedCounts.synced > 0 ? C.good : C.dim], ['  managed ', C.label], [String(snapshot.resolvedCounts.managed), snapshot.resolvedCounts.managed > 0 ? C.warn : C.dim]]),
      buildPanelLine(width, [[' last sync ', C.label], [snapshot.lastSync ? `${snapshot.lastSync.surface}/${snapshot.lastSync.direction}` : 'none', snapshot.lastSync ? C.good : C.dim], ['  when ', C.label], [snapshot.lastSync ? new Date(snapshot.lastSync.timestamp).toLocaleString() : 'n/a', C.dim]]),
      // Staged Bundle
      ...(snapshot.stagedManagedBundle
        ? [
            buildPanelLine(width, [[' profile ', C.label], [snapshot.stagedManagedBundle.profileName, C.value], ['  risk ', C.label], [snapshot.stagedManagedBundle.risk, snapshot.stagedManagedBundle.risk === 'high' ? C.bad : snapshot.stagedManagedBundle.risk === 'medium' ? C.warn : C.good], ['  changes ', C.label], [String(snapshot.stagedManagedBundle.changeCount), C.info]]),
            buildPanelLine(width, [[' path ', C.label], [truncateDisplay(snapshot.stagedManagedBundle.path, Math.max(0, width - 9)), C.dim]]),
          ]
        : [buildPanelLine(width, [[' No staged managed settings bundle.', C.dim]])]),
      // Recent Events
      ...(snapshot.recentEvents.length > 0
        ? snapshot.recentEvents.map((event) => buildPanelLine(width, [[fitDisplay(` ${event.surface}/${event.direction}`, 18).padEnd(18), C.info], [truncateDisplay(` ${event.detail}`, Math.max(0, width - 20)), C.dim]]))
        : [buildPanelLine(width, [[' No sync or managed-setting events recorded yet.', C.dim]])]),
      // Managed Locks
      ...(snapshot.managedLocks.length > 0
        ? snapshot.managedLocks.slice(0, 10).map((lock) => buildPanelLine(width, [[fitDisplay(` ${lock.key}`, 30).padEnd(30), C.value], [fitDisplay(` source=${lock.source}`, 24).padEnd(24), C.info], [truncateDisplay(` ${lock.reason}`, Math.max(0, width - 56)), C.dim]]))
        : [buildPanelLine(width, [[' No managed locks are currently active.', C.dim]])]),
      // Failures
      ...(snapshot.recentFailures.length > 0
        ? snapshot.recentFailures.map((failure) => buildPanelLine(width, [[` ${failure.surface}`.padEnd(10), C.bad], [truncateDisplay(` ${failure.message}`, Math.max(0, width - 12)), C.dim]]))
        : [buildPanelLine(width, [[' No recent sync or managed-setting failures.', C.dim]])]),
      // Conflicts
      ...(snapshot.conflicts.length > 0
        ? snapshot.conflicts.map((conflict) => buildPanelLine(width, [[fitDisplay(` ${conflict.key}`, 30).padEnd(30), C.value], [fitDisplay(` ${conflict.source}`, 10).padEnd(10), C.warn], [truncateDisplay(` resolve: /settings-sync resolve ${conflict.key} local|synced`, Math.max(0, width - 42)), C.dim]]))
        : [buildPanelLine(width, [[' No settings conflicts detected.', C.dim]])]),
      // Rollback History
      ...(snapshot.rollbackHistory.length > 0
        ? snapshot.rollbackHistory.map((entry) => buildPanelLine(width, [[fitDisplay(` ${entry.token}`, 18).padEnd(18), C.info], [fitDisplay(` ${entry.profileName}`, 18).padEnd(18), C.value], [` restored=${String(entry.restoredKeys.length).padEnd(4)}`, C.warn], [truncateDisplay(` ${new Date(entry.appliedAt).toLocaleString()}`, Math.max(0, width - 46)), C.dim]]))
        : [buildPanelLine(width, [[' No managed rollback records yet.', C.dim]])]),
    ];

    this.clampSelection();
    const selectedEntry = snapshot.resolvedEntries[this.selectedIndex];
    const footerLines: Line[] = [
      ...(selectedEntry
        ? buildDetailBlock(width, 'Selected setting', [
            buildPanelLine(width, [[' key ', C.label], [selectedEntry.key, C.value], ['  category ', C.label], [selectedEntry.category, C.info]]),
            buildPanelLine(width, [[' effective ', C.label], [selectedEntry.effectiveSource, selectedEntry.effectiveSource === 'managed' ? C.warn : selectedEntry.effectiveSource === 'synced' ? C.good : selectedEntry.effectiveSource === 'local' ? C.info : C.dim], ['  locked ', C.label], [selectedEntry.locked ? 'yes' : 'no', selectedEntry.locked ? C.warn : C.dim], ['  conflict ', C.label], [selectedEntry.conflict ? 'yes' : 'no', selectedEntry.conflict ? C.bad : C.good]]),
            buildPanelLine(width, [[' source ', C.label], [truncateDisplay(selectedEntry.sourceLabel ?? 'local/default', Math.max(0, width - 10)), C.dim]]),
            buildPanelLine(width, [[' overrides ', C.label], [truncateDisplay(selectedEntry.overriddenSources.length > 0 ? selectedEntry.overriddenSources.join(', ') : 'none', Math.max(0, width - 13)), C.dim]]),
            buildPanelLine(width, [[' local ', C.label], [truncateDisplay(String(selectedEntry.localValue), Math.max(0, width - 9)), C.dim]]),
            buildPanelLine(width, [[' synced ', C.label], [truncateDisplay(String(selectedEntry.syncedValue ?? '(unset)'), Math.max(0, width - 10)), C.good]]),
            buildPanelLine(width, [[' managed ', C.label], [truncateDisplay(String(selectedEntry.managedValue ?? '(unset)'), Math.max(0, width - 11)), C.warn]]),
          ], C)
        : [buildPanelLine(width, [[' Select a setting above to inspect its effective value, source, and overrides.', C.dim]])]),
      buildKeyboardHints(width, [
        { keys: '↑/↓', label: 'browse' },
        { keys: '/', label: 'filter' },
        { keys: '/settings-sync show <key>', label: 'inspect' },
        { keys: '/settings-sync resolve <key> <local|synced>', label: 'resolve conflict' },
      ], C),
    ];

    return this.renderList(width, height, {
      title: 'Settings Sync',
      header: headerLines,
      footer: footerLines,
    });
  }
}
