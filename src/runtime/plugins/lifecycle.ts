/**
 * Plugin lifecycle state machine.
 *
 * Defines the valid state transitions for the 8-state plugin lifecycle
 * and provides pure guard/transition functions with no side effects.
 *
 * States:
 *   discovered → loading → loaded → active ↔ degraded
 *                                          ↓
 *                                        error → (unloading | disabled)
 *                    active/loaded/degraded/error → unloading → disabled
 *                    any → error (non-fatal)
 *                    disabled → loading (re-enable)
 */

import type { PluginLifecycleState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/plugins';
import type { TransitionResult } from './types.ts';

/**
 * Adjacency map: from state → set of valid target states.
 *
 * Encoded as a plain Record so it is safe to evaluate at module load time
 * with no external dependencies.
 */
export const VALID_TRANSITIONS: Readonly<
  Record<PluginLifecycleState, ReadonlyArray<PluginLifecycleState>>
> = {
  discovered: ['loading'],
  loading:    ['loaded', 'error'],
  loaded:     ['active', 'error', 'unloading'],
  active:     ['degraded', 'error', 'unloading'],
  degraded:   ['active', 'error', 'unloading'],
  error:      ['unloading', 'disabled', 'loading'],
  unloading:  ['disabled'],
  disabled:   ['loading'],
} as const;

/**
 * Returns whether a transition from `from` → `to` is permitted by the
 * state machine.
 */
export function canTransition(
  from: PluginLifecycleState,
  to: PluginLifecycleState,
): boolean {
  return (VALID_TRANSITIONS[from] as ReadonlyArray<PluginLifecycleState>).includes(to);
}

/**
 * Attempts a state transition and returns a typed result.
 *
 * This is a pure function — it has no side effects. The caller is responsible
 * for updating the plugin record and emitting events.
 *
 * @param from - Current state.
 * @param to   - Desired target state.
 * @returns `{ ok: true, from, to }` on success or `{ ok: false, reason }` on
 *          invalid transition.
 */
export function applyTransition(
  from: PluginLifecycleState,
  to: PluginLifecycleState,
): TransitionResult {
  if (canTransition(from, to)) {
    return { ok: true, from, to };
  }
  return {
    ok: false,
    reason: `Invalid transition: ${from} → ${to} (allowed from ${from}: [${VALID_TRANSITIONS[from].join(', ')}])`,
  };
}

/**
 * Returns whether a plugin in the given state is considered "operational"
 * (i.e. actively servicing requests, possibly in a degraded capacity).
 */
export function isOperational(state: PluginLifecycleState): boolean {
  return state === 'active' || state === 'degraded';
}

/**
 * Returns whether a plugin in the given state can be safely hot-reloaded.
 * A hot reload requires the plugin to be quiesceable.
 */
export function isReloadable(state: PluginLifecycleState): boolean {
  return state === 'active' || state === 'loaded' || state === 'degraded' || state === 'error';
}

/**
 * Returns whether the plugin's current state represents a terminal failure
 * that requires operator intervention (disabled or persistent error).
 */
export function isTerminal(state: PluginLifecycleState): boolean {
  return state === 'disabled';
}
