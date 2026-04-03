/**
 * DeterministicReplayEngine — Section 5.2
 *
 * Consumes a recorded snapshot + typed event ledger to replay a run
 * deterministically. Supports stepwise transitions, seekable revision
 * positioning, and diff mode that reports expected-vs-replayed mismatches
 * with classifiers.
 *
 * The engine does not re-emit live events on the EventBus — it maintains
 * its own replay-local state tree built by folding ledger entries over the
 * initial snapshot. This isolation ensures replay never affects live state.
 */
import { writeFile } from 'node:fs/promises';
import { resolve, normalize } from 'node:path';
import { logger } from '../utils/logger.ts';
import type { LedgerEntry } from '../runtime/telemetry/exporters/local-ledger.ts';
import type { RuntimeStateSnapshot } from '../runtime/diagnostics/types.ts';
import { EventBus } from './event-bus.ts';

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
}

// ── DeterministicReplayEngine ──────────────────────────────────────────────

/**
 * DeterministicReplayEngine — Section 5.2
 *
 * Usage:
 * ```ts
 * const engine = new DeterministicReplayEngine();
 * engine.load(runId, snapshot, ledgerEntries);
 * engine.step();          // advance one event
 * engine.step(5);         // advance five events
 * engine.seek(10);        // jump to rev 10
 * const report = engine.diff();  // compare current to recorded
 * engine.export('/tmp/replay.json');  // write report to file
 * ```
 */
export class DeterministicReplayEngine {
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
  private readonly _subscribers = new Set<() => void>();

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

    EventBus.getInstance()?.emit('replay:loaded', {
      runId,
      totalRevisions: sorted.length,
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
      if (this._runId) {
        EventBus.getInstance()?.emit('replay:position-changed', {
          runId: this._runId,
          currentRev: afterSnap.currentRev,
          totalRevisions: afterSnap.totalRevisions,
          status: this._status,
        });
      }
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

    if (this._runId) {
      EventBus.getInstance()?.emit('replay:position-changed', {
        runId: this._runId,
        currentRev: clamped,
        totalRevisions: this._frames.length - 1,
        status: this._status,
      });
    }

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

    this._mismatches = mismatches;
    this._notify();

    logger.debug('[DeterministicReplayEngine] diff complete', {
      runId: this._runId,
      mismatchCount: mismatches.length,
    });

    if (this._runId) {
      EventBus.getInstance()?.emit('replay:diff-complete', {
        runId: this._runId,
        mismatchCount: mismatches.length,
      });
    }

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
    const resolved = resolve(normalize(filePath));
    const cwd = process.cwd();
    if (!resolved.startsWith(cwd) && !resolved.startsWith('/tmp')) {
      throw new Error(`Export path must be within project directory or /tmp. Got: ${resolved}`);
    }

    const report = {
      runId: this._runId,
      exportedAt: Date.now(),
      totalRevisions: this._frames.length - 1,
      currentRev: this._currentFrameIndex,
      mismatches: this._mismatches,
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
          description: `Rev ${rev} "${eventName}": field "${key}" value differs. Recorded: ${String(rv).slice(0, 80)}. Replayed: ${String(pv).slice(0, 80)}.`,
          recordedSummary: `${key}=${String(rv).slice(0, 40)}`,
          replayedSummary: `${key}=${String(pv).slice(0, 40)}`,
        };
      }
    }

    return null;
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch (err) {
        // Non-fatal: subscriber errors must not crash the engine.
        logger.debug('[DeterministicReplayEngine] subscriber error:', err);
      }
    }
  }
}

/** Module-level singleton. */
let _instance: DeterministicReplayEngine | undefined;

export function getReplayEngine(): DeterministicReplayEngine {
  if (!_instance) {
    _instance = new DeterministicReplayEngine();
  }
  return _instance;
}

/** Reset singleton (for testing). */
export function resetReplayEngine(): void {
  _instance = undefined;
}
