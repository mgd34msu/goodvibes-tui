/**
 * McpLifecycleManager — drives the MCP server state machine.
 *
 * Gated by the `mcp-lifecycle` feature flag. When the flag is disabled
 * callers should use the standard MCP registry path instead.
 *
 * Responsibilities:
 *   - Track per-server McpServerEntry state
 *   - Orchestrate McpClient connect/disconnect
 *   - Drive lifecycle state transitions via lifecycle.ts
 *   - Emit McpEvent on every transition
 *   - Schedule reconnects with exponential back-off
 *   - Delegate permission checks to McpPermissionManager
 *   - Delegate schema freshness to McpSchemaFreshnessTracker
 */
import { logger } from '../../utils/logger.ts';
import { McpClient } from '../../mcp/client.ts';
import type { McpServerConfig } from '../../mcp/config.ts';
import type { McpEvent } from '../events/mcp.ts';
import {
  applyTransition,
  isOperational,
} from './lifecycle.ts';
import { McpPermissionManager } from './permissions.ts';
import { McpSchemaFreshnessTracker } from './schema-freshness.ts';
import type {
  McpServerState,
  McpServerEntry,
  McpReconnectConfig,
  McpTrustLevel,
  McpPermission,
  SchemaFreshness,
  QuarantineReason,
} from './types.ts';
import { DEFAULT_RECONNECT_CONFIG } from './types.ts';

/** Callback type for state-change notifications. */
export type McpEventHandler = (event: McpEvent) => void;

// ── Factory ───────────────────────────────────────────────────────────────────

/** Options for constructing a McpLifecycleManager. */
export interface McpLifecycleManagerOptions {
  /** Reconnect back-off configuration. Defaults to DEFAULT_RECONNECT_CONFIG. */
  reconnect?: Partial<McpReconnectConfig>;
  /** Schema freshness TTL in ms. Defaults to 5 minutes. */
  schemaTtlMs?: number;
}

// ── Manager ───────────────────────────────────────────────────────────────────

/**
 * McpLifecycleManager — manages the full lifecycle of all configured MCP servers.
 *
 * Usage:
 * ```ts
 * const mgr = createMcpLifecycleManager();
 * mgr.onEvent((e) => store.dispatch(e));
 * await mgr.startAll(configs);
 * // ...
 * await mgr.stopAll();
 * ```
 */
export class McpLifecycleManager {
  private readonly servers = new Map<string, McpServerEntry>();
  private readonly clients = new Map<string, McpClient>();
  private readonly permissions: McpPermissionManager;
  private readonly freshness: McpSchemaFreshnessTracker;
  private readonly reconnectConfig: McpReconnectConfig;
  private readonly eventHandlers: McpEventHandler[] = [];
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: McpLifecycleManagerOptions = {}) {
    this.reconnectConfig = {
      ...DEFAULT_RECONNECT_CONFIG,
      ...options.reconnect,
    };
    this.permissions = new McpPermissionManager();
    this.freshness = new McpSchemaFreshnessTracker(options.schemaTtlMs);
  }

  // ── Event subscription ────────────────────────────────────────────────────

  /**
   * Register an event handler called on every lifecycle transition.
   *
   * @param handler - Callback receiving McpEvent on each transition
   */
  onEvent(handler: McpEventHandler): void {
    this.eventHandlers.push(handler);
  }

  // ── Server management ─────────────────────────────────────────────────────

  /**
   * Register and start all provided server configs.
   *
   * Connection errors on individual servers are logged but do not abort the
   * overall startup.
   *
   * @param configs - Array of server configurations to start
   */
  async startAll(configs: McpServerConfig[]): Promise<void> {
    await Promise.allSettled(configs.map((c) => this._startServer(c)));
  }

  /**
   * Register and start a single server.
   *
   * @param config - Server configuration
   */
  async startServer(config: McpServerConfig): Promise<void> {
    await this._startServer(config);
  }

  /**
   * Disconnect all servers and cancel pending reconnect timers.
   */
  async stopAll(): Promise<void> {
    const names = Array.from(this.servers.keys());
    await Promise.allSettled(names.map((n) => this._stopServer(n, 'stopAll called')));
  }

  /**
   * Disconnect a single server by name.
   *
   * @param serverName - Server identifier
   * @param reason     - Optional reason for disconnection
   */
  async stopServer(serverName: string, reason?: string): Promise<void> {
    await this._stopServer(serverName, reason);
  }

  // ── Permission delegation ─────────────────────────────────────────────────

  /**
   * Check whether a tool call is permitted for the given server.
   *
   * Quarantined schemas unconditionally block execution — the freshness check
   * runs before the permission check so a quarantined schema cannot be bypassed
   * by a permissive trust level.
   *
   * @param serverName - Server identifier
   * @param toolName   - Tool name on the server (not qualified)
   */
  isToolAllowed(serverName: string, toolName: string): McpPermission {
    if (this.freshness.isQuarantined(serverName)) {
      const record = this.freshness.getRecord(serverName);
      const detail = record?.quarantine?.detail ?? 'schema is quarantined';
      return {
        allowed: false,
        reason: `Schema quarantined (${record?.quarantine?.reason ?? 'unknown'}): ${detail}. Refresh schema or request operator approval to proceed.`,
      };
    }
    return this.permissions.isToolAllowed(serverName, toolName);
  }

  /**
   * Update the trust level for a server.
   *
   * @param serverName - Server identifier
   * @param level      - New trust level
   */
  setTrustLevel(serverName: string, level: McpTrustLevel): void {
    this.permissions.setTrustLevel(serverName, level);
  }

  /**
   * Explicitly allow a tool for a server.
   *
   * @param serverName - Server identifier
   * @param toolName   - Tool name
   * @param note       - Optional note
   */
  allowTool(serverName: string, toolName: string, note?: string): void {
    this.permissions.allowTool(serverName, toolName, note);
  }

  /**
   * Explicitly deny a tool for a server.
   *
   * @param serverName - Server identifier
   * @param toolName   - Tool name
   * @param note       - Optional note
   */
  denyTool(serverName: string, toolName: string, note?: string): void {
    this.permissions.denyTool(serverName, toolName, note);
  }

  // ── Schema freshness ──────────────────────────────────────────────────────

  /**
   * Return the schema freshness for a server.
   *
   * @param serverName - Server identifier
   */
  getSchemaFreshness(serverName: string): SchemaFreshness {
    return this.freshness.getFreshness(serverName);
  }

  /**
   * Returns `true` if the server's schema is quarantined.
   *
   * When quarantined, `isToolAllowed` will block all tool execution until the
   * schema is refreshed (`markFresh` via a successful schema fetch) or an
   * operator approves a temporary override via `approveSchemaQuarantine`.
   *
   * @param serverName - Server identifier
   */
  isSchemaQuarantined(serverName: string): boolean {
    return this.freshness.isQuarantined(serverName);
  }

  /**
   * Manually quarantine a server's schema.
   *
   * Intended for operator-initiated quarantine (e.g. after detecting schema
   * incompatibility). Emits `MCP_SCHEMA_QUARANTINED`.
   *
   * @param serverName - Server identifier
   * @param reason     - Why quarantine is being applied
   * @param detail     - Optional detail for the MCP panel display
   */
  quarantineSchema(
    serverName: string,
    reason: QuarantineReason,
    detail?: string,
  ): void {
    this.freshness.markQuarantined(serverName, reason, detail);
    this._emit({
      type: 'MCP_SCHEMA_QUARANTINED',
      serverId: serverName,
      reason,
      detail,
    });
    logger.warn('McpLifecycleManager: schema quarantined', { server: serverName, reason, detail });
  }

  /**
   * Operator override: approve a quarantined schema so tool execution can
   * proceed temporarily without a full schema refresh.
   *
   * The quarantine record is preserved for audit purposes. Freshness transitions
   * to `stale`. Emits `MCP_SCHEMA_QUARANTINE_APPROVED`.
   *
   * @param serverName - Server identifier
   * @param operatorId - Identifier of the approving operator
   */
  approveSchemaQuarantine(serverName: string, operatorId: string): void {
    if (!this.freshness.isQuarantined(serverName)) {
      logger.debug('McpLifecycleManager: approveSchemaQuarantine called but not quarantined', { server: serverName });
      return;
    }
    this.freshness.approveQuarantine(serverName, operatorId);
    this._emit({
      type: 'MCP_SCHEMA_QUARANTINE_APPROVED',
      serverId: serverName,
      operatorId,
    });
    logger.warn('McpLifecycleManager: quarantine override approved', { server: serverName, operatorId });
  }

  // ── Inspection ────────────────────────────────────────────────────────────

  /** Return the current lifecycle state for a server, or `null` if unknown. */
  getState(serverName: string): McpServerState | null {
    return this.servers.get(serverName)?.state ?? null;
  }

  /** Return all server entries as a read-only snapshot. */
  getServers(): ReadonlyMap<string, McpServerEntry> {
    return this.servers;
  }

  /** Return the entry for a single server, or `null`. */
  getServer(serverName: string): McpServerEntry | null {
    return this.servers.get(serverName) ?? null;
  }

  /** Names of all servers currently in an operational state (connected/degraded). */
  get operationalServerNames(): string[] {
    return Array.from(this.servers.entries())
      .filter(([, entry]) => isOperational(entry.state))
      .map(([name]) => name);
  }

  // ── Private: start ────────────────────────────────────────────────────────

  private async _startServer(config: McpServerConfig): Promise<void> {
    const { name } = config;

    if (this.servers.has(name)) {
      logger.info('McpLifecycleManager: server already registered', { name });
      return;
    }

    // Register in subsystems
    this.permissions.registerServer(name);
    this.freshness.registerServer(name);

    // Create entry in configured state
    const entry: McpServerEntry = {
      name,
      config,
      state: 'configured',
      reconnectAttempts: 0,
      reconnectPending: false,
      availableTools: [],
      availableResources: [],
      callCount: 0,
      errorCount: 0,
    };
    this.servers.set(name, entry);
    this._emit({ type: 'MCP_CONFIGURED', serverId: name, transport: 'stdio' });

    // Begin connection attempt
    await this._connect(name);
  }

  private async _connect(serverName: string): Promise<void> {
    const entry = this.servers.get(serverName);
    if (!entry) return;

    const toConnecting = applyTransition(entry.state, 'connecting');
    if (!toConnecting.success) {
      logger.debug('McpLifecycleManager: cannot transition to connecting', {
        server: serverName,
        reason: toConnecting.reason,
      });
      return;
    }
    this._setState(entry, 'connecting');
    this._emit({ type: 'MCP_CONNECTING', serverId: serverName });

    try {
      const client = new McpClient(entry.config);
      await client.connect();
      this.clients.set(serverName, client);

      // Load tool list
      const tools = await client.listTools().catch((err: unknown) => {
        logger.debug('McpLifecycleManager: listTools failed', { server: serverName, err: String(err) });
        return [];
      });
      entry.availableTools = tools.map((t) => t.name);

      entry.connectedAt = Date.now();
      entry.reconnectAttempts = 0;
      entry.reconnectPending = false;

      this._setState(entry, 'connected');
      this.freshness.markStale(serverName); // invalidate on (re)connect

      this._emit({
        type: 'MCP_CONNECTED',
        serverId: serverName,
        toolCount: entry.availableTools.length,
        resourceCount: entry.availableResources.length,
      });

      logger.info('McpLifecycleManager: server connected', {
        server: serverName,
        tools: entry.availableTools.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.lastError = message;
      logger.error('McpLifecycleManager: connection failed', { server: serverName, err: message });
      this._scheduleReconnect(serverName);
    }
  }

  // ── Private: stop ─────────────────────────────────────────────────────────

  private async _stopServer(serverName: string, reason?: string): Promise<void> {
    this._cancelReconnect(serverName);

    const entry = this.servers.get(serverName);
    if (!entry) return;

    const client = this.clients.get(serverName);
    if (client) {
      try {
        await client.disconnect();
      } catch (err) {
        // Non-fatal — we are stopping regardless
        logger.debug('McpLifecycleManager: disconnect error (suppressed)', { server: serverName, err: String(err) });
      }
      this.clients.delete(serverName);
    }

    entry.disconnectedAt = Date.now();
    entry.lastError = reason;
    this._setState(entry, 'disconnected');
    this._emit({ type: 'MCP_DISCONNECTED', serverId: serverName, reason, willRetry: false });
  }

  // ── Private: reconnect ────────────────────────────────────────────────────

  private _scheduleReconnect(serverName: string): void {
    const entry = this.servers.get(serverName);
    if (!entry) return;

    if (entry.reconnectAttempts >= this.reconnectConfig.maxAttempts) {
      logger.info('McpLifecycleManager: max reconnect attempts reached', {
        server: serverName,
        attempts: entry.reconnectAttempts,
      });
      entry.disconnectedAt = Date.now();
      this._setState(entry, 'disconnected');
      this._emit({
        type: 'MCP_DISCONNECTED',
        serverId: serverName,
        reason: `max reconnect attempts (${this.reconnectConfig.maxAttempts}) exceeded`,
        willRetry: false,
      });
      return;
    }

    const attempt = entry.reconnectAttempts + 1;
    const delay = Math.min(
      this.reconnectConfig.baseDelayMs * Math.pow(2, attempt - 1),
      this.reconnectConfig.maxDelayMs,
    );

    this._setState(entry, 'reconnecting');
    entry.reconnectPending = true;
    entry.reconnectAttempts = attempt;

    this._emit({
      type: 'MCP_RECONNECTING',
      serverId: serverName,
      attempt,
      maxAttempts: this.reconnectConfig.maxAttempts,
    });

    logger.info('McpLifecycleManager: scheduling reconnect', { server: serverName, attempt, delayMs: delay });

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(serverName);
      const current = this.servers.get(serverName);
      if (!current || current.state !== 'reconnecting') return;
      current.reconnectPending = false;
      void this._connect(serverName);
    }, delay);

    this.reconnectTimers.set(serverName, timer);
  }

  private _cancelReconnect(serverName: string): void {
    const timer = this.reconnectTimers.get(serverName);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.reconnectTimers.delete(serverName);
      const entry = this.servers.get(serverName);
      if (entry) entry.reconnectPending = false;
    }
  }

  // ── Private: state helpers ────────────────────────────────────────────────

  private _setState(entry: McpServerEntry, next: McpServerState): void {
    const result = applyTransition(entry.state, next);
    if (!result.success) {
      logger.debug('McpLifecycleManager: invalid transition (ignored)', {
        server: entry.name,
        from: entry.state,
        to: next,
        reason: result.reason,
      });
      return;
    }
    entry.state = next;
  }

  // ── Private: event emission ───────────────────────────────────────────────

  private _emit(event: McpEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        // Non-fatal: handler errors must not crash the manager
        logger.debug('McpLifecycleManager: event handler threw', { event: event.type, err: String(err) });
      }
    }
  }
}
