import type { Cell, Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';
import type { PolicyRuntimeState } from '../runtime/permissions/policy-runtime.ts';
import type { ForensicsRegistry } from '../runtime/forensics/registry.ts';
import type { ApiTokenAuditor } from '../security/token-audit.ts';

const C = {
  header: '#cbd5e1',
  headerBg: '#0f172a',
  label: '#94a3b8',
  value: '#e2e8f0',
  good: '#22c55e',
  warn: '#f59e0b',
  bad: '#ef4444',
  dim: '#475569',
  empty: '#334155',
} as const;

function buildLine(width: number, segments: Array<[string, string, string?]>): Line {
  const cells: Cell[] = [];
  for (const [text, fg, bg] of segments) {
    const style = { fg, bg: bg ?? '' };
    for (const ch of text) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, style));
    }
  }
  while (cells.length < width) cells.push(createStyledCell(' ', { fg: '' }));
  return cells.slice(0, width);
}

function pickColor(value: number, warnAt = 1, badAt = 3): string {
  if (value >= badAt) return C.bad;
  if (value >= warnAt) return C.warn;
  return C.good;
}

export class CockpitPanel extends BasePanel {
  private readonly store?: RuntimeStore;
  private readonly policyState?: PolicyRuntimeState;
  private readonly forensicsRegistry?: ForensicsRegistry;
  private readonly tokenAuditor?: ApiTokenAuditor;
  private readonly storeUnsub: (() => void) | null;
  private readonly policyUnsub: (() => void) | null;
  private readonly forensicsUnsub: (() => void) | null;

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

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const lines: Line[] = [];
    lines.push(buildLine(width, [[' Operator Cockpit', C.header, C.headerBg]]));

    if (!this.store) {
      lines.push(buildLine(width, [[' Runtime store not wired into this panel yet.', C.empty]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
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

    lines.push(buildLine(width, [
      [' active graphs ', C.label],
      [String(activeGraphs), pickColor(activeGraphs, 1, 4)],
      ['  running tasks ', C.label],
      [String(runningTasks), C.value],
      ['  blocked tasks ', C.label],
      [String(blockedTasks), pickColor(blockedTasks)],
      ['  failed tasks ', C.label],
      [String(failedTasks), pickColor(failedTasks)],
    ]));
    lines.push(buildLine(width, [
      [' recursion guards ', C.label],
      [String(guardTrips), pickColor(guardTrips)],
      ['  blocked comms ', C.label],
      [String(blockedMessages), pickColor(blockedMessages)],
      ['  pending permissions ', C.label],
      [String(pendingPermissions), pickColor(pendingPermissions)],
      ['  denied permissions ', C.label],
      [String(deniedPermissions), pickColor(deniedPermissions)],
    ]));
    lines.push(buildLine(width, [
      [' policy preflight ', C.label],
      [String(preflightStatus).toUpperCase(), preflightStatus === 'block' ? C.bad : preflightStatus === 'warn' ? C.warn : preflightStatus === 'pass' ? C.good : C.dim],
      ['  preflight issues ', C.label],
      [String(preflightIssueCount), pickColor(preflightIssueCount)],
      ['  lint findings ', C.label],
      [String(lintFindingCount), pickColor(lintFindingCount)],
    ]));
    lines.push(buildLine(width, [
      [' token blocked ', C.label],
      [String(tokenAudit?.blocked.length ?? 0), pickColor(tokenAudit?.blocked.length ?? 0)],
      ['  token overdue ', C.label],
      [String(tokenAudit?.rotationOverdue.length ?? 0), pickColor(tokenAudit?.rotationOverdue.length ?? 0)],
      ['  token scope violations ', C.label],
      [String(tokenAudit?.scopeViolations.length ?? 0), pickColor(tokenAudit?.scopeViolations.length ?? 0)],
      ['  token warnings ', C.label],
      [String(tokenAudit?.rotationWarnings.length ?? 0), pickColor(tokenAudit?.rotationWarnings.length ?? 0)],
    ]));
    lines.push(buildLine(width, [
      [' allow-all MCP ', C.label],
      [String(elevatedMcp), pickColor(elevatedMcp)],
      ['  unhealthy MCP ', C.label],
      [String(unhealthyMcp), pickColor(unhealthyMcp)],
      ['  incidents ', C.label],
      [String(incidentCount), pickColor(incidentCount)],
      ['  errored plugins ', C.label],
      [String(erroredPlugins), pickColor(erroredPlugins)],
      ['  failing integrations ', C.label],
      [String(failingIntegrations), pickColor(failingIntegrations)],
    ]));
    if (latestIncident) {
      lines.push(buildLine(width, [
        [' latest incident ', C.label],
        [latestIncident.classification, C.bad],
        ['  ', C.label],
        [latestIncident.summary.slice(0, Math.max(0, width - 19 - latestIncident.classification.length)), C.dim],
      ]));
    }
    lines.push(buildLine(width, [[' Domains', C.label]]));
    lines.push(buildLine(width, [[
      `tasks:${state.tasks.tasks.size} agents:${state.agents.agents.size} graphs:${state.orchestration.totalGraphs} comms:${state.communication.records.size} mcp:${state.mcp.servers.size} plugins:${state.plugins.plugins.size}`,
      C.dim,
    ]]));
    lines.push(buildLine(width, [[
      'Use /cockpit for this view, /orchestration for graph controls, /policy for simulation, /mcp for trust, and /hooks for execution visibility.',
      C.dim,
    ]]));

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
