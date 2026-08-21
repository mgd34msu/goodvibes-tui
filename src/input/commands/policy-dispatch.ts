import type { CommandContext } from '../command-registry.ts';
import {
  buildPolicyPreflightReview,
  createPermissionSimulator,
  lintPolicyConfig,
  runPolicySimulationScenarios,
} from '@/runtime/index.ts';
import { DivergenceDashboard } from '@/runtime/index.ts';
import type { PolicyRuntimeState } from '@/runtime/index.ts';
import { createUnsignedBundle } from '@/runtime/index.ts';
import type { PolicyBundlePayload } from '@/runtime/index.ts';
import type { PolicyRule, PermissionsConfig, DivergenceStats } from '@/runtime/index.ts';
import { requireShellPaths } from './runtime-services.ts';

function getPolicyState(ctx?: CommandContext): PolicyRuntimeState {
  const policyRuntimeState = ctx?.extensions.policyRuntimeState;
  if (!policyRuntimeState) {
    throw new Error('Policy runtime state is not available in this runtime.');
  }
  return policyRuntimeState;
}

function getRegistry(ctx?: CommandContext) {
  return ctx?.extensions.policyRegistry ?? getPolicyState(ctx).getRegistry();
}

function fmtRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function bundleSummary(
  label: string,
  version: { bundle: { bundleId: string; issuedAt: string; issuer?: string }; state: string; rules: PolicyRule[] },
): string {
  const issuer = version.bundle.issuer ? ` issuer=${version.bundle.issuer}` : '';
  const ts = version.bundle.issuedAt.replace('T', ' ').slice(0, 19);
  return `${label}: ${version.bundle.bundleId} (${ts}${issuer}) [${version.rules.length} rules, ${version.state}]`;
}

async function handleLoad(args: string[], context: CommandContext): Promise<void> {
  const registry = getRegistry(context);
  const policyState = getPolicyState(context);
  const bundleId = args[0] ?? `policy-candidate-${Date.now()}`;
  const ruleCount = Math.max(0, parseInt(args[1] ?? '0', 10));
  const rules: PolicyRule[] = [];
  for (let i = 0; i < ruleCount; i++) {
    rules.push({
      type: 'prefix',
      id: `${bundleId}-rule-${i}`,
      description: `Demo rule ${i}`,
      origin: 'user',
      effect: 'allow',
      toolPattern: '*',
      commandPrefixes: [],
    });
  }
  const payload: PolicyBundlePayload = {
    version: 1,
    rules,
    description: `Loaded via /policy load at ${new Date().toISOString()}`,
  };
  const bundle = createUnsignedBundle(bundleId, payload);
  const result = registry.loadCandidate(bundle);
  if (!result.ok) {
    context.print(`[policy] Load failed: ${result.error ?? 'unknown error'}`);
    return;
  }
  const candidate = registry.getCandidate();
  if (candidate) {
    policyState.notify();
    context.print(bundleSummary('[policy] Candidate loaded', candidate));
    context.print('[policy] Next: run `/policy simulate` to collect divergence evidence before promoting.');
  }
}

async function handleSimulate(args: string[], context: CommandContext): Promise<void> {
  const registry = getRegistry(context);
  const policyState = getPolicyState(context);
  const projectRoot = requireShellPaths(context).workingDirectory;
  const candidate = registry.getCandidate();
  const current = registry.getCurrent();
  if (!candidate) {
    context.print('[policy] No candidate bundle loaded. Run `/policy load <bundle-id>` first.');
    return;
  }
  if (!registry.markSimulating()) {
    context.print(`[policy] Cannot start simulation: candidate is in "${candidate.state}" state. Only a freshly loaded ("loaded") candidate can be simulated.`);
    return;
  }
  const currentConfig: PermissionsConfig = {
    mode: 'default',
    projectRoot,
    rules: current?.rules ?? [],
    defaultEffect: 'allow',
  };
  const candidateForSim = registry.getCandidate();
  if (!candidateForSim) {
    throw new Error('Invariant: candidate disappeared after markSimulating()');
  }
  const candidateConfig: PermissionsConfig = {
    mode: 'default',
    projectRoot,
    rules: candidateForSim.rules,
    defaultEffect: 'allow',
  };
  const modeArg = args[0];
  const simulationMode = modeArg === 'enforce' ? 'enforce' : modeArg === 'silent' ? 'simulation-only' : 'warn-on-divergence';
  const simulator = createPermissionSimulator(currentConfig, candidateConfig, simulationMode, {});
  const dashboard = new DivergenceDashboard(simulator, simulationMode, { threshold: 0.05 });
  policyState.setDashboard(dashboard);
  context.print(`[policy] Simulation started in "${simulationMode}" mode. Evaluations will be tracked against candidate bundle "${candidate.bundle.bundleId}".`);
  context.print('[policy] Use `/policy diff` to compare rules. When ready, run `/policy promote` to enforce (requires gate passing).');
  const report = simulator.getDivergenceReport();
  const gateResult = dashboard.checkEnforceGate();
  const scenarioSummary = runPolicySimulationScenarios(simulator);
  registry.attachSimulationReport(report, gateResult);
  policyState.recordSimulationSummary(scenarioSummary);
  const candidate2 = registry.getCandidate();
  policyState.notify();
  context.print(`[policy] Baseline divergence: ${fmtRate(report.overall.divergenceRate)} (${report.overall.total} divergences / ${report.overall.totalEvaluations} evaluations). Gate: ${gateResult.status}.`);
  context.print(`[policy] Scenario run: ${scenarioSummary.totalScenarios} samples, ${scenarioSummary.divergentScenarios} diverged, ${scenarioSummary.allowedByActual}/${scenarioSummary.allowedBySimulated} allowed (actual/candidate).`);
  if (candidate2) context.print(bundleSummary('[policy] Candidate state', candidate2));
}

async function handleDiff(_args: string[], context: CommandContext): Promise<void> {
  const registry = getRegistry(context);
  const diff = registry.diff();
  if (!diff) {
    const current = registry.getCurrent();
    const candidate = registry.getCandidate();
    if (!current) context.print('[policy] No active bundle. Load a bundle with `/policy load`.');
    else if (!candidate) context.print('[policy] No candidate bundle. Load a candidate with `/policy load`.');
    else context.print('[policy] Diff unavailable.');
    return;
  }
  context.print(`[policy] Diff: ${diff.fromBundleId} → ${diff.toBundleId} (${diff.totalChanges} change${diff.totalChanges !== 1 ? 's' : ''})`);
  context.print(`  Added:    ${diff.added.length} rule${diff.added.length !== 1 ? 's' : ''}`);
  context.print(`  Removed:  ${diff.removed.length} rule${diff.removed.length !== 1 ? 's' : ''}`);
  context.print(`  Changed:  ${diff.changed.length} rule${diff.changed.length !== 1 ? 's' : ''}`);
  context.print(`  Unchanged: ${diff.unchanged.length} rule${diff.unchanged.length !== 1 ? 's' : ''}`);
  if (diff.added.length > 0) {
    context.print('  [+] Added rules:');
    for (const r of diff.added) context.print(`      + ${r.id} (${r.type}, effect=${r.effect})`);
  }
  if (diff.removed.length > 0) {
    context.print('  [-] Removed rules:');
    for (const r of diff.removed) context.print(`      - ${r.id} (${r.type}, effect=${r.effect})`);
  }
  if (diff.changed.length > 0) {
    context.print('  [~] Changed rules:');
    for (const c of diff.changed) context.print(`      ~ ${c.ruleId}`);
  }
  const dashboard = getPolicyState(context).getDashboard();
  if (dashboard) {
    const snap = dashboard.getSnapshot();
    const report = snap.report;
    const prefixEntries = Object.entries(report.byCommandPrefix);
    if (prefixEntries.length > 0) {
      context.print('  [divergence by command prefix]');
      for (const [prefix, stats] of prefixEntries) {
        context.print(`      ${prefix}: ${fmtRate(stats.divergenceRate)} (${stats.total}/${stats.totalEvaluations})`);
      }
    }
    const classEntries = Object.entries(report.byToolClass) as Array<[string, DivergenceStats]>;
    if (classEntries.length > 0) {
      context.print('  [divergence by tool class]');
      for (const [cls, stats] of classEntries) {
        if (!stats) continue;
        context.print(`      ${cls}: ${fmtRate(stats.divergenceRate)} (${stats.total}/${stats.totalEvaluations})`);
      }
    }
  }
}

async function handleLint(_args: string[], context: CommandContext): Promise<void> {
  const registry = getRegistry(context);
  const current = registry.getCurrent();
  const candidate = registry.getCandidate();
  if (!current && !candidate) {
    context.print('[policy] No policy bundles loaded. Use `/policy load` to begin.');
    return;
  }
  const findings = [
    ...(current ? lintPolicyConfig({ mode: 'custom', rules: current.rules }).map((finding) => ({ scope: 'current', ...finding })) : []),
    ...(candidate ? lintPolicyConfig({ mode: 'custom', rules: candidate.rules }).map((finding) => ({ scope: 'candidate', ...finding })) : []),
  ];
  if (findings.length === 0) {
    context.print('[policy] No lint findings for the active or candidate bundles.');
    return;
  }
  context.print(`[policy] Lint findings (${findings.length}):`);
  for (const finding of findings) {
    context.print(`  [${finding.scope}] ${finding.severity.toUpperCase()} ${finding.ruleId ? `${finding.ruleId}: ` : ''}${finding.message}`);
  }
}

async function handlePreflight(_args: string[], context: CommandContext): Promise<void> {
  const registry = getRegistry(context);
  const policyState = getPolicyState(context);
  const current = registry.getCurrent();
  const candidate = registry.getCandidate();
  const lintFindings = [
    ...(current ? lintPolicyConfig({ mode: 'custom', rules: current.rules }) : []),
    ...(candidate ? lintPolicyConfig({ mode: 'custom', rules: candidate.rules }) : []),
  ];
  const review = buildPolicyPreflightReview({
    config: context.platform.config,
    lintFindings,
    mcpServers: context.extensions.mcpRegistry.listServerSecurity().map((server) => ({
      serverName: server.name,
      trustMode: server.trustMode,
      role: server.role,
      allowedPaths: server.allowedPaths,
      allowedHosts: server.allowedHosts,
    })),
  });
  policyState.recordPreflightReview(review);
  context.print(`[policy] Preflight review: ${review.status.toUpperCase()} (${review.issueCount} issue${review.issueCount === 1 ? '' : 's'})`);
  context.print(`[policy] ${review.summary}`);
  for (const issue of review.issues.slice(0, 8)) {
    const subject = issue.serverName ? ` ${issue.serverName}` : '';
    const detail = issue.detail ? `: ${issue.detail}` : '';
    context.print(`  [${issue.severity.toUpperCase()}] ${issue.source}${subject}: ${issue.message}${detail}`);
  }
}

async function handlePromote(args: string[], context: CommandContext): Promise<void> {
  const registry = getRegistry(context);
  const policyState = getPolicyState(context);
  const force = args.includes('--force');
  if (force) {
    context.print('[policy] WARNING: --force bypasses the divergence gate. This is not safe for production use.');
  }
  const result = registry.promote(force);
  if (!result.ok) {
    context.print(`[policy] Promotion blocked: ${result.error}`);
    if (result.gate) {
      context.print(`[policy] Gate: ${result.gate.status}; divergence rate ${result.gate.divergenceRate !== undefined ? fmtRate(result.gate.divergenceRate) : 'unknown'} (threshold ${fmtRate(result.gate.threshold)}, ${result.gate.totalEvaluations} evaluations).`);
    }
    return;
  }
  const current = registry.getCurrent();
  context.print(`[policy] Promoted: "${result.bundleId}" is now the active enforcement policy.`);
  if (result.gate) {
    context.print(`[policy] Gate at promotion: ${result.gate.status}; divergence rate ${result.gate.divergenceRate !== undefined ? fmtRate(result.gate.divergenceRate) : 'unknown'} (threshold ${fmtRate(result.gate.threshold)}).`);
  }
  if (current) context.print(bundleSummary('[policy] Active bundle', current));
  policyState.notify();
}

async function handleRollback(_args: string[], context: CommandContext): Promise<void> {
  const registry = getRegistry(context);
  const policyState = getPolicyState(context);
  const result = registry.rollback();
  if (!result.ok) {
    context.print(`[policy] Rollback failed: ${result.error}`);
    return;
  }
  const current = registry.getCurrent();
  context.print(`[policy] Rolled back to bundle "${result.restoredBundleId}".`);
  if (current) context.print(bundleSummary('[policy] Active bundle', current));
  policyState.setDashboard(null);
  policyState.notify();
  context.print('[policy] Simulation dashboard cleared. Run `/policy simulate` for the restored bundle.');
}

async function handleStatus(_args: string[], context: CommandContext): Promise<void> {
  const registry = getRegistry(context);
  const policyState = getPolicyState(context);
  const current = registry.getCurrent();
  const candidate = registry.getCandidate();
  const history = registry.getHistory();
  if (!current && !candidate) {
    context.print('[policy] No policy bundles loaded. Use `/policy load` to begin.');
    return;
  }
  if (current) context.print(bundleSummary('[policy] Current (enforced)', current));
  if (candidate) context.print(bundleSummary('[policy] Candidate', candidate));
  context.print(`[policy] History: ${history.length} previous bundle(s).`);
  const dashboard = policyState.getDashboard();
  if (dashboard) {
    const snap = dashboard.getSnapshot();
    context.print(`[policy] Divergence gate: ${snap.gate.status}; ${snap.gate.divergenceRate !== undefined ? fmtRate(snap.gate.divergenceRate) : fmtRate(snap.report.overall.divergenceRate)} (${snap.report.overall.totalEvaluations} evaluations).`);
  } else {
    context.print('[policy] No active simulation dashboard.');
  }
}

export function renderPolicyUsage(): string {
  return [
    'Usage: /policy <subcommand>',
    '  /policy                        — open the policy/governance panel',
    '  load <bundle-id> [rule-count]  — Load a candidate bundle',
    '  simulate [mode]               — Run simulation (silent|warn|enforce)',
    '  diff                          — Show rule diff (current vs candidate)',
    '  lint                          — Lint active and candidate bundles',
    '  preflight                     — Review proactive policy and MCP risk state',
    '  promote [--force]             — Promote candidate to enforcement',
    '  rollback                      — Restore the previous active bundle',
    '  status                        — Show current policy state',
  ].join('\n');
}

// W6 command-path parity: the policy modal dropped its 'r' (record a
// divergence-dashboard trend sample) action because the panel used to call
// this._state.recordTrendEntry() directly and /policy had no equivalent verb.
// This exposes it as a thin wrapper: recordTrendEntry() forwards to the attached
// DivergencePanel, so it only captures a sample while a simulation dashboard is
// active, reported honestly here rather than silently no-op'ing.
function handleRecordTrend(_args: string[], context: CommandContext): void {
  const policyState = getPolicyState(context);
  if (!policyState.getDashboard()) {
    context.print('[policy] No active simulation dashboard; nothing to sample. Run `/policy simulate` first, then `/policy record-trend`.');
    return;
  }
  policyState.recordTrendEntry();
  const snap = policyState.getSnapshot();
  context.print(`[policy] Recorded a divergence trend sample (${snap.divergence?.trend.length ?? 0} point(s) total).`);
}

export async function dispatchPolicyCommand(args: string[], context: CommandContext): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'load':
      await handleLoad(rest, context);
      break;
    case 'simulate':
    case 'sim':
      await handleSimulate(rest, context);
      break;
    case 'diff':
      await handleDiff(rest, context);
      break;
    case 'lint':
      await handleLint(rest, context);
      break;
    case 'preflight':
    case 'pf':
      await handlePreflight(rest, context);
      break;
    case 'promote':
      await handlePromote(rest, context);
      break;
    case 'rollback':
    case 'rb':
      await handleRollback(rest, context);
      break;
    case 'status':
    case 'st':
      await handleStatus(rest, context);
      break;
    case 'record-trend':
    case 'trend':
      handleRecordTrend(rest, context);
      break;
    default:
      context.print(renderPolicyUsage());
      break;
  }
}
