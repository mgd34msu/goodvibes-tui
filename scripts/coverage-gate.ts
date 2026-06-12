/**
 * coverage-gate.ts — aggregate coverage enforcement.
 *
 * Why this exists as a separate script:
 * - "bun run test" (scripts/run-tests.ts) spawns one bun process PER FILE for
 *   TMPDIR isolation. A bunfig coverageThreshold would therefore gate each
 *   file individually, which is meaningless and spuriously fails low-coverage
 *   single files. Aggregate enforcement needs one whole-suite process.
 * - The whole-suite single-process run currently has a small number of
 *   test failures caused by cross-file interference (they pass under the
 *   per-file runner). Correctness is gated by "bun run test"; THIS script
 *   gates coverage only, and reports interference failures without
 *   pretending they are coverage problems.
 * - IMPORTANT: bunfig.toml must not set "coverage = false". In bun 1.3.10
 *   that bunfig key overrides the CLI --coverage flag, the child run emits
 *   no coverage table, and the gate fails unconditionally.
 *
 * Floors are a ratchet: set just below the measured baseline, raised as
 * coverage improves, never lowered without an explicit decision.
 */
import { join } from "node:path";

// Measured baseline 2026-06-11 (whole-suite): Funcs 73.14%, Lines 76.80%.
export const FUNCS_FLOOR = 71;
export const LINES_FLOOR = 75;

export interface CoverageSummary {
  funcsPct: number;
  linesPct: number;
}

/**
 * Parse the bun text coverage reporter output. The table ends with a row:
 *   All files          |   73.14 |   76.80 |
 * Column order is File | % Funcs | % Lines per the bun text reporter.
 */
export function parseCoverageSummary(output: string): CoverageSummary | null {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("All files")) continue;
    const cells = trimmed.split("|").map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const funcsPct = Number.parseFloat(cells[1] ?? "");
    const linesPct = Number.parseFloat(cells[2] ?? "");
    if (Number.isFinite(funcsPct) && Number.isFinite(linesPct)) {
      return { funcsPct, linesPct };
    }
  }
  return null;
}

/** Extract "N fail" from the bun run summary; null when absent. */
export function parseFailCount(output: string): number | null {
  const match = output.match(/^\s*(\d+)\s+fail\s*$/m);
  if (!match) return null;
  return Number.parseInt(match[1] ?? "", 10);
}

export interface GateResult {
  pass: boolean;
  lines: string[];
}

export function evaluateGate(output: string): GateResult {
  const lines: string[] = [];
  const summary = parseCoverageSummary(output);
  if (!summary) {
    return {
      pass: false,
      lines: ["coverage-gate: FAIL — no coverage table found in output (did the run crash before reporting?)"],
    };
  }
  const funcsOk = summary.funcsPct >= FUNCS_FLOOR;
  const linesOk = summary.linesPct >= LINES_FLOOR;
  lines.push(
    "coverage-gate: functions " + summary.funcsPct.toFixed(2) + "% (floor " + FUNCS_FLOOR + "%) — " + (funcsOk ? "OK" : "BELOW FLOOR"),
    "coverage-gate: lines     " + summary.linesPct.toFixed(2) + "% (floor " + LINES_FLOOR + "%) — " + (linesOk ? "OK" : "BELOW FLOOR"),
  );
  const failCount = parseFailCount(output);
  if (failCount !== null && failCount > 0) {
    lines.push(
      "coverage-gate: note — " + failCount + " test(s) failed in whole-suite (single-process) mode.",
      "coverage-gate: correctness is gated by bun run test (per-file isolation); single-process",
      "coverage-gate: failures indicate cross-file interference debt, tracked separately.",
    );
  }
  const pass = funcsOk && linesOk;
  lines.push(pass ? "coverage-gate: PASS" : "coverage-gate: FAIL");
  return { pass, lines };
}

export interface RunGateOptions {
  /** Command to spawn; defaults to the whole-suite coverage run. */
  cmd?: string[];
  /** Working directory; defaults to process.cwd(). */
  cwd?: string;
}

/**
 * Spawn the coverage run, combine stdout+stderr, and evaluate the gate.
 * Exported (with an injectable command) so the spawn path itself is testable.
 */
export async function runCoverageGate(options: RunGateOptions = {}): Promise<GateResult> {
  const cwd = options.cwd ?? process.cwd();
  const cmd = options.cmd ?? ["bun", "test", "--coverage", join(cwd, "src")];
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const result = evaluateGate(stdout + "\n" + stderr);
  if (!result.pass && parseCoverageSummary(stdout + "\n" + stderr) === null) {
    result.lines.push("coverage-gate: child exit code " + exitCode);
  }
  return result;
}

async function main(): Promise<void> {
  const result = await runCoverageGate();
  for (const line of result.lines) {
    console.log(line);
  }
  process.exit(result.pass ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
