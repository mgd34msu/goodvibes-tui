import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { UiCockpitSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import type { CockpitRosterReadModel } from './cockpit-read-model.ts';
import {
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  buildStatPill,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import { agentStatusColor } from './agent-inspector-shared.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#cbd5e1',
  headerBg: '#0f172a',
} as const;

function pickColor(value: number, warnAt = 1, badAt = 3): string {
  if (value >= badAt) return C.bad;
  if (value >= warnAt) return C.warn;
  return C.good;
}

export interface CockpitPanelActionCallbacks {
  readonly openAgentDetail: (agentId: string) => void;
  readonly cancelAgent: (agentId: string) => boolean;
}

const WORKSPACE_IDS = ['flow', 'governance', 'health', 'domains', 'agents'] as const;
type WorkspaceId = (typeof WORKSPACE_IDS)[number];

function formatCost(cost: number | null): string {
  if (cost === null) return 'n/a';
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
}

export class CockpitPanel extends BasePanel {
  private readonly unsub: (() => void) | null;
  private readonly rosterUnsub: (() => void) | null;
  private readonly actionCallbacks: CockpitPanelActionCallbacks;
  private selectedWorkspaceIndex = 0;
  private agentCursorIndex = 0;
  private pendingCancelId: string | null = null;

  public constructor(
    private readonly readModel?: UiReadModel<UiCockpitSnapshot>,
    private readonly rosterReadModel?: CockpitRosterReadModel,
    actionCallbacks?: Partial<CockpitPanelActionCallbacks>,
  ) {
    super('cockpit', 'Cockpit', 'O', 'monitoring');
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
    this.rosterUnsub = rosterReadModel ? rosterReadModel.subscribe(() => this.markDirty()) : null;
    this.actionCallbacks = {
      openAgentDetail: actionCallbacks?.openAgentDetail ?? ((_id: string) => { /* noop */ }),
      cancelAgent: actionCallbacks?.cancelAgent ?? ((_id: string) => false),
    };
  }

  public override onDestroy(): void {
    this.unsub?.();
    this.rosterUnsub?.();
  }

  private get selectedWorkspace(): WorkspaceId {
    return WORKSPACE_IDS[this.selectedWorkspaceIndex] ?? 'flow';
  }

  public handleInput(key: string): boolean {
    // Confirm-cancel absorb: when a cancel is pending, only y/enter confirm, escape/n dismiss, everything else is consumed
    if (this.pendingCancelId !== null) {
      if (key === 'y' || key === 'enter') {
        this.actionCallbacks.cancelAgent(this.pendingCancelId);
        this.pendingCancelId = null;
        this.markDirty();
      } else if (key === 'escape' || key === 'n') {
        this.pendingCancelId = null;
        this.markDirty();
      }
      // All other keys are consumed while confirm is pending
      return true;
    }
    if (key === 'left' || key === 'h') {
      this.selectedWorkspaceIndex = Math.max(0, this.selectedWorkspaceIndex - 1);
      this.agentCursorIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'right' || key === 'l') {
      this.selectedWorkspaceIndex = Math.min(WORKSPACE_IDS.length - 1, this.selectedWorkspaceIndex + 1);
      this.agentCursorIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'home') {
      this.selectedWorkspaceIndex = 0;
      this.agentCursorIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'end') {
      this.selectedWorkspaceIndex = WORKSPACE_IDS.length - 1;
      this.agentCursorIndex = 0;
      this.markDirty();
      return true;
    }
    // Agents workspace: cursor movement, inspect, and cancel-initiation
    if (this.selectedWorkspace === 'agents') {
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
      if (key === 'i' || key === 'return') {
        const entry = roster[this.agentCursorIndex];
        if (entry) {
          this.actionCallbacks.openAgentDetail(entry.id);
        }
        return true;
      }
      if (key === 'c') {
        const entry = roster[this.agentCursorIndex];
        if (entry && !this.isTerminal(entry.status)) {
          this.pendingCancelId = entry.id;
          this.markDirty();
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
    const { roster, stalledAgentCount, totalCost } = this.rosterReadModel.getSnapshot();
    lines.push(buildPanelLine(width, [
      [` ${roster.length} agent${roster.length !== 1 ? 's' : ''}`, C.label],
      stalledAgentCount > 0 ? [`  ${stalledAgentCount} stalled`, C.bad] : ['', C.dim],
      [`  cost: ${formatCost(totalCost)}`, C.dim],
    ]));
    const colors: Record<string, string> = {
      pending: C.dim, running: C.value, completed: C.good, failed: C.bad, cancelled: C.dim, system: C.dim,
    };
    for (let i = 0; i < roster.length; i++) {
      const entry = roster[i]!;
      const cursor = i === this.agentCursorIndex ? '>' : ' ';
      const shortId = entry.id.length > 8 ? entry.id.slice(-8) : entry.id;
      const statusColor = agentStatusColor(entry.status, colors);
      const stalledBadge: [string, string] = entry.stalled ? [' STALLED', C.bad] : ['', C.dim];
      lines.push(buildPanelLine(width, [
        [cursor, i === this.agentCursorIndex ? C.value : C.dim],
        [` ${shortId} `, C.dim],
        [entry.status, statusColor],
        stalledBadge,
        ['  ', C.dim],
        [entry.task.slice(0, Math.max(0, width - 30)), C.label],
      ]));
    }
    if (roster.length === 0) {
      lines.push(buildPanelLine(width, [[' No agents tracked yet.', C.empty]]));
    }
    return lines;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;

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
        [snapshot.latestIncident.summary.slice(0, Math.max(0, width - 19 - snapshot.latestIncident.classification.length)), C.dim],
      ]));
    }
    const domainLines: Line[] = [buildPanelLine(width, [[
      `tasks:${snapshot.taskCount} agents:${snapshot.agentCount} graphs:${snapshot.totalGraphs} comms:${snapshot.communicationCount} mcp:${snapshot.mcpServerCount} plugins:${snapshot.pluginCount}`,
      C.dim,
    ]])];
    const workspaceLines: Line[] = [];
    if (selectedWorkspace === 'flow') {
      workspaceLines.push(buildKeyValueLine(width, [
        { label: 'running', value: String(snapshot.runningTasks), valueColor: C.value },
        { label: 'blocked', value: String(snapshot.blockedTasks), valueColor: pickColor(snapshot.blockedTasks) },
        { label: 'graphs', value: String(snapshot.activeGraphs), valueColor: pickColor(snapshot.activeGraphs, 1, 4) },
      ], C));
      workspaceLines.push(buildGuidanceLine(width, '/orchestration', 'inspect graph state, retries, and subtree controls', C));
      workspaceLines.push(buildGuidanceLine(width, '/tasks', 'review active task pressure and task-specific output', C));
    } else if (selectedWorkspace === 'governance') {
      workspaceLines.push(buildKeyValueLine(width, [
        { label: 'preflight', value: snapshot.preflightStatus.toUpperCase(), valueColor: snapshot.preflightStatus === 'block' ? C.bad : snapshot.preflightStatus === 'warn' ? C.warn : snapshot.preflightStatus === 'pass' ? C.good : C.dim },
        { label: 'lint', value: String(snapshot.lintFindingCount), valueColor: pickColor(snapshot.lintFindingCount) },
        { label: 'allow-all mcp', value: String(snapshot.elevatedMcp), valueColor: pickColor(snapshot.elevatedMcp) },
      ], C));
      workspaceLines.push(buildGuidanceLine(width, '/policy', 'run simulation, preflight, and bundle review', C));
      workspaceLines.push(buildGuidanceLine(width, '/security', 'inspect trust, tokens, quarantines, and incident pressure', C));
    } else if (selectedWorkspace === 'health') {
      workspaceLines.push(buildKeyValueLine(width, [
        { label: 'incidents', value: String(snapshot.incidentCount), valueColor: pickColor(snapshot.incidentCount) },
        { label: 'plugins', value: String(snapshot.erroredPlugins), valueColor: pickColor(snapshot.erroredPlugins) },
        { label: 'integrations', value: String(snapshot.failingIntegrations), valueColor: pickColor(snapshot.failingIntegrations) },
      ], C));
      workspaceLines.push(buildGuidanceLine(width, '/incident latest', 'inspect the latest incident bundle and replay fallout', C));
      workspaceLines.push(buildGuidanceLine(width, '/plugins', 'review errored plugins and provenance posture', C));
    } else if (selectedWorkspace === 'domains') {
      workspaceLines.push(buildKeyValueLine(width, [
        { label: 'tasks', value: String(snapshot.taskCount), valueColor: C.value },
        { label: 'comms', value: String(snapshot.communicationCount), valueColor: C.value },
        { label: 'mcp', value: String(snapshot.mcpServerCount), valueColor: C.value },
      ], C));
      workspaceLines.push(buildGuidanceLine(width, '/mcp', 'inspect trust, quarantine, and risky server posture', C));
      workspaceLines.push(buildGuidanceLine(width, '/communication', 'review blocked lanes and agent message flow', C));
    } else {
      // 'agents' workspace — roster from rosterReadModel
      workspaceLines.push(...this.renderAgentsWorkspace(width));
    }

    const sections: PanelWorkspaceSection[] = [
      { title: 'Flow', lines: flowLines },
      { title: 'Governance', lines: governanceLines },
      { title: 'Health', lines: healthLines },
      { title: 'Domains', lines: domainLines },
      { title: 'Selected Workspace', lines: workspaceLines },
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Operator Cockpit',
      intro: 'Live runtime pressure across orchestration, approvals, governance, integrations, and provider trust posture.',
      sections,
      footerLines: [buildPanelLine(width, [[`  Left/Right move workspace focus  Home/End jump  focus=${selectedWorkspace}`, C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
