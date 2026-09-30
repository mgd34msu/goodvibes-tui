/**
 * perf-frame-bench.ts, Shared headless frame micro-benchmark.
 *
 * Exports `runFrameBench()` which measures Compositor.composite() throughput
 * on a synthetic 80×24 frame, for scripts/perf-check.ts (the release gate).
 *
 * NEVER launches the interactive TUI binary. Stubs stdout entirely.
 *
 * Budgets live in scripts/perf-baseline.json, written by `bun run perf:baseline`.
 */

import { performance } from 'node:perf_hooks';
import { Compositor } from '../src/renderer/compositor.ts';
import { createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';

/** Frame bench configuration, change here to update both gate and test. */
export const FRAME_BENCH_CONFIG = {
  width: 80,
  height: 24,
  warmupFrames: 10,
  measureFrames: 200,
} as const;

/** Result of a single frame bench run. */
export interface FrameBenchResult {
  p95: number;
  p99: number;
  samples: number[];
}

/**
 * Run the frame micro-benchmark headlessly.
 * Creates a Compositor with a stubbed stdout, drives FRAME_BENCH_CONFIG.measureFrames
 * full-repaint frames (diff reset each frame), and returns sorted percentiles.
 */
export async function runFrameBench(): Promise<FrameBenchResult> {
  const { width, height, warmupFrames, measureFrames } = FRAME_BENCH_CONFIG;

  // Stub stdout so composite() does not emit escape codes
  const stubStdout = {
    write: () => true,
    columns: width,
    rows: height,
  } as unknown as NodeJS.WriteStream;

  const comp = new Compositor(stubStdout);

  // Synthetic frame: visible chars, named color string (Cell.fg is string)
  const makeLine = (w: number): Line => {
    const ln = createEmptyLine(w);
    for (let i = 0; i < w; i++) {
      const cell = ln[i]!;
      cell.char = String.fromCharCode(65 + (i % 26));
      cell.fg = '7';
    }
    return ln;
  };

  const headerRows = 2;
  const footerRows = 2;
  const viewportRows = height - headerRows - footerRows;

  const syntheticLine = makeLine(width);
  const req = {
    width,
    height,
    header: Array.from({ length: headerRows }, () => syntheticLine) as Line[],
    viewport: Array.from({ length: viewportRows }, () => syntheticLine) as Line[],
    footer: Array.from({ length: footerRows }, () => syntheticLine) as Line[],
  };

  // Warmup: allow JIT and module cache to settle
  for (let i = 0; i < warmupFrames; i++) comp.composite(req);

  // Measure: each frame resets the diff so the compositor must re-emit every cell
  const samples: number[] = [];
  for (let i = 0; i < measureFrames; i++) {
    comp.resetDiff();
    const t0 = performance.now();
    comp.composite(req);
    samples.push(performance.now() - t0);
  }

  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)]!;
  const p99 = samples[Math.floor(samples.length * 0.99)]!;
  return { p95, p99, samples };
}
