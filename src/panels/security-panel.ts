import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { TokenAuditResult } from '@pellux/goodvibes-sdk/platform/security/token-audit';
import type { UiReadModel, UiSecuritySnapshot } from '../runtime/ui-read-models.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';

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

export class SecurityPanel extends BasePanel {
  private selectedIndex = 0;
  private readonly unsub: (() => void) | null;

  public constructor(private readonly readModel: UiReadModel<UiSecuritySnapshot>) {
    super('security', 'Security', 'U', 'monitoring');
    this.unsub = this.readModel.subscribe(() => this.markDirty());
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    const snapshot = this.readModel.getSnapshot();
    if (key === 'r') {
      this.markDirty();
      return true;
    }
    if (snapshot.audit.results.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(snapshot.audit.results.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
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
    const footerLines = [
      buildGuidanceLine(width, '/policy preflight', 'run a proactive policy review before risky work starts', C),
    ] as const;

    const governanceLines: Line[] = [
      buildPanelLine(width, [
        [' mode ', C.label],
        [view.managed ? 'MANAGED' : 'ADVISORY', managedColor(view.managed)],
        ['  tokens ', C.label],
        [String(view.totalTokens), C.value],
        ['  blocked ', C.label],
        [String(view.blocked.length), view.blocked.length > 0 ? C.error : C.ok],
        ['  scope violations ', C.label],
        [String(view.scopeViolations.length), view.scopeViolations.length > 0 ? C.error : C.ok],
        ['  overdue ', C.label],
        [String(view.rotationOverdue.length), view.rotationOverdue.length > 0 ? C.error : C.ok],
        ['  warnings ', C.label],
        [String(view.rotationWarnings.length), view.rotationWarnings.length > 0 ? C.warn : C.ok],
      ]),
      buildPanelLine(width, [
        [' preflight ', C.label],
        [preflightStatus.toUpperCase(), preflightStatus === 'block' ? C.error : preflightStatus === 'warn' ? C.warn : preflightStatus === 'pass' ? C.ok : C.dim],
        ['  issues ', C.label],
        [String(preflightIssueCount), preflightIssueCount > 0 ? C.warn : C.ok],
        ['  lint ', C.label],
        [String(lintFindingCount), lintFindingCount > 0 ? C.warn : C.ok],
        ['  denied permissions ', C.label],
        [String(snapshot.deniedPermissions), snapshot.deniedPermissions > 0 ? C.warn : C.ok],
      ]),
    ];

    const threatLines: Line[] = [
      buildPanelLine(width, [
        [' quarantined MCP ', C.label],
        [String(quarantinedMcp.length), quarantinedMcp.length > 0 ? C.error : C.ok],
        ['  elevated MCP ', C.label],
        [String(elevatedMcp.length), elevatedMcp.length > 0 ? C.warn : C.ok],
        ['  quarantined plugins ', C.label],
        [String(quarantinedPlugins.length), quarantinedPlugins.length > 0 ? C.error : C.ok],
        ['  untrusted plugins ', C.label],
        [String(untrustedPlugins.length), untrustedPlugins.length > 0 ? C.warn : C.ok],
      ]),
      buildPanelLine(width, [
        ['  incidents ', C.label],
        [String(incidents.length), incidents.length > 0 ? C.warn : C.ok],
      ]),
    ];

    const attackPathLines: Line[] = [
      buildPanelLine(width, [
        ['  attack paths ', C.label],
        [String(attackPathReview.criticalFindings), attackPathReview.criticalFindings > 0 ? C.error : C.ok],
        [' critical ', C.label],
        [String(attackPathReview.incoherentFindings), attackPathReview.incoherentFindings > 0 ? C.warn : C.ok],
        [' review ', C.label],
        [attackPathReview.summary.slice(0, Math.max(0, width - 36)), C.dim],
      ]),
    ];

    if (view.results.length === 0) {
      const emptyLines = [
        ...governanceLines,
        ...threatLines,
        ...buildEmptyState(
          width,
          ' No API tokens are registered with the security auditor yet.',
          'The security control room can already review policy, MCP, plugin, and incident posture, but token-specific scope and rotation audit data has not been registered.',
          [
            { command: '/storage review', summary: 'inspect secure secret storage and environment overrides' },
            { command: '/policy preflight', summary: 'run a live preflight posture review' },
            { command: '/mcp trust', summary: 'inspect active MCP trust and quarantine posture' },
          ],
          C,
        ),
      ];
      if (quarantinedMcp.length > 0) {
        emptyLines.push(buildPanelLine(width, [[' MCP quarantine still active despite no registered tokens.', C.warn]]));
      }
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Security Control Room',
        intro: 'Token audit, policy posture, MCP attack-path review, plugin trust, and incident pressure.',
        sections: [
          { title: 'Governance', lines: emptyLines },
          { title: 'Attack Paths', lines: attackPathLines },
        ],
        footerLines,
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace.slice(0, height);
    }

    this.selectedIndex = Math.min(this.selectedIndex, view.results.length - 1);
    const selected = view.results[this.selectedIndex]!;
    const tokenRows: Line[] = [];
    for (let index = 0; index < view.results.length; index++) {
      const result = view.results[index]!;
      const bg = index === this.selectedIndex ? C.selectBg : undefined;
      tokenRows.push(buildPanelLine(width, [
        [' ', C.label, bg],
        [result.label.padEnd(22), C.value, bg],
        [` ${result.tokenId.padEnd(12)}`, C.info, bg],
        [` ${result.scope.policyId.padEnd(10)}`, C.label, bg],
        [` ${resultSummary(result).slice(0, Math.max(0, width - 49))}`, resultColor(result), bg],
      ]));
    }

    const detailLines: Line[] = [
      buildPanelLine(width, [
        ['  Token: ', C.label],
        [selected.label, C.value],
        ['  Policy: ', C.label],
        [selected.scope.policyId, C.info],
        ['  Blocked: ', C.label],
        [selected.blocked ? 'yes' : 'no', selected.blocked ? C.error : C.ok],
      ]),
      buildPanelLine(width, [
        ['  Scope: ', C.label],
        [selected.scope.outcome, selected.scope.outcome === 'violation' ? C.error : C.ok],
        ['  Excess: ', C.label],
        [(selected.scope.excessScopes.length > 0 ? selected.scope.excessScopes.join(', ') : 'none').slice(0, Math.max(0, width - 27)), selected.scope.excessScopes.length > 0 ? C.error : C.dim],
      ]),
      buildPanelLine(width, [
        ['  Rotation: ', C.label],
        [selected.rotation.outcome, selected.rotation.outcome === 'ok' ? C.ok : selected.rotation.outcome === 'warning' ? C.warn : C.error],
        ['  Due: ', C.label],
        [new Date(selected.rotation.dueAt).toISOString(), C.value],
        ['  Age(d): ', C.label],
        [String(Math.floor(selected.rotation.ageMs / (24 * 60 * 60 * 1000))), C.value],
      ]),
      buildPanelLine(width, [[
        `Last audit: ${view.lastAuditAt ? new Date(view.lastAuditAt).toISOString() : 'never'}  Press r to refresh.`,
        C.dim,
      ]]),
    ];

    if (preflightStatus !== 'n/a') {
      detailLines.push(buildPanelLine(width, [[
        `Policy preflight: ${preflightStatus} (${preflightIssueCount} issue${preflightIssueCount === 1 ? '' : 's'})`.slice(0, width),
        preflightStatus === 'block' ? C.error : preflightStatus === 'warn' ? C.warn : C.dim,
      ]]));
    }
    if (quarantinedMcp.length > 0) {
      const server = quarantinedMcp[0]!;
      detailLines.push(buildPanelLine(width, [[
        `MCP quarantine: ${server.name} ${server.quarantineReason ?? 'unknown'}${server.quarantineDetail ? ` - ${server.quarantineDetail}` : ''}`.slice(0, width),
        C.error,
      ]]));
    }
    if (quarantinedPlugins.length > 0) {
      const plugin = quarantinedPlugins[0]!;
      detailLines.push(buildPanelLine(width, [[
        `Plugin quarantine: ${plugin.name} (${plugin.trustTier})`.slice(0, width),
        C.error,
      ]]));
    } else if (untrustedPlugins.length > 0) {
      const plugin = untrustedPlugins[0]!;
      detailLines.push(buildPanelLine(width, [[
        `Plugin trust warning: ${plugin.name} remains untrusted.`.slice(0, width),
        C.warn,
      ]]));
    }
    if (latestIncident) {
      detailLines.push(buildPanelLine(width, [[
        `Latest incident: ${latestIncident.classification} - ${latestIncident.summary}`.slice(0, width),
        C.warn,
      ]]));
    }
    if (attackPathReview.findings.length > 0) {
      attackPathLines.push(buildPanelLine(width, [[' MCP attack-path review', C.label]]));
      for (const finding of attackPathReview.findings.slice(0, 3)) {
        attackPathLines.push(buildPanelLine(width, [[
          `  ${finding.severity.toUpperCase()} ${finding.serverName}: ${finding.route}`.slice(0, width),
          severityColor(finding.severity),
        ]]));
        attackPathLines.push(buildPanelLine(width, [[
          `    ${finding.reason}`.slice(0, width),
          C.dim,
        ]]));
        attackPathLines.push(buildPanelLine(width, [[
          `    evidence: ${finding.evidence.join(' | ')}`.slice(0, width),
          C.dim,
        ]]));
      }
    }

    const governanceSection: PanelWorkspaceSection = { title: 'Governance', lines: governanceLines };
    const trustSection: PanelWorkspaceSection = { title: 'Policy And Trust', lines: threatLines };
    const selectedSection: PanelWorkspaceSection = { title: 'Selected Token', lines: detailLines };
    const attackPathSection: PanelWorkspaceSection = { title: 'Attack Paths', lines: attackPathLines };
    const tokenAuditSection = resolveScrollablePanelSection(width, height, {
      intro: 'Token audit, policy posture, MCP attack-path review, plugin trust, and incident pressure.',
      footerLines,
      palette: C,
      beforeSections: [governanceSection, trustSection],
      section: {
        title: 'Token Audit',
        scrollableLines: tokenRows,
        selectedIndex: this.selectedIndex,
        scrollOffset: this.selectedIndex,
        minRows: 1,
      },
      afterSections: [selectedSection, attackPathSection],
    });

    const lines = buildPanelWorkspace(width, height, {
      title: 'Security Control Room',
      intro: 'Token audit, policy posture, MCP attack-path review, plugin trust, and incident pressure.',
      sections: [
        governanceSection,
        trustSection,
        tokenAuditSection.section,
        selectedSection,
        attackPathSection,
      ] satisfies readonly PanelWorkspaceSection[],
      footerLines,
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
