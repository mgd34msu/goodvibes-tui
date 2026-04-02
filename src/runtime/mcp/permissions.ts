/**
 * MCP per-server permission and trust-level management (v3 §11.3).
 *
 * McpPermissionManager tracks trust levels and per-tool allow/deny overrides
 * for every registered MCP server.
 */
import type {
  McpTrustLevel,
  McpPermission,
  McpToolPermission,
  McpServerPermissions,
} from './types.ts';
import { logger } from '../../utils/logger.ts';

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Trust level assigned to newly registered servers. */
const DEFAULT_TRUST_LEVEL: McpTrustLevel = 'standard';

// ── Manager ───────────────────────────────────────────────────────────────────

/**
 * Manages per-server permission state.
 *
 * Lifecycle:
 *   1. `registerServer(name)` — called when a server transitions to configured/connecting.
 *   2. `setTrustLevel(name, level)` — adjust trust at runtime.
 *   3. `allowTool(name, tool)` / `denyTool(name, tool)` — explicit overrides.
 *   4. `isToolAllowed(name, tool)` — checked before every tool invocation.
 *   5. `removeServer(name)` — called on permanent disconnection.
 */
export class McpPermissionManager {
  private readonly permissions = new Map<string, McpServerPermissions>();

  // ── Registration ─────────────────────────────────────────────────────────

  /**
   * Register a new server with default trust level `standard`.
   * Idempotent — calling again for an already-registered server is a no-op.
   *
   * @param serverName - Server identifier
   * @param trustLevel - Initial trust level (defaults to `standard`)
   */
  registerServer(
    serverName: string,
    trustLevel: McpTrustLevel = DEFAULT_TRUST_LEVEL,
  ): void {
    if (this.permissions.has(serverName)) return;
    this.permissions.set(serverName, {
      serverName,
      trustLevel,
      toolOverrides: new Map(),
      lastModifiedAt: Date.now(),
    });
    logger.debug('McpPermissionManager: server registered', { serverName, trustLevel });
  }

  /**
   * Remove all permission state for a server.
   *
   * @param serverName - Server identifier
   */
  removeServer(serverName: string): void {
    if (this.permissions.delete(serverName)) {
      logger.debug('McpPermissionManager: server removed', { serverName });
    }
  }

  // ── Trust level ───────────────────────────────────────────────────────────

  /**
   * Update the trust level for a registered server.
   *
   * @param serverName - Server identifier
   * @param level      - New trust level
   * @throws {Error} If the server is not registered
   */
  setTrustLevel(serverName: string, level: McpTrustLevel): void {
    const record = this._getRequired(serverName);
    record.trustLevel = level;
    record.lastModifiedAt = Date.now();
    logger.debug('McpPermissionManager: trust level updated', { serverName, level });
  }

  /**
   * Return the current trust level for a server, or `null` if not registered.
   *
   * @param serverName - Server identifier
   */
  getTrustLevel(serverName: string): McpTrustLevel | null {
    return this.permissions.get(serverName)?.trustLevel ?? null;
  }

  // ── Tool overrides ────────────────────────────────────────────────────────

  /**
   * Explicitly allow a tool on a server, overriding any deny.
   *
   * @param serverName - Server identifier
   * @param toolName   - Tool name on the server (not qualified)
   * @param note       - Optional reason for the override
   * @throws {Error} If the server is not registered
   */
  allowTool(serverName: string, toolName: string, note?: string): void {
    const record = this._getRequired(serverName);
    record.toolOverrides.set(toolName, { toolName, verdict: 'allow', note });
    record.lastModifiedAt = Date.now();
    logger.debug('McpPermissionManager: tool allowed', { serverName, toolName });
  }

  /**
   * Explicitly deny a tool on a server, overriding trust-level default.
   *
   * @param serverName - Server identifier
   * @param toolName   - Tool name on the server (not qualified)
   * @param note       - Optional reason for the denial
   * @throws {Error} If the server is not registered
   */
  denyTool(serverName: string, toolName: string, note?: string): void {
    const record = this._getRequired(serverName);
    record.toolOverrides.set(toolName, { toolName, verdict: 'deny', note });
    record.lastModifiedAt = Date.now();
    logger.debug('McpPermissionManager: tool denied', { serverName, toolName });
  }

  /**
   * Remove a per-tool override, reverting to the trust-level default.
   *
   * @param serverName - Server identifier
   * @param toolName   - Tool name on the server
   */
  clearToolOverride(serverName: string, toolName: string): void {
    const record = this.permissions.get(serverName);
    if (record?.toolOverrides.delete(toolName)) {
      record.lastModifiedAt = Date.now();
      logger.debug('McpPermissionManager: tool override cleared', { serverName, toolName });
    }
  }

  // ── Permission check ──────────────────────────────────────────────────────

  /**
   * Determine whether a tool call is permitted for the given server.
   *
   * Resolution order:
   *   1. Server not registered → deny
   *   2. Trust level `blocked`  → deny
   *   3. Per-tool override exists → honour override
   *   4. Trust level `restricted` with no allow override → deny
   *   5. Trust level `standard` or `trusted` → allow
   *
   * @param serverName - Server identifier
   * @param toolName   - Tool name on the server (not qualified)
   */
  isToolAllowed(serverName: string, toolName: string): McpPermission {
    const record = this.permissions.get(serverName);

    if (!record) {
      return { allowed: false, reason: `server '${serverName}' is not registered` };
    }

    if (record.trustLevel === 'blocked') {
      return { allowed: false, reason: `server '${serverName}' is blocked` };
    }

    const override = record.toolOverrides.get(toolName);
    if (override) {
      const allowed = override.verdict === 'allow';
      return {
        allowed,
        reason: allowed
          ? `tool '${toolName}' explicitly allowed${override.note ? ': ' + override.note : ''}`
          : `tool '${toolName}' explicitly denied${override.note ? ': ' + override.note : ''}`,
      };
    }

    if (record.trustLevel === 'restricted') {
      return {
        allowed: false,
        reason: `tool '${toolName}' not in allow-list for restricted server '${serverName}'`,
      };
    }

    // standard or trusted — allow
    return { allowed: true, reason: `trust level '${record.trustLevel}'` };
  }

  // ── Inspection ────────────────────────────────────────────────────────────

  /**
   * Return a snapshot of permission state for a server, or `null` if not registered.
   *
   * @param serverName - Server identifier
   */
  getServerPermissions(serverName: string): McpServerPermissions | null {
    return this.permissions.get(serverName) ?? null;
  }

  /** All registered server names. */
  get serverNames(): string[] {
    return Array.from(this.permissions.keys());
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _getRequired(serverName: string): McpServerPermissions {
    const record = this.permissions.get(serverName);
    if (!record) {
      throw new Error(`McpPermissionManager: server '${serverName}' is not registered`);
    }
    return record;
  }
}
