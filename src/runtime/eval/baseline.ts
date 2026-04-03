/**
 * Evaluation Harness — Baseline persistence.
 *
 * Provides load/save/capture utilities for EvalBaseline records.
 * Baselines are stored as JSON files on disk and loaded by the CI gate.
 *
 * File format: a single JSON object matching the EvalBaseline type.
 */

import type { EvalBaseline, EvalSuiteResult, BaselineSuiteSummary } from './types.ts';
import { resolve, normalize } from 'node:path';

// ── Serialisation ─────────────────────────────────────────────────────────────

/**
 * Capture a baseline snapshot from a set of suite results.
 *
 * @param label - Human-readable label (e.g. 'main', 'v0.12.0').
 * @param suiteResults - One or more suite results to capture.
 * @returns A new EvalBaseline.
 */
export function captureBaseline(
  label: string,
  suiteResults: EvalSuiteResult[],
): EvalBaseline {
  const suites: Record<string, BaselineSuiteSummary> = {};

  for (const result of suiteResults) {
    const scenarioScores: Record<string, number> = {};
    for (const r of result.results) {
      scenarioScores[r.scenario.id] = r.scorecard.compositeScore;
    }
    suites[result.suite] = {
      meanScore: result.meanScore,
      scenarioScores,
    };
  }

  return {
    label,
    capturedAt: Date.now(),
    suites,
  };
}

/**
 * Serialise a baseline to a JSON string.
 */
export function serialiseBaseline(baseline: EvalBaseline): string {
  return JSON.stringify(baseline, null, 2);
}

/**
 * Deserialise a baseline from a JSON string.
 * Throws if the payload is not a valid EvalBaseline shape.
 */
export function deserialiseBaseline(json: string): EvalBaseline {
  const parsed = JSON.parse(json) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).label !== 'string' ||
    typeof (parsed as Record<string, unknown>).capturedAt !== 'number' ||
    typeof (parsed as Record<string, unknown>).suites !== 'object'
  ) {
    throw new Error('Invalid baseline format: missing required fields (label, capturedAt, suites).');
  }
  return parsed as EvalBaseline;
}

// ── File I/O (Bun-compatible) ─────────────────────────────────────────────────

/**
 * Write a baseline to a file path.
 * Uses Bun.write for efficient file I/O.
 */
export async function writeBaseline(filePath: string, baseline: EvalBaseline): Promise<void> {
  const resolved = resolve(normalize(filePath));
  if (!resolved.startsWith(process.cwd())) {
    throw new Error('Baseline path must be within project directory');
  }
  const json = serialiseBaseline(baseline);
  await Bun.write(resolved, json);
}

/**
 * Load a baseline from a file path.
 * Returns undefined if the file does not exist.
 */
export async function loadBaseline(filePath: string): Promise<EvalBaseline | undefined> {
  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) return undefined;
  const json = await file.text();
  return deserialiseBaseline(json);
}

// ── Comparison helpers ────────────────────────────────────────────────────────

/**
 * Format a comparison summary between a baseline and a fresh suite result.
 */
export function formatBaselineComparison(
  baseline: EvalBaseline,
  fresh: EvalSuiteResult,
): string {
  const lines: string[] = [];
  const hr = '-'.repeat(72);

  lines.push(hr);
  lines.push(`Baseline Comparison: ${fresh.suite}`);
  lines.push(`Baseline: ${baseline.label} (captured ${new Date(baseline.capturedAt).toISOString()})`);
  lines.push(`Fresh run: ${new Date(fresh.startedAt).toISOString()}`);
  lines.push(hr);

  const baselineSuite = baseline.suites[fresh.suite];
  if (!baselineSuite) {
    lines.push(`No baseline data for suite "${fresh.suite}".`);
    lines.push(hr);
    return lines.join('\n');
  }

  lines.push(
    `${'Scenario'.padEnd(48)} ${'Baseline'.padEnd(10)} ${'Fresh'.padEnd(10)} Delta`,
  );
  lines.push(hr);

  for (const result of fresh.results) {
    const baseScore = baselineSuite.scenarioScores[result.scenario.id];
    const freshScore = result.scorecard.compositeScore;
    const baseStr = baseScore !== undefined ? baseScore.toFixed(1) : 'N/A';
    const delta =
      baseScore !== undefined
        ? `${freshScore - baseScore >= 0 ? '+' : ''}${(freshScore - baseScore).toFixed(1)}`
        : 'new';
    const name = result.scenario.name.slice(0, 46).padEnd(48);
    lines.push(
      `${name} ${baseStr.padEnd(10)} ${freshScore.toFixed(1).padEnd(10)} ${delta}`,
    );
  }

  lines.push(hr);
  lines.push(
    `Suite mean: baseline=${baselineSuite.meanScore.toFixed(1)}, ` +
    `fresh=${fresh.meanScore.toFixed(1)}, ` +
    `delta=${(fresh.meanScore - baselineSuite.meanScore >= 0 ? '+' : '') + (fresh.meanScore - baselineSuite.meanScore).toFixed(1)}`,
  );
  lines.push(hr);

  return lines.join('\n');
}
