#!/usr/bin/env bun
/**
 * CI eval gate script.
 *
 * Runs all built-in benchmark suites, compares results against the stored
 * baseline, and exits with code 1 if any suite has regressions above threshold.
 *
 * Usage:
 *   bun run eval:gate [--suite <name>] [--baseline <path>] [--save-baseline]
 *
 * Options:
 *   --suite <name>      Only run a specific suite (default: all).
 *   --baseline <path>   Path to baseline JSON (default: .goodvibes/eval/baseline.json).
 *   --save-baseline     Save the fresh results as the new baseline after comparison.
 */

import { EvalRunner } from '../src/runtime/eval/runner.ts';
import { BUILTIN_SUITES } from '../src/runtime/eval/suites.ts';
import { loadBaseline, captureBaseline, writeBaseline } from '../src/runtime/eval/baseline.ts';
import { formatSuiteResult, formatGateResult } from '../src/runtime/eval/format.ts';
import { formatScorecard } from '../src/runtime/eval/scorecard.ts';

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

// ── Suite selection ───────────────────────────────────────────────────────────

const suitesToRun: Array<[string, typeof BUILTIN_SUITES[string]]> =
  suiteArg && BUILTIN_SUITES[suiteArg]
    ? [[suiteArg, BUILTIN_SUITES[suiteArg]!]]
    : Object.entries(BUILTIN_SUITES);

if (suiteArg && !BUILTIN_SUITES[suiteArg]) {
  console.error(`eval-gate: Unknown suite "${suiteArg}". Available: ${Object.keys(BUILTIN_SUITES).join(', ')}`);
  process.exit(2);
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('='.repeat(72));
console.log(`Eval Gate — running ${suitesToRun.length} suite(s)`);
console.log(`Baseline: ${baselineFile}`);
console.log('='.repeat(72));

const runner = new EvalRunner({ regressionThreshold: 5 });
const baseline = await loadBaseline(baselineFile);
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
    await writeBaseline(baselineFile, newBaseline);
    console.log(`\nBaseline saved to ${baselineFile} (label: ${label})`);
  } catch (err) {
    console.error(`Warning: could not save baseline: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Exit ──────────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(72));
if (anyGateFailed) {
  console.error('Eval Gate: FAILED — one or more suites have regressions.');
  process.exit(1);
} else {
  console.log('Eval Gate: PASSED — all suites within regression threshold.');
  process.exit(0);
}
