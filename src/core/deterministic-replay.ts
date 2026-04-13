/**
 * DeterministicReplayEngine.
 *
 * Consumes a recorded snapshot + typed event ledger to replay a run
 * deterministically. Supports stepwise transitions, seekable revision
 * positioning, and diff mode that reports expected-vs-replayed mismatches
 * with classifiers.
 *
 * The engine does not re-emit live runtime events through a separate bus — it maintains
 * its own replay-local state tree built by folding ledger entries over the
 * initial snapshot. This isolation ensures replay never affects live state.
 */
import { writeFile } from 'node:fs/promises';
import { resolve, normalize } from 'node:path';
import { logger } from '../utils/logger.ts';
import type { LedgerEntry } from '../runtime/telemetry/exporters/local-ledger.ts';
import type { RuntimeStateSnapshot } from '../runtime/diagnostics/types.ts';

// ── Mismatch classifier ────────────────────────────────────────────────────

/**
 * Category of a mismatch between expected and replayed state.
 *
 * - `missing_event`    : an event expected at this revision was absent.
 * - `extra_event`      : an event appeared that was not in the recording.
 * - `payload_mismatch` : event name matched but payload differed.
 * - `ordering`         : events arrived in different order than recorded.
 * - `state_divergence` : domain state diverged after applying event.
 */
export type MismatchClass =
  | 'missing_event'
  | 'extra_event'
  | 'payload_mismatch'
  | 'ordering'
  | 'state_divergence';

export type ReplayMismatchOwnerDomain =
  | 'turn'
  | 'tasks'
  | 'tools'
  | 'providers'
  | 'session'
  | 'conversation'
  | 'agents'
  | 'workflows'
  | 'permissions'
  | 'transport'
  | 'unknown';

export type ReplayMismatchFailureMode =
  | 'missing_event'
  | 'extra_event'
  | 'ordering_violation'
  | 'payload_schema_mismatch'
  | 'payload_type_mismatch'
  | 'payload_value_mismatch'
  | 'missing_terminal_summary'
  | 'terminal_outcome_diverged'
  | 'stop_reason_diverged';

/**
 * A single actionable mismatch entry produced by diff mode.
 */
export interface ReplayMismatch {
  /** The revision at which the mismatch was detected. */
  readonly rev: number;
  /** Mismatch classifier. */
  readonly kind: MismatchClass;
  /** Human-readable description — sufficient to act on without raw dumps. */
  readonly description: string;
  /** The event name involved, if applicable. */
  readonly eventName?: string;
  /** Key fields from the recorded payload, if applicable. */
  readonly recordedSummary?: string;
  /** Key fields from the replayed payload, if applicable. */
  readonly replayedSummary?: string;
  /** Likely owning runtime domain for the divergence. */
  readonly ownerDomain?: ReplayMismatchOwnerDomain;
  /** Narrower replay failure mode for operator triage. */
  readonly failureMode?: ReplayMismatchFailureMode;
  /** Related turn ID when the divergence can be tied to a single turn. */
  readonly relatedTurnId?: string;
}

export type ReplayTurnOutcome = 'completed' | 'failed' | 'cancelled';

export interface ReplayTurnSummary {
  readonly turnId: string;
  readonly outcome: ReplayTurnOutcome;
  readonly terminalEvent: 'PREFLIGHT_FAIL' | 'TURN_COMPLETED' | 'TURN_ERROR' | 'TURN_CANCEL';
  readonly startedRev?: number;
  readonly terminalRev: number;
  readonly stopReason?: string;
  readonly message?: string;
}

// ── Replay state ───────────────────────────────────────────────────────────

/**
 * The replay-local state tree at a given revision.
 *
 * Built by folding ledger entries over the initial snapshot; each step
 * produces a new immutable frame.
 */
export interface ReplayFrame {
  /** The revision this frame represents (0 = initial snapshot). */
  readonly rev: number;
  /** The event that produced this frame (absent for the initial snapshot). */
  readonly entry?: LedgerEntry;
  /** Domain state at this revision — merged from snapshot + events applied so far. */
  readonly domains: Record<string, Record<string, unknown>>;
}

// ── Engine status ──────────────────────────────────────────────────────────

export type ReplayStatus =
  | 'idle'       // No run loaded.
  | 'loaded'     // Run loaded, positioned at rev 0 (snapshot).
  | 'running'    // Stepping through events.
  | 'exhausted'; // All events have been replayed.

/**
 * Snapshot of engine state for the Replay panel.
 */
export interface ReplayEngineSnapshot {
  readonly status: ReplayStatus;
  readonly runId: string | null;
  readonly currentRev: number;
  readonly totalRevisions: number;
  readonly currentFrame: ReplayFrame | null;
  readonly mismatches: readonly ReplayMismatch[];
  readonly turnSummaries: readonly ReplayTurnSummary[];
}

// ── DeterministicReplayEngine ──────────────────────────────────────────────

/**
 * DeterministicReplayEngine.
 *
 * Usage:
 * ```ts
 * const engine = new DeterministicReplayEngine('/path/to/project');
 * engine.load(runId, snapshot, ledgerEntries);
 * engine.step();          // advance one event
 * engine.step(5);         // advance five events
 * engine.seek(10);        // jump to rev 10
 * const report = engine.diff();  // compare current to recorded
 * engine.export('/tmp/replay.json');  // write report to file
 * ```
 */
export class DeterministicReplayEngine {
  private readonly _projectRoot: string;
  private _status: ReplayStatus = 'idle';
  private _runId: string | null = null;
  private _snapshot: RuntimeStateSnapshot | null = null;

  /**
   * Returns the initial snapshot that was loaded, or null if no run is loaded.
   */
  getInitialSnapshot(): RuntimeStateSnapshot | null {
    return this._snapshot;
  }
  private _entries: LedgerEntry[] = [];
  private _frames: ReplayFrame[] = [];
  private _currentFrameIndex = 0;
  private _mismatches: ReplayMismatch[] = [];
  private _turnSummaries: ReplayTurnSummary[] = [];
  private readonly _subscribers = new Set<() => void>();

  constructor(projectRoot: string) {
    this._projectRoot = resolve(projectRoot);
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Load a run for replay.
   *
   * Replaces any currently loaded run. The engine is positioned at rev 0
   * (the initial snapshot) after loading.
   *
   * @param runId    - The run identifier.
   * @param snapshot - The initial state snapshot captured at run start.
   * @param entries  - All ledger entries for this run, in any order (sorted internally).
   */
  load(runId: string, snapshot: RuntimeStateSnapshot, entries: LedgerEntry[]): void {
    this._runId = runId;
    this._snapshot = snapshot;
    this._mismatches = [];

    // Sort by revision ascending; validate rev sequence.
    const sorted = [...entries].sort((a, b) => a.rev - b.rev);
    this._entries = sorted;
    this._turnSummaries = this._deriveTurnSummaries(sorted);

    // Build the initial frame from the snapshot.
    const initialDomains = this._snapshotToDomains(snapshot);
    const initialFrame: ReplayFrame = {
      rev: 0,
      domains: initialDomains,
    };

    // Pre-build all frames by folding entries over the initial snapshot.
    this._frames = [initialFrame];
    for (const entry of sorted) {
      const prev = this._frames[this._frames.length - 1];
      const next = this._applyEntry(prev, entry);
      this._frames.push(next);
    }

    this._currentFrameIndex = 0;
    this._status = sorted.length === 0 ? 'exhausted' : 'loaded';

    logger.debug('[DeterministicReplayEngine] run loaded', {
      runId,
      revisions: sorted.length,
      domains: Object.keys(initialDomains).length,
    });

    this._notify();
  }

  /**
   * Advance the replay cursor by `n` steps (default: 1).
   *
   * Returns the frames that were stepped over.
   * If fewer than `n` events remain, steps to the end.
   *
   * @param n - Number of steps to advance.
   * @returns The frames produced by the steps.
   */
  step(n: number = 1): ReplayFrame[] {
    if (this._status === 'idle') {
      logger.warn('[DeterministicReplayEngine] step called with no run loaded');
      return [];
    }

    const stepped: ReplayFrame[] = [];
    for (let i = 0; i < n; i++) {
      if (this._currentFrameIndex >= this._frames.length - 1) {
        this._status = 'exhausted';
        break;
      }
      this._currentFrameIndex++;
      this._status = 'running';
      stepped.push(this._frames[this._currentFrameIndex]);
    }

    if (this._currentFrameIndex >= this._frames.length - 1) {
      this._status = 'exhausted';
    }

    if (stepped.length > 0) {
      const afterSnap = this.getSnapshot();
      this._notify();
    }

    return stepped;
  }

  /**
   * Seek to a specific revision.
   *
   * Valid revisions are 0 (initial snapshot) through `totalRevisions`.
   * Clamped to valid range.
   *
   * @param targetRev - Target revision number.
   */
  seek(targetRev: number): void {
    if (this._status === 'idle') {
      logger.warn('[DeterministicReplayEngine] seek called with no run loaded');
      return;
    }

    const clamped = Math.max(0, Math.min(targetRev, this._frames.length - 1));
    this._currentFrameIndex = clamped;
    if (clamped === 0) {
      this._status = 'loaded';
    } else if (clamped >= this._frames.length - 1) {
      this._status = 'exhausted';
    } else {
      this._status = 'running';
    }

    logger.debug('[DeterministicReplayEngine] seeked', { targetRev, clamped });

    this._notify();
  }

  /**
   * Run diff mode: compare each replayed frame against the recorded sequence.
   *
   * Produces a list of `ReplayMismatch` entries that identify divergences
   * with actionable classifiers and descriptions — not raw payload dumps.
   *
   * Diff analysis covers:
   * - Missing events (recorded entry has no corresponding replayed frame)
   * - Extra events (frame exists past the recorded sequence)
   * - Payload mismatches (event name matches, but key payload fields differ)
   * - Ordering violations (same events, different rev sequence)
   *
   * @returns Ordered list of mismatches (by rev).
   */
  diff(): ReplayMismatch[] {
    if (this._status === 'idle' || this._frames.length === 0) {
      return [];
    }

    const mismatches: ReplayMismatch[] = [];
    const maxRev = Math.max(this._entries.length, this._frames.length - 1);

    for (let i = 0; i < maxRev; i++) {
      const recorded = this._entries[i];
      const frame = this._frames[i + 1]; // frame[0] is snapshot (rev 0)

      if (!recorded && frame) {
        // Extra frame: replayed more events than recorded.
        mismatches.push({
          rev: frame.rev,
          kind: 'extra_event',
          ownerDomain: this._inferOwnerDomain(frame.entry?.eventName),
          failureMode: 'extra_event',
          relatedTurnId: this._extractTurnId(frame.entry?.payload),
          description: `Rev ${frame.rev}: event "${frame.entry?.eventName ?? 'unknown'}" was replayed but does not exist in the recording.`,
          eventName: frame.entry?.eventName,
        });
        continue;
      }

      if (recorded && !frame) {
        // Missing frame: recording has an event that replay did not produce.
        mismatches.push({
          rev: recorded.rev,
          kind: 'missing_event',
          ownerDomain: this._inferOwnerDomain(recorded.eventName),
          failureMode: 'missing_event',
          relatedTurnId: this._extractTurnId(recorded.payload),
          description: `Rev ${recorded.rev}: recorded event "${recorded.eventName}" was not replayed.`,
          eventName: recorded.eventName,
        });
        continue;
      }

      if (!recorded || !frame) continue;

      const frameEntry = frame.entry;
      if (!frameEntry) continue;

      // Check event name ordering.
      if (recorded.eventName !== frameEntry.eventName) {
        mismatches.push({
          rev: recorded.rev,
          kind: 'ordering',
          ownerDomain: this._inferOwnerDomain(recorded.eventName),
          failureMode: 'ordering_violation',
          relatedTurnId: this._extractTurnId(recorded.payload, frameEntry.payload),
          description: `Rev ${recorded.rev}: expected event "${recorded.eventName}" but replayed "${frameEntry.eventName}". Possible ordering violation.`,
          eventName: recorded.eventName,
          recordedSummary: recorded.eventName,
          replayedSummary: frameEntry.eventName,
        });
        continue;
      }

      // Check payload key-level diff.
      const payloadMismatch = this._diffPayloads(
        recorded.rev,
        recorded.eventName,
        recorded.payload,
        frameEntry.payload,
      );
      if (payloadMismatch) {
        mismatches.push(payloadMismatch);
      }
    }

    mismatches.push(...this._diffTurnSummaries());

    this._mismatches = mismatches;
    this._notify();

    logger.debug('[DeterministicReplayEngine] diff complete', {
      runId: this._runId,
      mismatchCount: mismatches.length,
    });

    return mismatches;
  }

  /**
   * Export the current replay report (frames + mismatches) to a JSON file.
   *
   * The exported object contains:
   * - `runId`
   * - `exportedAt` (epoch ms)
   * - `totalRevisions`
   * - `currentRev`
   * - `mismatches`
   * - `frames` (condensed: rev, eventName, domainNames only — no full state)
   *
   * @param filePath - Absolute path to write the JSON report.
   * @returns A promise that resolves when the file is written.
   */
  async export(filePath: string): Promise<void> {
    if (this._status === 'idle') {
      logger.warn('[DeterministicReplayEngine] export called with no run loaded');
      return;
    }

    // Path traversal guard — confine exports to the project directory or /tmp.
    const resolved = resolve(this._projectRoot, normalize(filePath));
    if (!resolved.startsWith(this._projectRoot) && !resolved.startsWith('/tmp')) {
      throw new Error(`Export path must be within project directory or /tmp. Got: ${resolved}`);
    }

    const report = {
      runId: this._runId,
      exportedAt: Date.now(),
      totalRevisions: this._frames.length - 1,
      currentRev: this._currentFrameIndex,
      mismatches: this._mismatches,
      turnSummaries: this._turnSummaries,
      frames: this._frames.map((f) => ({
        rev: f.rev,
        eventName: f.entry?.eventName ?? null,
        domainNames: Object.keys(f.domains),
      })),
    };

    try {
      await writeFile(resolved, JSON.stringify(report, null, 2), 'utf8');
      logger.info('[DeterministicReplayEngine] exported report', { filePath: resolved, runId: this._runId });
    } catch (err) {
      logger.warn('[DeterministicReplayEngine] export failed', { filePath: resolved, err: String(err) });
      throw err;
    }
  }

  /**
   * Get a snapshot of engine state for the Replay panel.
   */
  getSnapshot(): ReplayEngineSnapshot {
    return {
      status: this._status,
      runId: this._runId,
      currentRev: this._frames[this._currentFrameIndex]?.rev ?? 0,
      totalRevisions: this._frames.length - 1,
      currentFrame: this._frames[this._currentFrameIndex] ?? null,
      mismatches: this._mismatches,
      turnSummaries: this._turnSummaries,
    };
  }

  /**
   * Register a callback invoked when engine state changes.
   * @returns An unsubscribe function.
   */
  subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /** Reset to idle — clears all loaded state. */
  reset(): void {
    this._status = 'idle';
    this._runId = null;
    this._snapshot = null;
    this._entries = [];
    this._frames = [];
    this._currentFrameIndex = 0;
    this._mismatches = [];
    this._turnSummaries = [];
    this._notify();
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Convert a RuntimeStateSnapshot into a flat domain map.
   */
  private _snapshotToDomains(
    snapshot: RuntimeStateSnapshot,
  ): Record<string, Record<string, unknown>> {
    const domains: Record<string, Record<string, unknown>> = {};
    for (const entry of snapshot.domains) {
      domains[entry.domain] = { ...entry.state };
    }
    return domains;
  }

  /**
   * Apply a single ledger entry to the previous frame, producing a new frame.
   *
   * Event payloads are merged into the domain state by convention:
   * the payload is treated as a partial update to the event's implied domain
   * (derived from the event name prefix, e.g. "turn:" → "turn" domain).
   * Unknown domain prefixes are collected into a synthetic "_events" domain.
   */
  private _applyEntry(prev: ReplayFrame, entry: LedgerEntry): ReplayFrame {
    // Derive domain from event name prefix (e.g. "turn:start" → "turn").
    // Events without a colon separator fall back to the synthetic "_events" domain.
    const rawDomain = entry.eventName.split(':')[0];
    const domain = rawDomain && rawDomain !== entry.eventName ? rawDomain : '_events';
    const prevDomainState = prev.domains[domain] ?? {};

    const payload = entry.payload as Record<string, unknown> | null | undefined;
    const merged: Record<string, unknown> = {
      ...prevDomainState,
      _lastEvent: entry.eventName,
      _lastRev: entry.rev,
      _lastTs: entry.ts,
      ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}),
    };

    return {
      rev: entry.rev,
      entry,
      domains: {
        ...prev.domains,
        [domain]: merged,
      },
    };
  }

  /**
   * Compare two payloads at a key-level and return a mismatch if they diverge.
   *
   * Reports only the first differing key to keep the output actionable.
   */
  private _diffPayloads(
    rev: number,
    eventName: string,
    recorded: unknown,
    replayed: unknown,
  ): ReplayMismatch | null {
    const recKeys =
      recorded && typeof recorded === 'object' && !Array.isArray(recorded)
        ? Object.keys(recorded as object).sort()
        : [];
    const repKeys =
      replayed && typeof replayed === 'object' && !Array.isArray(replayed)
        ? Object.keys(replayed as object).sort()
        : [];

    const repSet = new Set(repKeys);
    const missingInReplay = recKeys.filter((k) => !repSet.has(k));
    const recSet = new Set(recKeys);
    const extraInReplay = repKeys.filter((k) => !recSet.has(k));

    if (missingInReplay.length > 0 || extraInReplay.length > 0) {
      return {
        rev,
        kind: 'payload_mismatch',
        eventName,
        ownerDomain: this._inferOwnerDomain(eventName),
        failureMode: 'payload_schema_mismatch',
        relatedTurnId: this._extractTurnId(recorded, replayed),
        description:
          `Rev ${rev} "${eventName}": payload schema mismatch.`
          + (missingInReplay.length ? ` Missing keys in replay: [${missingInReplay.join(', ')}].` : '')
          + (extraInReplay.length ? ` Extra keys in replay: [${extraInReplay.join(', ')}].` : ''),
        recordedSummary: `keys: [${recKeys.join(', ')}]`,
        replayedSummary: `keys: [${repKeys.join(', ')}]`,
      };
    }

    // Check value-level divergence for known scalar fields.
    const rec = recorded as Record<string, unknown>;
    const rep = replayed as Record<string, unknown>;
    for (const key of recKeys) {
      const rv = rec[key];
      const pv = rep[key];
      if (typeof rv !== typeof pv) {
        return {
          rev,
          kind: 'payload_mismatch',
          eventName,
          ownerDomain: this._inferOwnerDomain(eventName),
          failureMode: 'payload_type_mismatch',
          relatedTurnId: this._extractTurnId(recorded, replayed),
          description: `Rev ${rev} "${eventName}": field "${key}" type mismatch (recorded: ${typeof rv}, replayed: ${typeof pv}).`,
          recordedSummary: `${key}: ${typeof rv}`,
          replayedSummary: `${key}: ${typeof pv}`,
        };
      }
      // Scalar equality check.
      if (
        (typeof rv === 'string' || typeof rv === 'number' || typeof rv === 'boolean')
        && rv !== pv
      ) {
        return {
          rev,
          kind: 'payload_mismatch',
          eventName,
          ownerDomain: this._inferOwnerDomain(eventName),
          failureMode: 'payload_value_mismatch',
          relatedTurnId: this._extractTurnId(recorded, replayed),
          description: `Rev ${rev} "${eventName}": field "${key}" value differs. Recorded: ${String(rv).slice(0, 80)}. Replayed: ${String(pv).slice(0, 80)}.`,
          recordedSummary: `${key}=${String(rv).slice(0, 40)}`,
          replayedSummary: `${key}=${String(pv).slice(0, 40)}`,
        };
      }
    }

    return null;
  }

  private _deriveTurnSummaries(
    entries: Array<Pick<LedgerEntry, 'rev' | 'eventName' | 'payload'>>
  ): ReplayTurnSummary[] {
    const starts = new Map<string, number>();
    const summaries: ReplayTurnSummary[] = [];

    for (const entry of entries) {
      const payload =
        entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
          ? entry.payload as Record<string, unknown>
          : null;
      const turnId = typeof payload?.turnId === 'string' ? payload.turnId : undefined;
      if (!turnId) continue;

      if (entry.eventName === 'TURN_SUBMITTED') {
        starts.set(turnId, entry.rev);
        continue;
      }

      if (
        entry.eventName !== 'PREFLIGHT_FAIL'
        && entry.eventName !== 'TURN_COMPLETED'
        && entry.eventName !== 'TURN_ERROR'
        && entry.eventName !== 'TURN_CANCEL'
      ) {
        continue;
      }

      const outcome: ReplayTurnOutcome =
        entry.eventName === 'TURN_COMPLETED'
          ? 'completed'
          : entry.eventName === 'TURN_CANCEL'
            ? 'cancelled'
            : 'failed';

      const message =
        typeof payload?.reason === 'string'
          ? payload.reason
          : typeof payload?.error === 'string'
            ? payload.error
            : typeof payload?.response === 'string'
              ? payload.response.slice(0, 160)
              : undefined;

      summaries.push({
        turnId,
        outcome,
        terminalEvent: entry.eventName,
        startedRev: starts.get(turnId),
        terminalRev: entry.rev,
        stopReason: typeof payload?.stopReason === 'string' ? payload.stopReason : undefined,
        message,
      });
    }

    return summaries;
  }

  private _diffTurnSummaries(): ReplayMismatch[] {
    const recorded = this._deriveTurnSummaries(this._entries);
    const replayed = this._deriveTurnSummaries(
      this._frames
        .map((frame) => frame.entry)
        .filter((entry): entry is LedgerEntry => entry !== undefined),
    );

    const mismatches: ReplayMismatch[] = [];
    const replayedByTurnId = new Map(replayed.map((summary) => [summary.turnId, summary] as const));

    for (const recordedSummary of recorded) {
      const replayedSummary = replayedByTurnId.get(recordedSummary.turnId);
      if (!replayedSummary) {
        mismatches.push({
          rev: recordedSummary.terminalRev,
          kind: 'missing_event',
          eventName: recordedSummary.terminalEvent,
          ownerDomain: 'turn',
          failureMode: 'missing_terminal_summary',
          relatedTurnId: recordedSummary.turnId,
          description: `Rev ${recordedSummary.terminalRev}: missing terminal replay summary for turn "${recordedSummary.turnId}".`,
          recordedSummary: `${recordedSummary.outcome}/${recordedSummary.stopReason ?? 'none'}`,
        });
        continue;
      }

      if (recordedSummary.outcome !== replayedSummary.outcome) {
        mismatches.push({
          rev: recordedSummary.terminalRev,
          kind: 'state_divergence',
          eventName: recordedSummary.terminalEvent,
          ownerDomain: 'turn',
          failureMode: 'terminal_outcome_diverged',
          relatedTurnId: recordedSummary.turnId,
          description: `Rev ${recordedSummary.terminalRev}: turn "${recordedSummary.turnId}" terminal outcome diverged (recorded ${recordedSummary.outcome}, replayed ${replayedSummary.outcome}).`,
          recordedSummary: `${recordedSummary.outcome}/${recordedSummary.stopReason ?? 'none'}`,
          replayedSummary: `${replayedSummary.outcome}/${replayedSummary.stopReason ?? 'none'}`,
        });
        continue;
      }

      if (recordedSummary.stopReason !== replayedSummary.stopReason) {
        mismatches.push({
          rev: recordedSummary.terminalRev,
          kind: 'state_divergence',
          eventName: recordedSummary.terminalEvent,
          ownerDomain: 'turn',
          failureMode: 'stop_reason_diverged',
          relatedTurnId: recordedSummary.turnId,
          description: `Rev ${recordedSummary.terminalRev}: turn "${recordedSummary.turnId}" stop reason diverged (recorded ${recordedSummary.stopReason ?? 'none'}, replayed ${replayedSummary.stopReason ?? 'none'}).`,
          recordedSummary: `${recordedSummary.outcome}/${recordedSummary.stopReason ?? 'none'}`,
          replayedSummary: `${replayedSummary.outcome}/${replayedSummary.stopReason ?? 'none'}`,
        });
      }
    }

    return mismatches;
  }

  private _extractTurnId(...payloads: unknown[]): string | undefined {
    for (const payload of payloads) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
      const maybeTurnId = (payload as Record<string, unknown>).turnId;
      if (typeof maybeTurnId === 'string' && maybeTurnId.length > 0) return maybeTurnId;
    }
    return undefined;
  }

  private _inferOwnerDomain(eventName: string | undefined): ReplayMismatchOwnerDomain {
    if (!eventName) return 'unknown';
    if (eventName.startsWith('TURN_') || eventName.startsWith('PREFLIGHT_') || eventName.startsWith('STREAM_')) return 'turn';
    if (eventName.startsWith('TASK_')) return 'tasks';
    if (eventName.startsWith('TOOL_')) return 'tools';
    if (eventName.startsWith('WORKFLOW_')) return 'workflows';
    if (eventName.startsWith('AGENT_')) return 'agents';
    if (eventName.startsWith('PERMISSION_')) return 'permissions';
    if (eventName.startsWith('PROVIDER_') || eventName.startsWith('MODEL_')) return 'providers';
    if (eventName.startsWith('SESSION_')) return 'session';
    if (eventName.startsWith('CONVERSATION_')) return 'conversation';
    if (eventName.startsWith('TRANSPORT_') || eventName.startsWith('ACP_') || eventName.startsWith('DAEMON_')) return 'transport';
    return 'unknown';
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch (err) {
        // Non-fatal: subscriber errors must not crash the engine.
        logger.debug('[DeterministicReplayEngine] subscriber error', { error: String(err) });
      }
    }
  }
}
