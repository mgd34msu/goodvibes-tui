/**
 * Tool Contracts diagnostic panel data provider.
 *
 * Stores the contract verification results for all registered tools.
 * Results are loaded by calling `load()` with the full map from the
 * ToolContractVerifier, or incrementally via `upsert()` for live updates.
 *
 * No event bus subscription is used here: contract verification is a
 * registration-time operation, not a streaming lifecycle event.
 */
import type {
  ToolContractEntry,
  ToolContractViolation,
  PanelConfig,
} from '../types.ts';
import { DEFAULT_PANEL_CONFIG, appendBounded } from '../types.ts';
import type { ContractVerificationResult } from '../../tools/contract-verifier.ts';

/**
 * ToolContractsPanel — diagnostics data provider for tool contract verification.
 *
 * Usage:
 * ```ts
 * const panel = new ToolContractsPanel();
 * panel.load(verifier.verifyAll(registry.list()));
 *
 * const entry = panel.get('exec');
 * const all = panel.getAll();
 * const failures = panel.getFailures();
 * ```
 */
export class ToolContractsPanel {
  private readonly _config: PanelConfig;
  /** All contract entries keyed by tool name. */
  private readonly _entries = new Map<string, ToolContractEntry>();
  /** Subscribers to data changes. */
  private readonly _subscribers = new Set<() => void>();
  /**
   * Bounded history of entries from previous load() calls, for audit.
   * @internal
   */
  private readonly _history: ToolContractEntry[] = [];

  constructor(config: PanelConfig = DEFAULT_PANEL_CONFIG) {
    this._config = config;
  }

  /**
   * Load (or reload) all verification results.
   * Replaces all current entries with the provided map.
   *
   * @param results - Map of tool name → ContractVerificationResult from ToolContractVerifier.
   */
  public load(results: Map<string, ContractVerificationResult>): void {
    this._entries.clear();
    for (const [name, result] of results) {
      const entry = this._toEntry(result);
      this._entries.set(name, entry);
      appendBounded(this._history, entry, this._config.bufferLimit);
    }
    this._notify();
  }

  /**
   * Upsert a single verification result.
   * Call this when a single tool is re-verified (e.g. after hot-reload).
   *
   * @param result - The updated ContractVerificationResult.
   */
  public upsert(result: ContractVerificationResult): void {
    const entry = this._toEntry(result);
    this._entries.set(result.toolName, entry);
    appendBounded(this._history, entry, this._config.bufferLimit);
    this._notify();
  }

  /**
   * Get the contract entry for a specific tool.
   *
   * @param toolName - The tool name to look up.
   * @returns The entry or undefined if not yet verified.
   */
  public get(toolName: string): ToolContractEntry | undefined {
    return this._entries.get(toolName);
  }

  /**
   * Get all contract entries, sorted by tool name.
   */
  public getAll(): ToolContractEntry[] {
    return [...this._entries.values()].sort((a, b) =>
      a.toolName.localeCompare(b.toolName),
    );
  }

  /**
   * Get only tools that failed their contract checks (have error-level violations).
   */
  public getFailures(): ToolContractEntry[] {
    return this.getAll().filter((e) => !e.passed);
  }

  /**
   * Get only tools that passed with warnings.
   */
  public getWarnings(): ToolContractEntry[] {
    return this.getAll().filter(
      (e) => e.passed && e.violations.some((v) => v.severity === 'warn'),
    );
  }

  /**
   * Get only tools that passed all checks cleanly.
   */
  public getClean(): ToolContractEntry[] {
    return this.getAll().filter(
      (e) => e.passed && e.violations.every((v) => v.severity !== 'warn'),
    );
  }

  /**
   * Summary counts across all entries.
   */
  public getSummary(): {
    total: number;
    passed: number;
    passedWithWarnings: number;
    failed: number;
    totalViolations: number;
    totalErrors: number;
    totalWarnings: number;
  } {
    let passed = 0;
    let passedWithWarnings = 0;
    let failed = 0;
    let totalViolations = 0;
    let totalErrors = 0;
    let totalWarnings = 0;

    for (const e of this._entries.values()) {
      let errors = 0;
      let warns = 0;
      for (const v of e.violations) {
        if (v.severity === 'error') errors++;
        else warns++;
      }
      totalViolations += e.violations.length;
      totalErrors += errors;
      totalWarnings += warns;
      if (e.passed) {
        if (warns > 0) passedWithWarnings++;
        else passed++;
      } else {
        failed++;
      }
    }

    return {
      total: this._entries.size,
      passed,
      passedWithWarnings,
      failed,
      totalViolations,
      totalErrors,
      totalWarnings,
    };
  }

  /**
   * Register a callback invoked whenever the data changes.
   * @returns An unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /**
   * Release all subscriptions and clear internal state.
   */
  public dispose(): void {
    this._subscribers.clear();
    this._entries.clear();
    this._history.length = 0;
  }

  private _toEntry(result: ContractVerificationResult): ToolContractEntry {
    return {
      toolName: result.toolName,
      passed: result.passed,
      violations: result.violations.map((v): ToolContractViolation => ({
        dimension: v.dimension,
        severity: v.severity,
        message: v.message,
        hint: v.hint,
      })),
      verifiedAt: result.verifiedAt,
      isPhasedTool: result.isPhasedTool,
    };
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch (err) {
        // Non-fatal: subscriber errors must not crash the provider
        console.debug('[ToolContractsPanel] subscriber error:', err);
      }
    }
  }
}
