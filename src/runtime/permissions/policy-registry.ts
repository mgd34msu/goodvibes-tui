/**
 * Policy-as-Code Registry — Section 5.3.
 *
 * Manages versioned policy bundles with promote/rollback semantics.
 * Enforces the rule that no bundle may move to enforcement without
 * prior simulation evidence and a passing divergence gate.
 *
 * Bundle lifecycle:
 *   loaded → simulating → promoting (gate check) → active (enforced)
 *
 * At any time:
 *   - `current`   — the bundle whose rules are actively enforced
 *   - `candidate` — a loaded bundle awaiting simulation before promotion
 *   - `history`   — previous active bundles, kept for rollback
 */

import type { PolicyRule } from './types.ts';
import type { SignedPolicyBundle } from './policy-signer.ts';
import type { PolicyBundlePayload, BundleProvenance, PolicyLoadResult, PolicyLoaderOptions } from './policy-loader.ts';
import { loadPolicyBundle } from './policy-loader.ts';
import type { DivergenceReport, SimulationMode } from './types.ts';
import type { EnforceGateResult } from './divergence-dashboard.ts';

// ── Registry types ─────────────────────────────────────────────────────────────

/**
 * Lifecycle state of a policy bundle version.
 *
 * - `loaded`     — Bundle loaded as candidate; not yet simulated.
 * - `simulating` — Simulation pipeline is active; divergence being collected.
 * - `promoting`  — Gate check in progress; simulation evidence collected.
 * - `active`     — Bundle is the enforced policy.
 * - `rolled-back`— Bundle was superseded by a rollback operation.
 */
export type BundleLifecycleState =
  | 'loaded'
  | 'simulating'
  | 'promoting'
  | 'active'
  | 'rolled-back';

/**
 * A versioned policy bundle entry in the registry.
 */
export interface PolicyBundleVersion {
  /** The signed bundle as loaded from disk/inline. */
  bundle: SignedPolicyBundle<PolicyBundlePayload>;
  /** Provenance record from the loader. */
  provenance: BundleProvenance;
  /** The extracted rules (only populated when load succeeded). */
  rules: PolicyRule[];
  /** Lifecycle state for this version. */
  state: BundleLifecycleState;
  /** ISO 8601 timestamp when this version was loaded. */
  loadedAt: string;
  /** ISO 8601 timestamp when this version became active, if ever. */
  activatedAt?: string;
  /** ISO 8601 timestamp when this version was rolled back, if applicable. */
  rolledBackAt?: string;
  /** Simulation report collected before promotion, if any. */
  simulationReport?: DivergenceReport;
  /** The gate result that was evaluated at promotion time, if any. */
  gateResult?: EnforceGateResult;
}

/**
 * Result of a diff between two policy bundle versions.
 */
export interface PolicyDiffResult {
  /** ID of the "from" bundle (current or named). */
  fromBundleId: string;
  /** ID of the "to" bundle (candidate or named). */
  toBundleId: string;
  /** Rules present in `from` but not in `to` (removed). */
  removed: PolicyRule[];
  /** Rules present in `to` but not in `from` (added). */
  added: PolicyRule[];
  /** Rules whose `id` matches but whose payload differs. */
  changed: Array<{ ruleId: string; from: PolicyRule; to: PolicyRule }>;
  /** Rules identical in both bundles. */
  unchanged: PolicyRule[];
  /** Total count of changed rules (added + removed + modified). */
  totalChanges: number;
}

/**
 * Result of a promote operation.
 */
export interface PromoteResult {
  /** Whether the promotion succeeded. */
  ok: boolean;
  /** The gate result evaluated at promotion time. */
  gate?: EnforceGateResult;
  /** Human-readable explanation when promotion is blocked. */
  error?: string;
  /** The bundle that was promoted, if successful. */
  bundleId?: string;
}

/**
 * Result of a rollback operation.
 */
export interface RollbackResult {
  /** Whether the rollback succeeded. */
  ok: boolean;
  /** The bundle ID restored to active state. */
  restoredBundleId?: string;
  /** Human-readable error when rollback fails. */
  error?: string;
}

/**
 * Configuration for the PolicyRegistry.
 */
export interface PolicyRegistryConfig {
  /**
   * Maximum number of historical (non-active) bundle versions to retain.
   * Oldest entries are dropped when the limit is exceeded.
   * Defaults to 10.
   */
  maxHistorySize?: number;
  /**
   * Options forwarded to `loadPolicyBundle()` for every bundle load.
   */
  loaderOptions?: PolicyLoaderOptions;
}

// ── PolicyRegistry ─────────────────────────────────────────────────────────────

/**
 * PolicyRegistry — Versioned policy bundle manager.
 *
 * Maintains the full bundle lifecycle: loaded → simulating → promoting → active.
 * Enforces that promotion to `active` (enforcement mode) requires:
 *   1. A simulation report to have been attached (evidence of simulation).
 *   2. The divergence gate to be passing (rate below threshold).
 *
 * Usage:
 * ```ts
 * const registry = new PolicyRegistry();
 *
 * // Load a new candidate bundle
 * const loadResult = registry.loadCandidate(signedBundle);
 *
 * // After simulation, attach the report
 * registry.attachSimulationReport(divergenceReport, gateResult);
 *
 * // Promote when gate passes
 * const promoteResult = registry.promote();
 *
 * // Rollback if something goes wrong
 * registry.rollback();
 * ```
 */
export class PolicyRegistry {
  private _current: PolicyBundleVersion | null = null;
  private _candidate: PolicyBundleVersion | null = null;
  private _history: PolicyBundleVersion[] = [];

  public readonly DEFAULT_HISTORY_SIZE = 10;

  private readonly _maxHistorySize: number;
  private readonly _loaderOptions: PolicyLoaderOptions;

  constructor(config: PolicyRegistryConfig = {}) {
    this._maxHistorySize = config.maxHistorySize ?? this.DEFAULT_HISTORY_SIZE;
    this._loaderOptions = config.loaderOptions ?? {};
  }

  // ── Loading ──────────────────────────────────────────────────────────────────

  /**
   * loadCandidate — Load a signed policy bundle as the pending candidate.
   *
   * Replaces any existing candidate. The candidate must be simulated and
   * have its gate checked before it can be promoted to active.
   *
   * @param bundle  — The signed bundle to load.
   * @returns `PolicyLoadResult` indicating success or validation failure.
   */
  public loadCandidate(
    bundle: SignedPolicyBundle<PolicyBundlePayload>,
  ): PolicyLoadResult {
    const result = loadPolicyBundle(bundle, this._loaderOptions);

    if (!result.ok) {
      return result;
    }

    const version: PolicyBundleVersion = {
      bundle,
      provenance: result.provenance,
      rules: result.rules ?? [],
      state: 'loaded',
      loadedAt: new Date().toISOString(),
    };

    this._candidate = version;
    return result;
  }

  // ── Simulation evidence ───────────────────────────────────────────────────────

  /**
   * markSimulating — Transition candidate to `simulating` state.
   *
   * Called by the `/policy simulate` command when a simulation pipeline
   * is started. Validates that a candidate is loaded and in `loaded` state.
   *
   * @returns true if the state was successfully advanced.
   */
  public markSimulating(): boolean {
    if (!this._candidate || this._candidate.state !== 'loaded') {
      return false;
    }
    this._candidate = { ...this._candidate, state: 'simulating' };
    return true;
  }

  /**
   * attachSimulationReport — Attach divergence report and gate result to candidate.
   *
   * Advances the candidate to `promoting` state, which is a prerequisite for
   * calling `promote()`.
   *
   * @param report     — The divergence report from the simulation run.
   * @param gateResult — The gate evaluation at report time.
   * @returns true if the evidence was attached.
   */
  public attachSimulationReport(
    report: DivergenceReport,
    gateResult: EnforceGateResult,
  ): boolean {
    if (!this._candidate || this._candidate.state !== 'simulating') {
      return false;
    }
    this._candidate = {
      ...this._candidate,
      state: 'promoting',
      simulationReport: report,
      gateResult,
    };
    return true;
  }

  // ── Promotion ─────────────────────────────────────────────────────────────────

  /**
   * promote — Promote the candidate bundle to active enforcement.
   *
   * Blocked unless:
   *   - A candidate exists in `promoting` state (simulation evidence attached).
   *   - The attached gate result is `passing`.
   *
   * On success, the previous active bundle moves to history.
   *
   * @param force — Skip gate check. Use only for testing; not for production use.
   */
  public promote(force = false): PromoteResult {
    if (!this._candidate) {
      return { ok: false, error: 'No candidate bundle loaded.' };
    }

    if (this._candidate.state === 'loaded') {
      return {
        ok: false,
        error:
          'Candidate has not been simulated. Run `/policy simulate` first to collect divergence evidence.',
      };
    }

    if (this._candidate.state === 'simulating') {
      return {
        ok: false,
        error:
          'Simulation is in progress. Attach a divergence report before promoting.',
      };
    }

    if (this._candidate.state !== 'promoting') {
      return {
        ok: false,
        error: `Candidate is in unexpected state: "${this._candidate.state}".`,
      };
    }

    const gateResult = this._candidate.gateResult;
    if (!gateResult) {
      throw new Error(
        'Invariant violation: candidate is in "promoting" state but gateResult is missing. ' +
        'attachSimulationReport() must be called before promote().',
      );
    }

    if (!force && gateResult.status === 'blocked') {
      const rateStr = gateResult.divergenceRate !== undefined
        ? `${(gateResult.divergenceRate * 100).toFixed(1)}%`
        : 'unknown';
      return {
        ok: false,
        gate: gateResult,
        error:
          `Promotion blocked: divergence gate is "${gateResult.status}" ` +
          `(rate ${rateStr} exceeds threshold ` +
          `${(gateResult.threshold * 100).toFixed(1)}%). ` +
          `Reduce divergence or run more evaluations before promoting.`,
      };
    }

    const now = new Date().toISOString();

    // Archive the current active bundle
    if (this._current) {
      this._archiveVersion({ ...this._current });
    }

    // Promote candidate to active
    this._current = {
      ...this._candidate,
      state: 'active',
      activatedAt: now,
    };

    this._candidate = null;

    return {
      ok: true,
      gate: gateResult,
      bundleId: this._current.bundle.bundleId,
    };
  }

  // ── Rollback ──────────────────────────────────────────────────────────────────

  /**
   * rollback — Restore the previous active bundle.
   *
   * Moves the current active bundle to history and restores the most recent
   * previously-active bundle from history.
   *
   * @returns `RollbackResult` indicating success or failure.
   */
  public rollback(): RollbackResult {
    const previous = this._history.findLast((v) => v.state === 'active');

    if (!previous) {
      return {
        ok: false,
        error: 'No previous bundle version available for rollback.',
      };
    }

    const now = new Date().toISOString();

    // Archive current active bundle as rolled-back
    if (this._current) {
      this._archiveVersion({ ...this._current, state: 'rolled-back', rolledBackAt: now });
    }

    // Remove the restored version from history and set as current
    this._history = this._history.filter((v) => v !== previous);
    this._current = { ...previous, state: 'active', activatedAt: now };

    return {
      ok: true,
      restoredBundleId: this._current.bundle.bundleId,
    };
  }

  // ── Diff ──────────────────────────────────────────────────────────────────────

  /**
   * diff — Produce a structural diff between two bundle rule sets.
   *
   * Compares `from` (defaults to current active) and `to` (defaults to candidate).
   * Rules are matched by `id` field.
   *
   * @param fromRules — Override the "from" rule set (defaults to current active).
   * @param toRules   — Override the "to" rule set (defaults to candidate).
   */
  public diff(
    fromRules?: PolicyRule[],
    toRules?: PolicyRule[],
  ): PolicyDiffResult | null {
    const from = fromRules ?? this._current?.rules;
    const to = toRules ?? this._candidate?.rules;

    if (!from || !to) {
      return null;
    }

    const fromId = this._current?.bundle.bundleId ?? 'unknown';
    const toId = this._candidate?.bundle.bundleId ?? 'unknown';

    const fromMap = new Map(from.map((r) => [r.id, r]));
    const toMap = new Map(to.map((r) => [r.id, r]));

    const removed: PolicyRule[] = [];
    const added: PolicyRule[] = [];
    const changed: Array<{ ruleId: string; from: PolicyRule; to: PolicyRule }> = [];
    const unchanged: PolicyRule[] = [];

    // Check from → to (removed, changed, unchanged)
    for (const [id, fromRule] of fromMap) {
      const toRule = toMap.get(id);
      if (!toRule) {
        removed.push(fromRule);
      // Safe: PolicyRule objects are constructed uniformly with consistent key ordering
      // (all shapes extend BaseRule and are created only through controlled factory paths),
      // so JSON.stringify produces a stable, deterministic representation for deep equality.
      } else if (JSON.stringify(fromRule) !== JSON.stringify(toRule)) {
        changed.push({ ruleId: id, from: fromRule, to: toRule });
      } else {
        unchanged.push(fromRule);
      }
    }

    // Check to → from (added)
    for (const [id, toRule] of toMap) {
      if (!fromMap.has(id)) {
        added.push(toRule);
      }
    }

    return {
      fromBundleId: fromId,
      toBundleId: toId,
      removed,
      added,
      changed,
      unchanged,
      totalChanges: added.length + removed.length + changed.length,
    };
  }

  // ── Accessors ─────────────────────────────────────────────────────────────────

  /** Returns the currently active bundle version, or null if none loaded. */
  public getCurrent(): PolicyBundleVersion | null {
    return this._current;
  }

  /** Returns the candidate bundle version, or null if none loaded. */
  public getCandidate(): PolicyBundleVersion | null {
    return this._candidate;
  }

  /** Returns the bundle history (previous active bundles), oldest first. */
  public getHistory(): PolicyBundleVersion[] {
    return [...this._history];
  }

  /**
   * getSimulationMode — Returns the recommended simulation mode based on
   * whether the candidate has simulation evidence.
   *
   * This is a hint for the command handler; callers choose the actual mode.
   */
  public getSimulationMode(): SimulationMode {
    if (!this._candidate) return 'simulation-only';
    if (this._candidate.state === 'loaded') return 'simulation-only';
    return 'warn-on-divergence';
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private _archiveVersion(version: PolicyBundleVersion): void {
    this._history.push(version);
    // Trim to max history size (keep most recent)
    if (this._history.length > this._maxHistorySize) {
      this._history = this._history.slice(-this._maxHistorySize);
    }
  }
}
