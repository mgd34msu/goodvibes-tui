import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { UiCockpitSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import {
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  buildStatPill,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';

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

const WORKSPACE_IDS = ['flow', 'governance', 'health', 'domains'] as const;

export class CockpitPanel extends BasePanel {
  private readonly unsub: (() => void) | null;
  private selectedWorkspaceIndex = 0;

  public constructor(private readonly readModel?: UiReadModel<UiCockpitSnapshot>) {
    super('cockpit', 'Cockpit', 'O', 'monitoring');
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    if (key === 'left' || key === 'h') {
      this.selectedWorkspaceIndex = Math.max(0, this.selectedWorkspaceIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'right' || key === 'l') {
      this.selectedWorkspaceIndex = Math.min(WORKSPACE_IDS.length - 1, this.selectedWorkspaceIndex + 1);
      this.markDirty();
      return true;
    }
    if (key === 'home') {
      this.selectedWorkspaceIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'end') {
      this.selectedWorkspaceIndex = WORKSPACE_IDS.length - 1;
      this.markDirty();
      return true;
    }
    return false;
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
    } else {
      workspaceLines.push(buildKeyValueLine(width, [
        { label: 'tasks', value: String(snapshot.taskCount), valueColor: C.value },
        { label: 'comms', value: String(snapshot.communicationCount), valueColor: C.value },
        { label: 'mcp', value: String(snapshot.mcpServerCount), valueColor: C.value },
      ], C));
      workspaceLines.push(buildGuidanceLine(width, '/mcp', 'inspect trust, quarantine, and risky server posture', C));
      workspaceLines.push(buildGuidanceLine(width, '/communication', 'review blocked lanes and agent message flow', C));
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
