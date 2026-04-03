/**
 * Plugin lifecycle system — barrel export and factory.
 *
 * Gated by the `plugin-lifecycle-v2` feature flag. Import and call
 * `createPluginLifecycleManager()` at startup after the feature flag
 * manager has been initialised.
 *
 * @example
 * ```ts
 * import { createPluginLifecycleManager } from './src/runtime/plugins/index.ts';
 *
 * const lcm = createPluginLifecycleManager({ sessionId: session.id });
 * lcm.attachEventBus(eventBus);
 * lcm.scanAndRegister();
 * ```
 */

export type {
  PluginCapability,
  PluginCapabilityManifest,
  PluginManifestV2,
  PluginTransition,
  TransitionResult,
  PluginHealthCheckResult,
  PluginLifecycleRecord,
  PluginLifecycleManagerOptions,
  PluginLifecycleState,
} from './types.ts';

export { ALL_CAPABILITIES, MAX_TRANSITION_HISTORY } from './types.ts';

export {
  VALID_TRANSITIONS,
  canTransition,
  applyTransition,
  isOperational,
  isReloadable,
  isTerminal,
} from './lifecycle.ts';

export {
  resolveCapabilityManifest,
  hasCapability,
  validateManifestV2,
} from './manifest.ts';

export { PluginLifecycleManager } from './manager.ts';
import { PluginLifecycleManager } from './manager.ts';

// ── Trust Framework (§5.9) ────────────────────────────────────────────────────
export type {
  PluginTrustTier,
  PluginTrustRecord,
  SignatureValidationResult,
} from './trust.ts';
export {
  PluginTrustStore,
  validatePluginSignature,
  filterCapabilitiesByTrust,
  SAFE_CAPABILITIES,
} from './trust.ts';

export type { QuarantineRecord } from './quarantine.ts';
export { PluginQuarantineEngine } from './quarantine.ts';

export { isHighRiskCapability } from './manifest.ts';

export type { HotReloadOptions, HotReloadResult } from './hot-reload.ts';
export { runHotReload } from './hot-reload.ts';

/**
 * createPluginLifecycleManager — Factory function for the PluginLifecycleManager.
 *
 * Intended as the primary entry point for consumers. Respects the
 * `plugin-lifecycle-v2` feature flag — callers should check the flag before
 * invoking if they want to gate the entire system.
 *
 * @param options - Optional manager configuration.
 * @returns A new PluginLifecycleManager instance.
 */
export function createPluginLifecycleManager(
  options: import('./types.ts').PluginLifecycleManagerOptions = {},
): PluginLifecycleManager {
  return new PluginLifecycleManager(options);
}
