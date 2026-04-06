/**
 * McpRegistry — manages all connected MCP servers.
 *
 * Progressive loading strategy:
 *   - On connect: load tool names + descriptions only (F2)
 *   - On first callTool: fetch full JSON schema for that tool and cache it
 *
 * Tool namespace: mcp:<server-name>:<tool-name>
 */
import { logger } from '../utils/logger.ts';
import { loadMcpConfig } from './config.ts';
import { McpClient } from './client.ts';
import type { McpToolInfo, McpToolSchema } from './client.ts';
import type { McpServerConfig } from './config.ts';
import { getHookDispatcher } from '../hooks/index.ts';
import type { HookEvent } from '../hooks/types.ts';
import { McpPermissionManager } from '../runtime/mcp/permissions.ts';
import { McpSchemaFreshnessTracker } from '../runtime/mcp/schema-freshness.ts';
import type { McpDecisionRecord, QuarantineReason, SchemaFreshness } from '../runtime/mcp/types.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import {
  emitMcpConfigured,
  emitMcpPolicyUpdated,
  emitMcpSchemaQuarantineApproved,
  emitMcpSchemaQuarantined,
} from '../runtime/emitters/mcp.ts';

export interface RegisteredTool {
  /** Fully-qualified tool name: mcp:<server>:<tool> */
  qualifiedName: string;
  serverName: string;
  toolName: string;
  description: string;
}

export class McpRegistry {
  private clients = new Map<string, McpClient>();
  private permissions = new McpPermissionManager();
  private freshness = new McpSchemaFreshnessTracker();
  private runtimeBus: RuntimeEventBus | null = null;

  setRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.runtimeBus = runtimeBus;
  }

  /**
   * connectAll — Load config from .goodvibes/mcp.json and connect to all servers.
   * Errors on individual servers are logged but do not abort the whole startup.
   */
  async connectAll(baseDir = process.cwd()): Promise<void> {
    const mcpConfig = loadMcpConfig(baseDir);
    await Promise.allSettled(
      mcpConfig.servers.map((serverConfig) => this._connectServer(serverConfig)),
    );
  }

  /**
   * connectServer — Connect a single MCP server by config.
   * Exposed for programmatic use (testing, dynamic registration).
   */
  async connectServer(serverConfig: McpServerConfig): Promise<void> {
    await this._connectServer(serverConfig);
  }

  /**
   * listAllTools — Return all registered tools (name + description) from all connected servers.
   * Only loads tool names and descriptions — full schemas are NOT fetched here.
   */
  async listAllTools(): Promise<RegisteredTool[]> {
    const results: RegisteredTool[] = [];
    for (const [serverName, client] of this.clients) {
      if (!client.isConnected) continue;
      try {
        const tools: McpToolInfo[] = await client.listTools();
        for (const tool of tools) {
          results.push({
            qualifiedName: `mcp:${serverName}:${tool.name}`,
            serverName,
            toolName: tool.name,
            description: tool.description,
          });
        }
      } catch (err) {
        logger.info('McpRegistry: failed to list tools from server', { server: serverName, err: String(err) });
      }
    }
    return results;
  }

  /**
   * getToolSchema — Fetch full JSON schema for a qualified tool name.
   * Triggers lazy schema load and caches within McpClient.
   */
  async getToolSchema(qualifiedName: string): Promise<McpToolSchema | null> {
    const parsed = this._parseQualifiedName(qualifiedName);
    if (!parsed) return null;
    const client = this.clients.get(parsed.serverName);
    if (!client || !client.isConnected) return null;
    return client.getToolSchema(parsed.toolName);
  }

  /**
   * callTool — Execute a tool by its qualified name.
   * Fetches full schema on first use (progressive loading — F2).
   */
  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<unknown> {
    const parsed = this._parseQualifiedName(qualifiedName);
    if (!parsed) {
      throw new Error(`McpRegistry: invalid qualified tool name '${qualifiedName}'`);
    }
    const client = this.clients.get(parsed.serverName);
    if (!client) {
      throw new Error(`McpRegistry: no server named '${parsed.serverName}'`);
    }
    if (!client.isConnected) {
      throw new Error(`McpRegistry: server '${parsed.serverName}' is not connected`);
    }
    if (this.freshness.isQuarantined(parsed.serverName)) {
      const record = this.freshness.getRecord(parsed.serverName);
      throw new Error(
        `MCP call '${qualifiedName}' blocked: schema quarantined (${record?.quarantine?.reason ?? 'unknown'})${record?.quarantine?.detail ? ` — ${record.quarantine.detail}` : ''}`,
      );
    }

    const permission = this.permissions.evaluateToolCall(parsed.serverName, parsed.toolName, args);
    if (permission.verdict === 'deny') {
      throw new Error(`MCP call '${qualifiedName}' denied: ${permission.reason}`);
    }
    if (permission.verdict === 'ask') {
      throw new Error(`MCP call '${qualifiedName}' requires approval: ${permission.reason}`);
    }

    // Pre:mcp:call hook
    const dispatcher = getHookDispatcher();
    const preEvent: HookEvent = {
      path: 'Pre:mcp:call',
      phase: 'Pre',
      category: 'mcp',
      specific: 'call',
      sessionId: '', timestamp: Date.now(),
      payload: { tool: qualifiedName, args },
    };
    const preResult = await dispatcher.fire(preEvent).catch(() => ({ ok: true, decision: undefined as string | undefined }));
    if (preResult.decision === 'deny') {
      throw new Error(`MCP call '${qualifiedName}' denied by hook: ${(preResult as { reason?: string }).reason ?? 'no reason'}`);
    }

    try {
      const result = await client.callTool(parsed.toolName, args);
      this.freshness.markFresh(parsed.serverName);
      // Post:mcp:call hook (fire-and-forget)
      const postEvent: HookEvent = {
        path: 'Post:mcp:call',
        phase: 'Post',
        category: 'mcp',
        specific: 'call',
        sessionId: '', timestamp: Date.now(),
        payload: { tool: qualifiedName, args },
      };
      dispatcher.fire(postEvent).catch((err: unknown) => { logger.debug('Post:mcp:call hook error', { error: String(err) }); });
      return result;
    } catch (err) {
      this.freshness.markFailed(parsed.serverName, err instanceof Error ? err.message : String(err));
      // Fail:mcp:call hook (fire-and-forget)
      const failEvent: HookEvent = {
        path: 'Fail:mcp:call',
        phase: 'Fail',
        category: 'mcp',
        specific: 'call',
        sessionId: '', timestamp: Date.now(),
        payload: { tool: qualifiedName, args, error: err instanceof Error ? err.message : String(err) },
      };
      dispatcher.fire(failEvent).catch((hookErr: unknown) => { logger.debug('Fail:mcp:call hook error', { error: String(hookErr) }); });
      throw err;
    }
  }

  /**
   * disconnectAll — Stop all connected MCP server processes.
   */
  async disconnectAll(): Promise<void> {
    // Lifecycle:mcp:disconnected hooks (fire-and-forget for each server)
    const dispatcher = getHookDispatcher();
    for (const name of this.clients.keys()) {
      const disconnectedEvent: HookEvent = {
        path: 'Lifecycle:mcp:disconnected',
        phase: 'Lifecycle',
        category: 'mcp',
        specific: 'disconnected',
        sessionId: '', timestamp: Date.now(),
        payload: { server: name },
      };
      dispatcher.fire(disconnectedEvent).catch((err: unknown) => { logger.debug('Lifecycle:mcp:disconnected hook error', { error: String(err) }); });
    }
    await Promise.allSettled(
      Array.from(this.clients.values()).map((client) => client.disconnect()),
    );
    this.clients.clear();
  }

  /**
   * getClient — Get the McpClient for a given server name (for advanced use).
   */
  getClient(serverName: string): McpClient | undefined {
    return this.clients.get(serverName);
  }

  /** Connected server names. */
  get serverNames(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * listServers — Return status info for all known servers (connected or not).
   */
  listServers(): Array<{ name: string; connected: boolean }> {
    return Array.from(this.clients.entries()).map(([name, client]) => ({
      name,
      connected: client.isConnected,
    }));
  }

  listServerSecurity(): Array<{
    name: string;
    connected: boolean;
    role: import('../runtime/mcp/types.ts').McpServerRole;
    trustMode: import('../runtime/mcp/types.ts').McpTrustMode;
    allowedPaths: string[];
    allowedHosts: string[];
    schemaFreshness: SchemaFreshness;
    quarantineReason?: QuarantineReason;
    quarantineDetail?: string;
    quarantineApprovedBy?: string;
  }> {
    return this.listServers().map((server) => {
      const permissions = this.permissions.getServerPermissions(server.name);
      const freshnessRecord = this.freshness.getRecord(server.name);
      return {
        name: server.name,
        connected: server.connected,
        role: permissions?.profile.role ?? 'general',
        trustMode: permissions?.profile.mode ?? 'ask-on-risk',
        allowedPaths: permissions?.profile.allowedPaths ?? [],
        allowedHosts: permissions?.profile.allowedHosts ?? [],
        schemaFreshness: this.freshness.getFreshness(server.name),
        quarantineReason: freshnessRecord?.quarantine?.reason,
        quarantineDetail: freshnessRecord?.quarantine?.detail,
        quarantineApprovedBy: freshnessRecord?.quarantine?.overrideAcknowledgedBy,
      };
    });
  }

  setServerTrustMode(serverName: string, mode: import('../runtime/mcp/types.ts').McpTrustMode): void {
    this.permissions.setTrustMode(serverName, mode);
    this._emitPolicyUpdate(serverName);
  }

  setServerRole(serverName: string, role: import('../runtime/mcp/types.ts').McpServerRole): void {
    this.permissions.setServerRole(serverName, role);
    this._emitPolicyUpdate(serverName);
  }

  listRecentSecurityDecisions(limit = 8): McpDecisionRecord[] {
    return this.permissions.listRecentDecisions(limit);
  }

  quarantineSchema(serverName: string, reason: QuarantineReason, detail?: string): void {
    this.freshness.markQuarantined(serverName, reason, detail);
    if (this.runtimeBus) {
      emitMcpSchemaQuarantined(this.runtimeBus, {
        sessionId: 'mcp-registry',
        traceId: `mcp-registry:${serverName}:schema-quarantined`,
        source: 'mcp-registry',
      }, { serverId: serverName, reason, ...(detail ? { detail } : {}) });
    }
  }

  approveSchemaQuarantine(serverName: string, operatorId: string): void {
    this.freshness.approveQuarantine(serverName, operatorId);
    if (this.runtimeBus) {
      emitMcpSchemaQuarantineApproved(this.runtimeBus, {
        sessionId: 'mcp-registry',
        traceId: `mcp-registry:${serverName}:schema-approved`,
        source: 'mcp-registry',
      }, { serverId: serverName, operatorId });
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _connectServer(serverConfig: McpServerConfig): Promise<void> {
    const { name } = serverConfig;
    if (this.clients.has(name)) {
      logger.info('McpRegistry: server already registered', { name });
      return;
    }
    const client = new McpClient(serverConfig);
    this.freshness.registerServer(name);
    try {
      await client.connect();
      this.permissions.registerServer(name, 'standard', {
        role: serverConfig.role ?? 'general',
        mode: serverConfig.trustMode ?? 'ask-on-risk',
        allowedPaths: serverConfig.allowedPaths ?? [],
        allowedHosts: serverConfig.allowedHosts ?? [],
      });
      this.clients.set(name, client);
      this.freshness.markFresh(name);
      logger.info('McpRegistry: server connected', { name });
      if (this.runtimeBus) {
        emitMcpConfigured(this.runtimeBus, {
          sessionId: 'mcp-registry',
          traceId: `mcp-registry:${name}:configured`,
          source: 'mcp-registry',
        }, {
          serverId: name,
          transport: 'stdio',
          role: serverConfig.role ?? 'general',
          trustMode: serverConfig.trustMode ?? 'ask-on-risk',
          allowedPaths: serverConfig.allowedPaths ?? [],
          allowedHosts: serverConfig.allowedHosts ?? [],
        });
      }
      // Lifecycle:mcp:connected hook (fire-and-forget)
      const connectedEvent: HookEvent = {
        path: 'Lifecycle:mcp:connected',
        phase: 'Lifecycle',
        category: 'mcp',
        specific: 'connected',
        sessionId: '', timestamp: Date.now(),
        payload: { server: name },
      };
      getHookDispatcher().fire(connectedEvent).catch((err: unknown) => { logger.debug('Lifecycle:mcp:connected hook error', { error: String(err) }); });
    } catch (err) {
      this.freshness.markFailed(name, err instanceof Error ? err.message : String(err));
      logger.error('McpRegistry: failed to connect server', { name, err: String(err) });
      // Don't register the client — it's not usable
    }
  }

  /**
   * Parse mcp:<server>:<tool> qualified name.
   * Returns null if the name doesn't match the expected format.
   */
  private _parseQualifiedName(qualifiedName: string): { serverName: string; toolName: string } | null {
    const parts = qualifiedName.split(':');
    if (parts.length < 3 || parts[0] !== 'mcp') return null;
    // serverName is parts[1], toolName is the rest joined (tools can have colons)
    const serverName = parts[1];
    const toolName = parts.slice(2).join(':');
    if (!serverName || !toolName) return null;
    return { serverName, toolName };
  }

  private _emitPolicyUpdate(serverName: string): void {
    if (!this.runtimeBus) return;
    const permissions = this.permissions.getServerPermissions(serverName);
    if (!permissions) return;
    emitMcpPolicyUpdated(this.runtimeBus, {
      sessionId: 'mcp-registry',
      traceId: `mcp-registry:${serverName}:policy`,
      source: 'mcp-registry',
    }, {
      serverId: serverName,
      role: permissions.profile.role,
      trustMode: permissions.profile.mode,
      allowedPaths: [...permissions.profile.allowedPaths],
      allowedHosts: [...permissions.profile.allowedHosts],
    });
  }
}

/** Shared singleton instance — used by main.ts and slash commands. */
export const mcpRegistry = new McpRegistry();
