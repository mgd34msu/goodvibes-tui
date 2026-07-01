import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { UiControlPlaneSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildKeyboardHints,
  buildPanelLine,
  buildPanelWorkspace,
  buildSectionHeader,
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

function connectionColor(state: string): string {
  if (state === 'connected' || state === 'healthy') return C.good;
  if (state === 'degraded' || state === 'connecting' || state === 'initializing') return C.warn;
  if (state === 'terminal_failure') return C.bad;
  return C.dim;
}

type ControlPlaneClient = UiControlPlaneSnapshot['clients'][number];

export class ControlPlanePanel extends ScrollableListPanel<ControlPlaneClient> {
  private readonly unsub: (() => void) | null;

  public constructor(private readonly readModel?: UiReadModel<UiControlPlaneSnapshot>) {
    super('control-plane', 'Control Plane', 'C', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter clients';
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  protected override filterMatches(client: ControlPlaneClient, q: string): boolean {
    return client.kind.toLowerCase().includes(q)
      || client.label.toLowerCase().includes(q)
      || client.transport.toLowerCase().includes(q);
  }

  protected getItems(): readonly ControlPlaneClient[] {
    if (!this.readModel) return [];
    return this.readModel.getSnapshot().clients;
  }

  protected renderItem(client: ControlPlaneClient, _index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [client.kind.padEnd(10), C.info, bg],
      [` ${truncateDisplay(client.label, 20).padEnd(20)}`, C.value, bg],
      [` ${client.transport.padEnd(12)}`, C.dim, bg],
      [` ${truncateDisplay(formatTime(client.lastSeenAt), Math.max(0, width - 46))}`, C.dim, bg],
    ]);
  }

  protected override getEmptyStateMessage(): string {
    return ' No control-plane activity recorded.';
  }

  protected override getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [
      { command: '/cockpit', summary: 'watch operator posture from the terminal' },
      { command: '/schedule list', summary: 'run automation that creates surface and daemon traffic' },
    ];
  }

  public render(width: number, height: number): Line[] {
    const intro = 'Shared daemon control plane state, live clients, approval pressure, and recent omnichannel session posture.';

    if (!this.readModel) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Control Plane',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' Runtime read model not wired.',
            'This panel needs the shared control-plane read model to inspect clients, requests, and approvals.',
            [{ command: '/cockpit', summary: 'use the cockpit while control-plane wiring is unavailable' }],
            C,
          ),
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    const snapshot = this.readModel.getSnapshot();
    const approvals = snapshot.approvals;
    const sessions = snapshot.sessions;
    const recentEvents = snapshot.recentEvents;
    const clients = this.getItems();

    const headerLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'state', value: snapshot.connectionState, valueColor: connectionColor(snapshot.connectionState) },
        { label: 'clients', value: String(snapshot.activeClientIds.length), valueColor: snapshot.activeClientIds.length > 0 ? C.good : C.dim },
        { label: 'requests', value: String(snapshot.requestCount), valueColor: snapshot.requestCount > 0 ? C.info : C.dim },
        { label: 'errors', value: String(snapshot.errorCount), valueColor: snapshot.errorCount > 0 ? C.bad : C.dim },
      ], C),
      buildKeyValueLine(width, [
        { label: 'host', value: `${snapshot.host}:${snapshot.port}`, valueColor: C.value },
        { label: 'approvals', value: String(approvals.filter((entry) => entry.status === 'pending').length), valueColor: approvals.some((entry) => entry.status === 'pending') ? C.warn : C.dim },
        { label: 'sessions', value: String(sessions.length), valueColor: sessions.length > 0 ? C.info : C.dim },
        { label: 'events', value: String(recentEvents.length), valueColor: recentEvents.length > 0 ? C.info : C.dim },
      ], C),
      buildGuidanceLine(width, '/cockpit', 'use the web operator surface or daemon APIs for direct interventions while this panel tracks overall posture', C),
    ];

    if (clients.length === 0 && approvals.length === 0 && sessions.length === 0) {
      return this.renderList(width, height, {
        title: 'Control Plane',
        header: headerLines,
        emptyMessage: ' No control-plane activity recorded.',
      });
    }

    this.clampSelection();
    const selected = clients[this.selectedIndex];

    const footerLines: Line[] = [];
    if (selected) {
      footerLines.push(
        buildPanelLine(width, [
          ['  Client: ', C.label],
          [selected.label, C.value],
          ['  Kind: ', C.label],
          [selected.kind, C.info],
        ]),
        buildPanelLine(width, [
          ['  Transport: ', C.label],
          [selected.transport, C.value],
          ['  Connected: ', C.label],
          [selected.connected ? 'yes' : 'no', selected.connected ? C.good : C.warn],
        ]),
        buildPanelLine(width, [
          ['  Route: ', C.label],
          [selected.routeId ?? 'n/a', C.dim],
          ['  Session: ', C.label],
          [selected.sessionId ?? 'n/a', C.dim],
        ]),
        buildPanelLine(width, [
          ['  Last seen: ', C.label],
          [formatTime(selected.lastSeenAt), C.dim],
          ['  Remote: ', C.label],
          [truncateDisplay(selected.remoteAddress ?? 'n/a', Math.max(0, width - 36)), C.dim],
        ]),
      );
    } else {
      footerLines.push(buildPanelLine(width, [['  No connected client selected.', C.dim]]));
    }

    if (approvals.length > 0) {
      const pending = approvals.filter((entry) => entry.status === 'pending').length;
      footerLines.push(buildSectionHeader(width, `Approvals (${pending} pending / ${approvals.length})`, C));
      footerLines.push(
        ...approvals.slice(0, 6).map((approval) => buildPanelLine(width, [
          [' ', C.label],
          [approval.status.padEnd(10), approval.status === 'pending' ? C.warn : approval.status === 'approved' ? C.good : approval.status === 'denied' ? C.bad : C.dim],
          [` ${truncateDisplay(approval.request.tool, 16).padEnd(16)}`, C.value],
          [` ${truncateDisplay(approval.sessionId ?? approval.id, Math.max(0, width - 30))}`, C.dim],
        ])),
      );
    }

    if (sessions.length > 0) {
      const activeSessions = sessions.filter((session) => session.status === 'active').length;
      footerLines.push(buildSectionHeader(width, `Sessions (${activeSessions} active / ${sessions.length})`, C));
      footerLines.push(
        ...sessions.slice(0, 6).map((session) => buildPanelLine(width, [
          [' ', C.label],
          [session.status.padEnd(10), session.status === 'active' ? C.good : C.dim],
          [` ${truncateDisplay(session.title, 20).padEnd(20)}`, C.value],
          [` ${truncateDisplay(session.activeAgentId ?? session.id, Math.max(0, width - 34))}`, C.dim],
        ])),
      );
    }

    if (recentEvents.length > 0) {
      footerLines.push(buildSectionHeader(width, `Recent Events (${recentEvents.length})`, C));
      footerLines.push(
        ...recentEvents.slice(0, 6).map((event) => buildPanelLine(width, [
          [' ', C.label],
          [truncateDisplay(event.event, 16).padEnd(16), C.info],
          [` ${truncateDisplay(typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload) ?? '', Math.max(0, width - 19))}`, C.dim],
        ])),
      );
    }
    footerLines.push(
      this.filterActive
        ? buildKeyboardHints(width, [
            { keys: 'type', label: 'filter clients' },
            { keys: 'Enter', label: 'apply' },
            { keys: 'Esc', label: 'clear' },
          ], C)
        : buildKeyboardHints(width, [
            { keys: 'Up/Down', label: 'select client' },
            { keys: '/', label: 'filter' },
          ], C),
    );

    return this.renderList(width, height, {
      title: 'Control Plane',
      header: headerLines,
      footer: footerLines,
    });
  }
}
