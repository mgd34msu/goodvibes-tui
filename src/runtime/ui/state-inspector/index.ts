/**
 * State inspector barrel — public API for the state inspector subsystem.
 *
 * Import from here to access types, the provider class, and the factory.
 *
 * Usage:
 * ```ts
 * import { createStateInspector } from '../runtime/ui/state-inspector/index.ts';
 *
 * const inspector = createStateInspector({
 *   domains: [sessionAdapter, conversationAdapter],
 *   maxTransitions: 500,
 * });
 * ```
 *
 * v3 Section 26 (Devtools / State Inspector).
 */

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  DomainSnapshot,
  StateSnapshot,
  TransitionEntry,
  SubscriptionInfo,
  StateInspectorConfig,
} from './types.ts';
export { DEFAULT_MAX_TRANSITIONS } from './types.ts';

// ── Transition log ────────────────────────────────────────────────────────────
export { BoundedTransitionLog } from './transition-log.ts';

// ── Provider ─────────────────────────────────────────────────────────────────
export { StateInspectorProvider } from './inspector.ts';

// ── Domain adapter re-export ──────────────────────────────────────────────────
export type { InspectableDomain } from '../../diagnostics/panels/state-inspector.ts';

// ── Factory ───────────────────────────────────────────────────────────────────
import { StateInspectorProvider } from './inspector.ts';
import type { InspectableDomain } from '../../diagnostics/panels/state-inspector.ts';
import type { StateInspectorConfig } from './types.ts';

/**
 * Factory parameters for createStateInspector.
 */
export interface CreateStateInspectorOptions extends StateInspectorConfig {
  /** Domain adapters to register at construction time. */
  readonly domains?: InspectableDomain[];
}

/**
 * Create a fully configured StateInspectorProvider.
 *
 * @param options - Configuration including domains and capacity limits.
 * @returns A ready-to-use StateInspectorProvider instance.
 */
export function createStateInspector(
  options: CreateStateInspectorOptions = {},
): StateInspectorProvider {
  const { domains = [], ...config } = options;
  return new StateInspectorProvider(domains, config);
}
