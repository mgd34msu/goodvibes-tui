import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { UiControlPlaneSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import type { ApprovalBroker, ControlPlaneRecentEvent, SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import {
  type ConfirmState,
  handleConfirmInput,
  renderConfirmLines,
} from './confirm-state.ts';
import {
  buildDetailBlock,
  buildEmptyState,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
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

function approvalStatusColor(status: string): string {
  if (status === 'pending' || status === 'claimed') return C.warn;
  if (status === 'approved') return C.good;
  if (status === 'denied' || status === 'expired') return C.bad;
  return C.dim;
}

type ControlPlaneClient = UiControlPlaneSnapshot['clients'][number];
type ControlPlaneApproval = UiControlPlaneSnapshot['approvals'][number];
type ControlPlaneSession = UiControlPlaneSnapshot['sessions'][number];
type ControlPlaneEvent = UiControlPlaneSnapshot['recentEvents'][number];

type FocusSection = 'approvals' | 'clients' | 'sessions' | 'events';

const FOCUS_SECTIONS: readonly FocusSection[] = ['approvals', 'clients', 'sessions', 'events'];

type ControlPlaneItem =
  | { readonly kind: 'client'; readonly client: ControlPlaneClient }
  | { readonly kind: 'approval'; readonly approval: ControlPlaneApproval }
  | { readonly kind: 'session'; readonly session: ControlPlaneSession }
  | { readonly kind: 'event'; readonly event: ControlPlaneEvent };

type ApprovalConfirmSubject = { readonly approvalId: string; readonly approved: boolean };

/** Deps needed to drive real approve/deny and live session/event lookups (WO-121). */
export interface ControlPlanePanelDeps {
  readonly approvalBroker?: ApprovalBroker;
  readonly sessionBroker?: SharedSessionBroker;
  readonly getControlPlaneRecentEvents?: (limit: number) => readonly ControlPlaneRecentEvent[];
}

/**
 * ControlPlanePanel — daemon control-plane console (WO-121).
 *
 * Tab cycles focus across four selectable sections (approvals, clients,
 * sessions, events); approvals is the primary/default section and supports
 * a=approve / d=deny via ApprovalBroker.resolveApproval behind ConfirmState.
 * Sessions and events pull from the live brokers when wired, falling back to
 * the read-model snapshot when they are not.
 */
export class ControlPlanePanel extends ScrollableListPanel<ControlPlaneItem> {
  private readonly readModel?: UiReadModel<UiControlPlaneSnapshot>;
  private readonly approvalBroker?: ApprovalBroker;
  private readonly sessionBroker?: SharedSessionBroker;
  private readonly getControlPlaneRecentEvents?: (limit: number) => readonly ControlPlaneRecentEvent[];
  private readonly unsub: (() => void) | null;
  private focusSection: FocusSection = 'approvals';
  private confirmAction: ConfirmState<ApprovalConfirmSubject> | null = null;

  public constructor(
    readModel?: UiReadModel<UiControlPlaneSnapshot>,
    deps: ControlPlanePanelDeps = {},
  ) {
    super('control-plane', 'Control Plane', 'C', 'runtime-ops');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter approvals';
    this.readModel = readModel;
    this.approvalBroker = deps.approvalBroker;
    this.sessionBroker = deps.sessionBroker;
    this.getControlPlaneRecentEvents = deps.getControlPlaneRecentEvents;
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  /**
   * The read model's snapshot.approvals is capped upstream (SDK read model
   * calls approvalBroker.listApprovals(6)). Sourcing directly from the
   * broker when it's wired removes that cap so the panel can show and act
   * on the full pending set, not just the first six.
   */
  private _approvals(snapshot: UiControlPlaneSnapshot): readonly ControlPlaneApproval[] {
    const approvals = this.approvalBroker ? this.approvalBroker.listApprovals(50) : snapshot.approvals;
    const pending: ControlPlaneApproval[] = [];
    const rest: ControlPlaneApproval[] = [];
    for (const approval of approvals) {
      (approval.status === 'pending' ? pending : rest).push(approval);
    }
    return [...pending, ...rest];
  }

  private _sessions(snapshot: UiControlPlaneSnapshot): readonly ControlPlaneSession[] {
    return this.sessionBroker ? this.sessionBroker.listSessions(50) : snapshot.sessions;
  }

  private _recentEvents(snapshot: UiControlPlaneSnapshot): readonly ControlPlaneEvent[] {
    return this.getControlPlaneRecentEvents ? this.getControlPlaneRecentEvents(50) : snapshot.recentEvents;
  }

  protected getItems(): readonly ControlPlaneItem[] {
    if (!this.readModel) return [];
    const snapshot = this.readModel.getSnapshot();
    switch (this.focusSection) {
      case 'approvals':
        return this._approvals(snapshot).map((approval): ControlPlaneItem => ({ kind: 'approval', approval }));
      case 'sessions':
        return this._sessions(snapshot).map((session): ControlPlaneItem => ({ kind: 'session', session }));
      case 'events':
        return this._recentEvents(snapshot).map((event): ControlPlaneItem => ({ kind: 'event', event }));
      case 'clients':
      default:
        return snapshot.clients.map((client): ControlPlaneItem => ({ kind: 'client', client }));
    }
  }

  protected override filterMatches(item: ControlPlaneItem, q: string): boolean {
    switch (item.kind) {
      case 'client':
        return item.client.kind.toLowerCase().includes(q)
          || item.client.label.toLowerCase().includes(q)
          || item.client.transport.toLowerCase().includes(q);
      case 'approval':
        return item.approval.status.toLowerCase().includes(q)
          || item.approval.request.tool.toLowerCase().includes(q)
          || (item.approval.sessionId ?? '').toLowerCase().includes(q);
      case 'session':
        return item.session.status.toLowerCase().includes(q)
          || item.session.title.toLowerCase().includes(q);
      case 'event':
        return item.event.event.toLowerCase().includes(q);
    }
  }

  protected override getEmptyStateMessage(): string {
    switch (this.focusSection) {
      case 'approvals': return ' No approval pressure recorded.';
      case 'sessions': return ' No shared sessions recorded.';
      case 'events': return ' No recent control-plane events.';
      default: return ' No control-plane clients connected.';
    }
  }

  protected override getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [
      { command: '/cockpit', summary: 'watch operator posture from the terminal' },
      { command: '/schedule list', summary: 'run automation that creates surface and daemon traffic' },
    ];
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    if (this.confirmAction) {
      const result = handleConfirmInput(this.confirmAction, key);
      if (result === 'confirmed') {
        this._executeConfirmed(this.confirmAction.subject);
        this.confirmAction = null;
        this.markDirty();
        return true;
      }
      if (result === 'cancelled') {
        this.confirmAction = null;
        this.markDirty();
      }
      return true;
    }

    if (!this.filterActive) {
      if (key === 'tab') {
        this._cycleFocus();
        return true;
      }
      if (this.focusSection === 'approvals' && this.approvalBroker && (key === 'a' || key === 'd')) {
        this._beginApprovalDecision(key === 'a');
        return true;
      }
    }

    return super.handleInput(key);
  }

  private _cycleFocus(): void {
    const idx = FOCUS_SECTIONS.indexOf(this.focusSection);
    this.focusSection = FOCUS_SECTIONS[(idx + 1) % FOCUS_SECTIONS.length]!;
    this.filterLabel = `Filter ${this.focusSection}`;
    this.selectedIndex = 0;
    this.markDirty();
  }

  private _beginApprovalDecision(approved: boolean): void {
    const item = this.getVisibleItems()[this.selectedIndex];
    if (!item || item.kind !== 'approval') return;
    if (item.approval.status !== 'pending' && item.approval.status !== 'claimed') return;
    this.confirmAction = {
      subject: { approvalId: item.approval.id, approved },
      label: `${item.approval.request.tool} · ${truncateDisplay(item.approval.sessionId ?? item.approval.id, 24)}`,
      verb: approved ? 'Approve' : 'Deny',
    };
    this.markDirty();
  }

  private _executeConfirmed(subject: ApprovalConfirmSubject): void {
    if (!this.approvalBroker) return;
    void this.approvalBroker.resolveApproval(subject.approvalId, {
      approved: subject.approved,
      actor: 'operator',
      actorSurface: 'tui',
    }).catch((err) => {
      this.setError(`${subject.approved ? 'Approve' : 'Deny'} failed: ${summarizeError(err)}`);
      this.markDirty();
    });
  }

  // -------------------------------------------------------------------------
  // Rendering — item rows
  // -------------------------------------------------------------------------

  protected renderItem(item: ControlPlaneItem, _index: number, selected: boolean, width: number): Line {
    switch (item.kind) {
      case 'client': return this._renderClientRow(item.client, selected, width);
      case 'approval': return this._renderApprovalRow(item.approval, selected, width);
      case 'session': return this._renderSessionRow(item.session, selected, width);
      case 'event': return this._renderEventRow(item.event, selected, width);
    }
  }

  private _renderClientRow(client: ControlPlaneClient, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [client.kind.padEnd(10), C.info, bg],
      [` ${truncateDisplay(client.label, 20).padEnd(20)}`, C.value, bg],
      [` ${client.transport.padEnd(12)}`, C.dim, bg],
      [` ${truncateDisplay(formatTime(client.lastSeenAt), Math.max(0, width - 46))}`, C.dim, bg],
    ]);
  }

  private _renderApprovalRow(approval: ControlPlaneApproval, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [approval.status.padEnd(10), approvalStatusColor(approval.status), bg],
      [` ${truncateDisplay(approval.request.tool, 16).padEnd(16)}`, C.value, bg],
      [` ${truncateDisplay(approval.sessionId ?? approval.id, Math.max(0, width - 30))}`, C.dim, bg],
    ]);
  }

  private _renderSessionRow(session: ControlPlaneSession, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [session.status.padEnd(10), session.status === 'active' ? C.good : C.dim, bg],
      [` ${truncateDisplay(session.title, 20).padEnd(20)}`, C.value, bg],
      [` ${truncateDisplay(session.activeAgentId ?? session.id, Math.max(0, width - 34))}`, C.dim, bg],
    ]);
  }

  private _renderEventRow(event: ControlPlaneEvent, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    const payload = typeof event.payload === 'string' ? event.payload : (JSON.stringify(event.payload) ?? '');
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [truncateDisplay(event.event, 16).padEnd(16), C.info, bg],
      [` ${truncateDisplay(payload, Math.max(0, width - 19))}`, C.dim, bg],
    ]);
  }

  // -------------------------------------------------------------------------
  // Rendering — workspace
  // -------------------------------------------------------------------------

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
    const approvals = this._approvals(snapshot);
    const sessions = this._sessions(snapshot);
    const recentEvents = this._recentEvents(snapshot);
    const clients = snapshot.clients;
    const pendingApprovals = approvals.filter((entry) => entry.status === 'pending').length;

    const headerLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'state', value: snapshot.connectionState, valueColor: connectionColor(snapshot.connectionState) },
        { label: 'clients', value: String(snapshot.activeClientIds.length), valueColor: snapshot.activeClientIds.length > 0 ? C.good : C.dim },
        { label: 'requests', value: String(snapshot.requestCount), valueColor: snapshot.requestCount > 0 ? C.info : C.dim },
        { label: 'errors', value: String(snapshot.errorCount), valueColor: snapshot.errorCount > 0 ? C.bad : C.dim },
      ], C),
      buildKeyValueLine(width, [
        { label: 'host', value: `${snapshot.host}:${snapshot.port}`, valueColor: C.value },
        { label: 'approvals', value: `${pendingApprovals} pending / ${approvals.length}`, valueColor: pendingApprovals > 0 ? C.warn : C.dim },
        { label: 'sessions', value: String(sessions.length), valueColor: sessions.length > 0 ? C.info : C.dim },
        { label: 'events', value: String(recentEvents.length), valueColor: recentEvents.length > 0 ? C.info : C.dim },
      ], C),
      this._buildFocusTabsLine(width),
    ];

    if (clients.length === 0 && approvals.length === 0 && sessions.length === 0 && recentEvents.length === 0) {
      return this.renderList(width, height, {
        title: 'Control Plane',
        header: headerLines,
        emptyMessage: ' No control-plane activity recorded.',
      });
    }

    const items = this.getVisibleItems();
    this.clampSelection();
    const selected = items[this.selectedIndex];

    const footerLines: Line[] = [];
    if (selected) {
      footerLines.push(...this._buildDetailLines(width, selected));
      if (this.confirmAction) footerLines.push(...renderConfirmLines(width, this.confirmAction));
    } else {
      footerLines.push(buildPanelLine(width, [['  Nothing selected in this section.', C.dim]]));
    }

    return this.renderList(width, height, {
      title: 'Control Plane',
      header: headerLines,
      footer: footerLines,
      hints: this._buildHints(selected),
    });
  }

  private _buildFocusTabsLine(width: number): Line {
    const seg = (label: string, section: FocusSection): [string, string] => [
      ` ${label} `,
      this.focusSection === section ? C.value : C.dim,
    ];
    return buildPanelLine(width, [
      seg('Approvals', 'approvals'),
      seg('Clients', 'clients'),
      seg('Sessions', 'sessions'),
      seg('Events', 'events'),
      [' (Tab to switch)', C.dim],
    ]);
  }

  private _buildHints(selected: ControlPlaneItem | undefined): ReadonlyArray<{ keys: string; label: string }> {
    if (this.filterActive) {
      return [
        { keys: 'type', label: `filter ${this.focusSection}` },
        { keys: 'Enter', label: 'apply' },
        { keys: 'Esc', label: 'clear' },
      ];
    }
    const hints: Array<{ keys: string; label: string }> = [
      { keys: 'Up/Down', label: `select ${this.focusSection.slice(0, -1)}` },
      { keys: 'Tab', label: 'section' },
    ];
    if (
      this.focusSection === 'approvals'
      && this.approvalBroker
      && selected?.kind === 'approval'
      && (selected.approval.status === 'pending' || selected.approval.status === 'claimed')
    ) {
      hints.push({ keys: 'a', label: 'approve' }, { keys: 'd', label: 'deny' });
    }
    hints.push({ keys: '/', label: 'filter' });
    return hints;
  }

  private _buildDetailLines(width: number, item: ControlPlaneItem): Line[] {
    if (item.kind === 'client') {
      const client = item.client;
      const rows: Line[] = [
        buildPanelLine(width, [['  Client: ', C.label], [client.label, C.value], ['  Kind: ', C.label], [client.kind, C.info]]),
        buildPanelLine(width, [['  Transport: ', C.label], [client.transport, C.value], ['  Connected: ', C.label], [client.connected ? 'yes' : 'no', client.connected ? C.good : C.warn]]),
        buildPanelLine(width, [['  Route: ', C.label], [client.routeId ?? 'n/a', C.dim], ['  Session: ', C.label], [client.sessionId ?? 'n/a', C.dim]]),
        buildPanelLine(width, [['  Last seen: ', C.label], [formatTime(client.lastSeenAt), C.dim], ['  Remote: ', C.label], [truncateDisplay(client.remoteAddress ?? 'n/a', Math.max(0, width - 36)), C.dim]]),
      ];
      return buildDetailBlock(width, `Client · ${client.label}`, rows, C);
    }

    if (item.kind === 'approval') {
      const approval = item.approval;
      const rows: Line[] = [
        buildPanelLine(width, [['  Approval: ', C.label], [approval.id, C.value], ['  Status: ', C.label], [approval.status, approvalStatusColor(approval.status)]]),
        buildPanelLine(width, [['  Tool: ', C.label], [approval.request.tool, C.info], ['  Risk: ', C.label], [approval.request.analysis.riskLevel, C.warn]]),
        buildPanelLine(width, [['  Session: ', C.label], [approval.sessionId ?? 'n/a', C.dim], ['  Route: ', C.label], [approval.routeId ?? 'n/a', C.dim]]),
        buildPanelLine(width, [['  Requested: ', C.label], [formatTime(approval.createdAt), C.dim], ['  Updated: ', C.label], [formatTime(approval.updatedAt), C.dim]]),
      ];
      if (approval.decision) {
        rows.push(buildPanelLine(width, [['  Decision: ', C.label], [approval.decision.approved ? 'approved' : 'denied', approval.decision.approved ? C.good : C.bad]]));
      }
      return buildDetailBlock(width, `Approval · ${approval.request.tool}`, rows, C);
    }

    if (item.kind === 'session') {
      const session = item.session;
      const rows: Line[] = [
        buildPanelLine(width, [['  Session: ', C.label], [session.title, C.value], ['  Status: ', C.label], [session.status, session.status === 'active' ? C.good : C.dim]]),
        buildPanelLine(width, [['  Kind: ', C.label], [session.kind, C.info], ['  Messages: ', C.label], [String(session.messageCount), C.value]]),
        buildPanelLine(width, [['  Active agent: ', C.label], [session.activeAgentId ?? 'none (unattached)', session.activeAgentId ? C.good : C.dim], ['  Last agent: ', C.label], [session.lastAgentId ?? 'n/a', C.dim]]),
        buildPanelLine(width, [['  Pending inputs: ', C.label], [String(session.pendingInputCount), session.pendingInputCount > 0 ? C.warn : C.dim], ['  Last activity: ', C.label], [formatTime(session.lastActivityAt), C.dim]]),
      ];
      return buildDetailBlock(width, `Session · ${session.title}`, rows, C);
    }

    const event = item.event;
    const payload = typeof event.payload === 'string' ? event.payload : (JSON.stringify(event.payload) ?? '');
    const rows: Line[] = [
      buildPanelLine(width, [['  Event: ', C.label], [event.event, C.info], ['  At: ', C.label], [formatTime(event.createdAt), C.dim]]),
      buildPanelLine(width, [['  Payload: ', C.label], [truncateDisplay(payload, Math.max(0, width - 12)), C.dim]]),
    ];
    return buildDetailBlock(width, `Event · ${event.event}`, rows, C);
  }
}
