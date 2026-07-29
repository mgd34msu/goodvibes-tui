/**
 * perf-coalesce-bench.ts — render-call coalescing, before/after.
 *
 * Measures the streaming-burst scenario the acceptance calls for: N ticks,
 * each firing K render requests (the direct render() fan-out main.ts drives on the
 * streaming/turn hot path).
 *
 *   BEFORE  — every request runs a synchronous Compositor.composite() the instant
 *             it is called (the pre-coalescing behavior). K composites per tick.
 *   AFTER   — the same requests route through the same-tick microtask coalescer
 *             (createRenderScheduler from @pellux/goodvibes-terminal-shell, the same
 *             one main.ts wires up); each tick composites exactly once.
 *
 * Reports composites-per-burst (an exact count) and wall time for both. The frame
 * content is fixed WITHIN a tick and changes BETWEEN ticks, so — exactly as in
 * production — the first composite of a tick emits a diff and the redundant
 * within-tick composites hit the compositor's clean-diff cheap path. That makes
 * the wall-time delta the honest, bounded "(k-1) redundant composites per tick"
 * win the baseline report predicts, not an inflated full-repaint figure.
 *
 * Not a gate — a measurement harness. Never launches the interactive TUI.
 *
 *   Run: bun run scripts/perf-coalesce-bench.ts
 */

import { performance } from 'node:perf_hooks';
import { Compositor } from '../src/renderer/compositor.ts';
import { createEmptyLine } from '../src/types/grid.ts';
import { createRenderScheduler } from '@pellux/goodvibes-terminal-shell';
import type { Line } from '../src/types/grid.ts';

const WIDTH = 80;
const HEIGHT = 24;
const TICKS = 3000; // simulated streaming ticks (one per token/event)
const RENDERS_PER_TICK = 7; // direct render() fan-out per tick (report: ~k renders/tick)

function makeLine(w: number): Line {
  const ln = createEmptyLine(w);
  for (let i = 0; i < w; i++) {
    const cell = ln[i]!;
    cell.char = String.fromCharCode(65 + (i % 26));
    cell.fg = '7';
  }
  return ln;
}

const stubStdout = {
  write: () => true,
  columns: WIDTH,
  rows: HEIGHT,
} as unknown as NodeJS.WriteStream;

const headerRows = 2;
const footerRows = 2;
const viewportRows = HEIGHT - headerRows - footerRows;
const header = Array.from({ length: headerRows }, () => makeLine(WIDTH)) as Line[];
const footer = Array.from({ length: footerRows }, () => makeLine(WIDTH)) as Line[];
// One mutable viewport whose tail cell changes per tick, so each tick is a genuinely
// new frame (first composite emits) while within-tick repeats are clean (cheap path).
const viewport = Array.from({ length: viewportRows }, () => makeLine(WIDTH)) as Line[];
const tailLine = viewport[viewportRows - 1]!;

function setTickContent(tick: number): void {
  tailLine[tick % WIDTH]!.char = String.fromCharCode(33 + (tick % 90));
}

function buildReq() {
  return { width: WIDTH, height: HEIGHT, header, viewport, footer } as Parameters<Compositor['composite']>[0];
}

/** BEFORE: synchronous fan-out — K composites per tick. */
function runSynchronous(): { composites: number; ms: number } {
  const comp = new Compositor(stubStdout);
  const req = buildReq();
  let composites = 0;
  const renderNow = (): void => { comp.composite(req); composites++; };
  // warmup
  for (let k = 0; k < 20; k++) renderNow();
  composites = 0;
  const t0 = performance.now();
  for (let tick = 0; tick < TICKS; tick++) {
    setTickContent(tick);
    for (let k = 0; k < RENDERS_PER_TICK; k++) renderNow();
  }
  return { composites, ms: performance.now() - t0 };
}

/** AFTER: same-tick coalesced — 1 composite per tick. */
function runCoalesced(): { composites: number; ms: number } {
  const comp = new Compositor(stubStdout);
  const req = buildReq();
  let composites = 0;
  const renderNow = (): void => { comp.composite(req); composites++; };
  // Deterministic per-tick flush: collect queued flushes, drain at the tick boundary.
  const queue: Array<() => void> = [];
  const scheduler = createRenderScheduler(renderNow, (flush) => { queue.push(flush); });
  const drain = (): void => { const batch = queue.splice(0); for (const f of batch) f(); };
  // warmup
  for (let k = 0; k < 20; k++) renderNow();
  composites = 0;
  const t0 = performance.now();
  for (let tick = 0; tick < TICKS; tick++) {
    setTickContent(tick);
    for (let k = 0; k < RENDERS_PER_TICK; k++) scheduler.schedule();
    drain(); // tick boundary: the burst flushes as one composite
  }
  return { composites, ms: performance.now() - t0 };
}

function main(): void {
  const before = runSynchronous();
  const after = runCoalesced();

  const compositesPerBurstBefore = before.composites / TICKS;
  const compositesPerBurstAfter = after.composites / TICKS;
  const msPerTickBefore = before.ms / TICKS;
  const msPerTickAfter = after.ms / TICKS;

  console.log('render-call coalescing — streaming-burst bench');
  console.log(`  config: ${TICKS} ticks x ${RENDERS_PER_TICK} render()/tick, ${WIDTH}x${HEIGHT} frame`);
  console.log('');
  console.log('  BEFORE (synchronous fan-out):');
  console.log(`    composites total      : ${before.composites}`);
  console.log(`    composites per burst  : ${compositesPerBurstBefore.toFixed(1)}`);
  console.log(`    wall time             : ${before.ms.toFixed(2)} ms  (${msPerTickBefore.toFixed(4)} ms/tick)`);
  console.log('');
  console.log('  AFTER (same-tick coalesced):');
  console.log(`    composites total      : ${after.composites}`);
  console.log(`    composites per burst  : ${compositesPerBurstAfter.toFixed(1)}`);
  console.log(`    wall time             : ${after.ms.toFixed(2)} ms  (${msPerTickAfter.toFixed(4)} ms/tick)`);
  console.log('');
  console.log(`  composite reduction     : ${before.composites} -> ${after.composites}  (${(before.composites / after.composites).toFixed(1)}x fewer)`);
  console.log(`  wall-time delta         : ${(before.ms - after.ms).toFixed(2)} ms saved over ${TICKS} ticks`);
}

main();
