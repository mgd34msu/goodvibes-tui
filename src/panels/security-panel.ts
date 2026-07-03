import type { Line } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { TokenAuditResult } from '@pellux/goodvibes-sdk/platform/security';
import type { UiReadModel, UiSecuritySnapshot } from '../runtime/ui-read-models.ts';
import {
  buildAlignedRow,
  buildEmptyState,
  buildGuidanceLine,
  buildPanelLine,
  buildPanelWorkspace,
  buildStatusPill,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import { createEmptyLine } from '../types/grid.ts';
import type { PanelIntegrationContext } from './types.ts';

// Base chrome only — title band, state colors, and text tokens all come
// straight from DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

function managedColor(managed: boolean): string {
  return managed ? C.warn : C.info;
}

function resultColor(result: TokenAuditResult): string {
  if (result.blocked) return C.bad;
  if (result.scope.outcome === 'violation') return C.bad;
  if (result.rotation.outcome === 'overdue') return C.bad;
  if (result.rotation.outcome === 'warning') return C.warn;
  return C.good;
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
      return C.bad;
    case 'medium':
      return C.warn;
    case 'low':
    default:
      return C.good;
  }
}

// Relative-time formatting for audit/rotation timestamps — humanized instead
// of raw ISO strings (WO-137). Mirrors the fmtAgo pattern already used by
// approval-panel.ts / debug-panel.ts / communication-panel.ts.
function fmtAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function fmtDue(msUntilDue: number): string {
  const overdue = msUntilDue < 0;
  const sec = Math.floor(Math.abs(msUntilDue) / 1000);
  const unit = sec < 3600
    ? `${Math.max(1, Math.floor(sec / 60))}m`
    : sec < 86400
      ? `${Math.floor(sec / 3600)}h`
      : `${Math.floor(sec / 86400)}d`;
  return overdue ? `overdue by ${unit}` : `in ${unit}`;
}

// Attack-path finding rows: 3 rendered lines each (severity/route, reason,
// evidence). Bounds the per-render window to the panel's actual height
// instead of a fixed "3 findings" cap, and pages through the rest via
// attackPathScroll ('[' / ']').
const ATTACK_PATH_FINDING_LINES = 3;

export class SecurityPanel extends ScrollableListPanel<TokenAuditResult> {
  private readonly unsub: (() => void) | null;
  /** Scroll offset into attackPathReview.findings (in finding units, not lines). */
  private attackPathScroll = 0;
  /** Set by 'f'; consumed by handlePanelIntegrationAction to dispatch /policy preflight. */
  private pendingPreflight = false;
  /** Set by 'i'; consumed by handlePanelIntegrationAction to jump to the incident panel. */
  private pendingIncidentJump = false;

  public constructor(private readonly readModel: UiReadModel<UiSecuritySnapshot>) {
    super('security', 'Security', '▬', 'security-policy');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter tokens';
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
    return buildAlignedRow(
      width,
      [
        { text: result.label, fg: C.value },
        { text: result.tokenId, fg: C.info },
        { text: result.scope.policyId, fg: C.label },
        { text: resultSummary(result), fg: resultColor(result) },
      ],
      [
        { width: 22 },
        { width: 12 },
        { width: 10 },
        { width: Math.max(8, width - 50) },
      ],
      { selected, selectedBg: C.selectBg },
    );
  }

  public handleInput(key: string): boolean {
    if (!this.filterActive && key === 'r') {
      // Real re-audit: force the read model to recompute (ApiTokenAuditor.auditAll
      // under the hood) right now instead of waiting on the next incidental
      // render, so lastAuditAt visibly advances the instant 'r' is pressed.
      this.readModel.getSnapshot();
      this.markDirty();
      return true;
    }
    if (!this.filterActive && key === 'f') {
      this.pendingPreflight = true;
      this.markDirty();
      return true;
    }
    if (!this.filterActive && key === 'i') {
      if (!this.readModel.getSnapshot().latestIncident) return false;
      this.pendingIncidentJump = true;
      this.markDirty();
      return true;
    }
    if (!this.filterActive && key === '[') {
      this.attackPathScroll = Math.max(0, this.attackPathScroll - 1);
      this.markDirty();
      return true;
    }
    if (!this.filterActive && key === ']') {
      this.attackPathScroll += 1;
      this.markDirty();
      return true;
    }
    return super.handleInput(key);
  }

  /**
   * f (preflight) and i (jump to incident) both require the integration
   * context (executeCommand / panelManager), which is only available here —
   * same staged-pending-action pattern as worktree-panel.ts and
   * incident-review-panel.ts.
   */
  public handlePanelIntegrationAction(_key: string, ctx: PanelIntegrationContext): boolean {
    if (this.pendingPreflight) {
      this.pendingPreflight = false;
      if (!ctx.executeCommand) return false;
      void ctx.executeCommand('policy', ['preflight']).catch(() => { /* surfaced via /policy output */ });
      return true;
    }
    if (this.pendingIncidentJump) {
      this.pendingIncidentJump = false;
      ctx.panelManager.open('incident');
      return true;
    }
    return false;
  }

  protected override filterMatches(result: TokenAuditResult, q: string): boolean {
    return result.label.toLowerCase().includes(q)
      || result.scope.policyId.toLowerCase().includes(q)
      || result.tokenId.toLowerCase().includes(q);
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
        [truncateDisplay(attackPathReview.summary, Math.max(0, width - 36)), C.dim],
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
      // Fully scrollable — no fixed "3 findings" cap. The visible window
      // scales with the panel's actual height; '[' / ']' page through the
      // rest when there are more findings than currently fit.
      const windowSize = Math.max(1, Math.floor((height - 16) / ATTACK_PATH_FINDING_LINES));
      const maxScroll = Math.max(0, attackPathReview.findings.length - windowSize);
      this.attackPathScroll = Math.min(this.attackPathScroll, maxScroll);
      const start = this.attackPathScroll;
      const end = Math.min(attackPathReview.findings.length, start + windowSize);
      for (const finding of attackPathReview.findings.slice(start, end)) {
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
      if (attackPathReview.findings.length > windowSize) {
        attackPathLines.push(buildPanelLine(width, [[
          `  showing ${start + 1}-${end} of ${attackPathReview.findings.length} findings ([ / ] to scroll)`,
          C.dim,
        ]]));
      }
    }

    // Column header for the token audit list so the aligned columns are legible.
    const listHeader: Line[] = [
      ...governanceLines,
      buildAlignedRow(
        width,
        [
          { text: 'TOKEN LABEL', fg: C.label, bold: true },
          { text: 'TOKEN ID', fg: C.label, bold: true },
          { text: 'POLICY', fg: C.label, bold: true },
          { text: `STATUS (${view.results.length} audited)`, fg: C.label, bold: true },
        ],
        [
          { width: 22 },
          { width: 12 },
          { width: 10 },
          { width: Math.max(8, width - 50) },
        ],
        {},
      ),
    ];

    // Detail must track the filtered view the list highlights, not the raw
    // audit results — under an applied token filter they diverge.
    const selected = this.getSelectedItem();
    const detailLines: Line[] = [];
    if (selected) {
      detailLines.push(buildPanelLine(width, [
        ['  Token: ', C.label],
        [selected.label, C.value],
        ['  Policy: ', C.label],
        [selected.scope.policyId, C.info],
        ['  Blocked: ', C.label],
        [selected.blocked ? 'yes' : 'no', selected.blocked ? C.bad : C.good],
      ]));
      detailLines.push(buildPanelLine(width, [
        ['  Scope: ', C.label],
        [selected.scope.outcome, selected.scope.outcome === 'violation' ? C.bad : C.good],
        ['  Excess: ', C.label],
        [truncateDisplay(selected.scope.excessScopes.length > 0 ? selected.scope.excessScopes.join(', ') : 'none', Math.max(0, width - 27)), selected.scope.excessScopes.length > 0 ? C.bad : C.dim],
      ]));
      detailLines.push(buildPanelLine(width, [
        ['  Rotation: ', C.label],
        [selected.rotation.outcome, selected.rotation.outcome === 'ok' ? C.good : selected.rotation.outcome === 'warning' ? C.warn : C.bad],
        ['  Due: ', C.label],
        [fmtDue(selected.rotation.msUntilDue), selected.rotation.msUntilDue < 0 ? C.bad : C.value],
        ['  Age(d): ', C.label],
        [String(Math.floor(selected.rotation.ageMs / (24 * 60 * 60 * 1000))), C.value],
      ]));
      detailLines.push(buildPanelLine(width, [[
        `Last audit: ${view.lastAuditAt ? fmtAgo(view.lastAuditAt) : 'never'}  Press r to refresh.`,
        C.dim,
      ]]));
      if (preflightStatus !== 'n/a') {
        detailLines.push(buildPanelLine(width, [[
          truncateDisplay(`Policy preflight: ${preflightStatus} (${preflightIssueCount} issue${preflightIssueCount === 1 ? '' : 's'})`, width),
          preflightStatus === 'block' ? C.bad : preflightStatus === 'warn' ? C.warn : C.dim,
        ]]));
      }
      if (quarantinedMcp.length > 0) {
        const server = quarantinedMcp[0]!;
        detailLines.push(buildPanelLine(width, [[
          truncateDisplay(`MCP quarantine: ${server.name} ${server.quarantineReason ?? 'unknown'}${server.quarantineDetail ? ` - ${server.quarantineDetail}` : ''}`, width),
          C.bad,
        ]]));
      }
      if (quarantinedPlugins.length > 0) {
        const plugin = quarantinedPlugins[0]!;
        detailLines.push(buildPanelLine(width, [[
          truncateDisplay(`Plugin quarantine: ${plugin.name} (${plugin.trustTier})`, width),
          C.bad,
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

    const hints = this.filterActive
      ? [
          { keys: 'type', label: 'filter tokens' },
          { keys: 'Enter', label: 'apply' },
          { keys: 'Esc', label: 'clear' },
        ]
      : [
          { keys: '↑/↓', label: 'select token' },
          { keys: '/', label: 'filter' },
          { keys: 'r', label: 'refresh audit' },
          { keys: 'f', label: 'preflight' },
          ...(latestIncident ? [{ keys: 'i', label: 'jump to incident' }] : []),
          ...(attackPathReview.findings.length > 0 ? [{ keys: '[ / ]', label: 'scroll attack paths' }] : []),
        ];

    return this.renderList(width, height, {
      title: 'Security Control Room',
      header: listHeader,
      footer: [
        ...detailLines,
        ...attackPathLines,
        footerLine,
      ],
      hints,
    });
  }
}
