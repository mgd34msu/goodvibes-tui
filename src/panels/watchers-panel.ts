import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { UiReadModel, UiWatchersSnapshot } from '../runtime/ui-read-models.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  resolvePrimaryScrollableSection,
  type PanelWorkspaceSection,
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

export class WatchersPanel extends BasePanel {
  private readonly readModel?: UiReadModel<UiWatchersSnapshot>;
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(readModel?: UiReadModel<UiWatchersSnapshot>) {
    super('watchers', 'Watchers', 'W', 'monitoring');
    this.readModel = readModel;
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    const watchers = this.watchers();
    if (watchers.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(watchers.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  private watchers() {
    if (!this.readModel) return [];
    return [...this.readModel.getSnapshot().watchers];
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
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
    const watchers = this.watchers();
    const summarySection: PanelWorkspaceSection = {
      title: 'Posture',
      lines: [
        buildKeyValueLine(width, [
          { label: 'watchers', value: String(snapshot.totalWatchers), valueColor: snapshot.totalWatchers > 0 ? C.info : C.dim },
          { label: 'active', value: String(snapshot.activeWatcherIds.length), valueColor: snapshot.activeWatcherIds.length > 0 ? C.ok : C.dim },
          { label: 'degraded', value: String(snapshot.totalDegraded), valueColor: snapshot.totalDegraded > 0 ? C.warn : C.dim },
          { label: 'lagged', value: String(snapshot.totalLagged), valueColor: snapshot.totalLagged > 0 ? C.warn : C.dim },
        ], C),
        buildGuidanceLine(width, '/schedule list', 'verify jobs consuming these sources and use daemon APIs for watcher lifecycle control', C),
      ],
    };

    if (watchers.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Watchers',
        intro,
        sections: [
          summarySection,
          {
            lines: buildEmptyState(
              width,
              ' No watchers registered.',
              'Register daemon watchers or enable polling/integration sources to populate this control room.',
              [
                { command: '/schedule list', summary: 'review automation that will consume watcher events' },
                { command: '/services auth-review', summary: 'validate integration credentials before enabling remote watchers' },
              ],
              C,
            ),
          },
        ],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, watchers.length - 1));
    const selected = watchers[this.selectedIndex]!;

    const detailSection: PanelWorkspaceSection = {
      title: 'Selected Watcher',
      lines: [
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
        ...(selected.degradedReason ? [
          buildPanelLine(width, [
            ['  Reason: ', C.label],
            [truncateDisplay(selected.degradedReason, Math.max(0, width - 11)), C.warn],
          ]),
        ] : []),
        ...(selected.lastError ? [
          buildPanelLine(width, [
            ['  Error: ', C.label],
            [truncateDisplay(selected.lastError, Math.max(0, width - 10)), C.error],
          ]),
        ] : []),
      ],
    };

    const resolvedWatchers = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines: [buildPanelLine(width, [['  Up/Down move through watchers', C.dim]])],
      palette: C,
      beforeSections: [summarySection],
      section: {
        title: 'Watchers',
        scrollableLines: watchers.map((watcher, absolute) => {
          const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
          return buildPanelLine(width, [
            [' ', C.label, bg],
            [watcher.state.padEnd(10), stateColor(watcher.state), bg],
            [` ${truncateDisplay(watcher.label, 18).padEnd(18)}`, C.value, bg],
            [` ${String(watcher.sourceStatus ?? 'unknown').padEnd(10)}`, sourceStatusColor(watcher.sourceStatus), bg],
            [` ${truncateDisplay(formatLag(watcher.sourceLagMs), Math.max(0, width - 43))}`, C.dim, bg],
          ]);
        }),
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        guardRows: 1,
        minRows: 5,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [detailSection],
    });
    this.scrollOffset = resolvedWatchers.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      summarySection,
      resolvedWatchers.section,
      detailSection,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Watchers',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [['  Up/Down move through watchers', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
