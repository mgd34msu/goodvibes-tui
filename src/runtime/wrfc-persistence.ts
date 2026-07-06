/**
 * WRFC chain persistence — snapshot active chains to disk on every lifecycle
 * event so that a crash/restart can surface interrupted chains to the operator,
 * and so that terminal chains (passed/failed/cancelled) remain visible as
 * bounded history rather than vanishing the moment they finish.
 *
 * Architecture
 * ─────────────
 * 1. `createWrfcPersistence` subscribes to all 7 WORKFLOW_* events on the
 *    runtimeBus. Each event schedules a trailing-debounced snapshot (250 ms)
 *    so event bursts from a single state transition don't thrash disk.
 *
 * 2. `WrfcPersistence.rehydrate(router)` is called once on boot (after the
 *    SystemMessageRouter is available). It reads the snapshot, identifies
 *    chains that were in a non-terminal state at last write, emits a
 *    high-priority 'wrfc' system message per interrupted chain, and re-imports
 *    each interrupted chain into the WrfcController so it reappears as a panel
 *    row and can be resumed by the operator. The `interruptedChains` accessor
 *    additionally exposes the recovered set for inspection.
 *
 *    A chain that looked interrupted (non-terminal) in the old snapshot can be
 *    reaped to terminal IN PLACE by `WrfcController.importChain` (the zombie-reap pass:
 *    no member agent survived the restart — see wrfc-controller.ts). This
 *    module always re-checks `chain.state` AFTER the import call, never the
 *    pre-import classification, so a reaped chain is treated as history, not
 *    re-surfaced as interrupted and never re-imported again on a later restart.
 *
 * 3. Terminal-history retention (bounded, most-recently-completed first):
 *    Previously, every terminal chain was pruned from the snapshot the moment
 *    it was written or rehydrated — a killed/finished chain vanished from
 *    wrfc-chains.json entirely, including across a restart, so nothing could
 *    ever honestly report "last chain: <state>". Terminal chains are now
 *    RETAINED, capped at MAX_TERMINAL_HISTORY (20) most-recently-completed,
 *    both:
 *      - across a live session, via an internal history cache that survives
 *        even after WrfcController's own in-memory cleanup (60s after a
 *        chain terminates) drops the chain from listChains(); and
 *      - across a restart, via rehydrate() seeding that cache from whatever
 *        was already terminal in the prior snapshot instead of discarding it.
 *    A corrupt or version-mismatched snapshot is quarantined by renaming it
 *    to `<path>.unrecognized` — never a hard crash.
 *
 * Snapshot path: `.goodvibes/tui/wrfc-chains.json`
 * Snapshot schema: `{ version: 1, writtenAt: number, chains: WrfcChain[] }`
 */

import type { WrfcChain, WrfcState } from '@pellux/goodvibes-sdk/platform/agents';
import type { RuntimeEventBus, WorkflowEvent } from '@/runtime/index.ts';
import { atomicWriteFileSync } from '../config/atomic-write.ts';
import { readVersioned } from '../config/read-versioned.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';

// ─── Constants ───────────────────────────────────────────────────────────────

const SNAPSHOT_VERSION = 1;
const DEBOUNCE_MS = 250;

/** Bounded terminal-history retention: keep the most recent K chains, prune beyond. */
const MAX_TERMINAL_HISTORY = 20;

/** Terminal states — chains in these states will not be surfaced as interrupted. */
const TERMINAL_STATES = new Set<WrfcState>(['passed', 'failed']);

/** Non-terminal (interruptible) states. */
function isNonTerminal(state: WrfcState): boolean {
  return !TERMINAL_STATES.has(state);
}

/** Sort by most-recently-completed first (falls back to createdAt for chains missing completedAt) and keep only the first `limit`. */
function takeMostRecentTerminal(chains: readonly WrfcChain[], limit: number): WrfcChain[] {
  return [...chains]
    .sort((a, b) => (b.completedAt ?? b.createdAt ?? 0) - (a.completedAt ?? a.createdAt ?? 0))
    .slice(0, limit);
}

// ─── Snapshot schema ─────────────────────────────────────────────────────────

interface WrfcSnapshot {
  readonly version: number;
  readonly writtenAt: number;
  readonly chains: WrfcChain[];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Subset of WrfcController needed by this module. */
export interface WrfcControllerReader {
  listChains(): WrfcChain[];
  /**
   * Re-import a chain recovered from a previous process so it reappears in the
   * controller's in-memory map and becomes selectable/resumable from the panel.
   * Optional so read-only test doubles can omit it; the real WrfcController
   * provides it. `force` is left at its default — on a fresh start the map is
   * empty so importing never clobbers a live chain.
   */
  importChain?(chain: WrfcChain, force?: boolean): boolean;
}

export interface WrfcPersistenceOptions {
  /** Absolute path to the snapshot file, e.g. `.goodvibes/tui/wrfc-chains.json`. */
  readonly snapshotPath: string;
  /** Factory for the current SystemMessageRouter — may return null before it is wired. */
  readonly getSystemMessageRouter: () => SystemMessageRouter | null;
  /** WrfcController access — listChains() (read) plus optional importChain() (re-import on rehydrate). */
  readonly controller: WrfcControllerReader;
}

export interface WrfcPersistence {
  /**
   * Chains from the previous process that were in a non-terminal state.
   * Populated only after `rehydrate()` is called.
   */
  readonly interruptedChains: readonly WrfcChain[];

  /**
   * Subscribe to runtimeBus workflow events and start persisting snapshots.
   * Returns an array of unsubscribe functions to be added to `runtimeUnsubs`.
   */
  attach(runtimeBus: RuntimeEventBus): Array<() => void>;

  /**
   * All chains known after rehydrate(): the (re-checked, post-reap) interrupted
   * set plus the bounded terminal-history cache seeded from the prior snapshot.
   * Empty until rehydrate() is called. Consumers building a post-restart
   * summary (e.g. the boot resume notice) read this instead of re-parsing the
   * snapshot file themselves.
   */
  readonly knownChains: readonly WrfcChain[];

  /**
   * Read the snapshot from a previous process, surface any interrupted chains
   * as system messages, and retain terminal chains (bounded, most-recently-
   * completed first) as on-disk history instead of pruning them.
   *
   * Must be called after the SystemMessageRouter is available.
   */
  rehydrate(): void;

  /** Flush any pending debounced snapshot immediately (used in tests). */
  flush(): void;
}

// ─── Implementation ──────────────────────────────────────────────────────────

class WrfcPersistenceImpl implements WrfcPersistence {
  private readonly snapshotPath: string;
  private readonly getSystemMessageRouter: () => SystemMessageRouter | null;
  private readonly controller: WrfcControllerReader;

  private _interruptedChains: WrfcChain[] = [];
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bounded terminal-history cache (most-recently-completed first once
   * trimmed). Survives past WrfcController's own in-memory cleanup of
   * terminated chains (60s after termination — see wrfc-controller.ts
   * scheduleChainCleanup) so a chain that ages out of listChains() is not
   * silently dropped from the persisted snapshot.
   */
  private _terminalHistory: WrfcChain[] = [];

  constructor(options: WrfcPersistenceOptions) {
    this.snapshotPath = options.snapshotPath;
    this.getSystemMessageRouter = options.getSystemMessageRouter;
    this.controller = options.controller;
  }

  get interruptedChains(): readonly WrfcChain[] {
    return this._interruptedChains;
  }

  get knownChains(): readonly WrfcChain[] {
    return [...this._interruptedChains, ...this._terminalHistory];
  }

  attach(runtimeBus: RuntimeEventBus): Array<() => void> {
    const schedule = (): void => this._scheduleSnapshot();

    const events: WorkflowEvent['type'][] = [
      'WORKFLOW_CHAIN_CREATED',
      'WORKFLOW_STATE_CHANGED',
      'WORKFLOW_REVIEW_COMPLETED',
      'WORKFLOW_FIX_ATTEMPTED',
      'WORKFLOW_GATE_RESULT',
      'WORKFLOW_CHAIN_PASSED',
      'WORKFLOW_CHAIN_FAILED',
    ];

    return events.map((eventType) =>
      runtimeBus.on<Extract<WorkflowEvent, { type: typeof eventType }>>(eventType, schedule),
    );
  }

  rehydrate(): void {
    const snapshot = this._readSnapshot();
    if (!snapshot) return;

    // Seed the bounded terminal-history cache from whatever was already
    // terminal in the prior process's snapshot, so it survives this restart
    // instead of being wiped (the old behaviour pruned every terminal chain
    // unconditionally on every rehydrate).
    const alreadyTerminal = snapshot.chains.filter((c) => !isNonTerminal(c.state));
    this._terminalHistory = takeMostRecentTerminal(alreadyTerminal, MAX_TERMINAL_HISTORY);

    const candidateInterrupted = snapshot.chains.filter((c) => isNonTerminal(c.state));
    for (const chain of candidateInterrupted) {
      // Re-import so the chain reappears in the controller's in-memory map and
      // becomes selectable/resumable from the panel. On a fresh process start
      // the map is empty, so importChain (force=false) never clobbers a live
      // chain. The accessor is optional for read-only test doubles.
      //
      // NOTE: importChain may reap this chain to a terminal state IN PLACE
      // (zombie reap: no member agent survived the restart) —
      // always read chain.state AFTER this call below, never the pre-import
      // classification captured by candidateInterrupted.
      this.controller.importChain?.(chain);
    }

    // Re-partition after the reap check: a chain that looked interrupted
    // before import may now be terminal. Only genuinely still-live chains are
    // surfaced to the operator as interrupted; anything reaped just now joins
    // history instead — it is done, not a resurrection candidate, and must
    // never be handed to importChain again on a future restart (a chain only
    // ever lands in candidateInterrupted while its persisted state is
    // non-terminal; once it's history its state is terminal for good).
    this._interruptedChains = candidateInterrupted.filter((c) => isNonTerminal(c.state));
    const reapedJustNow = candidateInterrupted.filter((c) => !isNonTerminal(c.state));
    for (const chain of reapedJustNow) this._upsertHistoryChain(chain);

    const router = this.getSystemMessageRouter();
    for (const chain of this._interruptedChains) {
      const msg =
        `[WRFC] Chain ${chain.id.slice(0, 12)} (${chain.task.slice(0, 60).trim()}) ` +
        `was interrupted by a restart — state was '${chain.state}' ` +
        `after ${chain.reviewCycles} review cycle${chain.reviewCycles !== 1 ? 's' : ''}`;
      router?.wrfc(msg, 'high');
    }

    // Rewrite the snapshot only when something actually changed: a chain was
    // reaped just now, or the history cap pruned an entry that was on disk.
    // Terminal chains are RETAINED (bounded to MAX_TERMINAL_HISTORY, most
    // recently completed first) instead of erased — post-restart surfaces
    // (fleet, the resume notice, /wrfc history) need this to honestly report
    // e.g. "last chain: cancelled".
    if (reapedJustNow.length > 0 || alreadyTerminal.length !== this._terminalHistory.length) {
      const rebuilt: WrfcSnapshot = {
        version: SNAPSHOT_VERSION,
        writtenAt: Date.now(),
        chains: [...this._interruptedChains, ...this._terminalHistory],
      };
      this._writeSnapshot(rebuilt);
    }
  }

  flush(): void {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._writeCurrentSnapshot();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _scheduleSnapshot(): void {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._writeCurrentSnapshot();
    }, DEBOUNCE_MS);
  }

  private _writeCurrentSnapshot(): void {
    const live = this.controller.listChains();
    this._recordTerminalHistory(live);
    const snapshot: WrfcSnapshot = {
      version: SNAPSHOT_VERSION,
      writtenAt: Date.now(),
      chains: this._mergeWithHistory(live),
    };
    this._writeSnapshot(snapshot);
  }

  /** Fold any terminal chains in a live listing into the bounded history cache, so they are not lost once WrfcController's own in-memory cleanup drops them from listChains(). */
  private _recordTerminalHistory(chains: readonly WrfcChain[]): void {
    for (const chain of chains) {
      if (!isNonTerminal(chain.state)) this._upsertHistoryChain(chain);
    }
  }

  /** Insert/replace `chain` in the terminal-history cache (by id), then trim to MAX_TERMINAL_HISTORY, most-recently-completed first. */
  private _upsertHistoryChain(chain: WrfcChain): void {
    const next = this._terminalHistory.filter((c) => c.id !== chain.id);
    next.push(chain);
    this._terminalHistory = takeMostRecentTerminal(next, MAX_TERMINAL_HISTORY);
  }

  /**
   * Combine the live chains the controller is currently tracking with any
   * historical terminal chains the live map has already forgotten (e.g. after
   * WrfcController's own 60s in-memory cleanup) — so the persisted file never
   * loses a terminal chain just because the live map stopped carrying it.
   * Live entries win on id collision since they are always the freshest copy.
   */
  private _mergeWithHistory(live: readonly WrfcChain[]): WrfcChain[] {
    const liveIds = new Set(live.map((c) => c.id));
    const historyOnly = this._terminalHistory.filter((c) => !liveIds.has(c.id));
    return [...live, ...historyOnly];
  }

  private _writeSnapshot(snapshot: WrfcSnapshot): void {
    try {
      atomicWriteFileSync(this.snapshotPath, JSON.stringify(snapshot), { mkdirp: true });
    } catch {
      // Best-effort — never crash the TUI over a persistence failure.
    }
  }

  private _readSnapshot(): WrfcSnapshot | null {
    // readVersioned handles: missing file → null, corrupt JSON → quarantine to
    // .unrecognized, future/unrecognised version → quarantine, stepwise migration.
    const raw = readVersioned<WrfcSnapshot & { version: number }>(
      this.snapshotPath,
      {
        currentVersion: SNAPSHOT_VERSION,
        // v0 → v1: pass through the data as-is (safety net only).
        // NOTE: readVersioned does NOT coerce missing/non-numeric version fields to 0.
        // Files without a version field are quarantined immediately. This migration
        // only fires for files that explicitly contain `version: 0`.
        migrations: {
          0: (d) => ({ ...d, version: 1 }),
        },
        onUnknown: 'quarantine',
      },
    );
    if (!raw) return null;

    // Narrow the application-level fields that readVersioned does not validate.
    if (typeof raw['writtenAt'] !== 'number' || !Array.isArray(raw['chains'])) {
      return null;
    }

    return raw as WrfcSnapshot;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a WrfcPersistence instance.
 *
 * Call `persistence.attach(runtimeBus)` and push the returned unsubs into
 * `runtimeUnsubs`. Call `persistence.rehydrate()` once the SystemMessageRouter
 * is available.
 */
export function createWrfcPersistence(options: WrfcPersistenceOptions): WrfcPersistence {
  return new WrfcPersistenceImpl(options);
}
