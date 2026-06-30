import type { Line } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { TokenAuditResult } from '@pellux/goodvibes-sdk/platform/security';
import type { UiReadModel, UiSecuritySnapshot } from '../runtime/ui-read-models.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildPanelLine,
  buildPanelWorkspace,
  buildStatusPill,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import { createEmptyLine } from '../types/grid.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#94a3b8',
  headerBg: '#1e293b',
  dim: '#475569',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
  selectBg: '#0f172a',
} as const;

function managedColor(managed: boolean): string {
  return managed ? C.warn : C.info;
}

function resultColor(result: TokenAuditResult): string {
  if (result.blocked) return C.error;
  if (result.scope.outcome === 'violation') return C.error;
  if (result.rotation.outcome === 'overdue') return C.error;
  if (result.rotation.outcome === 'warning') return C.warn;
  return C.ok;
}

function resultSummary(result: TokenAuditResult): string {
  const parts: string[] = [];
  if (result.scope.outcome === 'violation') parts.push(`scope:${result.scope.excessScopes.join(',')}`);
  if (result.rotation.outcome === 'warning') parts.push('rotation warning');
  if (result.rotation.outcome === 'overdue') parts.push('rotation overdue');
  if (result.blocked) parts.push('blocked');
  return parts.length > 0 ? parts.join(' | ') : 'in policy';
}

function severityColor(severity: 'low' | 'medium' | 'high' | 'critical'): string {
  switch (severity) {
    case 'critical':
    case 'high':
      return C.error;
    case 'medium':
      return C.warn;
    case 'low':
    default:
      return C.ok;
  }
}

export class SecurityPanel extends ScrollableListPanel<TokenAuditResult> {
  private readonly unsub: (() => void) | null;

  public constructor(private readonly readModel: UiReadModel<UiSecuritySnapshot>) {
    super('security', 'Security', 'U', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.unsub = this.readModel.subscribe(() => this.markDirty());
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  protected override getPalette() { return C; }
  protected override getEmptyStateMessage() { return ' No API tokens are registered with the security auditor yet.'; }
  protected override getEmptyStateActions() {
    return [
      { command: '/storage review', summary: 'inspect secure secret storage and environment overrides' },
      { command: '/policy preflight', summary: 'run a live preflight posture review' },
      { command: '/mcp trust', summary: 'inspect active MCP trust and quarantine posture' },
    ];
  }

  protected getItems(): readonly TokenAuditResult[] {
    return this.readModel.getSnapshot().audit.results;
  }

  protected renderItem(result: TokenAuditResult, index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [result.label.padEnd(22), C.value, bg],
      [` ${result.tokenId.padEnd(12)}`, C.info, bg],
      [` ${result.scope.policyId.padEnd(10)}`, C.label, bg],
      [` ${resultSummary(result).slice(0, Math.max(0, width - 49))}`, resultColor(result), bg],
    ]);
  }

  public handleInput(key: string): boolean {
    if (key === 'r') {
      this.markDirty();
      return true;
    }
    return super.handleInput(key);
  }

  public render(width: number, height: number): Line[] {
    this.clampSelection();
    const snapshot = this.readModel.getSnapshot();
    const view = snapshot.audit;
    const preflightStatus = snapshot.policy.preflightStatus;
    const preflightIssueCount = snapshot.policy.preflightIssueCount;
    const lintFindingCount = snapshot.policy.lintFindingCount;
    const quarantinedMcp = snapshot.mcpServers.filter((server) => server.schemaFreshness === 'quarantined');
    const elevatedMcp = snapshot.mcpServers.filter((server) => server.trustMode === 'allow-all');
    const incidents = snapshot.incidents;
    const latestIncident = snapshot.latestIncident;
    const quarantinedPlugins = snapshot.quarantinedPlugins;
    const untrustedPlugins = snapshot.untrustedPlugins;
    const attackPathReview = snapshot.attackPathReview;
    const intro = 'Token audit, policy posture, MCP attack-path review, plugin trust, and incident pressure.';
    const footerLine = buildGuidanceLine(width, '/policy preflight', 'run a proactive policy review before risky work starts', C);

    const governanceLines: Line[] = [
      buildPanelLine(width, [
        [' mode ', C.label],
        [view.managed ? 'MANAGED' : 'ADVISORY', managedColor(view.managed)],
        ['  tokens ', C.label],
        [String(view.totalTokens), C.value],
        ['  blocked ', C.label],
        ...buildStatusPill(view.blocked.length > 0 ? 'bad' : 'good', String(view.blocked.length)),
        ['  scope violations ', C.label],
        ...buildStatusPill(view.scopeViolations.length > 0 ? 'bad' : 'good', String(view.scopeViolations.length)),
        ['  overdue ', C.label],
        ...buildStatusPill(view.rotationOverdue.length > 0 ? 'bad' : 'good', String(view.rotationOverdue.length)),
        ['  warnings ', C.label],
        ...buildStatusPill(view.rotationWarnings.length > 0 ? 'warn' : 'good', String(view.rotationWarnings.length)),
      ]),
      buildPanelLine(width, [
        [' preflight ', C.label],
        ...buildStatusPill(preflightStatus === 'block' ? 'bad' : preflightStatus === 'warn' ? 'warn' : preflightStatus === 'pass' ? 'good' : 'info', preflightStatus.toUpperCase()),
        ['  issues ', C.label],
        ...buildStatusPill(preflightIssueCount > 0 ? 'warn' : 'good', String(preflightIssueCount)),
        ['  lint ', C.label],
        ...buildStatusPill(lintFindingCount > 0 ? 'warn' : 'good', String(lintFindingCount)),
        ['  denied permissions ', C.label],
        ...buildStatusPill(snapshot.deniedPermissions > 0 ? 'warn' : 'good', String(snapshot.deniedPermissions)),
      ]),
      buildPanelLine(width, [
        [' quarantined MCP ', C.label],
        ...buildStatusPill(quarantinedMcp.length > 0 ? 'bad' : 'good', String(quarantinedMcp.length)),
        ['  elevated MCP ', C.label],
        ...buildStatusPill(elevatedMcp.length > 0 ? 'warn' : 'good', String(elevatedMcp.length)),
        ['  quarantined plugins ', C.label],
        ...buildStatusPill(quarantinedPlugins.length > 0 ? 'bad' : 'good', String(quarantinedPlugins.length)),
        ['  untrusted plugins ', C.label],
        ...buildStatusPill(untrustedPlugins.length > 0 ? 'warn' : 'good', String(untrustedPlugins.length)),
      ]),
      buildPanelLine(width, [
        ['  incidents ', C.label],
        ...buildStatusPill(incidents.length > 0 ? 'warn' : 'good', String(incidents.length)),
      ]),
    ];

    const attackPathLines: Line[] = [
      buildPanelLine(width, [
        ['  attack paths ', C.label],
        ...buildStatusPill(attackPathReview.criticalFindings > 0 ? 'bad' : 'good', String(attackPathReview.criticalFindings)),
        [' critical ', C.label],
        ...buildStatusPill(attackPathReview.incoherentFindings > 0 ? 'warn' : 'good', String(attackPathReview.incoherentFindings)),
        [' review ', C.label],
        [attackPathReview.summary.slice(0, Math.max(0, width - 36)), C.dim],
      ]),
    ];

    // Empty state: no token results yet — show governance + threat posture before base empty state
    if (view.results.length === 0) {
      const emptyStateLines = [
        ...governanceLines,
        ...buildEmptyState(
          width,
          this.getEmptyStateMessage(),
          'The security control room can already review policy, MCP, plugin, and incident posture, but token-specific scope and rotation audit data has not been registered.',
          this.getEmptyStateActions(),
          C,
        ),
      ];
      if (quarantinedMcp.length > 0) {
        emptyStateLines.push(buildPanelLine(width, [[' MCP quarantine still active despite no registered tokens.', C.warn]]));
      }
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Security Control Room',
        intro,
        sections: [
          { title: 'Governance', lines: emptyStateLines },
          { title: 'Attack Paths', lines: attackPathLines },
        ],
        footerLines: [footerLine],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace.slice(0, height);
    }

    if (attackPathReview.findings.length > 0) {
      attackPathLines.push(buildPanelLine(width, [[' MCP attack-path review', C.label]]));
      for (const finding of attackPathReview.findings.slice(0, 3)) {
        attackPathLines.push(buildPanelLine(width, [[
          truncateDisplay(`  ${finding.severity.toUpperCase()} ${finding.serverName}: ${finding.route}`, width),
          severityColor(finding.severity),
        ]]));
        attackPathLines.push(buildPanelLine(width, [[
          truncateDisplay(`    ${finding.reason}`, width),
          C.dim,
        ]]));
        attackPathLines.push(buildPanelLine(width, [[
          truncateDisplay(`    evidence: ${finding.evidence.join(' | ')}`, width),
          C.dim,
        ]]));
      }
    }

    const selected = view.results[this.selectedIndex];
    const detailLines: Line[] = [];
    if (selected) {
      detailLines.push(buildPanelLine(width, [
        ['  Token: ', C.label],
        [selected.label, C.value],
        ['  Policy: ', C.label],
        [selected.scope.policyId, C.info],
        ['  Blocked: ', C.label],
        [selected.blocked ? 'yes' : 'no', selected.blocked ? C.error : C.ok],
      ]));
      detailLines.push(buildPanelLine(width, [
        ['  Scope: ', C.label],
        [selected.scope.outcome, selected.scope.outcome === 'violation' ? C.error : C.ok],
        ['  Excess: ', C.label],
        [truncateDisplay(selected.scope.excessScopes.length > 0 ? selected.scope.excessScopes.join(', ') : 'none', Math.max(0, width - 27)), selected.scope.excessScopes.length > 0 ? C.error : C.dim],
      ]));
      detailLines.push(buildPanelLine(width, [
        ['  Rotation: ', C.label],
        [selected.rotation.outcome, selected.rotation.outcome === 'ok' ? C.ok : selected.rotation.outcome === 'warning' ? C.warn : C.error],
        ['  Due: ', C.label],
        [new Date(selected.rotation.dueAt).toISOString(), C.value],
        ['  Age(d): ', C.label],
        [String(Math.floor(selected.rotation.ageMs / (24 * 60 * 60 * 1000))), C.value],
      ]));
      detailLines.push(buildPanelLine(width, [[
        `Last audit: ${view.lastAuditAt ? new Date(view.lastAuditAt).toISOString() : 'never'}  Press r to refresh.`,
        C.dim,
      ]]));
      if (preflightStatus !== 'n/a') {
        detailLines.push(buildPanelLine(width, [[
          truncateDisplay(`Policy preflight: ${preflightStatus} (${preflightIssueCount} issue${preflightIssueCount === 1 ? '' : 's'})`, width),
          preflightStatus === 'block' ? C.error : preflightStatus === 'warn' ? C.warn : C.dim,
        ]]));
      }
      if (quarantinedMcp.length > 0) {
        const server = quarantinedMcp[0]!;
        detailLines.push(buildPanelLine(width, [[
          truncateDisplay(`MCP quarantine: ${server.name} ${server.quarantineReason ?? 'unknown'}${server.quarantineDetail ? ` - ${server.quarantineDetail}` : ''}`, width),
          C.error,
        ]]));
      }
      if (quarantinedPlugins.length > 0) {
        const plugin = quarantinedPlugins[0]!;
        detailLines.push(buildPanelLine(width, [[
          truncateDisplay(`Plugin quarantine: ${plugin.name} (${plugin.trustTier})`, width),
          C.error,
        ]]));
      } else if (untrustedPlugins.length > 0) {
        const plugin = untrustedPlugins[0]!;
        detailLines.push(buildPanelLine(width, [[
          truncateDisplay(`Plugin trust warning: ${plugin.name} remains untrusted.`, width),
          C.warn,
        ]]));
      }
      if (latestIncident) {
        detailLines.push(buildPanelLine(width, [[
          truncateDisplay(`Latest incident: ${latestIncident.classification} - ${latestIncident.summary}`, width),
          C.warn,
        ]]));
      }
    }

    return this.renderList(width, height, {
      title: 'Security Control Room',
      header: governanceLines,
      footer: [
        ...detailLines,
        ...attackPathLines,
        footerLine,
      ],
    });
  }
}
