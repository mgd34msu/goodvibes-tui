import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';
import type { PolicyRuntimeState } from '../runtime/permissions/policy-runtime.ts';
import type { ForensicsRegistry } from '../runtime/forensics/registry.ts';
import type { ApiTokenAuditor } from '../security/token-audit.ts';
import { buildGuidanceLine, buildKeyValueLine, buildPanelLine, buildPanelWorkspace, buildStatPill, DEFAULT_PANEL_PALETTE, type PanelWorkspaceSection } from './polish.ts';

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
type WorkspaceId = (typeof WORKSPACE_IDS)[number];

export class CockpitPanel extends BasePanel {
  private readonly store?: RuntimeStore;
  private readonly policyState?: PolicyRuntimeState;
  private readonly forensicsRegistry?: ForensicsRegistry;
  private readonly tokenAuditor?: ApiTokenAuditor;
  private readonly storeUnsub: (() => void) | null;
  private readonly policyUnsub: (() => void) | null;
  private readonly forensicsUnsub: (() => void) | null;
  private selectedWorkspaceIndex = 0;

  public constructor(
    store?: RuntimeStore,
    policyState?: PolicyRuntimeState,
    forensicsRegistry?: ForensicsRegistry,
    tokenAuditor?: ApiTokenAuditor,
  ) {
    super('cockpit', 'Cockpit', 'O', 'monitoring');
    this.store = store;
    this.policyState = policyState;
    this.forensicsRegistry = forensicsRegistry;
    this.tokenAuditor = tokenAuditor;
    this.storeUnsub = store ? store.subscribe(() => this.markDirty()) : null;
    this.policyUnsub = policyState ? policyState.subscribe(() => this.markDirty()) : null;
    this.forensicsUnsub = forensicsRegistry ? forensicsRegistry.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.storeUnsub?.();
    this.policyUnsub?.();
    this.forensicsUnsub?.();
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

    if (!this.store) {
      const lines: Line[] = [buildPanelLine(width, [[' Runtime store not wired into this panel yet.', C.empty]])];
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Operator Cockpit',
        sections: [{ lines }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    const state = this.store.getState();
    const runningTasks = [...state.tasks.tasks.values()].filter((task) => task.status === 'running').length;
    const blockedTasks = [...state.tasks.tasks.values()].filter((task) => task.status === 'blocked').length;
    const failedTasks = [...state.tasks.tasks.values()].filter((task) => task.status === 'failed').length;
    const activeGraphs = state.orchestration.activeGraphIds.length;
    const guardTrips = state.orchestration.recursionGuardTrips;
    const blockedMessages = state.communication.totalBlocked;
    const pendingPermissions = state.permissions.awaitingDecision ? 1 : 0;
    const deniedPermissions = state.permissions.denialCount;
    const policySnapshot = this.policyState?.getSnapshot() ?? null;
    const preflightStatus = policySnapshot?.lastPreflightReview?.status ?? 'n/a';
    const preflightIssueCount = policySnapshot?.lastPreflightReview?.issueCount ?? 0;
    const lintFindingCount = policySnapshot?.lintFindings.length ?? 0;
    const tokenAudit = this.tokenAuditor?.auditAll() ?? null;
    const incidentCount = this.forensicsRegistry?.count() ?? 0;
    const latestIncident = this.forensicsRegistry?.latest();
    const elevatedMcp = [...state.mcp.servers.values()].filter((server) => server.trustMode === 'allow-all').length;
    const unhealthyMcp = [...state.mcp.servers.values()].filter((server) => (
      server.status === 'degraded'
      || server.status === 'auth_required'
      || server.status === 'reconnecting'
      || server.status === 'disconnected'
    )).length;
    const erroredPlugins = state.plugins.erroredPluginNames.length;
    const failingIntegrations = [...state.integrations.integrations.values()].filter((record) => record.status === 'error').length;
    const selectedWorkspace = WORKSPACE_IDS[this.selectedWorkspaceIndex] ?? 'flow';

    const flowLines: Line[] = [
      buildPanelLine(width, [
      ...buildStatPill('graphs', String(activeGraphs), C.label, pickColor(activeGraphs, 1, 4)),
      ...buildStatPill('running', String(runningTasks), C.label, C.value),
      ...buildStatPill('blocked', String(blockedTasks), C.label, pickColor(blockedTasks)),
      ...buildStatPill('failed', String(failedTasks), C.label, pickColor(failedTasks)),
      ...buildStatPill('guards', String(guardTrips), C.label, pickColor(guardTrips)),
      ]),
      buildPanelLine(width, [
      ...buildStatPill('blocked comms', String(blockedMessages), C.label, pickColor(blockedMessages)),
      ...buildStatPill('pending approvals', String(pendingPermissions), C.label, pickColor(pendingPermissions)),
      ...buildStatPill('denied', String(deniedPermissions), C.label, pickColor(deniedPermissions)),
      ]),
    ];
    const governanceLines: Line[] = [
      buildPanelLine(width, [
      ...buildStatPill('preflight', String(preflightStatus).toUpperCase(), C.label, preflightStatus === 'block' ? C.bad : preflightStatus === 'warn' ? C.warn : preflightStatus === 'pass' ? C.good : C.dim),
      ...buildStatPill('issues', String(preflightIssueCount), C.label, pickColor(preflightIssueCount)),
      ...buildStatPill('lint', String(lintFindingCount), C.label, pickColor(lintFindingCount)),
      ...buildStatPill('allow-all MCP', String(elevatedMcp), C.label, pickColor(elevatedMcp)),
      ...buildStatPill('unhealthy MCP', String(unhealthyMcp), C.label, pickColor(unhealthyMcp)),
      ]),
      buildPanelLine(width, [
      ...buildStatPill('token blocked', String(tokenAudit?.blocked.length ?? 0), C.label, pickColor(tokenAudit?.blocked.length ?? 0)),
      ...buildStatPill('overdue', String(tokenAudit?.rotationOverdue.length ?? 0), C.label, pickColor(tokenAudit?.rotationOverdue.length ?? 0)),
      ...buildStatPill('scope violations', String(tokenAudit?.scopeViolations.length ?? 0), C.label, pickColor(tokenAudit?.scopeViolations.length ?? 0)),
      ...buildStatPill('warnings', String(tokenAudit?.rotationWarnings.length ?? 0), C.label, pickColor(tokenAudit?.rotationWarnings.length ?? 0)),
      ]),
    ];
    const healthLines: Line[] = [
      buildPanelLine(width, [
      ...buildStatPill('incidents', String(incidentCount), C.label, pickColor(incidentCount)),
      ...buildStatPill('plugins', String(erroredPlugins), C.label, pickColor(erroredPlugins)),
      ...buildStatPill('integrations', String(failingIntegrations), C.label, pickColor(failingIntegrations)),
      ]),
    ];
    if (latestIncident) {
      healthLines.push(buildPanelLine(width, [
        [' latest incident ', C.label],
        [latestIncident.classification, C.bad],
        ['  ', C.label],
        [latestIncident.summary.slice(0, Math.max(0, width - 19 - latestIncident.classification.length)), C.dim],
      ]));
    }
    const domainLines: Line[] = [buildPanelLine(width, [[
      `tasks:${state.tasks.tasks.size} agents:${state.agents.agents.size} graphs:${state.orchestration.totalGraphs} comms:${state.communication.records.size} mcp:${state.mcp.servers.size} plugins:${state.plugins.plugins.size}`,
      C.dim,
    ]])];
    const workspaceLines: Line[] = [];
    if (selectedWorkspace === 'flow') {
      workspaceLines.push(buildKeyValueLine(width, [
        { label: 'running', value: String(runningTasks), valueColor: C.value },
        { label: 'blocked', value: String(blockedTasks), valueColor: pickColor(blockedTasks) },
        { label: 'graphs', value: String(activeGraphs), valueColor: pickColor(activeGraphs, 1, 4) },
      ], C));
      workspaceLines.push(buildGuidanceLine(width, '/orchestration', 'inspect graph state, retries, and subtree controls', C));
      workspaceLines.push(buildGuidanceLine(width, '/tasks', 'review active task pressure and task-specific output', C));
    } else if (selectedWorkspace === 'governance') {
      workspaceLines.push(buildKeyValueLine(width, [
        { label: 'preflight', value: String(preflightStatus).toUpperCase(), valueColor: preflightStatus === 'block' ? C.bad : preflightStatus === 'warn' ? C.warn : preflightStatus === 'pass' ? C.good : C.dim },
        { label: 'lint', value: String(lintFindingCount), valueColor: pickColor(lintFindingCount) },
        { label: 'allow-all mcp', value: String(elevatedMcp), valueColor: pickColor(elevatedMcp) },
      ], C));
      workspaceLines.push(buildGuidanceLine(width, '/policy', 'run simulation, preflight, and bundle review', C));
      workspaceLines.push(buildGuidanceLine(width, '/security', 'inspect trust, tokens, quarantines, and incident pressure', C));
    } else if (selectedWorkspace === 'health') {
      workspaceLines.push(buildKeyValueLine(width, [
        { label: 'incidents', value: String(incidentCount), valueColor: pickColor(incidentCount) },
        { label: 'plugins', value: String(erroredPlugins), valueColor: pickColor(erroredPlugins) },
        { label: 'integrations', value: String(failingIntegrations), valueColor: pickColor(failingIntegrations) },
      ], C));
      workspaceLines.push(buildGuidanceLine(width, '/incident latest', 'inspect the latest incident bundle and replay fallout', C));
      workspaceLines.push(buildGuidanceLine(width, '/plugins', 'review errored plugins and provenance posture', C));
    } else {
      workspaceLines.push(buildKeyValueLine(width, [
        { label: 'tasks', value: String(state.tasks.tasks.size), valueColor: C.value },
        { label: 'comms', value: String(state.communication.records.size), valueColor: C.value },
        { label: 'mcp', value: String(state.mcp.servers.size), valueColor: C.value },
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
