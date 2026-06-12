/**
 * perf-check.ts — CI performance budget gate.
 *
 * Runs REAL headless measurements and compares against committed baselines.
 * Fails closed in CI when the baseline is absent (cannot gate against nothing).
 *
 * Measurements (all headless — never launches the interactive TUI binary):
 *   startup.renderer_load_ms  — cold import of compositor + buffer + grid
 *   frame.composite_p95_ms    — Compositor.composite() p95 over 200 full-repaint frames
 *   frame.composite_p99_ms    — Compositor.composite() p99 over 200 full-repaint frames
 *
 * Budgets are ratchets — set just above measured reality, tighten as perf improves.
 * Regenerate the baseline and budgets with:
 *   bun run perf:baseline
 *
 * Usage:
 *   bun run scripts/perf-check.ts          # normal gate
 *   GOODVIBES_PERF_SAVE_BASELINE=1 bun run scripts/perf-check.ts  # capture + save baseline
 *
 * Exit codes:
 *   0 — all budgets passed
 *   1 — one or more budgets exceeded, or baseline absent in CI
 */

import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runFrameBench, FRAME_BUDGETS } from './perf-frame-bench.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BudgetResult {
  metric: string;
  measured: number;
  budget: number;
  unit: string;
  passed: boolean;
}

interface PerfBaseline {
  _comment?: string;
  startup: {
    renderer_load_ms: { measured_max_ms: number; budget_ms: number; note: string };
  };
  frame: {
    composite_p95_ms: { measured_ms: number; budget_ms: number; note: string };
    composite_p99_ms: { measured_ms: number; budget_ms: number; note: string };
  };
}

// ---------------------------------------------------------------------------
// Baseline loading
// ---------------------------------------------------------------------------

const BASELINE_PATH = resolve(import.meta.dirname, 'perf-baseline.json');
const isCI = process.env['CI'] === 'true';
const saveBaseline = process.env['GOODVIBES_PERF_SAVE_BASELINE'] === '1';

function loadBaseline(): PerfBaseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as PerfBaseline;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fail-closed baseline guard (mirrors eval-gate pattern from cd8f14fa)
// ---------------------------------------------------------------------------
//
// In CI (env CI=true), a missing or corrupt baseline is a hard failure.
// A missing baseline means the gate has no reference to compare against —
// passing unconditionally is fail-open and meaningless (the bug this fixes).
//
// Locally, a missing baseline triggers auto-measure-and-save so first-runs
// are convenient. This matches eval-gate's local convenience behaviour.

const baseline = loadBaseline();

if (!baseline && isCI) {
  process.stderr.write(`
Perf Gate: FAILED — baseline not found at ${BASELINE_PATH}.

Running without a baseline in CI is fail-open: the gate cannot detect
performance regressions if there is no reference to compare against.

To generate a baseline locally:
  bun run perf:baseline        # measures, saves scripts/perf-baseline.json

Commit that file and re-run CI.
`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Startup measurement: renderer module cold-load
// ---------------------------------------------------------------------------
// Measures time to import compositor + buffer + grid from a fresh bun process.
// This is the cheapest proxy for "renderer subsystem is not catastrophically slow".
// We spawn a child process so each run is a genuine cold import.

async function measureStartup(): Promise<number> {
  const { spawnSync } = await import('node:child_process');
  const script = [
    `import { performance } from 'node:perf_hooks';`,
    `const t0 = performance.now();`,
    `await import('./src/renderer/compositor.ts');`,
    `await import('./src/renderer/buffer.ts');`,
    `await import('./src/types/grid.ts');`,
    `const t1 = performance.now();`,
    `process.stdout.write(String(Math.round((t1 - t0) * 10) / 10));`,
  ].join(' ');

  const result = spawnSync(
    process.execPath,
    ['--eval', script],
    { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf-8', timeout: 30_000 },
  );

  if (result.status !== 0) {
    throw new Error(`startup probe failed: ${result.stderr}`);
  }
  return parseFloat(result.stdout);
}

// ---------------------------------------------------------------------------
// Frame bench: Compositor.composite() throughput
// ---------------------------------------------------------------------------
// Delegates to the shared perf-frame-bench.ts helper so the gate script and
// the test in performance-gate.test.ts always measure identically.
// Change bench methodology in perf-frame-bench.ts — it updates both consumers.
// NEVER launches the interactive TUI binary.

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('='.repeat(72));
  console.log('Perf Gate — measuring headless benchmarks');
  console.log(new Date().toISOString());
  console.log('='.repeat(72));

  // --- Run measurements ---
  let startupMs: number;
  let frameP95: number;
  let frameP99: number;

  try {
    process.stdout.write('\nMeasuring startup (renderer module load)... ');
    startupMs = await measureStartup();
    console.log(`${startupMs.toFixed(1)}ms`);
  } catch (err) {
    console.error(`startup probe error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  try {
    process.stdout.write('Measuring frame bench (200 full-repaint frames)... ');
    const frame = await runFrameBench();
    frameP95 = frame.p95;
    frameP99 = frame.p99;
    console.log(`p95=${frameP95.toFixed(2)}ms  p99=${frameP99.toFixed(2)}ms`);
  } catch (err) {
    console.error(`frame bench error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // --- Load or establish budgets ---
  const budgets = baseline ?? {
    startup: { renderer_load_ms: { measured_max_ms: startupMs, budget_ms: Math.ceil(startupMs * 2 / 50) * 50, note: 'auto' } },
    frame: {
      composite_p95_ms: { measured_ms: frameP95, budget_ms: FRAME_BUDGETS.p95_ms, note: 'auto' },
      composite_p99_ms: { measured_ms: frameP99, budget_ms: FRAME_BUDGETS.p99_ms, note: 'auto' },
    },
  };

  // --- Evaluate against budgets ---
  const results: BudgetResult[] = [
    {
      metric: 'startup.renderer_load_ms',
      measured: startupMs,
      budget: budgets.startup.renderer_load_ms.budget_ms,
      unit: 'ms',
      passed: startupMs <= budgets.startup.renderer_load_ms.budget_ms,
    },
    {
      metric: 'frame.composite_p95_ms',
      measured: frameP95,
      budget: budgets.frame.composite_p95_ms.budget_ms ?? FRAME_BUDGETS.p95_ms,
      unit: 'ms',
      passed: frameP95 <= budgets.frame.composite_p95_ms.budget_ms,
    },
    {
      metric: 'frame.composite_p99_ms',
      measured: frameP99,
      budget: budgets.frame.composite_p99_ms.budget_ms ?? FRAME_BUDGETS.p99_ms,
      unit: 'ms',
      passed: frameP99 <= budgets.frame.composite_p99_ms.budget_ms,
    },
  ];

  // --- Format report ---
  const W_METRIC = 30;
  const W_VAL = 12;
  const sep = '-'.repeat(W_METRIC + W_VAL * 2 + 14);
  console.log(`\n${'Metric'.padEnd(W_METRIC)} | ${'Measured'.padEnd(W_VAL)} | ${'Budget'.padEnd(W_VAL)} | Status`);
  console.log(sep);
  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    const measured = `${r.measured.toFixed(2)}${r.unit}`;
    const budget = `${r.budget}${r.unit}`;
    console.log(`${r.metric.padEnd(W_METRIC)} | ${measured.padEnd(W_VAL)} | ${budget.padEnd(W_VAL)} | ${status}`);
  }
  console.log(sep);

  const anyFailed = results.some(r => !r.passed);

  // --- Save baseline (local auto-capture or explicit flag) ---
  if (saveBaseline || (!baseline && !isCI)) {
    const newBaseline: PerfBaseline = {
      _comment: `Perf baseline — generated ${new Date().toISOString().slice(0, 10)} on ${process.platform}-${process.arch}. Ratchet rule: budgets set at ceil(measured_max × 2) for startup, and at the stated SLO for frame timing (p95 ≤ 16ms). Regenerate with: bun run perf:baseline`,
      startup: {
        renderer_load_ms: {
          measured_max_ms: Math.ceil(startupMs),
          budget_ms: Math.ceil(startupMs * 2 / 50) * 50,
          note: 'Time to cold-import compositor + buffer + grid from a fresh bun process. Budget = ceil(max × 2), rounded to 50ms. Ratchet: tighten budget when measured_max drops below budget/2.',
        },
      },
      frame: {
        composite_p95_ms: {
          measured_ms: Math.round(frameP95 * 100) / 100,
          budget_ms: 16,
          note: 'Compositor.composite() p95 over 200 full-repaint frames, 80×24 synthetic content. Budget = stated frame SLO (16ms). Ratchet: tighten when measured drops below budget/3.',
        },
        composite_p99_ms: {
          measured_ms: Math.round(frameP99 * 100) / 100,
          budget_ms: Math.ceil(frameP99 * 4 / 10) * 10,
          note: 'Compositor.composite() p99 over 200 frames. Budget = ceil(measured × 4), rounded to 10ms. Ratchet: tighten when measured drops below budget/3.',
        },
      },
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2) + '\n', 'utf-8');
    console.log(`\nBaseline saved to ${BASELINE_PATH}`);
    console.log('Commit this file before running in CI.');
  }

  // --- Exit ---
  console.log('');
  if (anyFailed) {
    console.error('Perf Gate: FAILED — one or more budgets exceeded.');
    process.exit(1);
  } else {
    console.log('Perf Gate: PASSED — all budgets within threshold.');
    process.exit(0);
  }
}

await main();
