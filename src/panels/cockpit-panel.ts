import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { BasePanel } from './base-panel.ts';
import type { UiCockpitSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import type { CockpitRosterReadModel } from './cockpit-read-model.ts';
import {
  buildAlignedRow,
  buildPanelLine,
  buildPanelWorkspace,
  buildStatPill,
  DEFAULT_PANEL_PALETTE,
  type ColumnSpec,
  type PanelWorkspaceSection,
} from './polish.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import { agentStatusColor } from './agent-inspector-shared.ts';

// Base chrome only — title band and text tokens come straight from
// DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

// How often the panel force-refreshes while active so time-based state (the
// roster's stalled badges, which derive from wall-clock elapsed time rather
// than an event) stays current even when no agent lifecycle event has fired.
const STALL_TICK_MS = 5_000;

function pickColor(value: number, warnAt = 1, badAt = 3): string {
  if (value >= badAt) return C.bad;
  if (value >= warnAt) return C.warn;
  return C.good;
}

export interface CockpitPanelActionCallbacks {
  /** Open the quick agent-detail modal (bootstrap-shell openAgentDetail wiring). */
  readonly openAgentDetail: (agentId: string) => void;
  /** Deep-link into the Inspector panel focused on this agent (WO-110 inspectAgent route). */
  readonly inspectAgent: (agentId: string) => void;
  readonly cancelAgent: (agentId: string) => boolean;
  /** Cross-panel jump for a domain mini-summary card (wraps PanelManager.open via deps.openPanel). */
  readonly openPanel: (panelId: string) => void;
}

const WORKSPACE_IDS = ['flow', 'governance', 'health', 'domains', 'agents'] as const;
type WorkspaceId = (typeof WORKSPACE_IDS)[number];
type DomainWorkspaceId = Exclude<WorkspaceId, 'agents'>;

/** A single live domain mini-summary card. Enter on the focused card jumps to `target` via deps.openPanel. */
interface DomainCard {
  readonly label: string;
  readonly target: string;
}

// Replaces the old buildGuidanceLine ('/orchestration', '/policy', …) signposts:
// each non-agents workspace is now a short list of live, jumpable domain cards.
const DOMAIN_CARDS: Record<DomainWorkspaceId, readonly DomainCard[]> = {
  flow: [
    { label: 'Orchestration', target: 'orchestration' },
    { label: 'Tasks', target: 'tasks' },
  ],
  governance: [
    { label: 'Policy', target: 'policy' },
    { label: 'Security', target: 'security' },
  ],
  health: [
    { label: 'Incidents', target: 'incident' },
  ],
  domains: [
    { label: 'Communication', target: 'communication' },
  ],
};

/** Live stat triplet for a domain card, computed from the current cockpit snapshot. */
function domainCardStats(target: string, snapshot: UiCockpitSnapshot): ReadonlyArray<readonly [string, string, string]> {
  switch (target) {
    case 'orchestration':
      return [
        ['graphs', String(snapshot.activeGraphs), pickColor(snapshot.activeGraphs, 1, 4)],
        ['running', String(snapshot.runningTasks), C.value],
        ['guards', String(snapshot.guardTrips), pickColor(snapshot.guardTrips)],
      ];
    case 'tasks':
      return [
        ['running', String(snapshot.runningTasks), C.value],
        ['blocked', String(snapshot.blockedTasks), pickColor(snapshot.blockedTasks)],
        ['failed', String(snapshot.failedTasks), pickColor(snapshot.failedTasks)],
      ];
    case 'policy':
      return [
        ['preflight', snapshot.preflightStatus.toUpperCase(), snapshot.preflightStatus === 'block' ? C.bad : snapshot.preflightStatus === 'warn' ? C.warn : snapshot.preflightStatus === 'pass' ? C.good : C.dim],
        ['issues', String(snapshot.preflightIssueCount), pickColor(snapshot.preflightIssueCount)],
        ['lint', String(snapshot.lintFindingCount), pickColor(snapshot.lintFindingCount)],
      ];
    case 'security':
      return [
        ['token blocked', String(snapshot.tokenBlockedCount), pickColor(snapshot.tokenBlockedCount)],
        ['overdue', String(snapshot.tokenRotationOverdueCount), pickColor(snapshot.tokenRotationOverdueCount)],
        ['scope violations', String(snapshot.tokenScopeViolationCount), pickColor(snapshot.tokenScopeViolationCount)],
      ];
    case 'incident':
      return [
        ['count', String(snapshot.incidentCount), pickColor(snapshot.incidentCount)],
        ['latest', snapshot.latestIncident ? snapshot.latestIncident.classification : 'none', snapshot.latestIncident ? C.bad : C.dim],
      ];
    case 'communication':
      return [
        ['messages', String(snapshot.communicationCount), C.value],
        ['blocked', String(snapshot.blockedMessages), pickColor(snapshot.blockedMessages)],
      ];
    default:
      return [];
  }
}

function formatCost(cost: number | null): string {
  if (cost === null) return 'n/a';
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
}

function formatTokens(inputTokens: number | null, outputTokens: number | null): string {
  if (inputTokens === null && outputTokens === null) return 'n/a';
  const fmt = (n: number | null) => (n === null ? '-' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${fmt(inputTokens)}/${fmt(outputTokens)}`;
}

export class CockpitPanel extends BasePanel {
  private readonly unsub: (() => void) | null;
  private readonly rosterUnsub: (() => void) | null;
  private readonly actionCallbacks: CockpitPanelActionCallbacks;
  private selectedWorkspaceIndex = 0;
  private agentCursorIndex = 0;
  private domainCursorIndex = 0;
  private confirm: ConfirmState<string> | null = null;
  private stallTickTimer: ReturnType<typeof setInterval> | null = null;

  public constructor(
    private readonly readModel?: UiReadModel<UiCockpitSnapshot>,
    private readonly rosterReadModel?: CockpitRosterReadModel,
    actionCallbacks?: Partial<CockpitPanelActionCallbacks>,
  ) {
    super('cockpit', 'Cockpit', 'O', 'runtime-ops');
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
    this.rosterUnsub = rosterReadModel ? rosterReadModel.subscribe(() => this.markDirty()) : null;
    this.actionCallbacks = {
      openAgentDetail: actionCallbacks?.openAgentDetail ?? ((_id: string) => { /* noop */ }),
      inspectAgent: actionCallbacks?.inspectAgent ?? ((_id: string) => { /* noop */ }),
      cancelAgent: actionCallbacks?.cancelAgent ?? ((_id: string) => false),
      openPanel: actionCallbacks?.openPanel ?? ((_id: string) => { /* noop */ }),
    };
  }

  public override onActivate(): void {
    super.onActivate();
    // Periodic tick so the roster's time-derived stalled badges (see
    // cockpit-read-model's AGENT_STALL_THRESHOLD_MS) refresh even when no
    // agent lifecycle event fires while this panel is on screen.
    if (this.stallTickTimer === null) {
      this.stallTickTimer = this.registerTimer(setInterval(() => this.markDirty(), STALL_TICK_MS));
    }
  }

  public override onDeactivate(): void {
    super.onDeactivate();
    if (this.stallTickTimer !== null) {
      this.clearTimer(this.stallTickTimer);
      this.stallTickTimer = null;
    }
  }

  public override onDestroy(): void {
    super.onDestroy();
    this.unsub?.();
    this.rosterUnsub?.();
  }

  private get selectedWorkspace(): WorkspaceId {
    return WORKSPACE_IDS[this.selectedWorkspaceIndex] ?? 'flow';
  }

  public handleInput(key: string): boolean {
    // Confirm-cancel absorb: when a cancel is pending, only y/enter/return confirm,
    // escape/n dismiss, everything else is consumed (canonical ConfirmState contract).
    if (this.confirm) {
      const result = handleConfirmInput(this.confirm, key);
      if (result === 'confirmed') {
        this.actionCallbacks.cancelAgent(this.confirm.subject);
        this.confirm = null;
        this.markDirty();
      } else if (result === 'cancelled') {
        this.confirm = null;
        this.markDirty();
      }
      // 'absorbed' (and the confirmed/cancelled cases above) all consume the key.
      return true;
    }
    if (key === 'left' || key === 'h') {
      this.selectedWorkspaceIndex = Math.max(0, this.selectedWorkspaceIndex - 1);
      this.agentCursorIndex = 0;
      this.domainCursorIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'right' || key === 'l') {
      this.selectedWorkspaceIndex = Math.min(WORKSPACE_IDS.length - 1, this.selectedWorkspaceIndex + 1);
      this.agentCursorIndex = 0;
      this.domainCursorIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'home') {
      this.selectedWorkspaceIndex = 0;
      this.agentCursorIndex = 0;
      this.domainCursorIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'end') {
      this.selectedWorkspaceIndex = WORKSPACE_IDS.length - 1;
      this.agentCursorIndex = 0;
      this.domainCursorIndex = 0;
      this.markDirty();
      return true;
    }
    if (this.selectedWorkspace === 'agents') {
      // Agents workspace: roster cursor movement, inspect, and cancel-initiation.
      const roster = this.rosterReadModel?.getSnapshot().roster ?? [];
      if (key === 'up' || key === 'k') {
        this.agentCursorIndex = Math.max(0, this.agentCursorIndex - 1);
        this.markDirty();
        return true;
      }
      if (key === 'down' || key === 'j') {
        this.agentCursorIndex = Math.min(Math.max(0, roster.length - 1), this.agentCursorIndex + 1);
        this.markDirty();
        return true;
      }
      if (key === 'i') {
        // Quick view is only meaningful when the cursor is on a real roster
        // entry — otherwise leave the key unconsumed instead of absorbing it
        // as a silent no-op.
        const entry = roster[this.agentCursorIndex];
        if (!entry) return false;
        this.actionCallbacks.openAgentDetail(entry.id);
        return true;
      }
      if (key === 'enter' || key === 'return') {
        const entry = roster[this.agentCursorIndex];
        if (entry) {
          this.actionCallbacks.inspectAgent(entry.id);
        }
        return true;
      }
      if (key === 'c') {
        // Cancel is only meaningful on a real, non-terminal roster entry —
        // otherwise leave the key unconsumed instead of absorbing it as a
        // silent no-op.
        const entry = roster[this.agentCursorIndex];
        if (!entry || this.isTerminal(entry.status)) return false;
        const shortId = entry.id.length > 8 ? entry.id.slice(-8) : entry.id;
        this.confirm = { subject: entry.id, label: `agent ${shortId}`, verb: 'Cancel' };
        this.markDirty();
        return true;
      }
    } else {
      // Domain-summary workspaces: card cursor movement + Enter jump.
      const cards = DOMAIN_CARDS[this.selectedWorkspace];
      if (key === 'up' || key === 'k') {
        this.domainCursorIndex = Math.max(0, this.domainCursorIndex - 1);
        this.markDirty();
        return true;
      }
      if (key === 'down' || key === 'j') {
        this.domainCursorIndex = Math.min(cards.length - 1, this.domainCursorIndex + 1);
        this.markDirty();
        return true;
      }
      if (key === 'enter' || key === 'return') {
        const card = cards[this.domainCursorIndex];
        if (card) {
          this.actionCallbacks.openPanel(card.target);
        }
        return true;
      }
    }
    return false;
  }

  private isTerminal(status: string): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
  }

  private renderAgentsWorkspace(width: number): Line[] {
    const lines: Line[] = [];
    if (!this.rosterReadModel) {
      lines.push(buildPanelLine(width, [[' Agent roster read model not wired.', C.empty]]));
      return lines;
    }
    const { roster, stalledAgentCount, totalCost, totalInputTokens, totalOutputTokens } = this.rosterReadModel.getSnapshot();
    lines.push(buildPanelLine(width, [
      [` ${roster.length} agent${roster.length !== 1 ? 's' : ''}`, C.label],
      stalledAgentCount > 0 ? [`  ${stalledAgentCount} stalled`, C.bad] : ['', C.dim],
      [`  cost: ${formatCost(totalCost)}`, C.dim],
      [`  tokens: ${formatTokens(totalInputTokens, totalOutputTokens)}`, C.dim],
    ]));
    const colors: Record<string, string> = {
      pending: C.dim, running: C.value, completed: C.good, failed: C.bad, cancelled: C.dim, system: C.dim,
    };
    // Fixed-width columns (id/status/stalled/model/tokens/cost) + task takes the remainder.
    const columns: ColumnSpec[] = [
      { width: 9 },
      { width: 10 },
      { width: 8 },
      { width: 14 },
      { width: 13, align: 'right' },
      { width: 8, align: 'right' },
      { width: Math.max(8, width - 68) },
    ];
    for (let i = 0; i < roster.length; i++) {
      const entry = roster[i]!;
      const selected = i === this.agentCursorIndex;
      const shortId = entry.id.length > 8 ? entry.id.slice(-8) : entry.id;
      const statusColor = agentStatusColor(entry.status, colors);
      lines.push(buildAlignedRow(
        width,
        [
          { text: shortId, fg: C.dim },
          { text: entry.status, fg: statusColor },
          { text: entry.stalled ? 'STALLED' : '', fg: C.bad },
          { text: entry.model, fg: C.info },
          { text: formatTokens(entry.inputTokens, entry.outputTokens), fg: C.dim },
          { text: formatCost(entry.cost), fg: C.value },
          { text: entry.task, fg: C.label },
        ],
        columns,
        { selected, selectedBg: C.headerBg, marker: '▸' },
      ));
    }
    if (roster.length === 0) {
      lines.push(buildPanelLine(width, [[' No agents tracked yet.', C.empty]]));
    }
    return lines;
  }

  /** Live domain mini-summary cards for a non-agents workspace (replaces the old signpost pair). */
  private renderDomainWorkspace(width: number, workspace: DomainWorkspaceId, snapshot: UiCockpitSnapshot): Line[] {
    const cards = DOMAIN_CARDS[workspace];
    const lines: Line[] = [];
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]!;
      const focused = i === this.domainCursorIndex;
      const stats = domainCardStats(card.target, snapshot);
      lines.push(buildPanelLine(width, [
        [focused ? '▸ ' : '  ', focused ? C.value : C.dim],
        [card.label, focused ? C.header : C.label, focused ? C.headerBg : undefined],
        ['  ', C.dim],
        ...stats.flatMap(([label, value, color]): Array<[string, string, string?]> => [
          [`${label} `, C.dim],
          [`${value}  `, color],
        ]),
      ]));
    }
    lines.push(buildPanelLine(width, [[' ↑/↓ select domain  Enter opens panel', C.dim]]));
    return lines;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;

    if (this.confirm) {
      const lines = buildPanelWorkspace(width, height, {
        title: 'Operator Cockpit',
        sections: [{ title: 'Confirmation', lines: renderConfirmLines(width, this.confirm) }],
        footerLines: [buildPanelLine(width, [['  y / Enter confirm  n / Esc cancel', C.dim]])],
        palette: C,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    if (!this.readModel) {
      const lines: Line[] = [buildPanelLine(width, [[' Runtime read model not wired into this panel yet.', C.empty]])];
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Operator Cockpit',
        sections: [{ lines }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    const snapshot = this.readModel.getSnapshot();
    const selectedWorkspace = WORKSPACE_IDS[this.selectedWorkspaceIndex] ?? 'flow';

    const flowLines: Line[] = [
      buildPanelLine(width, [
        ...buildStatPill('graphs', String(snapshot.activeGraphs), C.label, pickColor(snapshot.activeGraphs, 1, 4)),
        ...buildStatPill('running', String(snapshot.runningTasks), C.label, C.value),
        ...buildStatPill('blocked', String(snapshot.blockedTasks), C.label, pickColor(snapshot.blockedTasks)),
        ...buildStatPill('failed', String(snapshot.failedTasks), C.label, pickColor(snapshot.failedTasks)),
        ...buildStatPill('guards', String(snapshot.guardTrips), C.label, pickColor(snapshot.guardTrips)),
      ]),
      buildPanelLine(width, [
        ...buildStatPill('blocked comms', String(snapshot.blockedMessages), C.label, pickColor(snapshot.blockedMessages)),
        ...buildStatPill('pending approvals', String(snapshot.pendingPermissions), C.label, pickColor(snapshot.pendingPermissions)),
        ...buildStatPill('denied', String(snapshot.deniedPermissions), C.label, pickColor(snapshot.deniedPermissions)),
      ]),
    ];
    const governanceLines: Line[] = [
      buildPanelLine(width, [
        ...buildStatPill('preflight', snapshot.preflightStatus.toUpperCase(), C.label, snapshot.preflightStatus === 'block' ? C.bad : snapshot.preflightStatus === 'warn' ? C.warn : snapshot.preflightStatus === 'pass' ? C.good : C.dim),
        ...buildStatPill('issues', String(snapshot.preflightIssueCount), C.label, pickColor(snapshot.preflightIssueCount)),
        ...buildStatPill('lint', String(snapshot.lintFindingCount), C.label, pickColor(snapshot.lintFindingCount)),
        ...buildStatPill('allow-all MCP', String(snapshot.elevatedMcp), C.label, pickColor(snapshot.elevatedMcp)),
        ...buildStatPill('unhealthy MCP', String(snapshot.unhealthyMcp), C.label, pickColor(snapshot.unhealthyMcp)),
      ]),
      buildPanelLine(width, [
        ...buildStatPill('token blocked', String(snapshot.tokenBlockedCount), C.label, pickColor(snapshot.tokenBlockedCount)),
        ...buildStatPill('overdue', String(snapshot.tokenRotationOverdueCount), C.label, pickColor(snapshot.tokenRotationOverdueCount)),
        ...buildStatPill('scope violations', String(snapshot.tokenScopeViolationCount), C.label, pickColor(snapshot.tokenScopeViolationCount)),
        ...buildStatPill('warnings', String(snapshot.tokenRotationWarningCount), C.label, pickColor(snapshot.tokenRotationWarningCount)),
      ]),
    ];
    const healthLines: Line[] = [
      buildPanelLine(width, [
        ...buildStatPill('incidents', String(snapshot.incidentCount), C.label, pickColor(snapshot.incidentCount)),
        ...buildStatPill('plugins', String(snapshot.erroredPlugins), C.label, pickColor(snapshot.erroredPlugins)),
        ...buildStatPill('integrations', String(snapshot.failingIntegrations), C.label, pickColor(snapshot.failingIntegrations)),
      ]),
    ];
    if (snapshot.latestIncident) {
      healthLines.push(buildPanelLine(width, [
        [' latest incident ', C.label],
        [snapshot.latestIncident.classification, C.bad],
        ['  ', C.label],
        [truncateDisplay(snapshot.latestIncident.summary, Math.max(0, width - 19 - snapshot.latestIncident.classification.length)), C.dim],
      ]));
    }
    const domainLines: Line[] = [buildPanelLine(width, [[
      `tasks:${snapshot.taskCount} agents:${snapshot.agentCount} graphs:${snapshot.totalGraphs} comms:${snapshot.communicationCount} mcp:${snapshot.mcpServerCount} plugins:${snapshot.pluginCount}`,
      C.dim,
    ]])];
    const workspaceLines: Line[] = selectedWorkspace === 'agents'
      ? this.renderAgentsWorkspace(width)
      : this.renderDomainWorkspace(width, selectedWorkspace, snapshot);

    // Visible workspace selector so focus and the available workspaces are
    // obvious at a glance (not buried in a footer string). Rendered as a
    // title-less row to keep it compact; the ▸ marker + accent show focus.
    const selectorLine = buildPanelLine(width, [
      [' switch ', C.label],
      ...WORKSPACE_IDS.flatMap((id, i): Array<[string, string, string?]> => {
        const focused = i === this.selectedWorkspaceIndex;
        return [
          [focused ? '▸' : ' ', focused ? C.value : C.dim],
          [`${id} `, focused ? C.header : C.dim, focused ? C.headerBg : undefined],
        ];
      }),
    ]);

    const sections: PanelWorkspaceSection[] = [
      { lines: [selectorLine] },
      { title: 'Flow', lines: flowLines },
      { title: 'Governance', lines: governanceLines },
      { title: 'Health', lines: healthLines },
      { title: 'Domains', lines: domainLines },
      { title: `Workspace · ${selectedWorkspace}`, lines: workspaceLines },
    ];
    // Context-aware footer: surface the keys that actually work in this view.
    const footerHint = selectedWorkspace === 'agents'
      ? '  ←/→ workspace  ↑/↓ select agent  i quick view  enter inspector  c cancel  Home/End jump'
      : '  ←/→ workspace  ↑/↓ select domain  enter opens panel  Home/End jump';
    const lines = buildPanelWorkspace(width, height, {
      title: 'Operator Cockpit',
      sections,
      footerLines: [buildPanelLine(width, [[footerHint, C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
