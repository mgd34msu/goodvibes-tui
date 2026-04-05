/**
 * lifecycle.ts
 *
 * Compaction lifecycle state machine for the compaction engine.
 *
 * Provides:
 * - Valid transition map for the 9-state machine
 * - Pure transition helpers (no side-effects)
 * - Strategy selection logic based on trigger and token pressure
 */

import type { CompactionLifecycleState, CompactionStrategy, CompactionTrigger } from './types.ts';

// ---------------------------------------------------------------------------
// Transition map
// ---------------------------------------------------------------------------

/**
 * Valid state transitions for the compaction lifecycle machine.
 *
 * Key   = current state
 * Value = set of states reachable from current
 */
const VALID_TRANSITIONS: ReadonlyMap<
  CompactionLifecycleState,
  ReadonlySet<CompactionLifecycleState>
> = new Map([
  ['idle',               new Set<CompactionLifecycleState>(['checking_threshold'])],
  ['checking_threshold', new Set<CompactionLifecycleState>(['microcompact', 'collapse', 'autocompact', 'reactive_compact', 'done', 'failed'])],
  ['microcompact',       new Set<CompactionLifecycleState>(['boundary_commit', 'failed'])],
  ['collapse',           new Set<CompactionLifecycleState>(['boundary_commit', 'failed'])],
  ['autocompact',        new Set<CompactionLifecycleState>(['boundary_commit', 'failed'])],
  ['reactive_compact',   new Set<CompactionLifecycleState>(['boundary_commit', 'failed'])],
  ['boundary_commit',    new Set<CompactionLifecycleState>(['done', 'failed'])],
  ['done',               new Set<CompactionLifecycleState>(['idle'])],
  ['failed',             new Set<CompactionLifecycleState>(['idle'])],
]);

// ---------------------------------------------------------------------------
// Transition helpers
// ---------------------------------------------------------------------------

/**
 * Returns whether a transition from `from` to `to` is valid.
 */
export function canTransition(
  from: CompactionLifecycleState,
  to: CompactionLifecycleState,
): boolean {
  return VALID_TRANSITIONS.get(from)?.has(to) ?? false;
}

/**
 * Returns all states reachable from `from`.
 */
export function reachableFrom(
  from: CompactionLifecycleState,
): ReadonlySet<CompactionLifecycleState> {
  return VALID_TRANSITIONS.get(from) ?? new Set();
}

/** Discriminated result of `applyTransition`. */
export type TransitionResult =
  | { ok: true;  state: CompactionLifecycleState }
  | { ok: false; reason: string };

/**
 * Validates and applies a state transition.
 *
 * @returns `{ ok: true, state }` on success, `{ ok: false, reason }` on rejection.
 */
export function applyTransition(
  current: CompactionLifecycleState,
  target: CompactionLifecycleState,
): TransitionResult {
  if (canTransition(current, target)) {
    return { ok: true, state: target };
  }
  return {
    ok: false,
    reason: `Invalid compaction transition: ${current} → ${target}`,
  };
}

// ---------------------------------------------------------------------------
// Terminal / operational helpers
// ---------------------------------------------------------------------------

/** Returns true if the state is a terminal completion state (done | failed). */
export function isTerminal(state: CompactionLifecycleState): boolean {
  return state === 'done' || state === 'failed';
}

/** Returns true if the state represents active compaction work in progress. */
export function isCompacting(state: CompactionLifecycleState): boolean {
  return (
    state === 'microcompact' ||
    state === 'collapse' ||
    state === 'autocompact' ||
    state === 'reactive_compact' ||
    state === 'boundary_commit'
  );
}

// ---------------------------------------------------------------------------
// Strategy selection
// ---------------------------------------------------------------------------

/** Parameters for selecting a compaction strategy. */
export interface StrategySelectionParams {
  /** What triggered compaction. */
  trigger: CompactionTrigger;
  /** Estimated tokens currently in context. */
  currentTokens: number;
  /** Model context window size. */
  contextWindow: number;
  /** Whether a prompt-too-long error was the immediate cause. */
  isPromptTooLong?: boolean;
}

/**
 * Selects the appropriate compaction strategy based on trigger and token pressure.
 *
 * Selection priority:
 * 1. `reactive`     — any prompt-too-long error (emergency, must shrink now)
 * 2. `microcompact` — token pressure < 50% of context window (light touch)
 * 3. `autocompact`  — token pressure 50–85% (standard auto-compaction)
 * 4. `collapse`     — token pressure > 85% or manual trigger (aggressive shrink)
 */
export function selectStrategy(
  params: StrategySelectionParams,
): CompactionStrategy {
  const { trigger, currentTokens, contextWindow, isPromptTooLong } = params;

  if (isPromptTooLong === true || trigger === 'prompt_too_long') {
    return 'reactive';
  }

  const pressure = currentTokens / contextWindow;

  if (pressure < 0.5) {
    return 'microcompact';
  }
  if (pressure < 0.85) {
    return 'autocompact';
  }
  // High pressure or manual trigger — aggressive collapse
  return 'collapse';
}

/**
 * Maps a chosen CompactionStrategy to its corresponding lifecycle state.
 */
export function strategyToState(
  strategy: CompactionStrategy,
): CompactionLifecycleState {
  switch (strategy) {
    case 'microcompact': return 'microcompact';
    case 'collapse':     return 'collapse';
    case 'autocompact':  return 'autocompact';
    case 'reactive':     return 'reactive_compact';
    default: {
      const _exhaustive: never = strategy;
      throw new Error(`Unknown compaction strategy: ${_exhaustive}`);
    }
  }
}
