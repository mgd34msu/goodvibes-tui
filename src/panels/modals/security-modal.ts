import { MODAL_TONES } from './modal-theme.ts';
import { infoRow } from './modal-surface-helpers.ts';
import type { TokenAuditResult } from '@pellux/goodvibes-sdk/platform/security';
import type { ModalSectionStyle } from '../../renderer/modal-factory.ts';
import type { UiReadModel, UiSecuritySnapshot } from '../../runtime/ui-read-models.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalTab,
  ConfigModalView,
} from '../../input/config-modal-types.ts';

// ---------------------------------------------------------------------------
// Security → config-modal surface (group-B port). Two tabs: 'Tokens' (the
// token scope/rotation audit list under the governance summary) and
// 'Governance' (policy preflight, MCP/plugin quarantine, latest incident, and
// the MCP attack-path review). Read-model-backed, so refresh() is a no-op,
// buildView reads getSnapshot() fresh every render. 'f' (preflight) routes to
// its `/policy preflight` command path; 'i' jumps to the incident surface
// (fleet) via the command path. Selection-blind port: the panel's
// selected-token scope/rotation detail is folded into each token row label.
// Determinism: absolute ISO timestamps (never Date.now()).
// ---------------------------------------------------------------------------

export interface SecurityModalDeps {
  readonly readModel: UiReadModel<UiSecuritySnapshot>;
}

const BAD: ModalSectionStyle = { fg: MODAL_TONES.bad };
const WARN: ModalSectionStyle = { fg: MODAL_TONES.warn };
const MAX_FINDINGS_SHOWN = 5;

function resultColor(result: TokenAuditResult): ModalSectionStyle | undefined {
  if (result.blocked) return BAD;
  if (result.scope.outcome === 'violation') return BAD;
  if (result.rotation.outcome === 'overdue') return BAD;
  if (result.rotation.outcome === 'warning') return WARN;
  return undefined;
}

function resultSummary(result: TokenAuditResult): string {
  const parts: string[] = [];
  if (result.scope.outcome === 'violation') parts.push(`scope:${result.scope.excessScopes.join(',')}`);
  if (result.rotation.outcome === 'warning') parts.push('rotation warning');
  if (result.rotation.outcome === 'overdue') parts.push('rotation overdue');
  if (result.blocked) parts.push('blocked');
  return parts.length > 0 ? parts.join(' | ') : 'in policy';
}

function fmtDue(msUntilDue: number): string {
  const overdue = msUntilDue < 0;
  const sec = Math.floor(Math.abs(msUntilDue) / 1000);
  const unit = sec < 3600 ? `${Math.max(1, Math.floor(sec / 60))}m` : sec < 86400 ? `${Math.floor(sec / 3600)}h` : `${Math.floor(sec / 86400)}d`;
  return overdue ? `overdue by ${unit}` : `in ${unit}`;
}

function fmtIso(ts: number | null | undefined): string {
  return ts === null || ts === undefined ? 'never' : new Date(ts).toISOString();
}

function findingColor(severity: string): ModalSectionStyle | undefined {
  return severity === 'critical' || severity === 'high' ? BAD : severity === 'medium' ? WARN : undefined;
}

class SecurityModalSurface implements ConfigModalSurface {
  readonly name = 'security-modal';
  readonly title = 'Security Control Room';
  private requestRender: () => void = () => {};
  private unsub: (() => void) | null = null;

  constructor(private readonly deps: SecurityModalDeps) {}

  readonly actions = [
    { key: 'f', id: 'preflight', label: 'preflight' },
    { key: 'i', id: 'jumpToIncident', label: 'jump to incident', enabledFor: () => Boolean(this.deps.readModel.getSnapshot().latestIncident) },
    { key: 'd', id: 'manageDevices', label: 'manage devices' },
    { key: 'r', id: 'refresh', label: 'refresh audit' },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    if (!this.unsub) this.unsub = this.deps.readModel.subscribe(() => this.requestRender());
  }

  onClose(): void { this.unsub?.(); this.unsub = null; }

  private governanceHeader(snapshot: UiSecuritySnapshot): string[] {
    const audit = snapshot.audit;
    const quarantinedMcp = snapshot.mcpServers.filter((s) => s.schemaFreshness === 'quarantined');
    const elevatedMcp = snapshot.mcpServers.filter((s) => s.trustMode === 'allow-all');
    return [
      `mode ${audit.managed ? 'MANAGED' : 'ADVISORY'}  tokens ${audit.totalTokens}  blocked ${audit.blocked.length}  scope violations ${audit.scopeViolations.length}  overdue ${audit.rotationOverdue.length}  warnings ${audit.rotationWarnings.length}`,
      `preflight ${snapshot.policy.preflightStatus.toUpperCase()}  issues ${snapshot.policy.preflightIssueCount}  lint ${snapshot.policy.lintFindingCount}  denied permissions ${snapshot.deniedPermissions}`,
      `quarantined MCP ${quarantinedMcp.length}  elevated MCP ${elevatedMcp.length}  quarantined plugins ${snapshot.quarantinedPlugins.length}  untrusted plugins ${snapshot.untrustedPlugins.length}`,
      `incidents ${snapshot.incidents.length}`,
    ];
  }

  private tokensTab(snapshot: UiSecuritySnapshot): ConfigModalTab {
    const audit = snapshot.audit;
    const header = this.governanceHeader(snapshot);
    const rows: ConfigModalRow[] = [];

    if (audit.results.length === 0) {
      const quarantinedMcp = snapshot.mcpServers.filter((s) => s.schemaFreshness === 'quarantined');
      rows.push(infoRow('empty:0', 'No API tokens are registered with the security auditor yet.'));
      rows.push(infoRow('empty:1', 'The security control room can already review policy, MCP, plugin, and incident posture, but token-specific scope and rotation audit data has not been registered.', { dim: true }));
      if (quarantinedMcp.length > 0) rows.push(infoRow('empty:mcp', 'MCP quarantine still active despite no registered tokens.', WARN));
      rows.push(infoRow('empty:title', 'Inspect further'));
      rows.push(infoRow('empty:storage', '/storage review — inspect secure secret storage and environment overrides', { dim: true }));
      rows.push(infoRow('empty:mcptrust', '/mcp trust      — inspect active MCP trust and quarantine posture', { dim: true }));
      return { id: 'tokens', label: 'Tokens', header, rows, emptyText: '' };
    }

    for (const result of audit.results) {
      const ageDays = Math.floor(result.rotation.ageMs / (24 * 60 * 60 * 1000));
      rows.push({
        id: result.tokenId,
        label: `${result.label.padEnd(22)} ${result.tokenId.padEnd(14)} ${result.scope.policyId.padEnd(12)} ${resultSummary(result)} · rot ${result.rotation.outcome}/${fmtDue(result.rotation.msUntilDue)} age ${ageDays}d${result.blocked ? ' · BLOCKED' : ''}`,
        ...(resultColor(result) ? { style: resultColor(result)! } : {}),
      });
    }
    rows.push(infoRow('audit:when', `Last audit ${fmtIso(audit.lastAuditAt)}: press r to refresh`, { dim: true }));
    return { id: 'tokens', label: 'Tokens', header, rows, hints: ['f preflight'] };
  }

  private governanceTab(snapshot: UiSecuritySnapshot): ConfigModalTab {
    const rows: ConfigModalRow[] = [];
    const quarantinedMcp = snapshot.mcpServers.filter((s) => s.schemaFreshness === 'quarantined');
    if (quarantinedMcp.length > 0) {
      const server = quarantinedMcp[0]!;
      rows.push(infoRow('mcp:q', `MCP quarantine: ${server.name} ${server.quarantineReason ?? 'unknown'}${server.quarantineDetail ? `; ${server.quarantineDetail}` : ''}`, BAD));
    }
    if (snapshot.quarantinedPlugins.length > 0) {
      const plugin = snapshot.quarantinedPlugins[0]!;
      rows.push(infoRow('plugin:q', `Plugin quarantine: ${plugin.name} (${plugin.trustTier})`, BAD));
    } else if (snapshot.untrustedPlugins.length > 0) {
      const plugin = snapshot.untrustedPlugins[0]!;
      rows.push(infoRow('plugin:u', `Plugin trust warning: ${plugin.name} remains untrusted.`, WARN));
    }
    if (snapshot.latestIncident) {
      rows.push(infoRow('incident', `Latest incident: ${snapshot.latestIncident.classification}; ${snapshot.latestIncident.summary} (${fmtIso(snapshot.latestIncident.generatedAt)})`, WARN));
    }

    const review = snapshot.attackPathReview;
    rows.push(infoRow('atk:title', 'MCP Attack-Path Review'));
    rows.push(infoRow('atk:counts', `critical ${review.criticalFindings}  incoherent ${review.incoherentFindings}`, review.criticalFindings > 0 ? BAD : { dim: true }));
    rows.push(infoRow('atk:summary', review.summary, { dim: true }));
    const shown = review.findings.slice(0, MAX_FINDINGS_SHOWN);
    shown.forEach((finding, i) => {
      rows.push(infoRow(`atk:${i}:h`, `${finding.severity.toUpperCase()} ${finding.serverName}: ${finding.route}`, findingColor(finding.severity)));
      rows.push(infoRow(`atk:${i}:r`, `  ${finding.reason}`, { dim: true }));
      rows.push(infoRow(`atk:${i}:e`, `  evidence: ${finding.evidence.join(' | ')}`, { dim: true }));
    });
    if (review.findings.length > shown.length) {
      const extra = review.findings.length - shown.length;
      rows.push(infoRow('atk:more', `+${extra} more finding${extra === 1 ? '' : 's'} not shown`, { dim: true }));
    }
    return { id: 'governance', label: 'Governance', rows, emptyText: 'No governance findings.' };
  }

  buildView(): ConfigModalView {
    const snapshot = this.deps.readModel.getSnapshot();
    return { title: 'Security Control Room', tabs: [this.tokensTab(snapshot), this.governanceTab(snapshot)] };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') { ctx.setStatus('Security posture is read live.'); ctx.requestRender(); return; }
    if (id === 'preflight') { void ctx.executeCommand?.('policy', ['preflight']); ctx.setStatus('Dispatched /policy preflight.'); return; }
    if (id === 'jumpToIncident' && this.deps.readModel.getSnapshot().latestIncident) {
      void ctx.executeCommand?.('panel', ['open', 'incident']);
      ctx.setStatus('Opened the incident surface (fleet).');
      return;
    }
    if (id === 'manageDevices') {
      ctx.openModal?.('devices-modal');
      ctx.setStatus('Opened paired-device management.');
    }
  }
}

export function createSecurityModalSurface(deps: SecurityModalDeps): ConfigModalSurface {
  return new SecurityModalSurface(deps);
}

/**
 * Deterministic golden fixture. A fixed `UiSecuritySnapshot` literal covering
 * the meaningful states in one shot: a clean token, a blocked/overdue/scope-
 * violating token, a quarantined allow-all MCP server, a quarantined plugin,
 * one recorded incident, and one critical attack-path finding. No Date.now().
 */
export function securityModalGoldenSurface(): ConfigModalSurface {
  const FIXED_INCIDENT = {
    id: 'inc-0001', traceId: 'trace-0001', sessionId: 'sess-0001', generatedAt: 1700000000000,
    classification: 'permission_denied' as const, summary: 'blocked write outside sandbox root',
    phaseTimings: [], phaseLedger: [], causalChain: [], cascadeEvents: [], permissionEvidence: [], budgetBreaches: [], jumpLinks: [],
  };
  const snapshot: UiSecuritySnapshot = {
    audit: {
      managed: true, totalTokens: 2,
      results: [
        { tokenId: 'tok-openai', label: 'OPENAI_API_KEY', scope: { tokenId: 'tok-openai', outcome: 'ok', excessScopes: [], policyId: 'openai' }, rotation: { tokenId: 'tok-openai', outcome: 'ok', ageMs: 5 * 86400000, cadenceMs: 90 * 86400000, msUntilDue: 85 * 86400000, dueAt: 1707600000000 }, blocked: false },
        { tokenId: 'tok-slack', label: 'SLACK_BOT_TOKEN', scope: { tokenId: 'tok-slack', outcome: 'violation', excessScopes: ['admin'], policyId: 'slack' }, rotation: { tokenId: 'tok-slack', outcome: 'overdue', ageMs: 120 * 86400000, cadenceMs: 90 * 86400000, msUntilDue: -30 * 86400000, dueAt: 1697328000000 }, blocked: true },
      ],
      blocked: ['tok-slack'], scopeViolations: ['tok-slack'], rotationWarnings: [], rotationOverdue: ['tok-slack'],
      lastAuditAt: 1700000000000, capturedAt: '2023-11-14T22:13:20.000Z',
    },
    policy: { preflightStatus: 'warn', preflightIssueCount: 2, lintFindingCount: 1 },
    deniedPermissions: 3, incidents: [FIXED_INCIDENT], latestIncident: FIXED_INCIDENT,
    mcpServers: [{ name: 'fs-server', role: 'filesystem', trustMode: 'allow-all', connected: true, allowedPaths: [], allowedHosts: [], schemaFreshness: 'quarantined', quarantineReason: 'stale_threshold', quarantineDetail: 'ttl expired 2 days ago' }],
    recentMcpDecisions: [],
    attackPathReview: {
      reviewedAt: 1700000000000, totalServers: 1, connectedServers: 1, allowAllServers: 1, askOnRiskServers: 0, constrainedServers: 0, blockedServers: 0, quarantinedServers: 1, incoherentFindings: 1, criticalFindings: 1,
      findings: [{ kind: 'server-posture', serverName: 'fs-server', route: 'fs-server -> write_fs', verdict: 'ask', severity: 'critical', incoherent: true, reason: 'allow-all trust combined with a quarantined schema', evidence: ['schemaFreshness=quarantined', 'trustMode=allow-all'] }],
      summary: '1 server in allow-all mode with a quarantined schema',
    },
    plugins: [],
    quarantinedPlugins: [{ name: 'legacy-formatter', version: '0.1.0', description: 'old formatter plugin', enabled: false, active: false, trustTier: 'untrusted', quarantined: true }],
    untrustedPlugins: [],
  };
  return createSecurityModalSurface({ readModel: { getSnapshot: () => snapshot, subscribe: () => () => {} } });
}
