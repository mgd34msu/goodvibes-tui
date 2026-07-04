import { MODAL_TONES } from './modal-theme.ts';
import type { TokenAuditResult } from '@pellux/goodvibes-sdk/platform/security';
import type { ModalConfig, ModalListItem, ModalSection, ModalSectionStyle } from '../../renderer/modal-factory.ts';
import type { UiReadModel, UiSecuritySnapshot } from '../../runtime/ui-read-models.ts';
import type { BoundModalSurface, ModalAction, ModalViewState } from './modal-surface.ts';

// ---------------------------------------------------------------------------
// Security → modal (W6 WO-B). Migrated from src/panels/security-panel.ts,
// a `ScrollableListPanel<TokenAuditResult>` over `ui.readModels.security`
// (UiReadModel<UiSecuritySnapshot>). Read-model-backed, so refresh() is a
// no-op (WO-B brief) — buildConfig reads getSnapshot() fresh every render,
// same as the panel's render() did.
//
// This is a token audit list (like marketplace's catalog list) plus a
// governance summary (policy preflight, MCP/plugin quarantine, incidents,
// MCP attack-path review) that the old panel folded into the same view.
// Kept read/navigate only: the panel's 'f' (preflight) and 'i' (jump to
// incident) both required PanelIntegrationContext to dispatch, i.e. they
// were never in-panel mutations — 'f' already went to `/policy preflight`
// via executeCommand, so it routes to its command path here too; 'i' is a
// pure cross-open (no mutation) and stays in-modal as `openModal`.
//
// Determinism: the panel's fmtAgo()/fmtDue()-for-audit used Date.now() for
// "3d ago"-style relative text. buildConfig here never calls Date.now() —
// lastAuditAt and incident timestamps render as absolute ISO strings so the
// golden fixture is byte-stable regardless of when the test runs. msUntilDue
// is already a pre-computed relative value on the audit result itself (no
// wall-clock read here), so that formatting is kept as-is.
// ---------------------------------------------------------------------------

/** Live deps the security modal reads. Mirrors SecurityPanel's constructor dep. */
export interface SecurityModalDeps {
  readonly readModel: UiReadModel<UiSecuritySnapshot>;
}

const BAD: ModalSectionStyle = { fg: MODAL_TONES.bad };
const WARN: ModalSectionStyle = { fg: MODAL_TONES.warn };
const DIM: ModalSectionStyle = { dim: true };

/** Max attack-path findings rendered before capping with a "+N more" note (no scroll surface at this layer — mirrors marketplace's `.slice(0, 3)` truncation for recommendations/startup issues). */
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

/** Relative-due formatting from a pre-computed `msUntilDue` — no wall-clock read (mirrors security-panel.ts's fmtDue). */
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

/** Absolute ISO formatting for an epoch-ms timestamp. Deterministic (formats the given value; never reads the clock). */
function fmtIso(ts: number | null | undefined): string {
  return ts === null || ts === undefined ? 'never' : new Date(ts).toISOString();
}

function findingColor(severity: string): ModalSectionStyle | undefined {
  return severity === 'critical' || severity === 'high' ? BAD : severity === 'medium' ? WARN : undefined;
}

function matchesQuery(result: TokenAuditResult, q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  return result.label.toLowerCase().includes(needle)
    || result.scope.policyId.toLowerCase().includes(needle)
    || result.tokenId.toLowerCase().includes(needle);
}

/**
 * Security → modal. Token scope/rotation audit list plus a governance
 * summary (policy preflight, MCP/plugin quarantine, incidents, MCP
 * attack-path review) — the full read surface security-panel.ts exposed.
 */
export function bindSecurityModal(deps: SecurityModalDeps): BoundModalSurface {
  const visibleResults = (view: ModalViewState, snapshot: UiSecuritySnapshot): TokenAuditResult[] =>
    snapshot.audit.results.filter((result) => matchesQuery(result, view.query));

  const selectedResult = (view: ModalViewState, snapshot: UiSecuritySnapshot): TokenAuditResult | undefined => {
    const visible = visibleResults(view, snapshot);
    if (visible.length === 0) return undefined;
    return visible[Math.max(0, Math.min(view.selectedIndex, visible.length - 1))];
  };

  const buildConfig = (view: ModalViewState): ModalConfig => {
    const snapshot = deps.readModel.getSnapshot();
    const audit = snapshot.audit;
    const preflightStatus = snapshot.policy.preflightStatus;
    const quarantinedMcp = snapshot.mcpServers.filter((server) => server.schemaFreshness === 'quarantined');
    const elevatedMcp = snapshot.mcpServers.filter((server) => server.trustMode === 'allow-all');
    const attackPathReview = snapshot.attackPathReview;
    const sections: ModalSection[] = [];

    // Governance summary (always visible — mirrors the panel's governanceLines,
    // shown above both the empty state and the populated list).
    sections.push({
      type: 'text',
      content: `mode ${audit.managed ? 'MANAGED' : 'ADVISORY'}  tokens ${audit.totalTokens}  blocked ${audit.blocked.length}  scope violations ${audit.scopeViolations.length}  overdue ${audit.rotationOverdue.length}  warnings ${audit.rotationWarnings.length}`,
      style: DIM,
    });
    sections.push({
      type: 'text',
      content: `preflight ${preflightStatus.toUpperCase()}  issues ${snapshot.policy.preflightIssueCount}  lint ${snapshot.policy.lintFindingCount}  denied permissions ${snapshot.deniedPermissions}`,
      style: DIM,
    });
    sections.push({
      type: 'text',
      content: `quarantined MCP ${quarantinedMcp.length}  elevated MCP ${elevatedMcp.length}  quarantined plugins ${snapshot.quarantinedPlugins.length}  untrusted plugins ${snapshot.untrustedPlugins.length}`,
      style: DIM,
    });
    sections.push({ type: 'text', content: `incidents ${snapshot.incidents.length}`, style: DIM });
    sections.push({ type: 'separator' });

    if (audit.results.length === 0) {
      sections.push({ type: 'text', content: 'No API tokens are registered with the security auditor yet.' });
      sections.push({
        type: 'text',
        content: 'The security control room can already review policy, MCP, plugin, and incident posture, but token-specific scope and rotation audit data has not been registered.',
        style: DIM,
      });
      if (quarantinedMcp.length > 0) {
        sections.push({ type: 'text', content: 'MCP quarantine still active despite no registered tokens.', style: WARN });
      }
      sections.push({ type: 'separator' });
      sections.push({ type: 'title', content: 'Inspect further' });
      sections.push({ type: 'text', content: '/storage review — inspect secure secret storage and environment overrides', style: DIM });
      sections.push({ type: 'text', content: '/mcp trust      — inspect active MCP trust and quarantine posture', style: DIM });
    } else {
      const visible = visibleResults(view, snapshot);
      const clampedIndex = Math.max(0, Math.min(view.selectedIndex, visible.length - 1));
      const items: ModalListItem[] = visible.map((result, index) => ({
        label: `${result.label.padEnd(22)} ${result.tokenId.padEnd(14)} ${result.scope.policyId.padEnd(12)} ${resultSummary(result)}`,
        selected: index === clampedIndex,
        style: resultColor(result),
      }));
      if (items.length === 0) {
        sections.push({ type: 'text', content: `No tokens match “${view.query}”.`, style: DIM });
      } else {
        sections.push({ type: 'list', items });
      }

      const selected = selectedResult(view, snapshot);
      if (selected) {
        sections.push({ type: 'separator' });
        sections.push({
          type: 'text',
          content: `Token ${selected.label}  Policy ${selected.scope.policyId}  Blocked ${selected.blocked ? 'yes' : 'no'}`,
          style: selected.blocked ? BAD : undefined,
        });
        sections.push({
          type: 'text',
          content: `Scope ${selected.scope.outcome}  Excess ${selected.scope.excessScopes.length > 0 ? selected.scope.excessScopes.join(', ') : 'none'}`,
          style: selected.scope.outcome === 'violation' ? BAD : undefined,
        });
        sections.push({
          type: 'text',
          content: `Rotation ${selected.rotation.outcome}  Due ${fmtDue(selected.rotation.msUntilDue)}  Age(d) ${Math.floor(selected.rotation.ageMs / (24 * 60 * 60 * 1000))}`,
          style: selected.rotation.outcome === 'ok' ? undefined : (selected.rotation.outcome === 'warning' ? WARN : BAD),
        });
        sections.push({ type: 'text', content: `Last audit ${fmtIso(audit.lastAuditAt)} — press r to refresh`, style: DIM });
        if (view.expanded?.has(selected.tokenId) && preflightStatus !== 'n/a') {
          sections.push({
            type: 'text',
            content: `Policy preflight ${preflightStatus} (${snapshot.policy.preflightIssueCount} issue${snapshot.policy.preflightIssueCount === 1 ? '' : 's'})`,
            style: preflightStatus === 'block' ? BAD : preflightStatus === 'warn' ? WARN : DIM,
          });
        }
      }
    }

    // MCP quarantine / plugin trust / latest incident — governance facts
    // independent of which token row is selected (unlike the panel, which
    // tucked these into the selected-token detail block only because that
    // was the only scrollable footer space it had).
    if (quarantinedMcp.length > 0) {
      const server = quarantinedMcp[0]!;
      sections.push({
        type: 'text',
        content: `MCP quarantine: ${server.name} ${server.quarantineReason ?? 'unknown'}${server.quarantineDetail ? ` — ${server.quarantineDetail}` : ''}`,
        style: BAD,
      });
    }
    if (snapshot.quarantinedPlugins.length > 0) {
      const plugin = snapshot.quarantinedPlugins[0]!;
      sections.push({ type: 'text', content: `Plugin quarantine: ${plugin.name} (${plugin.trustTier})`, style: BAD });
    } else if (snapshot.untrustedPlugins.length > 0) {
      const plugin = snapshot.untrustedPlugins[0]!;
      sections.push({ type: 'text', content: `Plugin trust warning: ${plugin.name} remains untrusted.`, style: WARN });
    }
    if (snapshot.latestIncident) {
      sections.push({
        type: 'text',
        content: `Latest incident: ${snapshot.latestIncident.classification} — ${snapshot.latestIncident.summary} (${fmtIso(snapshot.latestIncident.generatedAt)})`,
        style: WARN,
      });
    }

    // MCP attack-path review.
    sections.push({ type: 'separator' });
    sections.push({ type: 'title', content: 'MCP Attack-Path Review' });
    sections.push({
      type: 'text',
      content: `critical ${attackPathReview.criticalFindings}  incoherent ${attackPathReview.incoherentFindings}`,
      style: attackPathReview.criticalFindings > 0 ? BAD : DIM,
    });
    sections.push({ type: 'text', content: attackPathReview.summary, style: DIM });
    const shownFindings = attackPathReview.findings.slice(0, MAX_FINDINGS_SHOWN);
    for (const finding of shownFindings) {
      sections.push({
        type: 'text',
        content: `${finding.severity.toUpperCase()} ${finding.serverName}: ${finding.route}`,
        style: findingColor(finding.severity),
      });
      sections.push({ type: 'text', content: `  ${finding.reason}`, style: DIM });
      sections.push({ type: 'text', content: `  evidence: ${finding.evidence.join(' | ')}`, style: DIM });
    }
    if (attackPathReview.findings.length > shownFindings.length) {
      sections.push({
        type: 'text',
        content: `+${attackPathReview.findings.length - shownFindings.length} more finding${attackPathReview.findings.length - shownFindings.length === 1 ? '' : 's'} not shown`,
        style: DIM,
      });
    }

    return {
      title: 'Security Control Room',
      width: 88,
      search: view.query,
      sections,
      hints: [
        'up/down select token',
        'enter detail',
        'r refresh audit',
        'f preflight',
        ...(snapshot.latestIncident ? ['i jump to incident'] : []),
        '/ filter',
      ],
    };
  };

  const preflight: ModalAction = () => ({ kind: 'runCommand', command: '/policy preflight' });
  // W6.1: the old 'incident' panel folded into the fleet surface (RETIRE-INTO-
  // FLEET; 'incident' is an alias for 'fleet'), and fleet is a live panel, not
  // a modal — so route the jump to the panel, not a non-existent 'incident'
  // modal.
  const jumpToIncident: ModalAction = () => (
    deps.readModel.getSnapshot().latestIncident ? { kind: 'runCommand', command: '/panel open incident' } : { kind: 'none' }
  );

  return {
    name: 'security',
    title: 'Security Control Room',
    refresh: () => { /* read-model-backed: getSnapshot() is read lazily in buildConfig, nothing to reload */ },
    buildConfig,
    rowIds: (view) => visibleResults(view, deps.readModel.getSnapshot()).map((result) => result.tokenId),
    actions: {
      refresh: () => ({ kind: 'refresh' }),
      preflight,
      jumpToIncident,
    },
  };
}

/**
 * Deterministic golden fixture. A fixed `UiSecuritySnapshot` literal covering
 * the meaningful states in one shot: a clean token, a blocked/overdue/scope-
 * violating token, a quarantined allow-all MCP server, a quarantined plugin,
 * one recorded incident, and one critical attack-path finding. No Date.now()
 * anywhere — every timestamp is a fixed epoch-ms literal.
 */
export function securityModalGoldenSurface(): BoundModalSurface {
  const FIXED_INCIDENT = {
    id: 'inc-0001',
    traceId: 'trace-0001',
    sessionId: 'sess-0001',
    generatedAt: 1700000000000,
    classification: 'permission_denied' as const,
    summary: 'blocked write outside sandbox root',
    phaseTimings: [],
    phaseLedger: [],
    causalChain: [],
    cascadeEvents: [],
    permissionEvidence: [],
    budgetBreaches: [],
    jumpLinks: [],
  };

  const snapshot: UiSecuritySnapshot = {
    audit: {
      managed: true,
      totalTokens: 2,
      results: [
        {
          tokenId: 'tok-openai',
          label: 'OPENAI_API_KEY',
          scope: { tokenId: 'tok-openai', outcome: 'ok', excessScopes: [], policyId: 'openai' },
          rotation: { tokenId: 'tok-openai', outcome: 'ok', ageMs: 5 * 86400000, cadenceMs: 90 * 86400000, msUntilDue: 85 * 86400000, dueAt: 1707600000000 },
          blocked: false,
        },
        {
          tokenId: 'tok-slack',
          label: 'SLACK_BOT_TOKEN',
          scope: { tokenId: 'tok-slack', outcome: 'violation', excessScopes: ['admin'], policyId: 'slack' },
          rotation: { tokenId: 'tok-slack', outcome: 'overdue', ageMs: 120 * 86400000, cadenceMs: 90 * 86400000, msUntilDue: -30 * 86400000, dueAt: 1697328000000 },
          blocked: true,
        },
      ],
      blocked: ['tok-slack'],
      scopeViolations: ['tok-slack'],
      rotationWarnings: [],
      rotationOverdue: ['tok-slack'],
      lastAuditAt: 1700000000000,
      capturedAt: '2023-11-14T22:13:20.000Z',
    },
    policy: { preflightStatus: 'warn', preflightIssueCount: 2, lintFindingCount: 1 },
    deniedPermissions: 3,
    incidents: [FIXED_INCIDENT],
    latestIncident: FIXED_INCIDENT,
    mcpServers: [
      {
        name: 'fs-server',
        role: 'filesystem',
        trustMode: 'allow-all',
        connected: true,
        allowedPaths: [],
        allowedHosts: [],
        schemaFreshness: 'quarantined',
        quarantineReason: 'stale_threshold',
        quarantineDetail: 'ttl expired 2 days ago',
      },
    ],
    recentMcpDecisions: [],
    attackPathReview: {
      reviewedAt: 1700000000000,
      totalServers: 1,
      connectedServers: 1,
      allowAllServers: 1,
      askOnRiskServers: 0,
      constrainedServers: 0,
      blockedServers: 0,
      quarantinedServers: 1,
      incoherentFindings: 1,
      criticalFindings: 1,
      findings: [
        {
          kind: 'server-posture',
          serverName: 'fs-server',
          route: 'fs-server -> write_fs',
          verdict: 'ask',
          severity: 'critical',
          incoherent: true,
          reason: 'allow-all trust combined with a quarantined schema',
          evidence: ['schemaFreshness=quarantined', 'trustMode=allow-all'],
        },
      ],
      summary: '1 server in allow-all mode with a quarantined schema',
    },
    plugins: [],
    quarantinedPlugins: [
      { name: 'legacy-formatter', version: '0.1.0', description: 'old formatter plugin', enabled: false, active: false, trustTier: 'untrusted', quarantined: true },
    ],
    untrustedPlugins: [],
  };

  return bindSecurityModal({ readModel: { getSnapshot: () => snapshot, subscribe: () => () => {} } });
}
