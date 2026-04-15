/**
 * McpRegistry — manages all connected MCP servers.
 *
 * Progressive loading strategy:
 *   - On connect: load tool names + descriptions only (F2)
 *   - On first callTool: fetch full JSON schema for that tool and cache it
 *
 * Tool namespace: mcp:<server-name>:<tool-name>
 */
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { loadMcpConfig } from '@pellux/goodvibes-sdk/platform/mcp/config';
import { McpClient } from './client.ts';
import type { McpProcessSpec } from './client.ts';
import type { McpToolInfo, McpToolSchema } from './client.ts';
import type { McpServerConfig } from '@pellux/goodvibes-sdk/platform/mcp/config';
import type { HookDispatcher } from '../hooks/dispatcher.ts';
import type { HookEvent } from '@pellux/goodvibes-sdk/platform/hooks/types';
import { McpPermissionManager } from '@pellux/goodvibes-sdk/platform/runtime/mcp/permissions';
import { McpSchemaFreshnessTracker } from '@pellux/goodvibes-sdk/platform/runtime/mcp/schema-freshness';
import type { McpDecisionRecord, QuarantineReason, SchemaFreshness } from '@pellux/goodvibes-sdk/platform/runtime/mcp/types';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import {
  emitMcpConfigured,
  emitMcpPolicyUpdated,
  emitMcpSchemaQuarantineApproved,
  emitMcpSchemaQuarantined,
} from '../runtime/emitters/mcp.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { McpConfigRoots } from '@pellux/goodvibes-sdk/platform/mcp/config';
import { getSandboxConfigSnapshot } from '../runtime/sandbox/manager.ts';
import {
  type SandboxSessionRegistry,
} from '../runtime/sandbox/session-registry.ts';
import { resolveSandboxCommandPlan } from '../runtime/sandbox/backend.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

function compactEnv(env: NodeJS.ProcessEnv | Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

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
  private sandboxConfigManager: ConfigManager | null = null;
  private sandboxSessions: SandboxSessionRegistry;
  private sandboxSessionByServer = new Map<string, string>();
  private readonly hookDispatcher: Pick<HookDispatcher, 'fire'>;

  constructor(options: {
    readonly hookDispatcher: Pick<HookDispatcher, 'fire'>;
    readonly sandboxSessions: SandboxSessionRegistry;
  }) {
    this.hookDispatcher = options.hookDispatcher;
    this.sandboxSessions = options.sandboxSessions;
  }

  setRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.runtimeBus = runtimeBus;
  }

  setSandboxRuntime(configManager: ConfigManager, sessions: SandboxSessionRegistry): void {
    this.sandboxConfigManager = configManager;
    this.sandboxSessions = sessions;
  }

  /**
   * connectAll — Load config from .goodvibes/mcp.json and connect to all servers.
   * Errors on individual servers are logged but do not abort the whole startup.
   */
  async connectAll(roots: McpConfigRoots): Promise<void> {
    const mcpConfig = loadMcpConfig(roots);
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
        logger.info('McpRegistry: failed to list tools from server', { server: serverName, err: summarizeError(err) });
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
    const dispatcher = this.hookDispatcher;
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
      dispatcher.fire(postEvent).catch((err: unknown) => { logger.debug('Post:mcp:call hook error', { error: summarizeError(err) }); });
      return result;
    } catch (err) {
      this.freshness.markFailed(parsed.serverName, summarizeError(err));
      // Fail:mcp:call hook (fire-and-forget)
      const failEvent: HookEvent = {
        path: 'Fail:mcp:call',
        phase: 'Fail',
        category: 'mcp',
        specific: 'call',
        sessionId: '', timestamp: Date.now(),
        payload: { tool: qualifiedName, args, error: summarizeError(err) },
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
    const dispatcher = this.hookDispatcher;
    for (const name of this.clients.keys()) {
      const disconnectedEvent: HookEvent = {
        path: 'Lifecycle:mcp:disconnected',
        phase: 'Lifecycle',
        category: 'mcp',
        specific: 'disconnected',
        sessionId: '', timestamp: Date.now(),
        payload: { server: name },
      };
      dispatcher.fire(disconnectedEvent).catch((err: unknown) => { logger.debug('Lifecycle:mcp:disconnected hook error', { error: summarizeError(err) }); });
    }
    await Promise.allSettled(
      Array.from(this.clients.values()).map((client) => client.disconnect()),
    );
    this.clients.clear();
    for (const sessionId of this.sandboxSessionByServer.values()) {
      this.sandboxSessions.stop(sessionId);
    }
    this.sandboxSessionByServer.clear();
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
    role: import('@pellux/goodvibes-sdk/platform/runtime/mcp/types').McpServerRole;
    trustMode: import('@pellux/goodvibes-sdk/platform/runtime/mcp/types').McpTrustMode;
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

  listServerSandboxBindings(): Array<{
    name: string;
    sessionId?: string;
    profileId?: 'mcp-shared' | 'mcp-per-server';
    state?: import('@pellux/goodvibes-sdk/platform/runtime/sandbox/types').SandboxSessionState;
    backend?: import('@pellux/goodvibes-sdk/platform/runtime/sandbox/types').SandboxResolvedBackend | import('@pellux/goodvibes-sdk/platform/runtime/sandbox/types').SandboxVmBackend;
    startupStatus?: 'verified' | 'planned' | 'failed';
  }> {
    return this.serverNames.map((name) => {
      const sessionId = this.sandboxSessionByServer.get(name);
      const session = sessionId ? this.sandboxSessions.get(sessionId) : null;
      return {
        name,
        sessionId: sessionId ?? undefined,
        profileId: session?.profileId === 'mcp-shared' || session?.profileId === 'mcp-per-server'
          ? session.profileId
          : undefined,
        state: session?.state,
        backend: session?.resolvedBackend ?? session?.backend,
        startupStatus: session?.startupStatus,
      };
    });
  }

  setServerTrustMode(serverName: string, mode: import('@pellux/goodvibes-sdk/platform/runtime/mcp/types').McpTrustMode): void {
    this.permissions.setTrustMode(serverName, mode);
    this._emitPolicyUpdate(serverName);
  }

  setServerRole(serverName: string, role: import('@pellux/goodvibes-sdk/platform/runtime/mcp/types').McpServerRole): void {
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
    let sandboxSessionId: string | null = null;
    let processSpec: McpProcessSpec | undefined;
    if (this.sandboxConfigManager) {
      const resolved = await this._resolveSandboxProcessSpec(serverConfig);
      sandboxSessionId = resolved?.sessionId ?? null;
      processSpec = resolved?.processSpec;
    }
    const client = new McpClient(serverConfig, processSpec ? { processSpec } : undefined);
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
      if (sandboxSessionId) {
        this.sandboxSessionByServer.set(name, sandboxSessionId);
      }
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
      this.hookDispatcher.fire(connectedEvent).catch((err: unknown) => { logger.debug('Lifecycle:mcp:connected hook error', { error: summarizeError(err) }); });
    } catch (err) {
      if (sandboxSessionId) {
        this.sandboxSessions.stop(sandboxSessionId);
        this.sandboxSessionByServer.delete(name);
      }
      this.freshness.markFailed(name, summarizeError(err));
      logger.error('McpRegistry: failed to connect server', { name, err: summarizeError(err) });
      // Don't register the client — it's not usable
    }
  }

  private async _resolveSandboxProcessSpec(
    serverConfig: McpServerConfig,
  ): Promise<{ sessionId: string; processSpec: McpProcessSpec } | null> {
    const configManager = this.sandboxConfigManager;
    if (!configManager) return null;
    const sandbox = getSandboxConfigSnapshot(configManager);
    if (sandbox.mcpIsolation === 'disabled') return null;

    const profileId = this._selectSandboxProfile(serverConfig);
    const label = `${serverConfig.name} MCP`;
    const session = await this.sandboxSessions.start(profileId, label, configManager);
    if (!session.launchPlan) {
      throw new Error(`Sandbox session ${session.id} for MCP server '${serverConfig.name}' is missing a launch plan.`);
    }
    const resolvedPlan = resolveSandboxCommandPlan(
      session.launchPlan,
      serverConfig.command,
      serverConfig.args ?? [],
      configManager,
    );
    return {
      sessionId: session.id,
      processSpec: {
        command: resolvedPlan.command,
        args: [...resolvedPlan.args],
        env: compactEnv({ ...(serverConfig.env ?? {}), ...(resolvedPlan.env ?? {}) }),
        cwd: session.launchPlan.workspaceRoot,
        summary: resolvedPlan.summary,
        sandboxSessionId: session.id,
      },
    };
  }

  private _selectSandboxProfile(serverConfig: McpServerConfig): 'mcp-shared' | 'mcp-per-server' {
    const configManager = this.sandboxConfigManager;
    if (!configManager) return 'mcp-shared';
    const sandbox = getSandboxConfigSnapshot(configManager);
    switch (sandbox.mcpIsolation) {
      case 'per-server-vm':
        return 'mcp-per-server';
      case 'shared-vm':
        return 'mcp-shared';
      case 'hybrid':
        return this._requiresDedicatedMcpSandbox(serverConfig) ? 'mcp-per-server' : 'mcp-shared';
      case 'disabled':
      default:
        return 'mcp-shared';
    }
  }

  private _requiresDedicatedMcpSandbox(serverConfig: McpServerConfig): boolean {
    return Boolean(
      (serverConfig.allowedHosts?.length ?? 0) > 0
      || (serverConfig.allowedPaths?.length ?? 0) > 0
      || serverConfig.role === 'automation'
      || serverConfig.role === 'browser'
      || serverConfig.role === 'ops'
      || serverConfig.role === 'remote',
    );
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
