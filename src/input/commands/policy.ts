/**
 * Section 5.3 — /policy command handler.
 *
 * Implements the Policy-as-Code panel commands:
 *
 *   /policy load    — Load a signed policy bundle as the candidate
 *   /policy simulate — Run simulation pipeline (actual vs candidate)
 *   /policy diff    — Show structural diff between current and candidate bundles
 *   /policy promote — Promote candidate to enforcement (requires gate passing)
 *   /policy rollback — Restore the previous active bundle
 *
 * Invariant: No enforcement without simulation evidence.
 * Divergence trends visible by command class/prefix via the diagnostics panel.
 */

import type { SlashCommand, CommandContext } from '../command-registry.ts';
import { PolicyRegistry } from '../../runtime/permissions/policy-registry.ts';
import {
  createPermissionSimulator,
} from '../../runtime/permissions/index.ts';
import { DivergenceDashboard } from '../../runtime/permissions/divergence-dashboard.ts';
import { createUnsignedBundle } from '../../runtime/permissions/policy-loader.ts';
import type { PolicyBundlePayload } from '../../runtime/permissions/policy-loader.ts';
import type { PolicyRule, PermissionsV2Config, DivergenceStats } from '../../runtime/permissions/types.ts';

// ── Module-level registry singleton ────────────────────────────────────────────
//
// The registry is intentionally module-scoped so that all /policy subcommands
// operate on the same instance across invocations within a session.
// When ctx.policyRegistry is provided (injected via CommandContext), it takes
// precedence so the runtime can own the lifecycle; the module-level fallback
// exists for standalone use (e.g. ops consoles without a full app context).

let _registry: PolicyRegistry | null = null;
let _dashboard: DivergenceDashboard | null = null;

function getRegistry(ctx?: CommandContext): PolicyRegistry {
  if (ctx?.policyRegistry) return ctx.policyRegistry;
  if (!_registry) _registry = new PolicyRegistry();
  return _registry;
}

// ── Subcommand helpers ─────────────────────────────────────────────────────────

/**
 * Format a divergence rate as a percentage string.
 */
function fmtRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Render a compact summary line for a policy bundle version.
 */
function bundleSummary(
  label: string,
  version: { bundle: { bundleId: string; issuedAt: string; issuer?: string }; state: string; rules: PolicyRule[] },
): string {
  const issuer = version.bundle.issuer ? ` issuer=${version.bundle.issuer}` : '';
  const ts = version.bundle.issuedAt.replace('T', ' ').slice(0, 19);
  return `${label}: ${version.bundle.bundleId} (${ts}${issuer}) [${version.rules.length} rules, ${version.state}]`;
}

// ── /policy load ───────────────────────────────────────────────────────────────

async function handleLoad(
  args: string[],
  context: CommandContext,
): Promise<void> {
  const registry = getRegistry(context);

  // In a production integration, args[0] would be a path or bundle ID to load.
  // Here we demonstrate the loading path with an inline bundle constructed from
  // the args. Real usage: deserialise from disk/remote and call loadCandidate().
  //
  // Usage: /policy load [bundle-id] [rule-count]
  //   Loads an unsigned test bundle for demonstration / ops use.

  const bundleId = args[0] ?? `policy-candidate-${Date.now()}`;
  const ruleCount = Math.max(0, parseInt(args[1] ?? '0', 10));

  // Build a minimal demo payload — in real usage callers supply a full bundle
  const rules: PolicyRule[] = [];
  // Placeholder: generates `ruleCount` passthrough prefix rules for demo
  for (let i = 0; i < ruleCount; i++) {
    const prefixRule: PolicyRule = {
      type: 'prefix',
      id: `${bundleId}-rule-${i}`,
      description: `Demo rule ${i}`,
      origin: 'user',
      effect: 'allow',
      toolPattern: '*',
      commandPrefixes: [],
    };
    rules.push(prefixRule);
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
    context.print(bundleSummary('[policy] Candidate loaded', candidate));
    context.print(
      '[policy] Next: run `/policy simulate` to collect divergence evidence before promoting.',
    );
  }
}

// ── /policy simulate ───────────────────────────────────────────────────────────

async function handleSimulate(
  args: string[],
  context: CommandContext,
): Promise<void> {
  const registry = getRegistry(context);
  const candidate = registry.getCandidate();
  const current = registry.getCurrent();

  if (!candidate) {
    context.print('[policy] No candidate bundle loaded. Run `/policy load <bundle-id>` first.');
    return;
  }

  if (!registry.markSimulating()) {
    context.print(
      `[policy] Cannot start simulation: candidate is in "${candidate.state}" state. ` +
      'Only a freshly loaded ("loaded") candidate can be simulated.',
    );
    return;
  }

  // Build evaluator configs from bundle rules
  const currentConfig: PermissionsV2Config = {
    mode: 'default',
    rules: current?.rules ?? [],
    defaultEffect: 'allow',
  };
  const candidateForSim = registry.getCandidate();
  if (!candidateForSim) {
    throw new Error('Invariant: candidate disappeared after markSimulating()');
  }
  const candidateConfig: PermissionsV2Config = {
    mode: 'default',
    rules: candidateForSim.rules,
    defaultEffect: 'allow',
  };

  // Determine simulation mode from args or default to warn-on-divergence
  const modeArg = args[0];
  const simulationMode =
    modeArg === 'enforce'
      ? 'enforce'
      : modeArg === 'silent'
        ? 'simulation-only'
        : 'warn-on-divergence';

  const simulator = createPermissionSimulator(
    currentConfig,
    candidateConfig,
    simulationMode,
    {},
  );

  // Build or reset the divergence dashboard
  _dashboard = new DivergenceDashboard(simulator, simulationMode, { threshold: 0.05 });

  context.print(
    `[policy] Simulation started in "${simulationMode}" mode. ` +
    `Evaluations will be tracked against candidate bundle "${candidate.bundle.bundleId}".`,
  );
  context.print(
    '[policy] Use `/policy diff` to compare rules. ' +
    'When ready, run `/policy promote` to enforce (requires gate passing).',
  );

  // Immediately take a baseline divergence snapshot
  const report = simulator.getDivergenceReport();
  const gateResult = _dashboard.checkEnforceGate();

  // Attach the simulation report (transitions candidate to 'promoting' state)
  registry.attachSimulationReport(report, gateResult);

  const candidate2 = registry.getCandidate();
  context.print(
    `[policy] Baseline divergence: ${fmtRate(report.overall.divergenceRate)} ` +
    `(${report.overall.total} divergences / ${report.overall.totalEvaluations} evaluations). ` +
    `Gate: ${gateResult.status}.`,
  );

  if (candidate2) {
    context.print(bundleSummary('[policy] Candidate state', candidate2));
  }
}

// ── /policy diff ───────────────────────────────────────────────────────────────

async function handleDiff(
  _args: string[],
  context: CommandContext,
): Promise<void> {
  const registry = getRegistry(context);
  const diff = registry.diff();

  if (!diff) {
    const current = registry.getCurrent();
    const candidate = registry.getCandidate();
    if (!current) {
      context.print('[policy] No active bundle. Load a bundle with `/policy load`.');
    } else if (!candidate) {
      context.print('[policy] No candidate bundle. Load a candidate with `/policy load`.');
    } else {
      context.print('[policy] Diff unavailable.');
    }
    return;
  }

  context.print(
    `[policy] Diff: ${diff.fromBundleId} → ${diff.toBundleId} ` +
    `(${diff.totalChanges} change${diff.totalChanges !== 1 ? 's' : ''})`,
  );
  context.print(`  Added:    ${diff.added.length} rule${diff.added.length !== 1 ? 's' : ''}`);
  context.print(`  Removed:  ${diff.removed.length} rule${diff.removed.length !== 1 ? 's' : ''}`);
  context.print(`  Changed:  ${diff.changed.length} rule${diff.changed.length !== 1 ? 's' : ''}`);
  context.print(`  Unchanged: ${diff.unchanged.length} rule${diff.unchanged.length !== 1 ? 's' : ''}`);

  if (diff.added.length > 0) {
    context.print('  [+] Added rules:');
    for (const r of diff.added) {
      context.print(`      + ${r.id} (${r.type}, effect=${r.effect})`);
    }
  }
  if (diff.removed.length > 0) {
    context.print('  [-] Removed rules:');
    for (const r of diff.removed) {
      context.print(`      - ${r.id} (${r.type}, effect=${r.effect})`);
    }
  }
  if (diff.changed.length > 0) {
    context.print('  [~] Changed rules:');
    for (const c of diff.changed) {
      context.print(`      ~ ${c.ruleId}`);
    }
  }

  // Show divergence by prefix/class if dashboard is available
  if (_dashboard) {
    const snap = _dashboard.getSnapshot();
    const report = snap.report;
    const byPrefix = report.byCommandPrefix;
    const prefixEntries = Object.entries(byPrefix);
    if (prefixEntries.length > 0) {
      context.print('  [divergence by command prefix]');
      for (const [prefix, stats] of prefixEntries) {
        context.print(
          `      ${prefix}: ${fmtRate(stats.divergenceRate)} ` +
          `(${stats.total}/${stats.totalEvaluations})`,
        );
      }
    }
    const byClass = report.byToolClass;
    const classEntries = Object.entries(byClass) as Array<[string, DivergenceStats]>;
    if (classEntries.length > 0) {
      context.print('  [divergence by tool class]');
      for (const [cls, stats] of classEntries) {
        if (!stats) continue;
        context.print(
          `      ${cls}: ${fmtRate(stats.divergenceRate)} ` +
          `(${stats.total}/${stats.totalEvaluations})`,
        );
      }
    }
  }
}

// ── /policy promote ────────────────────────────────────────────────────────────

async function handlePromote(
  args: string[],
  context: CommandContext,
): Promise<void> {
  const registry = getRegistry(context);

  // --force bypasses gate check (not for production use)
  const force = args.includes('--force');

  if (force) {
    context.print(
      '[policy] WARNING: --force bypasses the divergence gate. ' +
      'This is not safe for production use.',
    );
  }

  const result = registry.promote(force);

  if (!result.ok) {
    context.print(`[policy] Promotion blocked: ${result.error}`);
    if (result.gate) {
      context.print(
        `[policy] Gate: ${result.gate.status} — ` +
        `divergence rate ${result.gate.divergenceRate !== undefined ? fmtRate(result.gate.divergenceRate) : 'unknown'} ` +
        `(threshold ${fmtRate(result.gate.threshold)}, ` +
        `${result.gate.totalEvaluations} evaluations).`,
      );
    }
    return;
  }

  const current = registry.getCurrent();
  context.print(
    `[policy] Promoted: "${result.bundleId}" is now the active enforcement policy.`,
  );
  if (result.gate) {
    context.print(
      `[policy] Gate at promotion: ${result.gate.status} — ` +
      `divergence rate ${result.gate.divergenceRate !== undefined ? fmtRate(result.gate.divergenceRate) : 'unknown'} ` +
      `(threshold ${fmtRate(result.gate.threshold)}).`,
    );
  }
  if (current) {
    context.print(bundleSummary('[policy] Active bundle', current));
  }
}

// ── /policy rollback ───────────────────────────────────────────────────────────

async function handleRollback(
  _args: string[],
  context: CommandContext,
): Promise<void> {
  const registry = getRegistry(context);
  const result = registry.rollback();

  if (!result.ok) {
    context.print(`[policy] Rollback failed: ${result.error}`);
    return;
  }

  const current = registry.getCurrent();
  context.print(
    `[policy] Rolled back to bundle "${result.restoredBundleId}".`,
  );
  if (current) {
    context.print(bundleSummary('[policy] Active bundle', current));
  }

  // Clear any active dashboard after rollback
  _dashboard = null;
  context.print('[policy] Simulation dashboard cleared. Run `/policy simulate` for the restored bundle.');
}

// ── /policy status (bonus) ─────────────────────────────────────────────────────

async function handleStatus(
  _args: string[],
  context: CommandContext,
): Promise<void> {
  const registry = getRegistry(context);
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

  if (_dashboard) {
    const snap = _dashboard.getSnapshot();
    context.print(
      `[policy] Divergence gate: ${snap.gate.status} — ` +
      `${snap.gate.divergenceRate !== undefined ? fmtRate(snap.gate.divergenceRate) : fmtRate(snap.report.overall.divergenceRate)} ` +
      `(${snap.report.overall.totalEvaluations} evaluations).`,
    );
  } else {
    context.print('[policy] No active simulation dashboard.');
  }
}

// ── Top-level command definition ───────────────────────────────────────────────

/**
 * policyCommand — The `/policy` slash command.
 *
 * Routes to subcommand handlers based on args[0].
 */
export const policyCommand: SlashCommand = {
  name: 'policy',
  aliases: ['pol'],
  description: 'Manage versioned policy bundles (load, simulate, diff, promote, rollback).',
  usage: '<subcommand> [args]',
  argsHint: 'load|simulate|diff|promote|rollback|status',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
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

      default: {
        const usage = [
          'Usage: /policy <subcommand>',
          '  load <bundle-id> [rule-count]  — Load a candidate bundle',
          '  simulate [mode]               — Run simulation (silent|warn|enforce)',
          '  diff                          — Show rule diff (current vs candidate)',
          '  promote [--force]             — Promote candidate to enforcement',
          '  rollback                      — Restore the previous active bundle',
          '  status                        — Show current policy state',
        ].join('\n');
        context.print(usage);
        break;
      }
    }
  },
};
