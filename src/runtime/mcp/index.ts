/**
 * src/runtime/mcp — MCP lifecycle barrel.
 *
 * Gated by the `mcp-lifecycle` feature flag.
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
export { McpPermissionManager, buildMcpAttackPathReview } from '@pellux/goodvibes-sdk/platform/runtime/mcp/permissions';
export { McpSchemaFreshnessTracker } from '@pellux/goodvibes-sdk/platform/runtime/mcp/schema-freshness';
export {
  canTransition,
  reachableFrom,
  applyTransition,
  isOperational,
  isTerminal,
  type TransitionResult,
} from '@pellux/goodvibes-sdk/platform/runtime/mcp/lifecycle';
export type {
  McpServerState,
  SchemaFreshness,
  McpSchemaRecord,
  QuarantineReason,
  QuarantineRecord,
  McpTrustLevel,
  McpTrustMode,
  McpServerRole,
  McpCapabilityClass,
  McpCoherenceVerdict,
  McpRiskLevel,
  McpPermission,
  McpTrustProfile,
  McpCoherenceAssessment,
  McpDecisionRecord,
  McpSecuritySnapshot,
  McpAttackPathFindingKind,
  McpAttackPathFinding,
  McpAttackPathReview,
  McpToolPermission,
  McpServerPermissions,
  McpServerEntry,
  McpReconnectConfig,
} from '@pellux/goodvibes-sdk/platform/runtime/mcp/types';
export { DEFAULT_RECONNECT_CONFIG } from '@pellux/goodvibes-sdk/platform/runtime/mcp/types';

import { McpLifecycleManager } from './manager.ts';
import type { McpLifecycleManagerOptions } from './manager.ts';

/**
 * Factory function for creating a `McpLifecycleManager`.
 *
 * Check the `mcp-lifecycle` feature flag before calling this — when the
 * flag is disabled, the caller should use the standard MCP registry path.
 *
 * @param options - Optional configuration overrides
 */
export function createMcpLifecycleManager(
  options?: McpLifecycleManagerOptions,
): McpLifecycleManager {
  return new McpLifecycleManager(options);
}
