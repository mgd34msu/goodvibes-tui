import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { UiReadModel, UiWatchersSnapshot } from '../runtime/ui-read-models.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
} from './polish.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#94a3b8',
  headerBg: '#1e293b',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
  info: '#38bdf8',
  selectBg: '#0f172a',
} as const;

function stateColor(state: string): string {
  if (state === 'running') return C.ok;
  if (state === 'degraded') return C.warn;
  if (state === 'failed') return C.error;
  return C.dim;
}

function sourceStatusColor(state?: string): string {
  if (state === 'healthy') return C.ok;
  if (state === 'lagging' || state === 'stale' || state === 'degraded') return C.warn;
  if (state === 'failed') return C.error;
  return C.dim;
}

function formatLag(value?: number): string {
  if (!value || value <= 0) return 'n/a';
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  return `${Math.round(value / 60_000)}m`;
}

function formatTime(value?: number): string {
  if (!value) return 'n/a';
  return new Date(value).toLocaleString();
}

type WatcherEntry = UiWatchersSnapshot['watchers'][number];

export class WatchersPanel extends ScrollableListPanel<WatcherEntry> {
  private readonly readModel?: UiReadModel<UiWatchersSnapshot>;
  private readonly unsub: (() => void) | null;

  public constructor(readModel?: UiReadModel<UiWatchersSnapshot>) {
    super('watchers', 'Watchers', 'W', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter watchers';
    this.readModel = readModel;
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  protected override filterMatches(watcher: WatcherEntry, q: string): boolean {
    return watcher.label.toLowerCase().includes(q)
      || watcher.state.toLowerCase().includes(q)
      || String(watcher.sourceStatus ?? '').toLowerCase().includes(q);
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  protected getItems(): readonly WatcherEntry[] {
    if (!this.readModel) return [];
    return this.readModel.getSnapshot().watchers;
  }

  protected renderItem(watcher: WatcherEntry, _index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [watcher.state.padEnd(10), stateColor(watcher.state), bg],
      [` ${truncateDisplay(watcher.label, 18).padEnd(18)}`, C.value, bg],
      [` ${String(watcher.sourceStatus ?? 'unknown').padEnd(10)}`, sourceStatusColor(watcher.sourceStatus), bg],
      [` ${truncateDisplay(formatLag(watcher.sourceLagMs), Math.max(0, width - 43))}`, C.dim, bg],
    ]);
  }

  protected override getEmptyStateMessage(): string {
    return ' No watchers registered.';
  }

  protected override getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [
      { command: '/schedule list', summary: 'review automation that will consume watcher events' },
      { command: '/services auth-review', summary: 'validate integration credentials before enabling remote watchers' },
    ];
  }

  public render(width: number, height: number): Line[] {
    const intro = 'Managed watchers and source health used to trigger automation, refresh routes, and surface degraded upstream conditions.';

    if (!this.readModel) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Watchers',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' Runtime store not wired.',
            'This panel needs the shared runtime store to inspect watcher health and source lag.',
            [{ command: '/services auth-review', summary: 'inspect supporting services until watcher wiring is available' }],
            C,
          ),
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    const snapshot = this.readModel.getSnapshot();
    const watchers = this.getItems();

    const headerLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'watchers', value: String(snapshot.totalWatchers), valueColor: snapshot.totalWatchers > 0 ? C.info : C.dim },
        { label: 'active', value: String(snapshot.activeWatcherIds.length), valueColor: snapshot.activeWatcherIds.length > 0 ? C.ok : C.dim },
        { label: 'degraded', value: String(snapshot.totalDegraded), valueColor: snapshot.totalDegraded > 0 ? C.warn : C.dim },
        { label: 'lagged', value: String(snapshot.totalLagged), valueColor: snapshot.totalLagged > 0 ? C.warn : C.dim },
      ], C),
      buildGuidanceLine(width, '/schedule list', 'verify jobs consuming these sources and use daemon APIs for watcher lifecycle control', C),
    ];

    if (watchers.length === 0) {
      return this.renderList(width, height, {
        title: 'Watchers',
        header: headerLines,
        emptyMessage: ' No watchers registered.',
      });
    }

    this.clampSelection();
    const selected = watchers[this.selectedIndex]!;

    const footerLines: Line[] = [
      buildPanelLine(width, [
        ['  Watcher: ', C.label],
        [selected.label, C.value],
        ['  Kind: ', C.label],
        [selected.kind, C.info],
      ]),
      buildPanelLine(width, [
        ['  State: ', C.label],
        [selected.state, stateColor(selected.state)],
        ['  Source: ', C.label],
        [selected.source.kind, C.value],
      ]),
      buildPanelLine(width, [
        ['  Source status: ', C.label],
        [selected.sourceStatus ?? 'unknown', sourceStatusColor(selected.sourceStatus)],
        ['  Lag: ', C.label],
        [formatLag(selected.sourceLagMs), selected.sourceLagMs ? C.warn : C.dim],
      ]),
      buildPanelLine(width, [
        ['  Heartbeat: ', C.label],
        [formatTime(selected.lastHeartbeatAt), C.dim],
        ['  Checkpoint: ', C.label],
        [truncateDisplay(selected.lastCheckpoint ?? 'n/a', Math.max(0, width - 38)), C.dim],
      ]),
    ];
    if (selected.degradedReason) {
      footerLines.push(buildPanelLine(width, [
        ['  Reason: ', C.label],
        [truncateDisplay(selected.degradedReason, Math.max(0, width - 11)), C.warn],
      ]));
    }
    if (selected.lastError) {
      footerLines.push(buildPanelLine(width, [
        ['  Error: ', C.label],
        [truncateDisplay(selected.lastError, Math.max(0, width - 10)), C.error],
      ]));
    }
    footerLines.push(buildPanelLine(width, [['  Up/Down move through watchers', C.dim]]));

    return this.renderList(width, height, {
      title: 'Watchers',
      header: headerLines,
      footer: footerLines,
    });
  }
}
