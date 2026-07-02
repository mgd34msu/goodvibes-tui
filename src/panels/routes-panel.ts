import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { PanelIntegrationContext } from './types.ts';
import { SessionBrowserPanel } from './session-browser-panel.ts';
import type { UiReadModel, UiRoutesSnapshot } from '../runtime/ui-read-models.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import {
  buildDetailBlock,
  buildEmptyState,
  buildKeyValueLine,
  buildKeyboardHints,
  buildPanelLine,
  buildPanelWorkspace,
  buildStatusPill,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
} from './polish.ts';

// Base chrome only — title band, state colors, and text tokens all come
// straight from DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

function formatTime(value?: number): string {
  if (!value) return 'n/a';
  return new Date(value).toLocaleString();
}

type RouteBinding = UiRoutesSnapshot['bindings'][number];

// Set by handleInput (enter/c) and consumed on the very next
// handlePanelIntegrationAction dispatch of that same key — handleInput has
// no access to the panelManager.
type PendingRouteAction =
  | { readonly kind: 'open-session'; readonly sessionId: string }
  | { readonly kind: 'open-communication' };

export class RoutesPanel extends ScrollableListPanel<RouteBinding> {
  private readonly readModel?: UiReadModel<UiRoutesSnapshot>;
  private readonly unsub: (() => void) | null;
  private pendingAction: PendingRouteAction | null = null;

  public constructor(readModel?: UiReadModel<UiRoutesSnapshot>) {
    super('routes', 'Routes', 'R', 'runtime-ops');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter routes';
    this.readModel = readModel;
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  public override handleInput(key: string): boolean {
    if (!this.filterActive) {
      // Enter jumps to the session browser focused on this binding's session
      // — a direct panel jump instead of a printed slash-command signpost.
      if (key === 'enter' || key === 'return') {
        const bindings = this.getVisibleItems();
        const selected = bindings[this.selectedIndex];
        if (selected?.sessionId) {
          this.pendingAction = { kind: 'open-session', sessionId: selected.sessionId };
          return true;
        }
        return false;
      }
      // c opens the communication panel to inspect routed message flow.
      if (key === 'c') {
        this.pendingAction = { kind: 'open-communication' };
        return true;
      }
    }
    return super.handleInput(key);
  }

  public handlePanelIntegrationAction(_key: string, ctx: PanelIntegrationContext): boolean {
    if (!this.pendingAction) return false;
    const action = this.pendingAction;
    this.pendingAction = null;
    if (action.kind === 'open-communication') {
      ctx.panelManager.open('communication');
      return true;
    }
    const panel = ctx.panelManager.open('sessions');
    if (panel instanceof SessionBrowserPanel) {
      panel.focusSession(action.sessionId);
    }
    return true;
  }

  protected override filterMatches(binding: RouteBinding, q: string): boolean {
    return binding.surfaceKind.toLowerCase().includes(q)
      || (binding.title ?? '').toLowerCase().includes(q)
      || binding.externalId.toLowerCase().includes(q)
      || (binding.sessionId ?? '').toLowerCase().includes(q)
      || (binding.runId ?? '').toLowerCase().includes(q);
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  protected getItems(): readonly RouteBinding[] {
    if (!this.readModel) return [];
    return this.readModel.getSnapshot().bindings;
  }

  protected renderItem(binding: RouteBinding, _index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [binding.surfaceKind.padEnd(9), C.info, bg],
      [` ${truncateDisplay(binding.title ?? binding.externalId, 22).padEnd(22)}`, C.value, bg],
      ...buildStatusPill(binding.sessionId ? 'good' : 'warn', ` ${truncateDisplay(binding.sessionId ?? binding.runId ?? 'unbound', 18).padEnd(18)}`, { bg }),
      [` ${truncateDisplay(formatTime(binding.lastSeenAt), Math.max(0, width - 54))}`, C.dim, bg],
    ]);
  }

  protected override getEmptyStateMessage(): string {
    return ' No route bindings recorded.';
  }

  protected override getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [
      { command: '/schedule list', summary: 'run jobs and triggers that create route bindings' },
      { command: '/communication', summary: 'inspect routed communication once a surface is active' },
    ];
  }

  public render(width: number, height: number): Line[] {
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
    const bindings = this.getItems();
    const surfaceEntries = Object.entries(snapshot.bindingIdsBySurface)
      .filter(([, ids]) => ids.length > 0)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

    const headerLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'bindings', value: String(snapshot.totalBindings), valueColor: snapshot.totalBindings > 0 ? C.info : C.dim },
        { label: 'active', value: String(snapshot.activeBindingIds.length), valueColor: snapshot.activeBindingIds.length > 0 ? C.good : C.dim },
        { label: 'resolved', value: String(snapshot.totalResolved), valueColor: snapshot.totalResolved > 0 ? C.good : C.dim },
        { label: 'failures', value: String(snapshot.totalFailures), valueColor: snapshot.totalFailures > 0 ? C.bad : C.dim },
      ], C),
    ];

    if (bindings.length === 0) {
      return this.renderList(width, height, {
        title: 'Route Bindings',
        header: headerLines,
        emptyMessage: ' No route bindings recorded.',
      });
    }

    this.clampSelection();
    // Detail must describe the row the (possibly filtered) list highlights —
    // getItems() would desync under an applied filter, and a filter that
    // matches nothing leaves no selection at all.
    const selected = this.getVisibleItems()[this.selectedIndex];

    const detailRows: Line[] = selected ? [
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
    ] : [];

    if (selected && surfaceEntries.length > 0) {
      detailRows.push(
        ...surfaceEntries.slice(0, 4).map(([surface, ids]) => buildPanelLine(width, [
          [' ', C.label],
          [surface.padEnd(10), C.info],
          [` ${String(ids.length)} binding(s)`, C.value],
        ])),
      );
    }

    const hints = this.filterActive
      ? [{ keys: 'type', label: 'filter' }, { keys: 'Enter', label: 'apply' }, { keys: 'Esc', label: 'clear' }]
      : [
          { keys: 'Up/Down', label: 'move' },
          ...(selected?.sessionId ? [{ keys: 'Enter', label: 'open session' }] : []),
          { keys: 'c', label: 'communication' },
          { keys: '/', label: 'filter' },
        ];

    return this.renderList(width, height, {
      title: 'Route Bindings',
      header: headerLines,
      footer: [
        ...(selected ? buildDetailBlock(width, `Binding · ${selected.surfaceKind}`, detailRows, C) : []),
        buildKeyboardHints(width, hints, C),
      ],
    });
  }
}
