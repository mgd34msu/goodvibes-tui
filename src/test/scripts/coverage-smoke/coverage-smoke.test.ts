import { expect, test } from "bun:test";
import { parseCoverageSummary } from "../../../../scripts/coverage-gate.ts";

// Tiny target for the coverage-gate spawn-path smoke test in
// src/test/scripts/coverage-gate.test.ts, which runs "bun test --coverage"
// against this directory to prove CLI coverage collection works under the
// repo bunfig (guarding the bun 1.3.10 trap where a bunfig "coverage = false"
// suppresses it). bun only renders the coverage table when at least one
// NON-test file is in the coverage set, so this file must import real source
// (scripts/coverage-gate.ts). Keep it free of spawns so the nested run stays
// one level deep.
test("coverage smoke: covers non-test source", () => {
  expect(parseCoverageSummary("All files | 50.00 | 50.00 |")).toEqual({
    funcsPct: 50,
    linesPct: 50,
  });
});
