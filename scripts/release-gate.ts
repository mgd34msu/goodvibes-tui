#!/usr/bin/env bun
/**
 * Release Gate Runner, Phase 9, Section 10
 *
 * Executes all 5 release gate test suites and reports pass/fail per gate.
 * Each gate must pass in full for a release to proceed.
 *
 * Usage:
 *   bun run scripts/release-gate.ts [--gate <name>] [--verbose]
 *
 * Gates:
 *   safety       , Permission + tool safety paths auditable and fail-closed
 *   determinism  , Replay + reconnect avoid duplicate side effects
 *   performance  , SLO + budget gates pass under representative load
 *   operability  , Diagnostics, replay, forensics are operator-usable
 *   product      , All post-v3 capabilities activatable + coherent
 */

import { spawnSync } from 'child_process';
import { join } from 'path';

// ── Gate definitions ────────────────────────────────────────────────────────

const GATE_FILES: Record<string, string> = {
  safety:       'src/test/release-gates/safety-gate.test.ts',
  determinism:  'src/test/release-gates/determinism-gate.test.ts',
  performance:  'src/test/release-gates/performance-gate.test.ts',
  operability:  'src/test/release-gates/operability-gate.test.ts',
  product:      'src/test/release-gates/product-quality-gate.test.ts',
};

const GATE_DESCRIPTIONS: Record<string, string> = {
  safety:      'Permission + tool safety paths are auditable and fail-closed',
  determinism: 'Replay + reconnect avoid duplicate side effects',
  performance: 'SLO + budget gates pass under representative load',
  operability: 'Diagnostics, replay, forensics are operator-usable',
  product:     'All post-v3 capabilities activatable + coherent',
};

// ── Argument parsing ────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

const gateArg = getArg('--gate');
const verbose = argv.includes('--verbose') || argv.includes('-v');
const root = process.cwd();

// ── Gate selection ──────────────────────────────────────────────────────────

let gatesToRun: Array<[string, string]>;

if (gateArg) {
  if (!GATE_FILES[gateArg]) {
    console.error(
      `release-gate: Unknown gate "${gateArg}". Available: ${Object.keys(GATE_FILES).join(', ')}`
    );
    process.exit(2);
  }
  gatesToRun = [[gateArg, GATE_FILES[gateArg]!]];
} else {
  gatesToRun = Object.entries(GATE_FILES);
}

// ── Runner ─────────────────────────────────────────────────────────────────

interface GateResult {
  name: string;
  description: string;
  passed: boolean;
  durationMs: number;
  output: string;
  errorOutput: string;
}

function runGate(name: string, filePath: string): GateResult {
  const fullPath = join(root, filePath);
  const start = Date.now();

  const result = spawnSync(
    'bun',
    ['test', fullPath],
    {
      cwd: root,
      encoding: 'utf-8',
      timeout: 60_000,
    }
  );

  const durationMs = Date.now() - start;
  const passed = result.status === 0;

  return {
    name,
    description: GATE_DESCRIPTIONS[name] ?? '',
    passed,
    durationMs,
    output: result.stdout ?? '',
    errorOutput: result.stderr ?? '',
  };
}

// ── Report helpers ─────────────────────────────────────────────────────────

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

function formatResult(r: GateResult): string {
  const statusStr = r.passed ? '[PASS]' : '[FAIL]';
  const duration = `${r.durationMs}ms`;
  return `  ${statusStr}  ${padRight(r.name, 14)}  ${padRight(duration, 8)}  ${r.description}`;
}

// ── Main ───────────────────────────────────────────────────────────────────

console.log('='.repeat(80));
console.log('Release Gate Runner: goodvibes-tui');
console.log(`Running ${gatesToRun.length} gate(s)`);
console.log('='.repeat(80));
console.log();

const results: GateResult[] = [];
let anyFailed = false;

for (const [name, filePath] of gatesToRun) {
  process.stdout.write(`Running gate: ${name}... `);
  const result = runGate(name, filePath);
  results.push(result);

  if (!result.passed) anyFailed = true;

  console.log(result.passed ? 'PASS' : 'FAIL');

  if (verbose || !result.passed) {
    if (result.output) {
      console.log('\n--- stdout ---');
      console.log(result.output.trim());
    }
    if (result.errorOutput) {
      console.log('\n--- stderr ---');
      console.log(result.errorOutput.trim());
    }
    console.log();
  }
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log();
console.log('='.repeat(80));
console.log('Gate Summary');
console.log('='.repeat(80));

for (const r of results) {
  console.log(formatResult(r));
}

console.log();

const passed = results.filter(r => r.passed).length;
const total = results.length;

console.log(`Result: ${passed}/${total} gates passed`);
console.log();

if (anyFailed) {
  console.error('Release Gate: FAILED; one or more gates did not pass.');
  console.error('All gates must pass before release.');
  process.exit(1);
} else {
  console.log('Release Gate: PASSED; all gates cleared. Release is safe to proceed.');
  process.exit(0);
}
