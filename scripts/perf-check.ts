#!/usr/bin/env bun
/**
 * perf-check.ts, the headless performance gate. A release gate, not a per-push
 * check: it runs in release-gates.yml (nightly, on demand, and before an
 * armed release), never in ci.yml.
 *
 * Metrics (all measured in-process or in a child bun, never the TUI binary):
 *   startup.renderer_load_ms   cold import of compositor + buffer + sdk types
 *   frame.composite_p95_ms     Compositor.composite() p95 over 200 full repaints
 *   frame.composite_p99_ms     the same run's p99
 *   <line bench ids>           Line[] builders above the compositor
 *                              (transcript build/append/resize, markdown, code
 *                              blocks, overlay open); see perf-line-bench.ts
 *
 * Budgets come from scripts/perf-baseline.json and nowhere else. Each budget
 * is the worst gate statistic seen across BASELINE_RUNS full measurement runs,
 * times HEADROOM, rounded up to two decimals. HEADROOM covers a GitHub runner
 * being slower than the machine that wrote the baseline; it is one number for
 * every metric instead of a hand-picked multiple per metric.
 *
 * Usage:
 *   bun run perf:check       measure once and compare with the baseline
 *   bun run perf:baseline    measure BASELINE_RUNS times and rewrite the baseline
 *
 * Exit: 0 all within budget; 1 a budget exceeded, a metric has no budget, or
 * the baseline is missing.
 */

import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runFrameBench } from './perf-frame-bench.ts';
import { runLineBenches, type LineBenchCase } from './perf-line-bench.ts';

/** Multiple of the worst measured value a budget allows. */
export const HEADROOM = 2;
/** Full measurement runs a baseline takes the worst value from. */
export const BASELINE_RUNS = 3;

const BASELINE_PATH = resolve(import.meta.dirname, 'perf-baseline.json');
const saveBaseline = process.env['GOODVIBES_PERF_SAVE_BASELINE'] === '1';

interface MetricEntry {
  /** Worst gate statistic seen across the baseline runs. */
  readonly measured_ms: number;
  readonly budget_ms: number;
  readonly stat: 'value' | 'p50' | 'p95' | 'p99';
}

interface PerfBaseline {
  readonly _comment: string;
  readonly headroom: number;
  readonly runs: number;
  readonly metrics: Record<string, MetricEntry>;
}

// Large allocation-heavy builds are gated on the stable median; small,
// high-sample-count builders on p95. A single GC pause landing in a 12-sample
// tail would otherwise decide the heavy ones.
const LINE_GATE_STAT: Readonly<Record<string, 'p50' | 'p95'>> = {
  'transcript.build_1k_ms': 'p50',
  'transcript.append_one_ms': 'p50',
  'transcript.resize_1k_ms': 'p50',
};

function lineStat(id: string): 'p50' | 'p95' {
  return LINE_GATE_STAT[id] ?? 'p95';
}

interface Measurement {
  readonly value: number;
  readonly stat: MetricEntry['stat'];
}

function measureStartup(): number {
  const script = [
    `import { performance } from 'node:perf_hooks';`,
    `const t0 = performance.now();`,
    `await import('./src/renderer/compositor.ts');`,
    `await import('./src/renderer/buffer.ts');`,
    `await import('@pellux/goodvibes-sdk/platform/types');`,
    `const t1 = performance.now();`,
    `process.stdout.write(String(Math.round((t1 - t0) * 10) / 10));`,
  ].join(' ');
  const result = spawnSync(process.execPath, ['--eval', script], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`startup probe failed: ${result.stderr}`);
  return parseFloat(result.stdout);
}

async function measureAll(): Promise<Map<string, Measurement>> {
  const out = new Map<string, Measurement>();
  out.set('startup.renderer_load_ms', { value: measureStartup(), stat: 'value' });
  const frame = await runFrameBench();
  out.set('frame.composite_p95_ms', { value: frame.p95, stat: 'p95' });
  out.set('frame.composite_p99_ms', { value: frame.p99, stat: 'p99' });
  const lines: LineBenchCase[] = await runLineBenches();
  for (const c of lines) {
    const stat = lineStat(c.id);
    out.set(c.id, { value: stat === 'p50' ? c.timeP50Ms : c.timeP95Ms, stat });
  }
  return out;
}

/** Budget for a worst-seen value: HEADROOM times it, rounded up to 0.01 ms. */
export function budgetFor(worstMs: number, headroom = HEADROOM): number {
  return Math.ceil(worstMs * headroom * 100) / 100;
}

function loadBaseline(): PerfBaseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as PerfBaseline;
    return parsed.metrics ? parsed : null;
  } catch {
    return null;
  }
}

async function writeBaseline(): Promise<void> {
  const worst = new Map<string, Measurement>();
  for (let run = 1; run <= BASELINE_RUNS; run += 1) {
    process.stdout.write(`baseline run ${run}/${BASELINE_RUNS}... `);
    const measured = await measureAll();
    for (const [id, m] of measured) {
      const prior = worst.get(id);
      if (!prior || m.value > prior.value) worst.set(id, m);
    }
    console.log('done');
  }
  const metrics: Record<string, MetricEntry> = {};
  for (const [id, m] of [...worst].sort(([a], [b]) => a.localeCompare(b))) {
    const measured = Math.round(m.value * 1000) / 1000;
    metrics[id] = { measured_ms: measured, budget_ms: budgetFor(measured), stat: m.stat };
  }
  const baseline: PerfBaseline = {
    _comment: `Written by \`bun run perf:baseline\` on ${new Date().toISOString().slice(0, 10)}, ${process.platform}-${process.arch}. budget_ms = measured_ms (worst of ${BASELINE_RUNS} runs) x ${HEADROOM}, rounded up to 0.01 ms.`,
    headroom: HEADROOM,
    runs: BASELINE_RUNS,
    metrics,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
  console.log(`\nBaseline written to ${BASELINE_PATH}`);
  for (const [id, e] of Object.entries(metrics)) {
    console.log(`  ${id.padEnd(30)} measured ${e.measured_ms}ms  budget ${e.budget_ms}ms`);
  }
}

async function check(): Promise<number> {
  const baseline = loadBaseline();
  if (!baseline) {
    console.error(`Perf gate: no baseline at ${BASELINE_PATH}. Write one with \`bun run perf:baseline\`.`);
    return 1;
  }
  const started = performance.now();
  const measured = await measureAll();
  let failed = 0;
  console.log(`\n${'Metric'.padEnd(30)} | ${'Measured'.padEnd(12)} | ${'Budget'.padEnd(12)} | Status`);
  for (const [id, m] of measured) {
    const entry = baseline.metrics[id];
    const ok = entry !== undefined && m.value <= entry.budget_ms;
    if (!ok) failed += 1;
    const budget = entry ? `${entry.budget_ms}ms` : 'none';
    console.log(`${id.padEnd(30)} | ${`${m.value.toFixed(2)}ms`.padEnd(12)} | ${budget.padEnd(12)} | ${ok ? 'PASS' : 'FAIL'}`);
  }
  for (const id of Object.keys(baseline.metrics)) {
    if (!measured.has(id)) {
      failed += 1;
      console.log(`${id.padEnd(30)} | ${'not measured'.padEnd(12)} | ${`${baseline.metrics[id]!.budget_ms}ms`.padEnd(12)} | FAIL`);
    }
  }
  console.log(`\n${failed === 0 ? 'Perf gate: PASSED' : `Perf gate: FAILED (${failed} metric(s))`} in ${Math.round(performance.now() - started)}ms.`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  if (saveBaseline) {
    await writeBaseline();
    process.exit(0);
  }
  process.exit(await check());
}
