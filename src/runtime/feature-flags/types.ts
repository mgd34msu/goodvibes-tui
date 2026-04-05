/**
 * Feature flag and kill switch type definitions for the goodvibes-tui runtime.
 *
 * These types model the lifecycle of a feature gate from initial declaration
 * through runtime toggling and emergency kill.
 */

/**
 * The three possible states for a feature flag.
 *
 * - `enabled`  — the feature is active
 * - `disabled` — the feature is inactive (default for all gates)
 * - `killed`   — the feature has been emergency-killed and cannot be re-enabled
 *                until it is explicitly un-killed
 */
export type FlagState = 'enabled' | 'disabled' | 'killed';

/**
 * Static declaration of a feature gate.
 *
 * Registered once at startup in `flags.ts`; state transitions are tracked
 * separately by `FeatureFlagManager`.
 */
export interface FeatureFlag {
  /** Unique kebab-case identifier used as the lookup key (e.g. `fetch-sanitization`) */
  id: string;

  /** Human-readable display name */
  name: string;

  /** One-line description of what this gate controls */
  description: string;

  /** Initial state applied on first load when no config override exists */
  defaultState: FlagState;

  /** When killed, this message explains why the flag was killed */
  killReason?: string;

  /** The implementation tier that introduced this flag (1-based) */
  tier: number;

  /**
   * Whether this flag supports state changes after startup.
   * Set to `false` for gates that can only be configured before the process starts.
   */
  runtimeToggleable: boolean;
}

/**
 * Persisted flag overrides loaded from the user config file.
 * Overrides are applied on top of each flag's `defaultState`.
 */
export interface FlagConfig {
  /** Map of flag id → desired state; missing keys fall back to `defaultState` */
  flags: Record<string, FlagState>;
}

/**
 * A single state-change record emitted to subscribers and written to the
 * in-memory audit log.
 */
export interface FlagTransition {
  /** The flag that changed */
  flagId: string;

  /** State before the transition */
  previous: FlagState;

  /** State after the transition */
  next: FlagState;

  /** Unix timestamp (ms) when the transition occurred */
  timestamp: number;

  /** Optional reason supplied with a kill operation */
  reason?: string;
}
