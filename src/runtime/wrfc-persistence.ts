/**
 * WRFC chain persistence — snapshot active chains to disk on every lifecycle
 * event so that a crash/restart can surface interrupted chains to the operator.
 *
 * Architecture
 * ─────────────
 * 1. `createWrfcPersistence` subscribes to all 7 WORKFLOW_* events on the
 *    runtimeBus. Each event schedules a trailing-debounced snapshot (250 ms)
 *    so event bursts from a single state transition don't thrash disk.
 *
 * 2. `WrfcPersistence.rehydrate(router)` is called once on boot (after the
 *    SystemMessageRouter is available). It reads the snapshot, identifies
 *    chains that were in a non-terminal state at last write, and emits a
 *    high-priority 'wrfc' system message per interrupted chain. The
 *    `interruptedChains` accessor makes the data available for panel reads
 *    without coupling this module to wrfc-panel.ts.
 *
 * 3. Snapshot lifecycle:
 *    - Terminal chains ('passed' | 'failed') are pruned from the snapshot
 *      after rehydration surfaces them.
 *    - A corrupt or version-mismatched snapshot is quarantined by renaming it
 *      to `<path>.unrecognized` — never a hard crash.
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

/** Terminal states — chains in these states will not be surfaced as interrupted. */
const TERMINAL_STATES = new Set<WrfcState>(['passed', 'failed']);

/** Non-terminal (interruptible) states. */
function isNonTerminal(state: WrfcState): boolean {
  return !TERMINAL_STATES.has(state);
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
}

export interface WrfcPersistenceOptions {
  /** Absolute path to the snapshot file, e.g. `.goodvibes/tui/wrfc-chains.json`. */
  readonly snapshotPath: string;
  /** Factory for the current SystemMessageRouter — may return null before it is wired. */
  readonly getSystemMessageRouter: () => SystemMessageRouter | null;
  /** WrfcController reader — only listChains() is needed. */
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
   * Read the snapshot from a previous process, surface any interrupted chains
   * as system messages, and prune terminal chains from the snapshot on disk.
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

  constructor(options: WrfcPersistenceOptions) {
    this.snapshotPath = options.snapshotPath;
    this.getSystemMessageRouter = options.getSystemMessageRouter;
    this.controller = options.controller;
  }

  get interruptedChains(): readonly WrfcChain[] {
    return this._interruptedChains;
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

    const interrupted = snapshot.chains.filter((c) => isNonTerminal(c.state));
    this._interruptedChains = interrupted;

    const router = this.getSystemMessageRouter();
    for (const chain of interrupted) {
      const msg =
        `[WRFC] Chain ${chain.id.slice(0, 12)} (${chain.task.slice(0, 60).trim()}) ` +
        `was interrupted by a restart — state was '${chain.state}' ` +
        `after ${chain.reviewCycles} review cycle${chain.reviewCycles !== 1 ? 's' : ''}`;
      router?.wrfc(msg, 'high');
    }

    // Prune terminal chains from the on-disk snapshot after surfacing.
    if (snapshot.chains.length !== interrupted.length) {
      const pruned: WrfcSnapshot = {
        version: SNAPSHOT_VERSION,
        writtenAt: Date.now(),
        chains: interrupted,
      };
      this._writeSnapshot(pruned);
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
    const snapshot: WrfcSnapshot = {
      version: SNAPSHOT_VERSION,
      writtenAt: Date.now(),
      chains: this.controller.listChains(),
    };
    this._writeSnapshot(snapshot);
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
