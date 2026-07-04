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
import type { ModalConfig, ModalSection, ModalSectionStyle } from '../../renderer/modal-factory.ts';
import type { BoundModalSurface, ModalAction, ModalViewState } from './modal-surface.ts';

// ---------------------------------------------------------------------------
// Policy → modal (W6 WO-B). Migrated from src/panels/policy-panel.ts, which
// read `deps.policyRuntimeState` (a `PolicyRuntimeState`, SDK:
// platform/runtime/permissions/policy-runtime.js). This is a governance
// content view, not a selectable list — the panel scrolled a flat Line[]
// via its own `_scrollOffset`; ModalFactory has no equivalent scroll window
// (confirmed against ecosystem-modals-golden.test.ts, which renders every
// surface's full config unclipped), so this builder renders the full
// governance content every time rather than paginating it. `rowIds()`
// returns [] — there is no row-selectable list here.
//
// Action parity (the load-bearing part of this migration): EVERY dispatchable
// key in the original panel (s/f/l/p/b) already routed to `/policy <sub>` via
// `ctx.executeCommand('policy', [action])` in `handlePanelIntegrationAction` —
// none of them were ever true in-panel mutations. 'p' (promote) and 'b'
// (rollback) additionally required an inline `ConfirmState` before being
// queued; per charter that confirm step is dropped here (never fold an
// approval/confirm prompt into a modal) and the command dispatches directly,
// same as every other action. "Rollout" (the WO brief's term for going live)
// maps to the registry's actual subcommand, `/policy promote [--force]` —
// grepping src/input/commands/policy-dispatch.ts found no literal "rollout"
// subcommand.
//
// 'r' (record a divergence-dashboard trend sample) is dropped: unlike the
// other five keys it was never routed through executeCommand — the panel
// called `this._state.recordTrendEntry()` directly — and `/policy` has no
// matching subcommand to route it to (see policy-dispatch.ts's
// `dispatchPolicyCommand` switch: load/simulate/diff/lint/preflight/promote/
// rollback/status only). Adding one is out of scope for this WO.
//
// Determinism: every timestamp field here (loadedAt, activatedAt, generatedAt,
// simulatedAt, requestedAt, ...) is an ISO string or epoch-ms number already
// captured by the runtime at record time — buildConfig only formats those
// given values (fmtTime/fmtRate below) and never reads the clock itself.
// ---------------------------------------------------------------------------

/**
 * Mirrors `PolicyRuntimeState.getSnapshot()`'s return shape (SDK:
 * platform/runtime/diagnostics/panels/policy.js `PolicyPanelSnapshot`) —
 * redeclared locally (same pattern policy-panel.ts uses) so this builder's
 * declared dependency is exactly the fields it reads, not the whole class.
 */
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

/** Live deps the policy modal reads. Minimal structural shape of `PolicyRuntimeState`. */
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
    case 'allowed':
      return GOOD;
    case 'blocked':
      return BAD;
    case 'no_data':
      return WARN;
    default:
      return DIM;
  }
}

function ruleLine(rule: { id: string; type: string; effect: string }): string {
  return `${rule.id} (${rule.type}, effect=${rule.effect})`;
}

/**
 * Policy → modal. Governance content view: current/candidate bundle state,
 * diff, divergence gate, history, permission audit, lint findings, preflight
 * review, and simulation samples — the full read surface policy-panel.ts
 * exposed, minus the panel's manual scroll (see file header).
 */
export function bindPolicyModal(deps: PolicyModalDeps): BoundModalSurface {
  const buildConfig = (_view: ModalViewState): ModalConfig => {
    const snapshot = deps.policyRuntimeState.getSnapshot();
    const sections: ModalSection[] = [];

    const preflight = snapshot.lastPreflightReview;
    const divergence = snapshot.divergence;
    const lintCount = snapshot.lintFindings.length;
    const preflightStatus = preflight ? preflight.status : 'none';
    const gateStatus = divergence?.gate.status ?? 'n/a';

    sections.push({
      type: 'text',
      content: `bundles ${snapshot.current ? 1 : 0}+${snapshot.candidate ? 1 : 0}c  preflight ${preflightStatus.toUpperCase()}  gate ${gateStatus}  lint ${lintCount}`,
      style: preflightStatus === 'block' || gateStatus === 'blocked' ? BAD : (lintCount > 0 || gateStatus === 'no_data' ? WARN : DIM),
    });
    sections.push({ type: 'separator' });

    const nothingRecorded = !snapshot.current && !snapshot.candidate && !divergence
      && snapshot.history.length === 0 && snapshot.recentPermissionAudit.length === 0
      && snapshot.lintFindings.length === 0 && !snapshot.lastSimulationSummary && !preflight;

    if (nothingRecorded) {
      sections.push({ type: 'text', content: 'No policy bundles loaded.' });
      sections.push({ type: 'text', content: 'Bundle: none active, none candidate. Gate: n/a.', style: DIM });
      sections.push({ type: 'separator' });
      sections.push({ type: 'title', content: 'Get started' });
      sections.push({ type: 'text', content: '/policy load — load a policy bundle to begin governance review', style: DIM });
      return {
        title: 'Policy And Governance',
        width: 84,
        sections,
        footer: 'read-only governance view · esc close',
      };
    }

    if (snapshot.current) {
      sections.push({ type: 'title', content: 'Current' });
      sections.push({ type: 'text', content: `Bundle ${snapshot.current.bundle.bundleId}  State ${snapshot.current.state}` });
      sections.push({ type: 'text', content: `Loaded ${fmtTime(snapshot.current.loadedAt)}  Active ${fmtTime(snapshot.current.activatedAt)}`, style: DIM });
    }

    if (snapshot.candidate) {
      sections.push({ type: 'title', content: 'Candidate' });
      sections.push({ type: 'text', content: `Bundle ${snapshot.candidate.bundle.bundleId}  State ${snapshot.candidate.state}` });
      sections.push({ type: 'text', content: `Loaded ${fmtTime(snapshot.candidate.loadedAt)}  Rules ${snapshot.candidate.rules.length}`, style: DIM });
    }

    if (snapshot.diff) {
      const diff = snapshot.diff;
      sections.push({ type: 'title', content: 'Diff' });
      sections.push({ type: 'text', content: `${diff.fromBundleId} -> ${diff.toBundleId}  changes ${diff.totalChanges}` });
      if (diff.added.length > 0) {
        sections.push({ type: 'text', content: 'Added', style: GOOD });
        for (const rule of diff.added.slice(0, MAX_ROWS)) {
          sections.push({ type: 'text', content: `  + ${ruleLine(rule)}`, style: DIM });
        }
      }
      if (diff.removed.length > 0) {
        sections.push({ type: 'text', content: 'Removed', style: BAD });
        for (const rule of diff.removed.slice(0, MAX_ROWS)) {
          sections.push({ type: 'text', content: `  - ${ruleLine(rule)}`, style: DIM });
        }
      }
      if (diff.changed.length > 0) {
        sections.push({ type: 'text', content: 'Changed', style: WARN });
        for (const change of diff.changed.slice(0, MAX_ROWS)) {
          sections.push({ type: 'text', content: `  ~ ${change.ruleId}`, style: DIM });
        }
      }
    }

    if (divergence) {
      sections.push({ type: 'title', content: 'Governance Gate' });
      sections.push({
        type: 'text',
        content: `Mode ${divergence.mode}  Gate ${divergence.gate.status}  Divergence ${fmtRate(divergence.gate.divergenceRate ?? divergence.report.overall.divergenceRate)}`,
        style: gateColor(divergence.gate.status),
      });
      sections.push({
        type: 'text',
        content: `Evaluations ${divergence.report.overall.totalEvaluations}  Trend points ${divergence.trend.length}`,
        style: DIM,
      });
      const prefixEntries = Object.entries(divergence.report.byCommandPrefix);
      if (prefixEntries.length > 0) {
        sections.push({ type: 'text', content: 'Divergence by command prefix', style: DIM });
        for (const [prefix, stats] of prefixEntries.slice(0, MAX_ROWS)) {
          sections.push({
            type: 'text',
            content: `  ${prefix}  ${fmtRate(stats.divergenceRate)}  ${stats.total}/${stats.totalEvaluations}`,
            style: stats.divergenceRate > 0 ? WARN : undefined,
          });
        }
      }
      const classEntries = Object.entries(divergence.report.byToolClass)
        .filter((entry): entry is [string, DivergenceStats] => entry[1] !== undefined);
      if (classEntries.length > 0) {
        sections.push({ type: 'text', content: 'Divergence by tool class', style: DIM });
        for (const [cls, stats] of classEntries.slice(0, MAX_ROWS)) {
          sections.push({
            type: 'text',
            content: `  ${cls}  ${fmtRate(stats.divergenceRate)}  ${stats.total}/${stats.totalEvaluations}`,
            style: stats.divergenceRate > 0 ? WARN : undefined,
          });
        }
      }
    }

    if (snapshot.history.length > 0) {
      sections.push({ type: 'title', content: 'History' });
      for (const version of snapshot.history.slice(0, MAX_ROWS)) {
        sections.push({
          type: 'text',
          content: `${version.bundle.bundleId}  ${version.state}  ${fmtTime(version.activatedAt ?? version.loadedAt)}`,
          style: DIM,
        });
      }
    }

    if (snapshot.recentPermissionAudit.length > 0) {
      sections.push({ type: 'title', content: 'Permission Audit' });
      for (const entry of snapshot.recentPermissionAudit.slice(0, MAX_ROWS)) {
        const outcome = entry.approved === undefined ? 'pending' : entry.approved ? 'approved' : 'denied';
        sections.push({
          type: 'text',
          content: `${entry.tool}  ${entry.riskLevel.toUpperCase()}  ${outcome}`,
          style: entry.approved === undefined ? WARN : entry.approved ? undefined : BAD,
        });
        sections.push({ type: 'text', content: `  ${entry.summary}`, style: DIM });
      }
    }

    if (snapshot.lintFindings.length > 0) {
      sections.push({ type: 'title', content: 'Policy Lint' });
      for (const finding of snapshot.lintFindings.slice(0, MAX_ROWS)) {
        sections.push({
          type: 'text',
          content: `${finding.severity.toUpperCase()} ${finding.message}`,
          style: finding.severity === 'error' ? BAD : finding.severity === 'warn' ? WARN : undefined,
        });
      }
    }

    if (preflight) {
      sections.push({ type: 'title', content: 'Preflight Review' });
      sections.push({
        type: 'text',
        content: `Status ${preflight.status.toUpperCase()}  Issues ${preflight.issueCount}  Generated ${fmtTime(preflight.generatedAt)}`,
        style: preflight.status === 'pass' ? GOOD : preflight.status === 'warn' ? WARN : BAD,
      });
      sections.push({ type: 'text', content: preflight.summary, style: DIM });
      for (const issue of preflight.issues.slice(0, 4)) {
        sections.push({
          type: 'text',
          content: `${issue.severity.toUpperCase()} ${issue.message}`,
          style: issue.severity === 'error' ? BAD : issue.severity === 'warn' ? WARN : undefined,
        });
      }
    }

    if (snapshot.lastSimulationSummary) {
      const sim = snapshot.lastSimulationSummary;
      sections.push({ type: 'title', content: 'Simulation Samples' });
      sections.push({
        type: 'text',
        content: `Mode ${sim.mode}  Diverged ${sim.divergentScenarios}/${sim.totalScenarios}  Allowed(actual/sim) ${sim.allowedByActual}/${sim.allowedBySimulated}`,
        style: sim.divergentScenarios > 0 ? WARN : GOOD,
      });
      for (const result of sim.results.slice(0, 4)) {
        sections.push({
          type: 'text',
          content: `${result.scenario.label}  ${(result.authoritativeDecision.allowed ? 'allow' : 'deny').toUpperCase()}  ${result.diverged ? (result.divergenceType ?? 'diverged') : 'aligned'}`,
          style: result.diverged ? WARN : (result.authoritativeDecision.allowed ? GOOD : BAD),
        });
      }
    }

    return {
      title: 'Policy And Governance',
      width: 84,
      sections,
      hints: ['s simulate', 'f preflight', 'l lint', 'p promote', 'b rollback'],
    };
  };

  const runPolicy = (sub: string): ModalAction => () => ({ kind: 'runCommand', command: `/policy ${sub}` });

  return {
    name: 'policy',
    title: 'Policy And Governance',
    refresh: () => { /* pull-based: getSnapshot() is read lazily in buildConfig, nothing to reload */ },
    buildConfig,
    rowIds: () => [],
    actions: {
      simulate: runPolicy('simulate'),
      preflight: runPolicy('preflight'),
      lint: runPolicy('lint'),
      // "Rollout" in the WO brief maps to the registry's actual subcommand —
      // there is no separate `/policy rollout`.
      promote: runPolicy('promote'),
      rollback: runPolicy('rollback'),
    },
  };
}

/**
 * Deterministic golden fixture. A fixed `PolicyModalSnapshot` literal
 * covering every rendered branch in one shot: an active current bundle, a
 * simulating candidate, a 3-rule diff, a blocked divergence gate with one
 * command-prefix and one tool-class breakdown row, one rolled-back history
 * entry, one denied permission-audit entry, one lint warning, one preflight
 * review with one issue, and one diverged simulation sample. No Date.now()
 * anywhere — every timestamp is a fixed ISO string or epoch-ms literal.
 */
export function policyModalGoldenSurface(): BoundModalSurface {
  const currentBundle: PolicyBundleVersion = {
    bundle: { bundleId: 'bundle-current-1', issuedAt: '2023-11-01T00:00:00.000Z', payload: { version: 1, rules: [] }, issuer: 'ops' },
    provenance: { policyBundleId: 'bundle-current-1', signatureStatus: 'unsigned', provenanceSource: 'local-file', issuedAt: '2023-11-01T00:00:00.000Z', issuer: 'ops' },
    rules: [{ id: 'rule-base-1', type: 'prefix', origin: 'managed', effect: 'allow', toolPattern: '*', commandPrefixes: [] }],
    state: 'active',
    loadedAt: '2023-11-01T00:00:00.000Z',
    activatedAt: '2023-11-01T00:05:00.000Z',
  };

  const candidateBundle: PolicyBundleVersion = {
    bundle: { bundleId: 'bundle-candidate-1', issuedAt: '2023-11-10T00:00:00.000Z', payload: { version: 1, rules: [] }, issuer: 'ops' },
    provenance: { policyBundleId: 'bundle-candidate-1', signatureStatus: 'unsigned', provenanceSource: 'local-file', issuedAt: '2023-11-10T00:00:00.000Z', issuer: 'ops' },
    rules: [
      { id: 'rule-base-1', type: 'prefix', origin: 'managed', effect: 'allow', toolPattern: '*', commandPrefixes: [] },
      { id: 'rule-added-1', type: 'network-scope', origin: 'user', effect: 'deny', toolPattern: 'Fetch', hostPatterns: ['*'] },
    ],
    state: 'simulating',
    loadedAt: '2023-11-10T00:00:00.000Z',
  };

  const historyBundle: PolicyBundleVersion = {
    bundle: { bundleId: 'bundle-prev-1', issuedAt: '2023-10-01T00:00:00.000Z', payload: { version: 1, rules: [] } },
    provenance: { policyBundleId: 'bundle-prev-1', signatureStatus: 'unsigned', provenanceSource: 'local-file', issuedAt: '2023-10-01T00:00:00.000Z' },
    rules: [],
    state: 'rolled-back',
    loadedAt: '2023-10-01T00:00:00.000Z',
    activatedAt: '2023-10-01T00:05:00.000Z',
    rolledBackAt: '2023-11-01T00:00:00.000Z',
  };

  const removedRule = { id: 'rule-removed-1', type: 'path-scope' as const, origin: 'user' as const, effect: 'deny' as const, toolPattern: '*', pathPatterns: ['/tmp/**'] };
  const addedRule = { id: 'rule-added-1', type: 'network-scope' as const, origin: 'user' as const, effect: 'deny' as const, toolPattern: 'Fetch', hostPatterns: ['*'] };
  const changedFrom = { id: 'rule-base-1', type: 'prefix' as const, origin: 'managed' as const, effect: 'allow' as const, toolPattern: '*', commandPrefixes: [] };
  const changedTo = { id: 'rule-base-1', type: 'prefix' as const, origin: 'managed' as const, effect: 'deny' as const, toolPattern: '*', commandPrefixes: [] };

  const stats = (divergenceRate: number): DivergenceStats => ({
    total: 1,
    byType: { 'allow-vs-deny': 1, 'deny-vs-allow': 0, 'reason-mismatch': 0 },
    divergenceRate,
    totalEvaluations: 20,
  });

  const decision = (allowed: boolean, reason: 'DEFAULT_ALLOW' | 'RULE_DENY_USER') => ({
    allowed,
    reason,
    sourceLayer: 'policy' as const,
    toolName: 'Fetch',
    args: {},
    timestamp: 1700000000000,
    evaluationTrace: [],
  });

  const snapshot: PolicyModalSnapshot = {
    current: currentBundle,
    candidate: candidateBundle,
    history: [historyBundle],
    diff: {
      fromBundleId: 'bundle-current-1',
      toBundleId: 'bundle-candidate-1',
      removed: [removedRule],
      added: [addedRule],
      changed: [{ ruleId: 'rule-base-1', from: changedFrom, to: changedTo }],
      unchanged: [],
      totalChanges: 3,
    },
    divergence: {
      report: {
        overall: stats(0.1),
        byToolClass: { network: stats(0.1) },
        byCommandPrefix: { 'fetch ': stats(0.1) },
        byMode: {},
        records: [],
      },
      mode: 'warn-on-divergence',
      gate: { status: 'blocked', divergenceRate: 0.1, threshold: 0.05, totalEvaluations: 20, message: 'divergence rate 10.0% exceeds 5.0% threshold' },
      trend: [{ ts: 1700000000000, divergenceRate: 0.1, totalEvaluations: 20, totalDivergences: 2, gatePassing: false }],
      capturedAt: 1700000000000,
    },
    recentPermissionAudit: [{
      callId: 'call-1',
      tool: 'Bash',
      category: 'exec',
      approved: false,
      riskLevel: 'high',
      classification: 'destructive',
      summary: 'blocked rm -rf outside sandbox root',
      reasons: ['path escape'],
      requestedAt: 1700000000000,
      decidedAt: 1700000001000,
    }],
    lintFindings: [{ severity: 'warn', ruleId: 'rule-added-1', message: 'toolPattern "Fetch" combined with a wildcard host pattern is broad; consider narrowing.' }],
    lastSimulationSummary: {
      simulatedAt: '2023-11-10T00:00:00.000Z',
      mode: 'warn-on-divergence',
      totalScenarios: 4,
      divergentScenarios: 1,
      allowedByActual: 3,
      allowedBySimulated: 2,
      results: [{
        scenario: { id: 'scenario-1', label: 'fetch external API', toolName: 'Fetch', args: {} },
        actualDecision: decision(true, 'DEFAULT_ALLOW'),
        simulatedDecision: decision(false, 'RULE_DENY_USER'),
        authoritativeDecision: decision(true, 'DEFAULT_ALLOW'),
        diverged: true,
        divergenceType: 'allow-vs-deny',
      }],
    },
    lastPreflightReview: {
      generatedAt: '2023-11-10T00:10:00.000Z',
      status: 'warn',
      summary: '1 candidate rule broadens network access beyond the current policy.',
      issueCount: 1,
      issues: [{ severity: 'warn', source: 'policy', message: 'candidate rule rule-added-1 denies all outbound network access', detail: 'verify this is intentional before promotion' }],
    },
    capturedAt: '2023-11-10T00:15:00.000Z',
  };

  return bindPolicyModal({ policyRuntimeState: { getSnapshot: () => snapshot } });
}
