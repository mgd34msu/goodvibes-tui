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

export interface RegisteredTool {
  /** Fully-qualified tool name: mcp:<server>:<tool> */
  qualifiedName: string;
  serverName: string;
  toolName: string;
  description: string;
}

export class McpRegistry {
  private clients = new Map<string, McpClient>();

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
    return client.callTool(parsed.toolName, args);
  }

  /**
   * disconnectAll — Stop all connected MCP server processes.
   */
  async disconnectAll(): Promise<void> {
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
    try {
      await client.connect();
      this.clients.set(name, client);
      logger.info('McpRegistry: server connected', { name });
    } catch (err) {
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
}

/** Shared singleton instance — used by main.ts and slash commands. */
export const mcpRegistry = new McpRegistry();
