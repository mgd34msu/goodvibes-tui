/**
 * src/runtime/mcp — MCP Lifecycle v2 barrel.
 *
 * Gated by the `mcp-lifecycle-v2` feature flag.
 *
 * Public API:
 *   - `createMcpLifecycleManager()` — factory function
 *   - All types from types.ts
 *   - State machine helpers from lifecycle.ts
 *   - Permission manager from permissions.ts
 *   - Schema freshness tracker from schema-freshness.ts
 *   - Manager from manager.ts
 */

export { McpLifecycleManager, type McpEventHandler, type McpLifecycleManagerOptions } from './manager.ts';
export { McpPermissionManager } from './permissions.ts';
export { McpSchemaFreshnessTracker } from './schema-freshness.ts';
export {
  canTransition,
  reachableFrom,
  applyTransition,
  isOperational,
  isTerminal,
  type TransitionResult,
} from './lifecycle.ts';
export type {
  McpServerState,
  SchemaFreshness,
  McpSchemaRecord,
  McpTrustLevel,
  McpPermission,
  McpToolPermission,
  McpServerPermissions,
  McpServerEntry,
  McpReconnectConfig,
} from './types.ts';
export { DEFAULT_RECONNECT_CONFIG } from './types.ts';

import { McpLifecycleManager } from './manager.ts';
import type { McpLifecycleManagerOptions } from './manager.ts';

/**
 * Factory function for creating a `McpLifecycleManager`.
 *
 * Check the `mcp-lifecycle-v2` feature flag before calling this — when the
 * flag is disabled, the caller should fall through to the legacy `McpRegistry`.
 *
 * @param options - Optional configuration overrides
 */
export function createMcpLifecycleManager(
  options?: McpLifecycleManagerOptions,
): McpLifecycleManager {
  return new McpLifecycleManager(options);
}
