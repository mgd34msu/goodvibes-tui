/**
 * SecurityPanel — diagnostics data provider for token scope and rotation audits.
 *
 * Wraps an `ApiTokenAuditor` and exposes a snapshot of the current audit state
 * for the diagnostics view. Consumers subscribe to change notifications and
 * call `getSnapshot()` to retrieve a fresh rendering-ready view.
 *
 * This panel is push-passive: it does not drive timers. Callers trigger audits
 * by calling `runAudit()` — typically on a schedule or on relevant events.
 */

import { logger } from '../../../utils/logger.ts';
import type {
  ApiTokenAuditor,
  TokenAuditReport,
  TokenAuditResult,
} from '../../../security/token-audit.ts';
import type { PanelConfig } from '../types.ts';
import { DEFAULT_PANEL_CONFIG } from '../types.ts';

// ---------------------------------------------------------------------------
// Snapshot type
// ---------------------------------------------------------------------------

/**
 * Point-in-time snapshot of token security audit state for diagnostics rendering.
 */
export interface SecurityPanelSnapshot {
  /** Whether the auditor is running in managed mode. */
  managed: boolean;
  /** Total number of registered tokens. */
  totalTokens: number;
  /** Per-token audit results (most recently audited set). */
  results: TokenAuditResult[];
  /** Token IDs blocked in managed mode. */
  blocked: string[];
  /** Token IDs with scope violations. */
  scopeViolations: string[];
  /** Token IDs with rotation warnings (approaching deadline). */
  rotationWarnings: string[];
  /** Token IDs with overdue rotation. */
  rotationOverdue: string[];
  /** Epoch ms when the last audit was run. null if no audit has been run yet. */
  lastAuditAt: number | null;
  /** ISO 8601 timestamp of when this snapshot was captured. */
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// SecurityPanel
// ---------------------------------------------------------------------------

/**
 * SecurityPanel — diagnostics data provider for token scope and rotation audits.
 *
 * @remarks
 * Instantiated by the diagnostics bootstrap (deferred wiring pattern, same as
 * OpsPanel and ForensicsDataPanel). The panel is constructed once during
 * bootstrap and wired to the application-level `ApiTokenAuditor` instance;
 * individual callers do not construct it directly.
 *
 * Usage:
 * ```ts
 * const auditor = new ApiTokenAuditor({ managed: true });
 * const panel = new SecurityPanel(auditor);
 *
 * panel.subscribe(() => {
 *   const snap = panel.getSnapshot();
 *   render(snap);
 * });
 *
 * // Run audit (e.g. on schedule or event):
 * panel.runAudit();
 *
 * // On cleanup:
 * panel.dispose();
 * ```
 */
export class SecurityPanel {
  private readonly _auditor: ApiTokenAuditor;
  private readonly _config: PanelConfig;
  private readonly _subscribers = new Set<() => void>();
  private _lastReport: TokenAuditReport | null = null;

  constructor(
    auditor: ApiTokenAuditor,
    config: PanelConfig = DEFAULT_PANEL_CONFIG,
  ) {
    this._auditor = auditor;
    this._config = config;
  }

  /**
   * Run a full audit of all registered tokens and notify subscribers.
   * Returns the report so callers can emit events or take action.
   */
  public runAudit(now: number = Date.now()): TokenAuditReport {
    const report = this._auditor.auditAll(now);
    this._lastReport = report;
    this._notify();
    return report;
  }

  /**
   * getSnapshot — Returns the current security audit snapshot.
   * Returns an empty snapshot if no audit has been run yet.
   */
  public getSnapshot(): SecurityPanelSnapshot {
    const report = this._lastReport;

    if (!report) {
      return {
        managed: this._auditor.isManaged,
        totalTokens: this._auditor.tokenCount,
        results: [],
        blocked: [],
        scopeViolations: [],
        rotationWarnings: [],
        rotationOverdue: [],
        lastAuditAt: null,
        capturedAt: new Date().toISOString(),
      };
    }

    // Cap results for display using the panel's buffer limit
    const results = report.results.slice(0, this._config.bufferLimit);

    return {
      managed: this._auditor.isManaged,
      totalTokens: this._auditor.tokenCount,
      results,
      blocked: report.blocked,
      scopeViolations: report.scopeViolations,
      rotationWarnings: report.rotationWarnings,
      rotationOverdue: report.rotationOverdue,
      lastAuditAt: report.capturedAt,
      capturedAt: new Date().toISOString(),
    };
  }

  /**
   * Register a callback invoked whenever the panel state changes.
   * @returns An unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /**
   * Release all subscriptions.
   */
  public dispose(): void {
    this._subscribers.clear();
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch (err) {
        logger.debug('[SecurityPanel] subscriber error', { err });
      }
    }
  }
}
