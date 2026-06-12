import { describe, expect, test } from "bun:test";
import {
  FUNCS_FLOOR,
  LINES_FLOOR,
  evaluateGate,
  parseCoverageSummary,
  parseFailCount,
  runCoverageGate,
} from "../../../scripts/coverage-gate.ts";

function table(funcs: string, lines: string): string {
  return [
    "some test noise",
    "--------------|---------|---------|-------------------",
    "File          | % Funcs | % Lines | Uncovered Line #s",
    "--------------|---------|---------|-------------------",
    "All files     |   " + funcs + " |   " + lines + " |",
    "--------------|---------|---------|-------------------",
    " 8125 pass",
    " 5 fail",
    "Ran 8130 tests across 510 files.",
    "",
  ].join("\n");
}

describe("coverage-gate parsing", () => {
  test("parses the All files row", () => {
    const summary = parseCoverageSummary(table("73.14", "76.80"));
    expect(summary).toEqual({ funcsPct: 73.14, linesPct: 76.8 });
  });

  test("returns null when no table is present", () => {
    expect(parseCoverageSummary("8125 pass\n0 fail\n")).toBeNull();
  });

  test("parses fail count from the run summary", () => {
    expect(parseFailCount(table("73.14", "76.80"))).toBe(5);
    expect(parseFailCount("all good\n 12 pass\n 0 fail\n")).toBe(0);
    expect(parseFailCount("no summary here")).toBeNull();
  });
});

describe("coverage-gate evaluation", () => {
  test("passes at the measured baseline", () => {
    const result = evaluateGate(table("73.14", "76.80"));
    expect(result.pass).toBe(true);
    expect(result.lines.at(-1)).toBe("coverage-gate: PASS");
  });

  test("fails below the functions floor", () => {
    const result = evaluateGate(table(String(FUNCS_FLOOR - 1), "76.80"));
    expect(result.pass).toBe(false);
  });

  test("fails below the lines floor", () => {
    const result = evaluateGate(table("73.14", String(LINES_FLOOR - 1)));
    expect(result.pass).toBe(false);
  });

  test("fails loudly when the table is missing", () => {
    const result = evaluateGate("crash before reporting");
    expect(result.pass).toBe(false);
    expect(result.lines[0]).toContain("no coverage table");
  });

  test("reports interference failures without gating on them", () => {
    const result = evaluateGate(table("73.14", "76.80"));
    expect(result.pass).toBe(true);
    expect(result.lines.join("\n")).toContain("single-process");
  });
});

describe("coverage-gate spawn path", () => {
  test("runCoverageGate evaluates output from a real spawned process", async () => {
    const fake = "All files     |   80.00 |   85.00 |\n 0 fail\n";
    const result = await runCoverageGate({
      cmd: ["bun", "-e", "console.log(" + JSON.stringify(fake) + ")"],
    });
    expect(result.pass).toBe(true);
    expect(result.lines.at(-1)).toBe("coverage-gate: PASS");
  });

  test("runCoverageGate fails loudly and reports exit code when no table is emitted", async () => {
    const result = await runCoverageGate({
      cmd: ["bun", "-e", "console.log(123)"],
    });
    expect(result.pass).toBe(false);
    expect(result.lines.join("\n")).toContain("no coverage table");
    expect(result.lines.join("\n")).toContain("child exit code");
  });

  test(
    "bun test --coverage emits a coverage table under the repo bunfig",
    async () => {
      // Empirical guard for the bun 1.3.10 trap where a bunfig
      // "coverage = false" overrides the CLI --coverage flag. If that key
      // ever returns to bunfig.toml, this test fails. The child must target
      // src/test/scripts/coverage-smoke (whose test imports non-test source):
      // bun only renders the coverage table when at least one non-test file
      // is in the coverage set.
      const proc = Bun.spawn(
        ["bun", "test", "--coverage", "src/test/scripts/coverage-smoke"],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      const summary = parseCoverageSummary(stdout + "\n" + stderr);
      expect(summary).not.toBeNull();
    },
    30000,
  );
});
