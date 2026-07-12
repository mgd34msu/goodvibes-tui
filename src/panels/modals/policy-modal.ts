import { MODAL_TONES } from './modal-theme.ts';
import type {
  DivergenceDashboardSnapshot,
  DivergenceStats,
  PermissionAuditEntry,
  PolicyBundleVersion,
  PolicyDiffResult,
  PolicyLintFinding,
  PolicyPreflightReview,
  PolicySimulationSummary,
} from '@/runtime/index.ts';
import type { ModalSectionStyle } from '../../renderer/modal-factory.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';

// ---------------------------------------------------------------------------
// Policy → config-modal surface (group-B port). Governance CONTENT view,
// not a selectable list — current/candidate bundle state, diff, divergence
// gate, history, permission audit, lint findings, preflight review, and
// simulation samples render as non-selectable rows (the host windows/scrolls
// them). EVERY dispatchable key in the original panel (s/f/l/p/b) already
// routed to `/policy <sub>` via executeCommand — none were in-panel mutations;
// the panel's promote/rollback confirm step is dropped per charter (never fold
// a confirm into a modal) and the command dispatches directly. Determinism:
// timestamps are formatted (fmtTime/fmtRate), never read from the clock.
// ---------------------------------------------------------------------------

interface PolicyModalSnapshot {
  readonly current: PolicyBundleVersion | null;
  readonly candidate: PolicyBundleVersion | null;
  readonly history: readonly PolicyBundleVersion[];
  readonly diff: PolicyDiffResult | null;
  readonly divergence: DivergenceDashboardSnapshot | null;
  readonly recentPermissionAudit: readonly PermissionAuditEntry[];
  readonly lintFindings: readonly PolicyLintFinding[];
  readonly lastSimulationSummary: PolicySimulationSummary | null;
  readonly lastPreflightReview: PolicyPreflightReview | null;
  readonly capturedAt: string;
}

export interface PolicyModalDeps {
  readonly policyRuntimeState: { getSnapshot(): PolicyModalSnapshot };
}

const BAD: ModalSectionStyle = { fg: MODAL_TONES.bad };
const WARN: ModalSectionStyle = { fg: MODAL_TONES.warn };
const GOOD: ModalSectionStyle = { fg: MODAL_TONES.good };
const DIM: ModalSectionStyle = { dim: true };
const MAX_ROWS = 5;

function fmtTime(value: string | undefined): string {
  if (!value) return 'n/a';
  return value.replace('T', ' ').slice(0, 19);
}

function fmtRate(value: number | undefined): string {
  if (value === undefined) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function gateColor(status: string | undefined): ModalSectionStyle | undefined {
  switch (status) {
    case 'allowed': return GOOD;
    case 'blocked': return BAD;
    case 'no_data': return WARN;
    default: return DIM;
  }
}

function ruleLine(rule: { id: string; type: string; effect: string }): string {
  return `${rule.id} (${rule.type}, effect=${rule.effect})`;
}

class PolicyModalSurface implements ConfigModalSurface {
  readonly name = 'policy-modal';
  readonly title = 'Policy And Governance';

  constructor(private readonly deps: PolicyModalDeps) {}

  readonly actions = [
    { key: 's', id: 'simulate', label: 'simulate' },
    { key: 'f', id: 'preflight', label: 'preflight' },
    { key: 'l', id: 'lint', label: 'lint' },
    { key: 'p', id: 'promote', label: 'promote' },
    { key: 'b', id: 'rollback', label: 'rollback' },
  ];

  buildView(): ConfigModalView {
    const snapshot = this.deps.policyRuntimeState.getSnapshot();
    const preflight = snapshot.lastPreflightReview;
    const divergence = snapshot.divergence;
    const lintCount = snapshot.lintFindings.length;
    const preflightStatus = preflight ? preflight.status : 'none';
    const gateStatus = divergence?.gate.status ?? 'n/a';

    const header = [`bundles ${snapshot.current ? 1 : 0}+${snapshot.candidate ? 1 : 0}c  preflight ${preflightStatus.toUpperCase()}  gate ${gateStatus}  lint ${lintCount}`];

    const rows: ConfigModalRow[] = [];
    let n = 0;
    const push = (label: string, style?: ModalSectionStyle): void => { rows.push({ id: `row:${n++}`, label, selectable: false, ...(style ? { style } : {}) }); };

    const nothingRecorded = !snapshot.current && !snapshot.candidate && !divergence
      && snapshot.history.length === 0 && snapshot.recentPermissionAudit.length === 0
      && snapshot.lintFindings.length === 0 && !snapshot.lastSimulationSummary && !preflight;

    if (nothingRecorded) {
      push('No policy bundles loaded.');
      push('Bundle: none active, none candidate. Gate: n/a.', DIM);
      push('Get started');
      push('/policy load — load a policy bundle to begin governance review', DIM);
      return { title: 'Policy And Governance', tabs: [{ id: 'governance', label: 'Governance', header, rows, emptyText: '' }] };
    }

    if (snapshot.current) {
      push('Current');
      push(`Bundle ${snapshot.current.bundle.bundleId}  State ${snapshot.current.state}`);
      push(`Loaded ${fmtTime(snapshot.current.loadedAt)}  Active ${fmtTime(snapshot.current.activatedAt)}`, DIM);
    }
    if (snapshot.candidate) {
      push('Candidate');
      push(`Bundle ${snapshot.candidate.bundle.bundleId}  State ${snapshot.candidate.state}`);
      push(`Loaded ${fmtTime(snapshot.candidate.loadedAt)}  Rules ${snapshot.candidate.rules.length}`, DIM);
    }
    if (snapshot.diff) {
      const diff = snapshot.diff;
      push('Diff');
      push(`${diff.fromBundleId} -> ${diff.toBundleId}  changes ${diff.totalChanges}`);
      if (diff.added.length > 0) { push('Added', GOOD); for (const r of diff.added.slice(0, MAX_ROWS)) push(`  + ${ruleLine(r)}`, DIM); }
      if (diff.removed.length > 0) { push('Removed', BAD); for (const r of diff.removed.slice(0, MAX_ROWS)) push(`  - ${ruleLine(r)}`, DIM); }
      if (diff.changed.length > 0) { push('Changed', WARN); for (const c of diff.changed.slice(0, MAX_ROWS)) push(`  ~ ${c.ruleId}`, DIM); }
    }
    if (divergence) {
      push('Governance Gate');
      push(`Mode ${divergence.mode}  Gate ${divergence.gate.status}  Divergence ${fmtRate(divergence.gate.divergenceRate ?? divergence.report.overall.divergenceRate)}`, gateColor(divergence.gate.status));
      push(`Evaluations ${divergence.report.overall.totalEvaluations}  Trend points ${divergence.trend.length}`, DIM);
      const prefixEntries = Object.entries(divergence.report.byCommandPrefix);
      if (prefixEntries.length > 0) {
        push('Divergence by command prefix', DIM);
        for (const [prefix, stats] of prefixEntries.slice(0, MAX_ROWS)) push(`  ${prefix}  ${fmtRate(stats.divergenceRate)}  ${stats.total}/${stats.totalEvaluations}`, stats.divergenceRate > 0 ? WARN : undefined);
      }
      const classEntries = Object.entries(divergence.report.byToolClass).filter((e): e is [string, DivergenceStats] => e[1] !== undefined);
      if (classEntries.length > 0) {
        push('Divergence by tool class', DIM);
        for (const [cls, stats] of classEntries.slice(0, MAX_ROWS)) push(`  ${cls}  ${fmtRate(stats.divergenceRate)}  ${stats.total}/${stats.totalEvaluations}`, stats.divergenceRate > 0 ? WARN : undefined);
      }
    }
    if (snapshot.history.length > 0) {
      push('History');
      for (const v of snapshot.history.slice(0, MAX_ROWS)) push(`${v.bundle.bundleId}  ${v.state}  ${fmtTime(v.activatedAt ?? v.loadedAt)}`, DIM);
    }
    if (snapshot.recentPermissionAudit.length > 0) {
      push('Permission Audit');
      for (const entry of snapshot.recentPermissionAudit.slice(0, MAX_ROWS)) {
        const outcome = entry.approved === undefined ? 'pending' : entry.approved ? 'approved' : 'denied';
        push(`${entry.tool}  ${entry.riskLevel.toUpperCase()}  ${outcome}`, entry.approved === undefined ? WARN : entry.approved ? undefined : BAD);
        push(`  ${entry.summary}`, DIM);
      }
    }
    if (snapshot.lintFindings.length > 0) {
      push('Policy Lint');
      for (const f of snapshot.lintFindings.slice(0, MAX_ROWS)) push(`${f.severity.toUpperCase()} ${f.message}`, f.severity === 'error' ? BAD : f.severity === 'warn' ? WARN : undefined);
    }
    if (preflight) {
      push('Preflight Review');
      push(`Status ${preflight.status.toUpperCase()}  Issues ${preflight.issueCount}  Generated ${fmtTime(preflight.generatedAt)}`, preflight.status === 'pass' ? GOOD : preflight.status === 'warn' ? WARN : BAD);
      push(preflight.summary, DIM);
      for (const issue of preflight.issues.slice(0, 4)) push(`${issue.severity.toUpperCase()} ${issue.message}`, issue.severity === 'error' ? BAD : issue.severity === 'warn' ? WARN : undefined);
    }
    if (snapshot.lastSimulationSummary) {
      const sim = snapshot.lastSimulationSummary;
      push('Simulation Samples');
      push(`Mode ${sim.mode}  Diverged ${sim.divergentScenarios}/${sim.totalScenarios}  Allowed(actual/sim) ${sim.allowedByActual}/${sim.allowedBySimulated}`, sim.divergentScenarios > 0 ? WARN : GOOD);
      for (const result of sim.results.slice(0, 4)) push(`${result.scenario.label}  ${(result.authoritativeDecision.allowed ? 'allow' : 'deny').toUpperCase()}  ${result.diverged ? (result.divergenceType ?? 'diverged') : 'aligned'}`, result.diverged ? WARN : (result.authoritativeDecision.allowed ? GOOD : BAD));
    }

    return { title: 'Policy And Governance', tabs: [{ id: 'governance', label: 'Governance', header, rows }] };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    // "Rollout" in the WO brief maps to the registry's actual subcommand —
    // there is no separate `/policy rollout`.
    const sub = id === 'simulate' ? 'simulate' : id === 'preflight' ? 'preflight' : id === 'lint' ? 'lint' : id === 'promote' ? 'promote' : id === 'rollback' ? 'rollback' : null;
    if (!sub) return;
    void ctx.executeCommand?.('policy', [sub]);
    ctx.setStatus(`Dispatched /policy ${sub}.`);
  }
}

export function createPolicyModalSurface(deps: PolicyModalDeps): ConfigModalSurface {
  return new PolicyModalSurface(deps);
}

/**
 * Deterministic golden fixture. A fixed `PolicyModalSnapshot` literal covering
 * every rendered branch in one shot: an active current bundle, a simulating
 * candidate, a 3-rule diff, a blocked divergence gate with one command-prefix
 * and one tool-class breakdown row, one rolled-back history entry, one denied
 * permission-audit entry, one lint warning, one preflight review with one issue,
 * and one diverged simulation sample. No Date.now().
 */
export function policyModalGoldenSurface(): ConfigModalSurface {
  const currentBundle: PolicyBundleVersion = {
    bundle: { bundleId: 'bundle-current-1', issuedAt: '2023-11-01T00:00:00.000Z', payload: { version: 1, rules: [] }, issuer: 'ops' },
    provenance: { policyBundleId: 'bundle-current-1', signatureStatus: 'unsigned', provenanceSource: 'local-file', issuedAt: '2023-11-01T00:00:00.000Z', issuer: 'ops' },
    rules: [{ id: 'rule-base-1', type: 'prefix', origin: 'managed', effect: 'allow', toolPattern: '*', commandPrefixes: [] }],
    state: 'active', loadedAt: '2023-11-01T00:00:00.000Z', activatedAt: '2023-11-01T00:05:00.000Z',
  };
  const candidateBundle: PolicyBundleVersion = {
    bundle: { bundleId: 'bundle-candidate-1', issuedAt: '2023-11-10T00:00:00.000Z', payload: { version: 1, rules: [] }, issuer: 'ops' },
    provenance: { policyBundleId: 'bundle-candidate-1', signatureStatus: 'unsigned', provenanceSource: 'local-file', issuedAt: '2023-11-10T00:00:00.000Z', issuer: 'ops' },
    rules: [
      { id: 'rule-base-1', type: 'prefix', origin: 'managed', effect: 'allow', toolPattern: '*', commandPrefixes: [] },
      { id: 'rule-added-1', type: 'network-scope', origin: 'user', effect: 'deny', toolPattern: 'Fetch', hostPatterns: ['*'] },
    ],
    state: 'simulating', loadedAt: '2023-11-10T00:00:00.000Z',
  };
  const historyBundle: PolicyBundleVersion = {
    bundle: { bundleId: 'bundle-prev-1', issuedAt: '2023-10-01T00:00:00.000Z', payload: { version: 1, rules: [] } },
    provenance: { policyBundleId: 'bundle-prev-1', signatureStatus: 'unsigned', provenanceSource: 'local-file', issuedAt: '2023-10-01T00:00:00.000Z' },
    rules: [], state: 'rolled-back', loadedAt: '2023-10-01T00:00:00.000Z', activatedAt: '2023-10-01T00:05:00.000Z', rolledBackAt: '2023-11-01T00:00:00.000Z',
  };
  const removedRule = { id: 'rule-removed-1', type: 'path-scope' as const, origin: 'user' as const, effect: 'deny' as const, toolPattern: '*', pathPatterns: ['/tmp/**'] };
  const addedRule = { id: 'rule-added-1', type: 'network-scope' as const, origin: 'user' as const, effect: 'deny' as const, toolPattern: 'Fetch', hostPatterns: ['*'] };
  const changedFrom = { id: 'rule-base-1', type: 'prefix' as const, origin: 'managed' as const, effect: 'allow' as const, toolPattern: '*', commandPrefixes: [] };
  const changedTo = { id: 'rule-base-1', type: 'prefix' as const, origin: 'managed' as const, effect: 'deny' as const, toolPattern: '*', commandPrefixes: [] };
  const stats = (divergenceRate: number): DivergenceStats => ({ total: 1, byType: { 'allow-vs-deny': 1, 'deny-vs-allow': 0, 'reason-mismatch': 0 }, divergenceRate, totalEvaluations: 20 });
  const decision = (allowed: boolean, reason: 'DEFAULT_ALLOW' | 'RULE_DENY_USER') => ({ allowed, reason, sourceLayer: 'policy' as const, toolName: 'Fetch', args: {}, timestamp: 1700000000000, evaluationTrace: [] });

  const snapshot: PolicyModalSnapshot = {
    current: currentBundle, candidate: candidateBundle, history: [historyBundle],
    diff: { fromBundleId: 'bundle-current-1', toBundleId: 'bundle-candidate-1', removed: [removedRule], added: [addedRule], changed: [{ ruleId: 'rule-base-1', from: changedFrom, to: changedTo }], unchanged: [], totalChanges: 3 },
    divergence: {
      report: { overall: stats(0.1), byToolClass: { network: stats(0.1) }, byCommandPrefix: { 'fetch ': stats(0.1) }, byMode: {}, records: [] },
      mode: 'warn-on-divergence',
      gate: { status: 'blocked', divergenceRate: 0.1, threshold: 0.05, totalEvaluations: 20, message: 'divergence rate 10.0% exceeds 5.0% threshold' },
      trend: [{ ts: 1700000000000, divergenceRate: 0.1, totalEvaluations: 20, totalDivergences: 2, gatePassing: false }],
      capturedAt: 1700000000000,
    },
    recentPermissionAudit: [{ callId: 'call-1', tool: 'Bash', category: 'exec', approved: false, riskLevel: 'high', classification: 'destructive', summary: 'blocked rm -rf outside sandbox root', reasons: ['path escape'], requestedAt: 1700000000000, decidedAt: 1700000001000 }],
    lintFindings: [{ severity: 'warn', ruleId: 'rule-added-1', message: 'toolPattern "Fetch" combined with a wildcard host pattern is broad; consider narrowing.' }],
    lastSimulationSummary: {
      simulatedAt: '2023-11-10T00:00:00.000Z', mode: 'warn-on-divergence', totalScenarios: 4, divergentScenarios: 1, allowedByActual: 3, allowedBySimulated: 2,
      results: [{ scenario: { id: 'scenario-1', label: 'fetch external API', toolName: 'Fetch', args: {} }, actualDecision: decision(true, 'DEFAULT_ALLOW'), simulatedDecision: decision(false, 'RULE_DENY_USER'), authoritativeDecision: decision(true, 'DEFAULT_ALLOW'), diverged: true, divergenceType: 'allow-vs-deny' }],
    },
    lastPreflightReview: {
      generatedAt: '2023-11-10T00:10:00.000Z', status: 'warn', summary: '1 candidate rule broadens network access beyond the current policy.', issueCount: 1,
      issues: [{ severity: 'warn', source: 'policy', message: 'candidate rule rule-added-1 denies all outbound network access', detail: 'verify this is intentional before promotion' }],
    },
    capturedAt: '2023-11-10T00:15:00.000Z',
  };
  return createPolicyModalSurface({ policyRuntimeState: { getSnapshot: () => snapshot } });
}
