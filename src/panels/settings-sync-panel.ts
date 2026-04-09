import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import {
  buildDetailBlock,
  buildGuidanceLine,
  buildPanelListRow,
  buildPanelLine,
  buildPanelWorkspace,
  buildSummaryBlock,
  DEFAULT_PANEL_PALETTE,
  resolvePrimaryScrollableSection,
  type PanelWorkspaceSection,
} from './polish.ts';
import { getSettingsControlPlaneSnapshot } from '../runtime/settings/control-plane.ts';
import type { ConfigManager } from '../config/index.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  dim: '#475569',
  info: '#38bdf8',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
} as const;

export class SettingsSyncPanel extends BasePanel {
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(private readonly configManager: ConfigManager) {
    super('settings-sync', 'Settings Sync', 'S', 'monitoring');
  }

  public handleInput(key: string): boolean {
    const total = getSettingsControlPlaneSnapshot(this.configManager).resolvedEntries.length;
    if (total <= 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(total - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const snapshot = getSettingsControlPlaneSnapshot(this.configManager);
    const safeSelectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, snapshot.resolvedEntries.length - 1)));
    this.selectedIndex = safeSelectedIndex;
    const postureLines: Line[] = [
      buildPanelLine(width, [[' resolved keys ', C.label], [String(snapshot.resolvedEntries.length), C.value], ['  conflicts ', C.label], [String(snapshot.conflicts.length), snapshot.conflicts.length > 0 ? C.error : C.good], ['  failures ', C.label], [String(snapshot.recentFailures.length), snapshot.recentFailures.length > 0 ? C.warn : C.good]]),
      buildPanelLine(width, [[' managed locks ', C.label], [String(snapshot.managedLockCount), snapshot.managedLockCount > 0 ? C.warn : C.dim], ['  staged bundle ', C.label], [snapshot.stagedManagedBundle ? snapshot.stagedManagedBundle.profileName : 'none', snapshot.stagedManagedBundle ? C.info : C.dim]]),
      buildGuidanceLine(width, '/settingssync conflicts', 'review conflicting synced values before they silently shape effective configuration', C),
      buildGuidanceLine(width, '/managed review', 'inspect staged managed changes, risk posture, and rollback records', C),
    ];
    const prefixSections: PanelWorkspaceSection[] = [
      {
        lines: buildSummaryBlock(width, 'Settings posture', postureLines, C),
      },
      {
        title: 'Layers',
        lines: [
          buildPanelLine(width, [[' local typed config ', C.label], [String(snapshot.liveKeyCount), C.value], ['  saved profiles ', C.label], [String(snapshot.profileCount), C.info], ['  managed locks ', C.label], [String(snapshot.managedLockCount), snapshot.managedLockCount > 0 ? C.warn : C.dim]]),
          buildPanelLine(width, [[' effective local ', C.label], [String(snapshot.resolvedCounts.local), C.info], ['  synced ', C.label], [String(snapshot.resolvedCounts.synced), snapshot.resolvedCounts.synced > 0 ? C.ok : C.dim], ['  managed ', C.label], [String(snapshot.resolvedCounts.managed), snapshot.resolvedCounts.managed > 0 ? C.warn : C.dim]]),
          buildPanelLine(width, [[' last sync ', C.label], [snapshot.lastSync ? `${snapshot.lastSync.surface}/${snapshot.lastSync.direction}` : 'none', snapshot.lastSync ? C.ok : C.dim], ['  when ', C.label], [snapshot.lastSync ? new Date(snapshot.lastSync.timestamp).toLocaleString() : 'n/a', C.dim]]),
        ],
      },
      {
        title: 'Staged Bundle',
        lines: snapshot.stagedManagedBundle
          ? [
              buildPanelLine(width, [[' profile ', C.label], [snapshot.stagedManagedBundle.profileName, C.value], ['  risk ', C.label], [snapshot.stagedManagedBundle.risk, snapshot.stagedManagedBundle.risk === 'high' ? C.error : snapshot.stagedManagedBundle.risk === 'medium' ? C.warn : C.ok], ['  changes ', C.label], [String(snapshot.stagedManagedBundle.changeCount), C.info]]),
              buildPanelLine(width, [[' path ', C.label], [snapshot.stagedManagedBundle.path.slice(0, Math.max(0, width - 9)), C.dim]]),
            ]
          : [buildPanelLine(width, [[' No staged managed settings bundle.', C.dim]])],
      },
      {
        title: 'Recent Events',
        lines: snapshot.recentEvents.length > 0
          ? snapshot.recentEvents.map((event) => buildPanelLine(width, [[` ${event.surface}/${event.direction}`.padEnd(18), C.info], [` ${event.detail}`.slice(0, Math.max(0, width - 20)), C.dim]]))
          : [buildPanelLine(width, [[' No sync or managed-setting events recorded yet.', C.dim]])],
      },
      {
        title: 'Managed Locks',
        lines: snapshot.managedLocks.length > 0
          ? snapshot.managedLocks.slice(0, 10).map((lock) => buildPanelLine(width, [[` ${lock.key}`.padEnd(30), C.value], [` source=${lock.source}`.padEnd(24), C.info], [` ${lock.reason}`.slice(0, Math.max(0, width - 56)), C.dim]]))
          : [buildPanelLine(width, [[' No managed locks are currently active.', C.dim]])],
      },
      {
        title: 'Failures',
        lines: snapshot.recentFailures.length > 0
          ? snapshot.recentFailures.map((failure) => buildPanelLine(width, [[` ${failure.surface}`.padEnd(10), C.error], [` ${failure.message}`.slice(0, Math.max(0, width - 12)), C.dim]]))
          : [buildPanelLine(width, [[' No recent sync or managed-setting failures.', C.dim]])],
      },
      {
        title: 'Conflicts',
          lines: snapshot.conflicts.length > 0
          ? snapshot.conflicts.map((conflict) => buildPanelLine(width, [[` ${conflict.key}`.padEnd(30), C.value], [` ${conflict.source}`.padEnd(10), C.warn], [` resolve: /settingssync resolve ${conflict.key} local|synced`.slice(0, Math.max(0, width - 42)), C.dim]]))
          : [buildPanelLine(width, [[' No settings conflicts detected.', C.dim]])],
      },
      {
        title: 'Rollback History',
        lines: snapshot.rollbackHistory.length > 0
          ? snapshot.rollbackHistory.map((entry) => buildPanelLine(width, [[` ${entry.token}`.padEnd(18), C.info], [` ${entry.profileName}`.padEnd(18), C.value], [` restored=${String(entry.restoredKeys.length).padEnd(4)}`, C.warn], [` ${new Date(entry.appliedAt).toLocaleString()}`.slice(0, Math.max(0, width - 46)), C.dim]]))
          : [buildPanelLine(width, [[' No managed rollback records yet.', C.dim]])],
      },
    ];
    const selected = snapshot.resolvedEntries[this.selectedIndex];
    const selectedSections = !selected ? [] as PanelWorkspaceSection[] : [{
      lines: buildDetailBlock(width, 'Selected setting', [
        buildPanelLine(width, [[' key ', C.label], [selected.key, C.value], ['  category ', C.label], [selected.category, C.info]]),
        buildPanelLine(width, [[' effective ', C.label], [selected.effectiveSource, selected.effectiveSource === 'managed' ? C.warn : selected.effectiveSource === 'synced' ? C.ok : selected.effectiveSource === 'local' ? C.info : C.dim], ['  locked ', C.label], [selected.locked ? 'yes' : 'no', selected.locked ? C.warn : C.dim], ['  conflict ', C.label], [selected.conflict ? 'yes' : 'no', selected.conflict ? C.error : C.good]]),
        buildPanelLine(width, [[' source ', C.label], [(selected.sourceLabel ?? 'local/default').slice(0, Math.max(0, width - 10)), C.dim]]),
        buildPanelLine(width, [[' overrides ', C.label], [(selected.overriddenSources.length > 0 ? selected.overriddenSources.join(', ') : 'none').slice(0, Math.max(0, width - 13)), C.dim]]),
        buildPanelLine(width, [[' local ', C.label], [String(selected.localValue).slice(0, Math.max(0, width - 9)), C.dim]]),
        buildPanelLine(width, [[' synced ', C.label], [String(selected.syncedValue ?? '(unset)').slice(0, Math.max(0, width - 10)), C.ok]]),
        buildPanelLine(width, [[' managed ', C.label], [String(selected.managedValue ?? '(unset)').slice(0, Math.max(0, width - 11)), C.warn]]),
      ], C),
    }];
    const resolvedEntriesSection = resolvePrimaryScrollableSection(width, height, {
      intro: 'Local typed config, synced and managed layers, staged bundle review, conflicts, and control-plane failures.',
      footerLines: [buildPanelLine(width, [[' ↑/↓ browse  /settingssync show <key>  /settingssync resolve <key> <local|synced>  /managed apply-staged [key...] ', C.dim]])],
      palette: C,
      beforeSections: prefixSections,
      section: {
        title: 'Resolved Entries',
        scrollableLines: snapshot.resolvedEntries.map((entry, absolute) => {
          return buildPanelListRow(width, [
            { text: entry.key.padEnd(32), fg: C.value },
            { text: ` ${entry.effectiveSource}`.padEnd(11), fg: entry.effectiveSource === 'managed' ? C.warn : entry.effectiveSource === 'synced' ? C.ok : entry.effectiveSource === 'local' ? C.info : C.dim },
            { text: `${String(entry.effectiveValue)}`.slice(0, Math.max(0, width - 47)), fg: entry.locked ? C.warn : C.dim },
          ], C, { selected: absolute === this.selectedIndex });
        }),
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: selectedSections,
    });
    this.scrollOffset = resolvedEntriesSection.scrollOffset;
    const sections: PanelWorkspaceSection[] = [
      ...prefixSections,
      resolvedEntriesSection.section,
      ...selectedSections,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Settings Sync',
      intro: 'Local typed config, synced and managed layers, staged bundle review, conflicts, and control-plane failures.',
      sections,
      footerLines: [buildPanelLine(width, [[' ↑/↓ browse  /settingssync show <key>  /settingssync resolve <key> <local|synced>  /managed apply-staged [key...] ', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
