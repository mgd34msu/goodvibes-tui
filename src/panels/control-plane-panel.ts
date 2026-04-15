import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import { createEmptyLine } from '@pellux/goodvibes-sdk/platform/types/grid';
import { BasePanel } from './base-panel.ts';
import type { UiControlPlaneSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import { truncateDisplay } from '@pellux/goodvibes-sdk/platform/utils/terminal-width';
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

function connectionColor(state: string): string {
  if (state === 'connected' || state === 'healthy') return C.ok;
  if (state === 'degraded' || state === 'connecting' || state === 'initializing') return C.warn;
  if (state === 'terminal_failure') return C.error;
  return C.dim;
}

export class ControlPlanePanel extends BasePanel {
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(private readonly readModel?: UiReadModel<UiControlPlaneSnapshot>) {
    super('control-plane', 'Control Plane', 'C', 'monitoring');
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    const clients = this.clients();
    if (clients.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(clients.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  private clients() {
    if (!this.readModel) return [];
    return [...this.readModel.getSnapshot().clients];
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
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
    const clients = this.clients();

    const summarySection: PanelWorkspaceSection = {
      title: 'Posture',
      lines: [
        buildKeyValueLine(width, [
          { label: 'state', value: snapshot.connectionState, valueColor: connectionColor(snapshot.connectionState) },
          { label: 'clients', value: String(snapshot.activeClientIds.length), valueColor: snapshot.activeClientIds.length > 0 ? C.ok : C.dim },
          { label: 'requests', value: String(snapshot.requestCount), valueColor: snapshot.requestCount > 0 ? C.info : C.dim },
          { label: 'errors', value: String(snapshot.errorCount), valueColor: snapshot.errorCount > 0 ? C.error : C.dim },
        ], C),
        buildKeyValueLine(width, [
          { label: 'host', value: `${snapshot.host}:${snapshot.port}`, valueColor: C.value },
          { label: 'approvals', value: String(approvals.filter((entry) => entry.status === 'pending').length), valueColor: approvals.some((entry) => entry.status === 'pending') ? C.warn : C.dim },
          { label: 'sessions', value: String(sessions.length), valueColor: sessions.length > 0 ? C.info : C.dim },
          { label: 'events', value: String(recentEvents.length), valueColor: recentEvents.length > 0 ? C.info : C.dim },
        ], C),
        buildGuidanceLine(width, '/cockpit', 'use the web operator surface or daemon APIs for direct interventions while this panel tracks overall posture', C),
      ],
    };

    if (clients.length === 0 && approvals.length === 0 && sessions.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Control Plane',
        intro,
        sections: [
          summarySection,
          {
            lines: buildEmptyState(
              width,
              ' No control-plane activity recorded.',
              'Start the daemon, connect a surface, or trigger an approval to populate this operator panel.',
              [
                { command: '/cockpit', summary: 'watch operator posture from the terminal' },
                { command: '/schedule list', summary: 'run automation that creates surface and daemon traffic' },
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

    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, clients.length - 1));
    const selected = clients[this.selectedIndex];

    const detailSection: PanelWorkspaceSection = selected
      ? {
          title: 'Selected Client',
          lines: [
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
              [selected.connected ? 'yes' : 'no', selected.connected ? C.ok : C.warn],
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
          ],
        }
      : {
          title: 'Selected Client',
          lines: [buildPanelLine(width, [['  No connected client selected.', C.dim]])],
        };

    const approvalsSection: PanelWorkspaceSection = {
      title: 'Approvals',
      lines: approvals.length > 0
        ? approvals.slice(0, 6).map((approval) => buildPanelLine(width, [
            [' ', C.label],
            [approval.status.padEnd(10), approval.status === 'pending' ? C.warn : approval.status === 'approved' ? C.ok : approval.status === 'denied' ? C.error : C.dim],
            [` ${truncateDisplay(approval.request.tool, 16).padEnd(16)}`, C.value],
            [` ${truncateDisplay(approval.sessionId ?? approval.id, Math.max(0, width - 30))}`, C.dim],
          ]))
        : [buildPanelLine(width, [['  No recent approvals.', C.dim]])],
    };

    const sessionsSection: PanelWorkspaceSection = {
      title: 'Sessions',
      lines: sessions.length > 0
        ? sessions.slice(0, 6).map((session) => buildPanelLine(width, [
            [' ', C.label],
            [session.status.padEnd(10), session.status === 'active' ? C.ok : C.dim],
            [` ${truncateDisplay(session.title, 20).padEnd(20)}`, C.value],
            [` ${truncateDisplay(session.activeAgentId ?? session.id, Math.max(0, width - 34))}`, C.dim],
          ]))
        : [buildPanelLine(width, [['  No shared sessions recorded.', C.dim]])],
    };

    const eventsSection: PanelWorkspaceSection = {
      title: 'Recent Events',
      lines: recentEvents.length > 0
        ? recentEvents.slice(0, 6).map((event) => buildPanelLine(width, [
            [' ', C.label],
            [truncateDisplay(event.event, 16).padEnd(16), C.info],
            [` ${truncateDisplay(typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload) ?? '', Math.max(0, width - 19))}`, C.dim],
          ]))
        : [buildPanelLine(width, [['  No recent control-plane events.', C.dim]])],
    };

    const resolvedClients = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines: [buildPanelLine(width, [['  Up/Down move through connected clients', C.dim]])],
      palette: C,
      beforeSections: [summarySection],
      section: {
        title: 'Clients',
        scrollableLines: clients.map((client, absolute) => {
          const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
          return buildPanelLine(width, [
            [' ', C.label, bg],
            [client.kind.padEnd(10), C.info, bg],
            [` ${truncateDisplay(client.label, 20).padEnd(20)}`, C.value, bg],
            [` ${client.transport.padEnd(12)}`, C.dim, bg],
            [` ${truncateDisplay(formatTime(client.lastSeenAt), Math.max(0, width - 46))}`, C.dim, bg],
          ]);
        }),
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [detailSection, approvalsSection, sessionsSection, eventsSection],
    });
    this.scrollOffset = resolvedClients.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      summarySection,
      resolvedClients.section,
      detailSection,
      approvalsSection,
      sessionsSection,
      eventsSection,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Control Plane',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [['  Up/Down move through connected clients', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
