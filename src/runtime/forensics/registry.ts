/**
 * ForensicsRegistry — in-memory store for FailureReport objects.
 *
 * Maintains a bounded circular buffer of reports (newest last), keyed by
 * report ID for O(1) lookup. Supports `latest()`, `getById()`, raw report
 * export, and incident bundle export for the /forensics command subcommands.
 */
import type {
  FailureReport,
  ForensicsBundle,
  ForensicsReplayEvidence,
  ForensicsReplayMismatchEvidence,
  ForensicsReplayTurnEvidence,
} from './types.ts';

export interface ReplaySnapshotInput {
  readonly status: string;
  readonly runId: string | null;
  readonly currentRev: number;
  readonly totalRevisions: number;
  readonly mismatches: ReadonlyArray<{
    readonly rev: number;
    readonly kind: string;
    readonly description: string;
    readonly eventName?: string;
    readonly ownerDomain?: string;
    readonly failureMode?: string;
    readonly relatedTurnId?: string;
  }>;
  readonly turnSummaries: ReadonlyArray<{
    readonly turnId: string;
    readonly outcome: 'completed' | 'failed' | 'cancelled';
    readonly terminalEvent: 'PREFLIGHT_FAIL' | 'TURN_COMPLETED' | 'TURN_ERROR' | 'TURN_CANCEL';
    readonly startedRev?: number;
    readonly terminalRev: number;
    readonly stopReason?: string;
    readonly message?: string;
  }>;
}

/** Default maximum number of failure reports retained in memory. */
export const DEFAULT_REGISTRY_LIMIT = 100;

export class ForensicsRegistry {
  private readonly _reports: FailureReport[] = [];
  private readonly _byId = new Map<string, FailureReport>();
  private readonly _limit: number;
  private readonly _subscribers = new Set<() => void>();

  public constructor(limit: number = DEFAULT_REGISTRY_LIMIT) {
    this._limit = limit;
  }

  /**
   * Push a new failure report into the registry.
   * If the buffer is full, the oldest entry is evicted.
   */
  public push(report: FailureReport): void {
    // Evict oldest if at capacity
    if (this._reports.length >= this._limit) {
      const evicted = this._reports.shift();
      if (evicted) this._byId.delete(evicted.id);
    }
    this._reports.push(report);
    this._byId.set(report.id, report);
    this._notify();
  }

  /**
   * Return the most recently generated report, or undefined if none exist.
   */
  public latest(): FailureReport | undefined {
    return this._reports.at(-1);
  }

  /**
   * Return a report by its short ID, or undefined if not found.
   */
  public getById(id: string): FailureReport | undefined {
    return this._byId.get(id);
  }

  /**
   * Return all reports, newest first.
   */
  public getAll(): FailureReport[] {
    return [...this._reports].reverse();
  }

  /**
   * Return the count of retained reports.
   */
  public count(): number {
    return this._reports.length;
  }

  /**
   * Serialize a report to a pretty-printed JSON string.
   * Returns undefined if the report ID is not found.
   */
  public exportAsJson(id: string): string | undefined {
    const report = this._byId.get(id);
    if (!report) return undefined;
    return JSON.stringify(report, null, 2);
  }

  /**
   * Build a richer incident bundle for export, including derived evidence and
   * optional replay state when available.
   */
  public buildBundle(
    id: string,
    options: { replaySnapshot?: ReplaySnapshotInput } = {},
  ): ForensicsBundle | undefined {
    const report = this._byId.get(id);
    if (!report) return undefined;

    const rootCause = report.causalChain.find((entry) => entry.isRootCause)?.description;
    const terminalPhase = report.phaseLedger.at(-1);

    return {
      schemaVersion: 'v1',
      exportedAt: Date.now(),
      report,
      evidence: {
        rootCause,
        terminalPhase: terminalPhase?.phase,
        terminalOutcome: terminalPhase?.outcome,
        phaseCount: report.phaseLedger.length,
        causalCount: report.causalChain.length,
        cascadeCount: report.cascadeEvents.length,
        permissionDecisionCount: report.permissionEvidence.length,
        deniedPermissionCount: report.permissionEvidence.filter((entry) => entry.approved === false).length,
        budgetBreachCount: report.budgetBreaches.length,
        slowPhases: report.phaseTimings
          .filter((phase) => (phase.durationMs ?? 0) >= 1_000)
          .map((phase) => phase.phase),
        jumpLinkCount: report.jumpLinks.length,
        relatedIds: {
          turnId: report.turnId,
          taskId: report.taskId,
          agentId: report.agentId,
        },
      },
      replay: this._buildReplayEvidence(report, options.replaySnapshot),
    };
  }

  /**
   * Serialize an incident bundle to pretty-printed JSON.
   * Returns undefined if the report ID is not found.
   */
  public exportBundleAsJson(
    id: string,
    options: { replaySnapshot?: ReplaySnapshotInput } = {},
  ): string | undefined {
    const bundle = this.buildBundle(id, options);
    if (!bundle) return undefined;
    return JSON.stringify(bundle, null, 2);
  }

  /**
   * Subscribe to registry changes. Returns an unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => { this._subscribers.delete(callback); };
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try { cb(); } catch { /* non-fatal — subscriber errors must not affect the registry */ }
    }
  }

  private _buildReplayEvidence(
    report: FailureReport,
    snapshot?: ReplaySnapshotInput,
  ): ForensicsReplayEvidence {
    if (!snapshot) {
      return {
        status: 'unavailable',
        mismatchCount: 0,
        mismatches: [],
        relatedMismatches: [],
        mismatchBreakdown: { byKind: {}, byFailureMode: {}, byOwnerDomain: {} },
        turnSummaries: [],
      };
    }

    if (snapshot.status === 'idle' || !snapshot.runId) {
      return {
        status: 'not_loaded',
        mismatchCount: 0,
        mismatches: [],
        relatedMismatches: [],
        mismatchBreakdown: { byKind: {}, byFailureMode: {}, byOwnerDomain: {} },
        turnSummaries: [],
      };
    }

    const mismatches: ForensicsReplayMismatchEvidence[] = snapshot.mismatches.map((mismatch) => ({
      rev: mismatch.rev,
      kind: mismatch.kind,
      description: mismatch.description,
      eventName: mismatch.eventName,
      ownerDomain: mismatch.ownerDomain,
      failureMode: mismatch.failureMode,
      relatedTurnId: mismatch.relatedTurnId,
    }));
    const turnSummaries: ForensicsReplayTurnEvidence[] = snapshot.turnSummaries.map((summary) => ({
      turnId: summary.turnId,
      outcome: summary.outcome,
      terminalEvent: summary.terminalEvent,
      startedRev: summary.startedRev,
      terminalRev: summary.terminalRev,
      stopReason: summary.stopReason,
      message: summary.message,
    }));

    const relatedMismatches = report.turnId
      ? mismatches.filter((mismatch) => mismatch.relatedTurnId === report.turnId)
      : [];

    return {
      status: 'available',
      runId: snapshot.runId,
      currentRev: snapshot.currentRev,
      totalRevisions: snapshot.totalRevisions,
      mismatchCount: mismatches.length,
      mismatches,
      relatedMismatches,
      mismatchBreakdown: {
        byKind: this._countBy(mismatches, (mismatch) => mismatch.kind),
        byFailureMode: this._countBy(mismatches, (mismatch) => mismatch.failureMode ?? 'unknown'),
        byOwnerDomain: this._countBy(mismatches, (mismatch) => mismatch.ownerDomain ?? 'unknown'),
      },
      turnSummaries,
      matchingTurnSummary: report.turnId
        ? turnSummaries.find((summary) => summary.turnId === report.turnId)
        : undefined,
    };
  }

  private _countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of items) {
      const label = key(item);
      counts[label] = (counts[label] ?? 0) + 1;
    }
    return counts;
  }
}
