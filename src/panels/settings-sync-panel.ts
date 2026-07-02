import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { fitDisplay, truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import {
  buildDetailBlock,
  buildKeyboardHints,
  buildPanelListRow,
  buildPanelLine,
  buildPanelWorkspace,
  buildStatusPill,
  buildSummaryBlock,
  DEFAULT_PANEL_PALETTE,
  resolveScrollablePanelSection,
  type PanelPalette,
  type PanelWorkspaceSection,
} from './polish.ts';
import { getSettingsControlPlaneSnapshot } from '@/runtime/index.ts';
import type { ConfigManager } from '../config/index.ts';
import type { PanelIntegrationContext } from './types.ts';

// Base chrome only — state colors and text tokens come straight from
// DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

type SettingsSnapshot = ReturnType<typeof getSettingsControlPlaneSnapshot>;
type ResolvedEntry = SettingsSnapshot['resolvedEntries'][number];

// Tab-toggled browse modes (RemotePanel pattern): 'keys' is the primary
// selectable list (kept at its own scroll viewport); the rest were
// previously dumped unconditionally into the header, squeezing the key
// list out of view.
const BROWSE_MODES = ['keys', 'events', 'locks', 'failures', 'conflicts', 'rollback'] as const;
type BrowseMode = typeof BROWSE_MODES[number];

interface BrowseModeContent {
  readonly title: string;
  readonly rows: Line[];
  readonly emptyMessage: string;
}

export class SettingsSyncPanel extends ScrollableListPanel<ResolvedEntry> {
  private browseMode: BrowseMode = 'keys';
  private browseIndex = 0;
  private browseScrollOffset = 0;

  // Inline local/synced picker for a conflicted entry (Enter on the keys
  // list). Resolved via handlePanelIntegrationAction, the only place
  // executeCommand is available.
  private _resolvePrompt: { readonly key: string } | null = null;
  private _pendingResolve: { readonly key: string; readonly choice: 'local' | 'synced' } | null = null;
  private _pendingManagedReview = false;

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
      { text: truncateDisplay(`${String(entry.effectiveValue)}`, Math.max(0, width - 47)), fg: entry.conflict ? C.bad : entry.locked ? C.warn : C.dim },
    ], C, { selected });
  }

  protected override getEmptyStateMessage(): string {
    return ' No resolved settings entries.';
  }

  /** Enter on a conflicted entry opens the inline local/synced picker. */
  protected override onSelect(entry: ResolvedEntry): void {
    if (!entry.conflict) return;
    this._resolvePrompt = { key: entry.key };
    this.needsRender = true;
  }

  public override handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    if (this._resolvePrompt) {
      if (key === 'l') {
        this._pendingResolve = { key: this._resolvePrompt.key, choice: 'local' };
        this._resolvePrompt = null;
        this.needsRender = true;
        return true;
      }
      if (key === 's') {
        this._pendingResolve = { key: this._resolvePrompt.key, choice: 'synced' };
        this._resolvePrompt = null;
        this.needsRender = true;
        return true;
      }
      if (key === 'escape' || key === 'n') {
        this._resolvePrompt = null;
        this.needsRender = true;
        return true;
      }
      return true; // absorbed — keep the picker pending
    }

    // The inline `/`-filter capture must win over browse-mode/managed-review
    // keys while it is actively collecting a query (e.g. typing "m").
    if (this.filterActive) {
      return super.handleInput(key);
    }

    if (key === 'tab') {
      const idx = BROWSE_MODES.indexOf(this.browseMode);
      this.browseMode = BROWSE_MODES[(idx + 1) % BROWSE_MODES.length]!;
      this.browseIndex = 0;
      this.browseScrollOffset = 0;
      this.needsRender = true;
      return true;
    }

    if (key === 'm') {
      const snapshot = getSettingsControlPlaneSnapshot(this.configManager);
      if (snapshot.stagedManagedBundle) {
        this._pendingManagedReview = true;
        return true;
      }
      return false;
    }

    if (this.browseMode !== 'keys') {
      return this._handleBrowseInput(key);
    }

    return super.handleInput(key);
  }

  public handlePanelIntegrationAction(_key: string, ctx: PanelIntegrationContext): boolean {
    if (this._pendingResolve) {
      const { key, choice } = this._pendingResolve;
      this._pendingResolve = null;
      void ctx.executeCommand?.('settings-sync', ['resolve', key, choice]).catch((err) => {
        logger.debug('settings-sync resolve dispatch failed', { err });
      });
      return true;
    }
    if (this._pendingManagedReview) {
      this._pendingManagedReview = false;
      void ctx.executeCommand?.('managed', ['review']).catch((err) => {
        logger.debug('managed review dispatch failed', { err });
      });
      return true;
    }
    return false;
  }

  private _browseItemCount(): number {
    const snapshot = getSettingsControlPlaneSnapshot(this.configManager);
    switch (this.browseMode) {
      case 'events': return snapshot.recentEvents.length;
      case 'locks': return snapshot.managedLocks.length;
      case 'failures': return snapshot.recentFailures.length;
      case 'conflicts': return snapshot.conflicts.length;
      case 'rollback': return snapshot.rollbackHistory.length;
      default: return 0;
    }
  }

  private _handleBrowseInput(key: string): boolean {
    const count = this._browseItemCount();
    if (count === 0) return false;
    switch (key) {
      case 'up':
      case 'k':
        this.browseIndex = Math.max(0, this.browseIndex - 1);
        this.needsRender = true;
        return true;
      case 'down':
      case 'j':
        this.browseIndex = Math.min(count - 1, this.browseIndex + 1);
        this.needsRender = true;
        return true;
      case 'pageup':
        this.browseIndex = Math.max(0, this.browseIndex - this.getPageSize());
        this.needsRender = true;
        return true;
      case 'pagedown':
        this.browseIndex = Math.min(count - 1, this.browseIndex + this.getPageSize());
        this.needsRender = true;
        return true;
      case 'home':
      case 'g':
        this.browseIndex = 0;
        this.needsRender = true;
        return true;
      case 'end':
      case 'G':
        this.browseIndex = count - 1;
        this.needsRender = true;
        return true;
      default:
        return false;
    }
  }

  /** ≤5 fixed rows total (1 summary title + 4 rows), shared by every mode. */
  private _buildPostureHeader(width: number, snapshot: SettingsSnapshot): Line[] {
    const rows: Line[] = [
      buildPanelLine(width, [
        [' resolved keys ', C.label], [String(snapshot.resolvedEntries.length), C.value],
        ['  conflicts ', C.label], ...buildStatusPill(snapshot.conflicts.length > 0 ? 'bad' : 'good', String(snapshot.conflicts.length)),
        ['  failures ', C.label], ...buildStatusPill(snapshot.recentFailures.length > 0 ? 'warn' : 'good', String(snapshot.recentFailures.length)),
      ]),
      buildPanelLine(width, [
        [' managed locks ', C.label], [String(snapshot.managedLockCount), snapshot.managedLockCount > 0 ? C.warn : C.dim],
        ['  staged bundle ', C.label], [snapshot.stagedManagedBundle ? snapshot.stagedManagedBundle.profileName : 'none', snapshot.stagedManagedBundle ? C.info : C.dim],
      ]),
      buildPanelLine(width, [
        [' effective local ', C.label], [String(snapshot.resolvedCounts.local), C.info],
        ['  synced ', C.label], [String(snapshot.resolvedCounts.synced), snapshot.resolvedCounts.synced > 0 ? C.good : C.dim],
        ['  managed ', C.label], [String(snapshot.resolvedCounts.managed), snapshot.resolvedCounts.managed > 0 ? C.warn : C.dim],
      ]),
      buildPanelLine(width, [
        [' last sync ', C.label], [snapshot.lastSync ? `${snapshot.lastSync.surface}/${snapshot.lastSync.direction}` : 'none', snapshot.lastSync ? C.good : C.dim],
        ['  mode ', C.label], [this.browseMode, C.info],
      ]),
    ];
    return buildSummaryBlock(width, 'Settings posture', rows, C);
  }

  private _buildResolvePromptLines(width: number, key: string): Line[] {
    return [
      buildPanelLine(width, [[` Resolve conflict for "${key}"?`, C.warn]]),
      buildPanelLine(width, [
        [' l', C.info], ['  keep local', C.dim],
        ['   s', C.info], ['  use synced', C.dim],
        ['   Esc', C.info], ['  cancel', C.dim],
      ]),
    ];
  }

  private _buildBrowseModeContent(width: number, snapshot: SettingsSnapshot): BrowseModeContent {
    switch (this.browseMode) {
      case 'events':
        return {
          title: 'Recent Sync & Managed-Setting Events',
          rows: snapshot.recentEvents.map((event, index) => buildPanelListRow(width, [
            { text: fitDisplay(` ${event.surface}/${event.direction}`, 18).padEnd(18), fg: C.info },
            { text: truncateDisplay(` ${event.detail}`, Math.max(0, width - 20)), fg: C.dim },
          ], C, { selected: index === this.browseIndex })),
          emptyMessage: ' No sync or managed-setting events recorded yet.',
        };
      case 'locks':
        return {
          title: 'Managed Locks',
          rows: snapshot.managedLocks.map((lock, index) => buildPanelListRow(width, [
            { text: fitDisplay(` ${lock.key}`, 30).padEnd(30), fg: C.value },
            { text: fitDisplay(` source=${lock.source}`, 24).padEnd(24), fg: C.info },
            { text: truncateDisplay(` ${lock.reason}`, Math.max(0, width - 56)), fg: C.dim },
          ], C, { selected: index === this.browseIndex })),
          emptyMessage: ' No managed locks are currently active.',
        };
      case 'failures':
        return {
          title: 'Sync & Managed-Setting Failures',
          rows: snapshot.recentFailures.map((failure, index) => buildPanelListRow(width, [
            { text: ` ${failure.surface}`.padEnd(10), fg: C.bad },
            { text: truncateDisplay(` ${failure.message}`, Math.max(0, width - 12)), fg: C.dim },
          ], C, { selected: index === this.browseIndex })),
          emptyMessage: ' No recent sync or managed-setting failures.',
        };
      case 'conflicts':
        return {
          title: 'Settings Conflicts',
          rows: snapshot.conflicts.map((conflict, index) => buildPanelListRow(width, [
            { text: fitDisplay(` ${conflict.key}`, 30).padEnd(30), fg: C.value },
            { text: fitDisplay(` ${conflict.source}`, 10).padEnd(10), fg: C.warn },
            { text: truncateDisplay(` local=${String(conflict.localValue)}  incoming=${String(conflict.incomingValue)}`, Math.max(0, width - 42)), fg: C.dim },
          ], C, { selected: index === this.browseIndex })),
          emptyMessage: ' No settings conflicts detected. Resolve conflicts from the keys list (Enter on a conflicted entry).',
        };
      case 'rollback':
        return {
          title: 'Managed Rollback History',
          rows: snapshot.rollbackHistory.map((entry, index) => buildPanelListRow(width, [
            { text: fitDisplay(` ${entry.token}`, 18).padEnd(18), fg: C.info },
            { text: fitDisplay(` ${entry.profileName}`, 18).padEnd(18), fg: C.value },
            { text: ` restored=${String(entry.restoredKeys.length).padEnd(4)}`, fg: C.warn },
            { text: truncateDisplay(` ${new Date(entry.appliedAt).toLocaleString()}`, Math.max(0, width - 46)), fg: C.dim },
          ], C, { selected: index === this.browseIndex })),
          emptyMessage: ' No managed rollback records yet.',
        };
      default:
        return { title: '', rows: [], emptyMessage: '' };
    }
  }

  private _renderKeysMode(width: number, height: number, snapshot: SettingsSnapshot): Line[] {
    const headerLines = this._buildPostureHeader(width, snapshot);

    this.clampSelection();
    // Detail must describe the row the (possibly filtered) list highlights —
    // raw resolvedEntries desyncs selectedIndex under an applied '/' filter.
    const selectedEntry = this.getVisibleItems()[this.selectedIndex];
    const detailLines: Line[] = this._resolvePrompt
      ? this._buildResolvePromptLines(width, this._resolvePrompt.key)
      : (selectedEntry
          ? buildDetailBlock(width, 'Selected setting', [
              buildPanelLine(width, [[' key ', C.label], [selectedEntry.key, C.value], ['  category ', C.label], [selectedEntry.category, C.info]]),
              buildPanelLine(width, [[' effective ', C.label], [selectedEntry.effectiveSource, selectedEntry.effectiveSource === 'managed' ? C.warn : selectedEntry.effectiveSource === 'synced' ? C.good : selectedEntry.effectiveSource === 'local' ? C.info : C.dim], ['  locked ', C.label], [selectedEntry.locked ? 'yes' : 'no', selectedEntry.locked ? C.warn : C.dim], ['  conflict ', C.label], [selectedEntry.conflict ? 'yes' : 'no', selectedEntry.conflict ? C.bad : C.good]]),
              buildPanelLine(width, [[' source ', C.label], [truncateDisplay(selectedEntry.sourceLabel ?? 'local/default', Math.max(0, width - 10)), C.dim]]),
              buildPanelLine(width, [[' overrides ', C.label], [truncateDisplay(selectedEntry.overriddenSources.length > 0 ? selectedEntry.overriddenSources.join(', ') : 'none', Math.max(0, width - 13)), C.dim]]),
              buildPanelLine(width, [[' local ', C.label], [truncateDisplay(String(selectedEntry.localValue), Math.max(0, width - 9)), C.dim]]),
              buildPanelLine(width, [[' synced ', C.label], [truncateDisplay(String(selectedEntry.syncedValue ?? '(unset)'), Math.max(0, width - 10)), C.good]]),
              buildPanelLine(width, [[' managed ', C.label], [truncateDisplay(String(selectedEntry.managedValue ?? '(unset)'), Math.max(0, width - 11)), C.warn]]),
            ], C)
          : [buildPanelLine(width, [[' Select a setting above to inspect its effective value, source, and overrides.', C.dim]])]);

    return this.renderList(width, height, {
      title: 'Settings Sync',
      header: headerLines,
      // Keyboard hints are placed BEFORE the detail block (rather than after,
      // which is the usual convention) so that if the fixed-row budget is
      // tight, the tail of the detail block is what gets clipped by the
      // panel-workspace row budget — not the hints row itself.
      footer: [
        buildKeyboardHints(width, [
          { keys: '↑/↓', label: 'browse' },
          { keys: '/', label: 'filter' },
          { keys: 'enter', label: 'resolve conflict' },
          { keys: 'tab', label: 'events/locks/failures/conflicts/rollback' },
          { keys: 'm', label: 'managed review' },
        ], C),
        ...detailLines,
      ],
    });
  }

  private _renderBrowseMode(width: number, height: number, snapshot: SettingsSnapshot): Line[] {
    this.needsRender = false;
    const postureSection: PanelWorkspaceSection = { lines: this._buildPostureHeader(width, snapshot) };
    const content = this._buildBrowseModeContent(width, snapshot);
    const itemCount = content.rows.length;
    this.browseIndex = itemCount > 0 ? Math.min(this.browseIndex, itemCount - 1) : 0;
    const scrollableLines = itemCount > 0 ? content.rows : [buildPanelLine(width, [[content.emptyMessage, C.dim]])];

    const hintsLine = buildKeyboardHints(width, [
      { keys: '↑/↓', label: 'browse' },
      { keys: 'tab', label: 'next mode' },
      { keys: 'm', label: 'managed review' },
    ], C);

    const resolved = resolveScrollablePanelSection(width, height, {
      palette: C,
      beforeSections: [postureSection],
      footerLines: [hintsLine],
      section: {
        title: content.title,
        scrollableLines,
        selectedIndex: itemCount > 0 ? this.browseIndex : undefined,
        scrollOffset: this.browseScrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
    });
    this.browseScrollOffset = resolved.scrollOffset;

    const lines = buildPanelWorkspace(width, height, {
      title: 'Settings Sync',
      sections: [postureSection, resolved.section],
      footerLines: [hintsLine],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }

  public render(width: number, height: number): Line[] {
    const snapshot = getSettingsControlPlaneSnapshot(this.configManager);
    if (this.browseMode !== 'keys') {
      return this._renderBrowseMode(width, height, snapshot);
    }
    return this._renderKeysMode(width, height, snapshot);
  }
}
