#!/usr/bin/env bun
/**
 * CI eval gate script.
 *
 * Runs the standing-gate suite set (GATE_SUITES, the all-floors-passing
 * scenarios the SDK designates for gating, as distinct from BUILTIN_SUITES'
 * branch-exercising scenarios), compares results against the stored
 * baseline, and exits with code 1 if any suite has regressions above
 * threshold or fails an absolute per-dimension floor.
 *
 * Usage:
 *   bun run eval:gate [--suite <name>] [--baseline <path>] [--save-baseline]
 *
 * Options:
 *   --suite <name>      Only run a specific suite (default: all).
 *   --baseline <path>   Path to baseline JSON (default: .goodvibes/eval/baseline.json).
 *   --save-baseline     Save the fresh results as the new baseline after comparison.
 */

import { EvalRunner } from '@/runtime/index.ts';
import { GATE_SUITES } from '@/runtime/index.ts';
import { loadBaseline, captureBaseline, writeBaseline } from '@/runtime/index.ts';
import { formatSuiteResult, formatGateResult } from '@/runtime/index.ts';
import { formatScorecard } from '@/runtime/index.ts';

// ── Argument parsing ──────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

const suiteArg = getArg('--suite');
const baselineFile = getArg('--baseline') ?? '.goodvibes/eval/baseline.json';
const saveBaseline = argv.includes('--save-baseline');
const verbose = argv.includes('--verbose') || argv.includes('-v');
const projectRoot = process.cwd();

// ── Suite selection ───────────────────────────────────────────────────────────

const suitesToRun: Array<[string, typeof GATE_SUITES[string]]> =
  suiteArg && GATE_SUITES[suiteArg]
    ? [[suiteArg, GATE_SUITES[suiteArg]!]]
    : Object.entries(GATE_SUITES);

if (suiteArg && !GATE_SUITES[suiteArg]) {
  console.error(`eval-gate: Unknown suite "${suiteArg}". Available: ${Object.keys(GATE_SUITES).join(', ')}`);
  process.exit(2);
}

// ── CI fail-closed baseline guard ────────────────────────────────────────────
//
// In CI (env CI=true), a missing or corrupt baseline is a hard failure.
// A missing baseline means no prior run set a reference, gating against
// nothing is fail-open and meaningless. Generate a baseline locally with:
//   bun run eval:baseline
// then commit .goodvibes/eval/baseline.json before running in CI.
//
// Outside CI, a missing baseline triggers auto-capture-and-continue so
// local first-runs are convenient.

const isCI = process.env['CI'] === 'true';

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('='.repeat(72));
console.log(`Eval Gate: running ${suitesToRun.length} suite(s)`);
console.log(`Baseline: ${baselineFile}`);
console.log('='.repeat(72));

const runner = new EvalRunner({ regressionThreshold: 5 });
const baseline = await loadBaseline(baselineFile, projectRoot);

if (!baseline && isCI) {
  console.error(`
Eval Gate: FAILED; baseline not found at ${baselineFile}.

Running without a baseline in CI is fail-open: the gate cannot detect
regressions if there is no prior reference to compare against.

To generate a baseline:
  bun run eval:baseline          # runs suites, saves .goodvibes/eval/baseline.json

Commit that file and re-run CI.
`);
  process.exit(1);
}

const freshResults = [];
let anyGateFailed = false;

for (const [name, scenarios] of suitesToRun) {
  console.log(`\nRunning suite: ${name} (${scenarios.length} scenarios)`);
  const fresh = await runner.runSuite(name, scenarios);
  freshResults.push(fresh);

  console.log(formatSuiteResult(fresh));

  if (verbose) {
    for (const r of fresh.results) {
      console.log(formatScorecard(r.scorecard));
    }
  }

  const gate = runner.evaluateGate(fresh, baseline);
  console.log(formatGateResult(gate));

  if (!gate.passed) {
    anyGateFailed = true;
  }
}

// ── Baseline persistence ──────────────────────────────────────────────────────

if (saveBaseline || !baseline) {
  const label = `run-${new Date().toISOString().slice(0, 10)}`;
  const newBaseline = captureBaseline(label, freshResults);
  try {
    await writeBaseline(baselineFile, newBaseline, projectRoot);
    console.log(`\nBaseline saved to ${baselineFile} (label: ${label})`);
  } catch (err) {
    console.error(`Warning: could not save baseline: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Exit ──────────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(72));
if (anyGateFailed) {
  console.error('Eval Gate: FAILED; one or more suites have regressions.');
  process.exit(1);
} else {
  console.log('Eval Gate: PASSED; all suites within regression threshold.');
  process.exit(0);
}
