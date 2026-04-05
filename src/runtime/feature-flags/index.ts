/**
 * Feature flag and kill-switch system for the goodvibes-tui runtime — barrel exports and factory.
 *
 * Usage:
 * ```ts
 * import { createFeatureFlagManager } from './feature-flags/index.ts';
 * const flagManager = createFeatureFlagManager();
 *
 * // Check before using a gated subsystem
 * if (flagManager.isEnabled('fetch-sanitization')) {
 *   // enable stricter fetch sanitization rules
 * }
 *
 * // Emergency kill
 * flagManager.kill('fetch-sanitization', 'Crash loop detected in production');
 * ```
 */

export type { FlagState, FeatureFlag, FlagConfig, FlagTransition } from './types.ts';
export type { FlagSubscriber } from './manager.ts';
export { FeatureFlagManager, createFeatureFlagManager } from './manager.ts';
export { FEATURE_FLAGS, FEATURE_FLAG_MAP } from './flags.ts';
