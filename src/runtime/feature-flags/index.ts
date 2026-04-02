/**
 * Feature flag and kill-switch system for the goodvibes-tui runtime — barrel exports and factory.
 *
 * Usage:
 * ```ts
 * import { createFeatureFlagManager } from './feature-flags/index.ts';
 * const flagManager = createFeatureFlagManager();
 *
 * // Check before using a new subsystem
 * if (flagManager.isEnabled('phased-tool-executor')) {
 *   // route through new pipeline
 * }
 *
 * // Emergency kill
 * flagManager.kill('phased-tool-executor', 'Crash loop detected in production');
 * ```
 */

export type { FlagState, FeatureFlag, FlagConfig, FlagTransition } from './types.ts';
export type { FlagSubscriber } from './manager.ts';
export { FeatureFlagManager } from './manager.ts';
export { FEATURE_FLAGS, FEATURE_FLAG_MAP } from './flags.ts';

import { FeatureFlagManager } from './manager.ts';

/**
 * Factory function that creates a ready-to-use `FeatureFlagManager`.
 *
 * All flags are seeded from the registry with their declared defaults.
 * Call `loadFromConfig()` on the returned manager to apply user overrides.
 *
 * @returns A new `FeatureFlagManager` instance.
 */
export function createFeatureFlagManager(): FeatureFlagManager {
  return new FeatureFlagManager();
}
