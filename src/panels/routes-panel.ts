import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { UiReadModel, UiRoutesSnapshot } from '../runtime/ui-read-models.ts';
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

function formatTime(value?: number): string {
  if (!value) return 'n/a';
  return new Date(value).toLocaleString();
}

export class RoutesPanel extends BasePanel {
  private readonly readModel?: UiReadModel<UiRoutesSnapshot>;
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(readModel?: UiReadModel<UiRoutesSnapshot>) {
    super('routes', 'Routes', 'R', 'monitoring');
    this.readModel = readModel;
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    const bindings = this.bindings();
    if (bindings.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(bindings.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  private bindings() {
    if (!this.readModel) return [];
    return [...this.readModel.getSnapshot().bindings];
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const intro = 'External route bindings that preserve thread, session, and reply context across Slack, Discord, ntfy, webhook, web, and TUI surfaces.';

    if (!this.readModel) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Route Bindings',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' Runtime store not wired.',
            'This panel needs the shared runtime store to inspect omnichannel route bindings.',
            [{ command: '/communication', summary: 'review communication posture while route state is unavailable' }],
            C,
          ),
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    const snapshot = this.readModel.getSnapshot();
    const bindings = this.bindings();
    const surfaceEntries = Object.entries(snapshot.bindingIdsBySurface)
      .filter(([, ids]) => ids.length > 0)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

    const summarySection: PanelWorkspaceSection = {
      title: 'Posture',
      lines: [
        buildKeyValueLine(width, [
          { label: 'bindings', value: String(snapshot.totalBindings), valueColor: snapshot.totalBindings > 0 ? C.info : C.dim },
          { label: 'active', value: String(snapshot.activeBindingIds.length), valueColor: snapshot.activeBindingIds.length > 0 ? C.ok : C.dim },
          { label: 'resolved', value: String(snapshot.totalResolved), valueColor: snapshot.totalResolved > 0 ? C.ok : C.dim },
          { label: 'failures', value: String(snapshot.totalFailures), valueColor: snapshot.totalFailures > 0 ? C.error : C.dim },
        ], C),
        buildGuidanceLine(width, '/communication', 'inspect routed message flow and delivery behavior across bound surfaces', C),
      ],
    };

    if (bindings.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Route Bindings',
        intro,
        sections: [
          summarySection,
          {
            lines: buildEmptyState(
              width,
              ' No route bindings recorded.',
              'Bindings appear when the daemon links an external surface, thread, or remote client to a shared session or automation run.',
              [
                { command: '/schedule list', summary: 'run jobs and triggers that create route bindings' },
                { command: '/communication', summary: 'inspect routed communication once a surface is active' },
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

    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, bindings.length - 1));
    const selected = bindings[this.selectedIndex]!;

    const surfaceSection: PanelWorkspaceSection = {
      title: 'Surfaces',
      lines: surfaceEntries.length > 0
        ? surfaceEntries.slice(0, 6).map(([surface, ids]) => buildPanelLine(width, [
            [' ', C.label],
            [surface.padEnd(10), C.info],
            [` ${String(ids.length)} binding(s)`, C.value],
          ]))
        : [buildPanelLine(width, [['  No surface counts recorded.', C.dim]])],
    };

    const detailSection: PanelWorkspaceSection = {
      title: 'Selected Binding',
      lines: [
        buildPanelLine(width, [
          ['  Binding: ', C.label],
          [selected.id, C.value],
          ['  Surface: ', C.label],
          [selected.surfaceKind, C.info],
        ]),
        buildPanelLine(width, [
          ['  External: ', C.label],
          [truncateDisplay(selected.externalId, 28), C.value],
          ['  Kind: ', C.label],
          [selected.kind, C.dim],
        ]),
        buildPanelLine(width, [
          ['  Session: ', C.label],
          [selected.sessionId ?? 'n/a', C.value],
          ['  Run: ', C.label],
          [selected.runId ?? 'n/a', C.dim],
        ]),
        buildPanelLine(width, [
          ['  Channel: ', C.label],
          [selected.channelId ?? 'n/a', C.dim],
          ['  Thread: ', C.label],
          [selected.threadId ?? 'n/a', C.dim],
        ]),
        buildPanelLine(width, [
          ['  Last seen: ', C.label],
          [formatTime(selected.lastSeenAt), C.dim],
        ]),
      ],
    };

    const resolvedBindings = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines: [buildPanelLine(width, [['  Up/Down move through route bindings', C.dim]])],
      palette: C,
      beforeSections: [summarySection],
      section: {
        title: 'Bindings',
        scrollableLines: bindings.map((binding, absolute) => {
          const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
          return buildPanelLine(width, [
            [' ', C.label, bg],
            [binding.surfaceKind.padEnd(9), C.info, bg],
            [` ${truncateDisplay(binding.title ?? binding.externalId, 22).padEnd(22)}`, C.value, bg],
            [` ${truncateDisplay(binding.sessionId ?? binding.runId ?? 'unbound', 18).padEnd(18)}`, binding.sessionId ? C.ok : C.warn, bg],
            [` ${truncateDisplay(formatTime(binding.lastSeenAt), Math.max(0, width - 54))}`, C.dim, bg],
          ]);
        }),
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        guardRows: 1,
        minRows: 5,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [detailSection, surfaceSection],
    });
    this.scrollOffset = resolvedBindings.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      summarySection,
      resolvedBindings.section,
      detailSection,
      surfaceSection,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Route Bindings',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [['  Up/Down move through route bindings', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
