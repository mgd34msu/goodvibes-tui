import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';
import { ApprovalBroker, ControlPlaneGateway, SharedSessionBroker } from '../control-plane/index.ts';
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

function connectionColor(state: string): string {
  if (state === 'connected' || state === 'healthy') return C.ok;
  if (state === 'degraded' || state === 'connecting' || state === 'initializing') return C.warn;
  if (state === 'terminal_failure') return C.error;
  return C.dim;
}

export class ControlPlanePanel extends BasePanel {
  private readonly store?: RuntimeStore;
  private readonly unsubStore: (() => void) | null;
  private readonly unsubApprovals: (() => void) | null;
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(store?: RuntimeStore) {
    super('control-plane', 'Control Plane', 'C', 'monitoring');
    this.store = store;
    this.unsubStore = store ? store.subscribe(() => this.markDirty()) : null;
    this.unsubApprovals = ApprovalBroker.getInstance().subscribe(() => this.markDirty());
  }

  public override onDestroy(): void {
    this.unsubStore?.();
    this.unsubApprovals?.();
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
    if (!this.store) return [];
    const domain = this.store.getState().controlPlane;
    return domain.clientIds
      .map((id) => domain.clients.get(id))
      .filter((client): client is NonNullable<typeof client> => client !== undefined)
      .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.id.localeCompare(b.id));
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const intro = 'Shared daemon control plane state, live clients, approval pressure, and recent omnichannel session posture.';

    if (!this.store) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Control Plane',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' Runtime store not wired.',
            'This panel needs the shared runtime store to inspect clients, requests, and approvals.',
            [{ command: '/cockpit', summary: 'use the cockpit while control-plane wiring is unavailable' }],
            C,
          ),
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    const state = this.store.getState();
    const control = state.controlPlane;
    const approvals = ApprovalBroker.getInstance().listApprovals(6);
    const sessions = SharedSessionBroker.getInstance().listSessions(6);
    const recentEvents = ControlPlaneGateway.getActive()?.listRecentEvents(6) ?? [];
    const clients = this.clients();

    const summarySection: PanelWorkspaceSection = {
      title: 'Posture',
      lines: [
        buildKeyValueLine(width, [
          { label: 'state', value: control.connectionState, valueColor: connectionColor(control.connectionState) },
          { label: 'clients', value: String(control.activeClientIds.length), valueColor: control.activeClientIds.length > 0 ? C.ok : C.dim },
          { label: 'requests', value: String(control.requestCount), valueColor: control.requestCount > 0 ? C.info : C.dim },
          { label: 'errors', value: String(control.errorCount), valueColor: control.errorCount > 0 ? C.error : C.dim },
        ], C),
        buildKeyValueLine(width, [
          { label: 'host', value: `${control.host}:${control.port}`, valueColor: C.value },
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
        : [buildPanelLine(width, [['  No approval records.', C.dim]])],
    };

    const sessionsSection: PanelWorkspaceSection = {
      title: 'Sessions',
      lines: sessions.length > 0
        ? sessions.slice(0, 6).map((session) => buildPanelLine(width, [
            [' ', C.label],
            [session.status.padEnd(8), session.status === 'active' ? C.ok : C.warn],
            [` ${truncateDisplay(session.title ?? session.id, 22).padEnd(22)}`, C.value],
            [` routes=${String(session.routeIds.length).padEnd(3)}`, C.info],
            [` msgs=${String(session.messageCount)}`, C.dim],
          ]))
        : [buildPanelLine(width, [['  No shared sessions.', C.dim]])],
    };

    const recentEventsSection: PanelWorkspaceSection = {
      title: 'Recent Events',
      lines: recentEvents.length > 0
        ? recentEvents.slice(0, 6).map((event) => buildPanelLine(width, [
            [' ', C.label],
            [truncateDisplay(event.event, 18).padEnd(18), C.info],
            [` ${truncateDisplay(formatTime(event.createdAt), 20).padEnd(20)}`, C.dim],
            [` ${truncateDisplay(JSON.stringify(event.payload), Math.max(0, width - 41))}`, C.value],
          ]))
        : [buildPanelLine(width, [['  No recent control-plane events.', C.dim]])],
    };

    const resolvedClients = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines: [buildPanelLine(width, [['  Up/Down move through clients', C.dim]])],
      palette: C,
      beforeSections: [summarySection],
      section: {
        title: 'Clients',
        scrollableLines: clients.map((client, absolute) => {
          const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
          return buildPanelLine(width, [
            [' ', C.label, bg],
            [client.kind.padEnd(9), C.info, bg],
            [` ${truncateDisplay(client.label, 20).padEnd(20)}`, C.value, bg],
            [` ${client.transport.padEnd(10)}`, C.dim, bg],
            [` ${truncateDisplay(formatTime(client.lastSeenAt), Math.max(0, width - 43))}`, C.dim, bg],
          ]);
        }),
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        guardRows: 1,
        minRows: 5,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [detailSection, approvalsSection, sessionsSection, recentEventsSection],
    });
    this.scrollOffset = resolvedClients.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      summarySection,
      resolvedClients.section,
      detailSection,
      approvalsSection,
      sessionsSection,
      recentEventsSection,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Control Plane',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [['  Up/Down move through clients', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
