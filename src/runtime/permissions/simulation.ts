/**
 * Permissions v2 — Simulation Pipeline.
 *
 * `PermissionSimulator` wraps two `LayeredPolicyEvaluator` instances —
 * the *actual* (authoritative) evaluator and a *simulated* (candidate)
 * evaluator — and runs both in parallel for every call to `evaluate()`.
 *
 * Divergence tracking:
 *   - Counts by tool class, command prefix, and simulation mode.
 *   - Configurable divergence threshold for enforcement gate.
 *   - `getDivergenceReport()` returns aggregated stats.
 *
 * Simulation modes:
 *   - `simulation-only`    — Actual decision enforced; divergence logged silently.
 *   - `warn-on-divergence` — Actual decision enforced; divergence emits a warning.
 *   - `enforce`            — Simulated decision becomes authoritative; blocked if
 *                           divergence gate fails (rate > threshold).
 *
 * Feature flag: `permissions-simulation` must be enabled to use this module.
 */

import type {
  CommandClassification,
  DivergenceRecord,
  DivergenceReport,
  DivergenceStats,
  DivergenceType,
  PermissionDecision,
  PermissionSimulatorConfig,
  PermissionsV2Config,
  SimulationMode,
  SimulationResult,
} from './types.ts';

import { LayeredPolicyEvaluator } from './evaluator.ts';

// ── Private helpers ────────────────────────────────────────────────────────────

/** Extracts the first meaningful token from the first string argument. */
function extractCommandPrefix(
  args: Record<string, unknown>,
): string | undefined {
  for (const key of ['command', 'path', 'url']) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0) {
      return val.split(/[\s/]+/)[0];
    }
  }
  return undefined;
}

/** Determines the divergence type between two decisions. */
function classifyDivergence(
  actual: PermissionDecision,
  simulated: PermissionDecision,
): DivergenceType {
  if (actual.allowed && !simulated.allowed) return 'allow-vs-deny';
  if (!actual.allowed && simulated.allowed) return 'deny-vs-allow';
  return 'reason-mismatch';
}

/** Returns an empty DivergenceStats object. */
function emptyStats(totalEvaluations = 0): DivergenceStats {
  return {
    total: 0,
    byType: {
      'allow-vs-deny': 0,
      'deny-vs-allow': 0,
      'reason-mismatch': 0,
    },
    divergenceRate: 0,
    totalEvaluations,
  };
}

/** Increments a DivergenceStats object with a new divergence. */
function accumulateStats(
  stats: DivergenceStats,
  type: DivergenceType,
): DivergenceStats {
  const updated: DivergenceStats = {
    ...stats,
    total: stats.total + 1,
    byType: { ...stats.byType, [type]: stats.byType[type] + 1 },
  };
  updated.divergenceRate =
    updated.totalEvaluations > 0
      ? updated.total / updated.totalEvaluations
      : 0;
  return updated;
}

// ── PermissionSimulator ────────────────────────────────────────────────────────

/**
 * PermissionSimulator — Dual-evaluator simulation pipeline for Permissions v2.
 *
 * Runs two `LayeredPolicyEvaluator` instances (actual + simulated) in parallel
 * and tracks divergence between their decisions.
 *
 * Usage:
 * ```ts
 * const simulator = createPermissionSimulator(
 *   { mode: 'default', rules: currentRules },
 *   { mode: 'default', rules: candidateRules },
 *   'warn-on-divergence',
 * );
 * const result = simulator.evaluate('write', { path: '/tmp/out.txt' });
 * if (result.diverged) {
 *   console.warn('divergence:', result.divergenceType);
 * }
 * ```
 */
export class PermissionSimulator {
  private readonly actual: LayeredPolicyEvaluator;
  private readonly simulated: LayeredPolicyEvaluator;
  private readonly simulationMode: SimulationMode;
  private readonly maxDivergenceRecords: number;
  private readonly divergenceThreshold: number;
  private readonly onWarning: ((record: DivergenceRecord) => void) | undefined;

  /** All recorded divergences, capped at `maxDivergenceRecords`. */
  private records: DivergenceRecord[] = [];

  /** Per-tool-class evaluation counts (diverged + non-diverged). */
  private evalsByClass: Partial<Record<CommandClassification, number>> = {};

  /** Per-command-prefix evaluation counts. */
  private evalsByPrefix: Record<string, number> = {};

  /** Per-mode evaluation counts. */
  private evalsByMode: Partial<Record<SimulationMode, number>> = {};

  /** Total evaluations across all calls. */
  private totalEvals = 0;

  private static readonly DEFAULT_MAX_RECORDS = 500;
  private static readonly DEFAULT_THRESHOLD = 0.05;

  constructor(
    actualConfig: PermissionsV2Config,
    simulatedConfig: PermissionsV2Config,
    simulationMode: SimulationMode,
    config: PermissionSimulatorConfig = {},
  ) {
    this.actual = new LayeredPolicyEvaluator(actualConfig);
    this.simulated = new LayeredPolicyEvaluator(simulatedConfig);
    this.simulationMode = simulationMode;
    this.maxDivergenceRecords =
      config.maxDivergenceRecords ?? PermissionSimulator.DEFAULT_MAX_RECORDS;
    this.divergenceThreshold =
      config.divergenceThreshold ?? PermissionSimulator.DEFAULT_THRESHOLD;
    this.onWarning = config.onWarning;
  }

  /**
   * evaluate — Runs both evaluators and returns a `SimulationResult`.
   *
   * In `enforce` mode the call will throw `SimulationEnforcementError` if
   * the divergence rate exceeds the configured threshold.
   *
   * @param toolName — The tool name being evaluated.
   * @param args     — The arguments passed to the tool.
   */
  evaluate(
    toolName: string,
    args: Record<string, unknown>,
  ): SimulationResult {
    // Enforcement gate — checked before evaluation in enforce mode
    if (this.simulationMode === 'enforce') {
      this.assertDivergenceGate();
    }

    const actualDecision = this.actual.evaluate(toolName, args);
    const simulatedDecision = this.simulated.evaluate(toolName, args);

    const diverged =
      actualDecision.allowed !== simulatedDecision.allowed ||
      actualDecision.reason !== simulatedDecision.reason ||
      actualDecision.sourceLayer !== simulatedDecision.sourceLayer;

    const commandPrefix = extractCommandPrefix(args);
    const toolClass = actualDecision.classification ?? 'write';

    // ── Bookkeeping ────────────────────────────────────────────────────
    this.totalEvals += 1;
    this.evalsByClass[toolClass] = (this.evalsByClass[toolClass] ?? 0) + 1;
    this.evalsByMode[this.simulationMode] =
      (this.evalsByMode[this.simulationMode] ?? 0) + 1;
    if (commandPrefix !== undefined) {
      this.evalsByPrefix[commandPrefix] =
        (this.evalsByPrefix[commandPrefix] ?? 0) + 1;
    }

    // Determine the authoritative decision based on mode
    const authoritativeDecision =
      this.simulationMode === 'enforce' ? simulatedDecision : actualDecision;

    if (!diverged) {
      return { actualDecision, simulatedDecision, authoritativeDecision, diverged: false };
    }

    const divergenceType = classifyDivergence(actualDecision, simulatedDecision);

    // ── Record divergence ──────────────────────────────────────────────
    const record: DivergenceRecord = {
      timestamp: Date.now(),
      toolName,
      toolClass,
      commandPrefix,
      mode: this.simulationMode,
      divergenceType,
      actualReason: actualDecision.reason,
      simulatedReason: simulatedDecision.reason,
    };

    if (this.records.length >= this.maxDivergenceRecords) {
      this.records.shift();
    }
    this.records.push(record);

    // ── Warn on divergence ─────────────────────────────────────────────
    if (this.simulationMode === 'warn-on-divergence') {
      if (this.onWarning) {
        this.onWarning(record);
      } else {
        process.stderr.write(
          `[permissions-simulation] warn-on-divergence: tool=${toolName} type=${divergenceType} actual=${actualDecision.reason} simulated=${simulatedDecision.reason}\n`,
        );
      }
    }

    return { actualDecision, simulatedDecision, authoritativeDecision, diverged: true, divergenceType };
  }

  /**
   * getDivergenceReport — Returns aggregated divergence statistics.
   *
   * Queryable by tool class and command prefix. Includes overall summary,
   * per-class, per-prefix, and per-mode breakdowns.
   */
  getDivergenceReport(): DivergenceReport {
    const overall = emptyStats(this.totalEvals);

    const byToolClass: Partial<Record<CommandClassification, DivergenceStats>> =
      {};
    const byCommandPrefix: Record<string, DivergenceStats> = {};
    const byMode: Partial<Record<SimulationMode, DivergenceStats>> = {};

    // Prime per-class and per-prefix stats with evaluation counts
    for (const [cls, count] of Object.entries(this.evalsByClass)) {
      byToolClass[cls as CommandClassification] = emptyStats(count as number);
    }
    for (const [prefix, count] of Object.entries(this.evalsByPrefix)) {
      byCommandPrefix[prefix] = emptyStats(count as number);
    }
    for (const [mode, count] of Object.entries(this.evalsByMode)) {
      byMode[mode as SimulationMode] = emptyStats(count as number);
    }

    // Accumulate divergence records into all buckets
    let accumulatedOverall = overall;
    for (const rec of this.records) {
      const cls = rec.toolClass;
      const prefix = rec.commandPrefix;
      const mode = rec.mode;
      const type = rec.divergenceType;

      // Overall — use accumulateStats for consistency with other buckets
      accumulatedOverall = accumulateStats(accumulatedOverall, type);

      // By class
      const existingClass = byToolClass[cls];
      if (existingClass !== undefined) {
        byToolClass[cls] = accumulateStats(existingClass, type);
      }

      // By prefix
      if (prefix !== undefined) {
        const existingPrefix = byCommandPrefix[prefix];
        if (existingPrefix !== undefined) {
          byCommandPrefix[prefix] = accumulateStats(existingPrefix, type);
        }
      }

      // By mode
      const existingMode = byMode[mode];
      if (existingMode !== undefined) {
        byMode[mode] = accumulateStats(existingMode, type);
      }
    }

    return {
      overall: accumulatedOverall,
      byToolClass,
      byCommandPrefix,
      byMode,
      records: [...this.records],
    };
  }

  /**
   * getActualEvaluator — Exposes the actual evaluator for direct inspection.
   */
  getActualEvaluator(): LayeredPolicyEvaluator {
    return this.actual;
  }

  /**
   * getSimulatedEvaluator — Exposes the simulated evaluator for direct inspection.
   */
  getSimulatedEvaluator(): LayeredPolicyEvaluator {
    return this.simulated;
  }

  /**
   * getSimulationMode — Returns the active simulation mode.
   */
  getSimulationMode(): SimulationMode {
    return this.simulationMode;
  }

  /**
   * isDivergenceGatePassing — Returns whether the divergence rate is within
   * the configured threshold. Always `true` in non-enforce modes.
   */
  isDivergenceGatePassing(): boolean {
    if (this.totalEvals === 0) return true;
    const report = this.getDivergenceReport();
    return report.overall.divergenceRate <= this.divergenceThreshold;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * assertDivergenceGate — Throws if divergence rate exceeds threshold.
   *
   * Only called in `enforce` mode prior to evaluation.
   */
  private assertDivergenceGate(): void {
    if (!this.isDivergenceGatePassing()) {
      const report = this.getDivergenceReport();
      throw new SimulationEnforcementError(
        `Simulation enforcement blocked: divergence rate ${
          (report.overall.divergenceRate * 100).toFixed(2)
        }% exceeds threshold ${
          (this.divergenceThreshold * 100).toFixed(2)
        }%`,
        report.overall.divergenceRate,
        this.divergenceThreshold,
      );
    }
  }
}

// ── SimulationEnforcementError ────────────────────────────────────────────────

/**
 * Thrown when `enforce` mode is active and the divergence gate fails.
 */
export class SimulationEnforcementError extends Error {
  /** Current divergence rate (0–1). */
  readonly divergenceRate: number;
  /** Configured divergence threshold (0–1). */
  readonly threshold: number;

  constructor(message: string, divergenceRate: number, threshold: number) {
    super(message);
    this.name = 'SimulationEnforcementError';
    this.divergenceRate = divergenceRate;
    this.threshold = threshold;
  }
}
