/**
 * Plugin lifecycle system — barrel export and factory.
 *
 * Gated by the `plugin-lifecycle` feature flag. Import and call
 * `createPluginLifecycleManager()` at startup after the feature flag
 * manager has been initialised.
 *
 * @example
 * ```ts
 * import { createPluginLifecycleManager } from './src/runtime/plugins/index.ts';
 *
 * const lcm = createPluginLifecycleManager({ sessionId: session.id, runtimeBus });
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
} from '@pellux/goodvibes-sdk/platform/runtime/plugins/types';

export { ALL_CAPABILITIES, MAX_TRANSITION_HISTORY } from '@pellux/goodvibes-sdk/platform/runtime/plugins/types';

export {
  VALID_TRANSITIONS,
  canTransition,
  applyTransition,
  isOperational,
  isReloadable,
  isTerminal,
} from '@pellux/goodvibes-sdk/platform/runtime/plugins/lifecycle';

export {
  resolveCapabilityManifest,
  hasCapability,
  validateManifestV2,
} from '@pellux/goodvibes-sdk/platform/runtime/plugins/manifest';

export { PluginLifecycleManager } from '@pellux/goodvibes-sdk/platform/runtime/plugins/manager';
import { PluginLifecycleManager } from '@pellux/goodvibes-sdk/platform/runtime/plugins/manager';

// Trust framework.
export type {
  PluginTrustTier,
  PluginTrustRecord,
  SignatureValidationResult,
} from '@pellux/goodvibes-sdk/platform/runtime/plugins/trust';
export {
  PluginTrustStore,
  validatePluginSignature,
  filterCapabilitiesByTrust,
  SAFE_CAPABILITIES,
} from '@pellux/goodvibes-sdk/platform/runtime/plugins/trust';

export type { QuarantineRecord } from '@pellux/goodvibes-sdk/platform/runtime/plugins/quarantine';
export { PluginQuarantineEngine } from '@pellux/goodvibes-sdk/platform/runtime/plugins/quarantine';

export { isHighRiskCapability } from '@pellux/goodvibes-sdk/platform/runtime/plugins/manifest';

export type { HotReloadOptions, HotReloadResult } from '@pellux/goodvibes-sdk/platform/runtime/plugins/hot-reload';
export { runHotReload } from '@pellux/goodvibes-sdk/platform/runtime/plugins/hot-reload';

/**
 * createPluginLifecycleManager — Factory function for the PluginLifecycleManager.
 *
 * Intended as the primary entry point for consumers. Respects the
 * `plugin-lifecycle` feature flag — callers should check the flag before
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
