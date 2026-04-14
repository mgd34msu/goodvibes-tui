/**
 * FeatureFlagManager — runtime feature gate and emergency kill-switch controller.
 *
 * Responsibilities:
 *   - Initialises all flags from the registry with their default states.
 *   - Applies config-layer overrides (`loadFromConfig`).
 *   - Enforces kill-switch semantics: a killed flag cannot be re-enabled without
 *     first being un-killed via `disable()`.
 *   - Refuses runtime toggles for flags marked `runtimeToggleable: false`.
 *   - Maintains an in-process audit log of all transitions.
 *   - Notifies subscribers synchronously on every state change.
 */
import { FEATURE_FLAG_MAP } from './flags.ts';
import type { FlagConfig, FlagState, FlagTransition, FeatureFlag } from './types.ts';
import { summarizeError } from '../../utils/error-display.ts';

/** Subscriber callback type for flag state changes */
export type FlagSubscriber = (
  flagId: string,
  state: FlagState,
  previous: FlagState,
) => void;

/**
 * Manages the runtime state of all registered feature flags.
 *
 */
class FeatureFlagManagerImpl {
  /** Current state for each registered flag */
  private readonly _states: Map<string, FlagState> = new Map();

  /** Kill reasons stored separately to survive a disable() then re-kill cycle */
  private readonly _killReasons: Map<string, string> = new Map();

  /** In-process ordered audit log of all state transitions */
  private readonly _transitions: FlagTransition[] = [];

  /** Active subscriber callbacks */
  private readonly _subscribers: Set<FlagSubscriber> = new Set();

  constructor() {
    // Seed all flags with their declared defaults
    for (const [id, flag] of FEATURE_FLAG_MAP) {
      this._states.set(id, flag.defaultState);
    }
  }

  // ── Read API ────────────────────────────────────────────────────────────

  /**
   * Returns `true` only if the flag is in the `'enabled'` state.
   * A killed flag always returns `false`.
   *
   * @param flagId - The flag's kebab-case identifier.
   */
  isEnabled(flagId: string): boolean {
    return this._states.get(flagId) === 'enabled';
  }

  /**
   * Returns `true` if the flag has been emergency-killed.
   *
   * @param flagId - The flag's kebab-case identifier.
   */
  isKilled(flagId: string): boolean {
    return this._states.get(flagId) === 'killed';
  }

  /**
   * Returns the current `FlagState` for the given flag.
   * Throws if the flag id is not registered.
   *
   * @param flagId - The flag's kebab-case identifier.
   */
  getState(flagId: string): FlagState {
    const state = this._states.get(flagId);
    if (state === undefined) {
      throw new Error(`[FeatureFlagManager] Unknown flag: "${flagId}"`);
    }
    return state;
  }

  /**
   * Returns a new snapshot Map of all flags with their current state.
   * Changes to the returned map do not affect the manager's internal state.
   */
  getAll(): Map<string, { flag: FeatureFlag; state: FlagState }> {
    const result = new Map<string, { flag: FeatureFlag; state: FlagState }>();
    for (const [id, state] of this._states) {
      const flag = FEATURE_FLAG_MAP.get(id);
      if (flag !== undefined) {
        result.set(id, { flag, state });
      }
    }
    return result;
  }

  /**
   * Returns the ordered audit log of all flag state transitions recorded
   * in this process lifetime.
   */
  getTransitions(): readonly FlagTransition[] {
    return this._transitions;
  }

  // ── Write API ───────────────────────────────────────────────────────────

  /**
   * Enables a flag.
   *
   * Throws if:
   *   - The flag id is not registered.
   *   - The flag is currently `'killed'` (must call `disable()` first to un-kill).
   *   - The flag is not `runtimeToggleable` and the process has already started.
   *
   * @param flagId - The flag's kebab-case identifier.
   */
  enable(flagId: string): void {
    const flag = this._requireFlag(flagId);
    const previous = this._states.get(flagId) as FlagState;

    if (previous === 'enabled') return; // idempotent

    if (previous === 'killed') {
      throw new Error(
        `[FeatureFlagManager] Cannot enable killed flag "${flagId}". Call disable() first to un-kill, then enable().`,
      );
    }

    if (!flag.runtimeToggleable) {
      // Startup-only flags may only be enabled via loadFromConfig before the
      // runtime event loop begins; runtime calls are rejected.
      throw new Error(
        `[FeatureFlagManager] Flag "${flagId}" is not runtime-toggleable. Use loadFromConfig() at startup.`,
      );
    }

    this._transition(flagId, previous, 'enabled');
  }

  /**
   * Disables a flag (or un-kills it, resetting to `'disabled'`).
   *
   * This is the only way to move a flag out of the `'killed'` state.
   *
   * Throws if the flag is not `runtimeToggleable` and is not currently killed
   * (un-killing a killed flag is always permitted regardless of toggleability).
   *
   * @param flagId - The flag's kebab-case identifier.
   */
  disable(flagId: string): void {
    const flag = this._requireFlag(flagId);
    const previous = this._states.get(flagId) as FlagState;

    if (previous === 'disabled') return; // idempotent

    if (!flag.runtimeToggleable && previous !== 'killed') {
      throw new Error(
        `[FeatureFlagManager] Flag "${flagId}" is not runtime-toggleable. Use loadFromConfig() at startup.`,
      );
    }

    this._killReasons.delete(flagId);
    this._transition(flagId, previous, 'disabled');
  }

  /**
   * Emergency-kills a flag with a mandatory reason.
   *
   * A killed flag:
   *   - Returns `false` from `isEnabled()`.
   *   - Cannot be re-enabled until `disable()` is called first.
   *   - Records the kill reason in the audit log and the `_killReasons` map.
   *
   * Calling `kill()` on an already-killed flag updates the reason and
   * records a new transition (idempotent on state, not on reason).
   *
   * **Note:** `kill()` intentionally bypasses `runtimeToggleable` — it is an
   * emergency override and must never be blocked by flag configuration.
   *
   * @param flagId - The flag's kebab-case identifier.
   * @param reason - Human-readable explanation of why the flag was killed.
   */
  kill(flagId: string, reason: string): void {
    if (!reason || reason.trim().length === 0) {
      throw new Error(`[FeatureFlagManager] Kill reason is required for flag '${flagId}'`);
    }

    this._requireFlag(flagId);
    const previous = this._states.get(flagId) as FlagState;

    this._killReasons.set(flagId, reason);

    this._transition(flagId, previous, 'killed', reason);
  }

  // ── Config integration ──────────────────────────────────────────────────

  /**
   * Applies flag state overrides from the user config layer.
   *
   * - Missing flag ids are silently ignored (avoids crashes on stale configs).
   * - Skips non-toggleable flags if the current state is already non-default
   *   (allows startup-only flags to be seeded via config without error).
   * - A config-level `'killed'` state is applied without a reason string;
   *   use `kill()` directly for operator-initiated kills with reasons.
   *
   * @param config - Parsed flag config block from the user config file.
   */
  loadFromConfig(config: FlagConfig): void {
    for (const [id, desiredState] of Object.entries(config.flags)) {
      const flag = FEATURE_FLAG_MAP.get(id);
      if (flag === undefined) continue; // unknown flag — ignore

      const current = this._states.get(id) as FlagState;
      if (current === desiredState) continue; // already correct — skip

      if (desiredState === 'killed') {
        this._killReasons.set(id, 'Loaded from config');
        this._transition(id, current, 'killed', 'Loaded from config');
        continue;
      }

      if (desiredState === 'enabled' && current === 'killed') {
        // Config wants enabled but flag is killed — skip; kill takes precedence
        continue;
      }

      this._transition(id, current, desiredState);
    }
  }

  // ── Subscriptions ───────────────────────────────────────────────────────

  /**
   * Subscribes to flag state changes.
   *
   * The callback fires synchronously when a flag transitions state.
   * Callbacks must not throw — errors are caught and logged to stderr.
   *
   * @param callback - Called with `(flagId, newState, previousState)`.
   * @returns An unsubscribe function; call it to remove the subscription.
   */
  subscribe(callback: FlagSubscriber): () => void {
    this._subscribers.add(callback);
    return () => {
      this._subscribers.delete(callback);
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Validates that a flag exists and returns its declaration.
   * Throws a clear error if the id is unknown.
   */
  private _requireFlag(flagId: string): FeatureFlag {
    const flag = FEATURE_FLAG_MAP.get(flagId);
    if (flag === undefined) {
      throw new Error(`[FeatureFlagManager] Unknown flag: "${flagId}"`);
    }
    return flag;
  }

  /**
   * Records a state transition, updates `_states`, writes the audit log entry,
   * and notifies all subscribers.
   */
  private _transition(
    flagId: string,
    previous: FlagState,
    next: FlagState,
    reason?: string,
  ): void {
    this._states.set(flagId, next);

    const entry: FlagTransition = {
      flagId,
      previous,
      next,
      timestamp: Date.now(),
      ...(reason !== undefined ? { reason } : {}),
    };
    this._transitions.push(entry);

    // Notify subscribers — guard against throwing callbacks
    for (const subscriber of this._subscribers) {
      try {
        subscriber(flagId, next, previous);
      } catch (err) {
        // Subscribers must not crash the manager
        process.stderr.write(
          `[FeatureFlagManager] Subscriber error for flag "${flagId}": ${
            summarizeError(err)
          }\n`,
        );
      }
    }
  }
}

/**
 * Construct a fresh feature-flag manager.
 *
 * Keeping this factory in the same module as the class avoids test-runner
 * namespace quirks around cross-module construction while preserving the same
 * runtime behavior.
 */
export { FeatureFlagManagerImpl as FeatureFlagManager };

export function createFeatureFlagManager(): FeatureFlagManagerImpl {
  return new FeatureFlagManagerImpl();
}
