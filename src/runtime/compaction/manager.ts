/**
 * manager.ts
 *
 * CompactionManager — orchestrates the full compaction lifecycle state machine.
 *
 * Responsibilities:
 * - Gate all compaction behind the `session-compaction-v2` feature flag
 * - Drive state transitions (idle → checking_threshold → strategy → boundary_commit → done/failed)
 * - Select and execute the appropriate compaction strategy
 * - Create boundary commits with lineage tracking
 * - Emit CompactionEvents at each transition
 * - Expose the resume repair pipeline
 */

import { logger } from '../../utils/logger.ts';
import type { RuntimeEventBus } from '../events/index.ts';
import type { FeatureFlagManager } from '../feature-flags/manager.ts';
import type { EmitterContext } from '../emitters/index.ts';
import {
  applyTransition,
  selectStrategy,
  strategyToState,
} from './lifecycle.ts';
import {
  runMicrocompact,
  runCollapse,
  runAutocompact,
  runReactive,
  createBoundaryCommit,
  validateBoundaryCommit,
} from './strategies/index.ts';
import { runResumeRepair } from './resume-repair.ts';
import type {
  BoundaryCommit,
  CompactionLifecycleResult,
  CompactionLifecycleState,
  CompactionStrategy,
  CompactionTrigger,
  StrategyInput,
  StrategyOutput,
} from './types.ts';
import type { ResumeRepairResult } from './types.ts';
import {
  emitCompactionCheck,
  emitCompactionDone,
  emitCompactionFailed,
  emitCompactionBoundaryCommit,
  emitCompactionMicrocompact,
  emitCompactionCollapse,
  emitCompactionAutocompact,
  emitCompactionReactive,
} from '../emitters/compaction.ts';
import type { ProviderMessage } from '../../providers/interface.ts';

// ---------------------------------------------------------------------------
// Manager options
// ---------------------------------------------------------------------------

/** Options for constructing a CompactionManager. */
export interface CompactionManagerOptions {
  /** Session ID for event correlation. */
  sessionId: string;
  /** Runtime event bus for emitting CompactionEvents. */
  bus: RuntimeEventBus;
  /** Feature flag manager — used to gate on `session-compaction-v2`. */
  flags: FeatureFlagManager;
  /** Model context window size (tokens). */
  contextWindow: number;
  /** Threshold fraction at which compaction is triggered (default: 0.75). */
  thresholdFraction?: number;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * CompactionManager — manages the full lifecycle of session context compaction.
 *
 * All compaction is gated behind the `session-compaction-v2` feature flag.
 * When the flag is disabled, `compact()` is a no-op and returns the original
 * messages unchanged.
 *
 * Usage:
 * ```ts
 * const manager = createCompactionManager({ sessionId, bus, flags, contextWindow });
 * const result = await manager.compact({ messages, tokenCount: 45000, trigger: 'auto' });
 * ```
 */
export class CompactionManager {
  private readonly _sessionId: string;
  private readonly _bus: RuntimeEventBus;
  private readonly _flags: FeatureFlagManager;
  private readonly _contextWindow: number;
  private readonly _thresholdFraction: number;

  /** Current state machine state. */
  private _state: CompactionLifecycleState = 'idle';

  /** Most recent boundary commit (null until first successful compaction). */
  private _lastCommit: BoundaryCommit | null = null;

  /** Emitter context used for all event emissions. */
  private readonly _ctx: EmitterContext;

  constructor(opts: CompactionManagerOptions) {
    this._sessionId = opts.sessionId;
    this._bus = opts.bus;
    this._flags = opts.flags;
    this._contextWindow = opts.contextWindow;
    this._thresholdFraction = opts.thresholdFraction ?? 0.75;
    this._ctx = {
      sessionId: opts.sessionId,
      source: 'compaction-manager',
      traceId: crypto.randomUUID(),
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Returns the current lifecycle state. */
  get state(): CompactionLifecycleState {
    return this._state;
  }

  /** Returns the most recent boundary commit, or null. */
  get lastCommit(): BoundaryCommit | null {
    return this._lastCommit;
  }

  /**
   * Options for a compaction run.
   */

  /**
   * Runs the compaction lifecycle for the given messages and trigger.
   *
   * If the `session-compaction-v2` feature flag is disabled, returns the
   * original messages unchanged with no events emitted.
   *
   * @param opts - Run options.
   * @returns Lifecycle result, or null if gated/skipped.
   */
  async compact(opts: {
    messages: ProviderMessage[];
    tokenCount: number;
    trigger: CompactionTrigger;
    isPromptTooLong?: boolean;
  }): Promise<CompactionLifecycleResult | null> {
    // ── Feature flag gate ────────────────────────────────────────────────────
    if (!this._flags.isEnabled('session-compaction-v2')) {
      logger.debug('[CompactionManager] session-compaction-v2 flag disabled; skipping', {
        sessionId: this._sessionId,
      });
      return null;
    }

    const runStart = Date.now();
    const { messages, tokenCount, trigger, isPromptTooLong } = opts;
    const threshold = Math.floor(this._contextWindow * this._thresholdFraction);

    // ── Transition: idle → checking_threshold ────────────────────────────────
    this._transition('checking_threshold');

    emitCompactionCheck(this._bus, this._ctx, {
      sessionId: this._sessionId,
      tokenCount,
      threshold,
    });

    // ── Check threshold ──────────────────────────────────────────────────────
    if (trigger === 'auto' && !isPromptTooLong && tokenCount < threshold) {
      // Below threshold — go straight to done without compacting
      this._transition('done');
      this._transition('idle');
      logger.debug('[CompactionManager] below threshold; no compaction needed', {
        sessionId: this._sessionId,
        tokenCount,
        threshold,
      });
      return null;
    }

    // ── Select strategy ──────────────────────────────────────────────────────
    const strategy = selectStrategy({
      trigger,
      currentTokens: tokenCount,
      contextWindow: this._contextWindow,
      isPromptTooLong,
    });
    const strategyState = strategyToState(strategy);

    // ── Transition: checking_threshold → <strategy state> ────────────────────
    this._transition(strategyState);

    // ── Execute strategy ─────────────────────────────────────────────────────
    let strategyOutput: StrategyOutput;
    try {
      strategyOutput = await this._runStrategy(strategy, {
        sessionId: this._sessionId,
        messages,
        tokensBefore: tokenCount,
        contextWindow: this._contextWindow,
        strategy,
        meta: isPromptTooLong !== undefined ? { isPromptTooLong } : undefined,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this._transition('failed');
      emitCompactionFailed(this._bus, this._ctx, {
        sessionId: this._sessionId,
        strategy,
        error,
      });
      this._transition('idle');
      logger.error('[CompactionManager] strategy execution failed', {
        sessionId: this._sessionId,
        strategy,
        error,
      });
      return null;
    }

    // ── Transition: <strategy> → boundary_commit ─────────────────────────────
    this._transition('boundary_commit');

    // ── Create boundary commit ───────────────────────────────────────────────
    const commit = createBoundaryCommit({
      sessionId: this._sessionId,
      strategyOutput,
      parent: this._lastCommit,
      tokensBefore: tokenCount,
    });

    const commitErrors = validateBoundaryCommit(commit);
    if (commitErrors.length > 0) {
      const error = commitErrors.join('; ');
      this._transition('failed');
      emitCompactionFailed(this._bus, this._ctx, {
        sessionId: this._sessionId,
        strategy,
        error,
      });
      this._transition('idle');
      logger.error('[CompactionManager] boundary commit validation failed', {
        sessionId: this._sessionId,
        errors: commitErrors,
      });
      return null;
    }

    emitCompactionBoundaryCommit(this._bus, this._ctx, {
      sessionId: this._sessionId,
      checkpointId: commit.checkpointId,
    });

    this._lastCommit = commit;

    // ── Transition: boundary_commit → done ───────────────────────────────────
    this._transition('done');
    const durationMs = Date.now() - runStart;

    emitCompactionDone(this._bus, this._ctx, {
      sessionId: this._sessionId,
      strategy,
      tokensBefore: tokenCount,
      tokensAfter: strategyOutput.tokensAfter,
      durationMs,
    });

    // ── Transition: done → idle ───────────────────────────────────────────────
    this._transition('idle');

    return {
      sessionId: this._sessionId,
      strategy,
      tokensBefore: tokenCount,
      tokensAfter: strategyOutput.tokensAfter,
      durationMs,
      commit,
      messages: strategyOutput.messages,
      warnings: strategyOutput.warnings,
    };
  }

  /**
   * Runs the session resume repair pipeline on the last boundary commit.
   *
   * If no commit exists, returns a result with the original messages and
   * a warning action.
   *
   * @param overrideCommit - Optional commit to repair (defaults to lastCommit).
   * @returns ResumeRepairResult.
   */
  repair(
    overrideCommit?: BoundaryCommit,
  ): ResumeRepairResult {
    const commit = overrideCommit ?? this._lastCommit;
    if (!commit) {
      return {
        sessionId: this._sessionId,
        repaired: false,
        actions: [
          {
            kind: 'no_commit',
            description: 'No boundary commit available; nothing to repair.',
            severity: 'info',
          },
        ],
        messages: [],
        safeToResume: false,
        failReason: 'No boundary commit available for repair.',
      };
    }
    return runResumeRepair({ commit });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Executes the selected strategy and emits the corresponding domain event.
   */
  private async _runStrategy(
    strategy: CompactionStrategy,
    input: StrategyInput,
  ): Promise<StrategyOutput> {
    switch (strategy) {
      case 'microcompact': {
        const output = runMicrocompact(input);
        emitCompactionMicrocompact(this._bus, this._ctx, {
          sessionId: this._sessionId,
          turnCount: input.messages.length,
          tokensBefore: input.tokensBefore,
          tokensAfter: output.tokensAfter,
        });
        return output;
      }
      case 'collapse': {
        const output = runCollapse(input);
        emitCompactionCollapse(this._bus, this._ctx, {
          sessionId: this._sessionId,
          messageCount: input.messages.length,
          tokensBefore: input.tokensBefore,
          tokensAfter: output.tokensAfter,
        });
        return output;
      }
      case 'autocompact': {
        const output = runAutocompact(input);
        emitCompactionAutocompact(this._bus, this._ctx, {
          sessionId: this._sessionId,
          strategy: 'autocompact',
          tokensBefore: input.tokensBefore,
          tokensAfter: output.tokensAfter,
        });
        return output;
      }
      case 'reactive': {
        const output = runReactive(input);
        emitCompactionReactive(this._bus, this._ctx, {
          sessionId: this._sessionId,
          tokenCount: input.tokensBefore,
          limit: this._contextWindow,
        });
        return output;
      }
      default: {
        const _exhaustive: never = strategy;
        throw new Error(`Unknown compaction strategy: ${_exhaustive}`);
      }
    }
  }

  /**
   * Applies a state transition, throwing if invalid.
   * Invalid transitions are logged and treated as internal errors.
   */
  private _transition(target: CompactionLifecycleState): void {
    const result = applyTransition(this._state, target);
    if (!result.ok) {
      logger.error('[CompactionManager] invalid state transition', {
        from: this._state,
        to: target,
        reason: result.reason,
        sessionId: this._sessionId,
      });
      // Force to failed to avoid being stuck in an inconsistent state
      this._state = 'failed';
      return;
    }
    this._state = result.state;
  }
}
