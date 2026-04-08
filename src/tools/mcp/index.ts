import type { Tool } from '../../types/tools.ts';
import { mcpRegistry } from '../../mcp/registry.ts';
import { MCP_TOOL_SCHEMA, type McpToolInput } from './schema.ts';

export const mcpTool: Tool = {
  definition: {
    name: 'mcp',
    description: 'Inspect MCP servers, tools, schemas, and trust state.',
    parameters: MCP_TOOL_SCHEMA.parameters,
    sideEffects: ['state'],
    concurrency: 'serial',
  },

  async execute(args: Record<string, unknown>) {
    if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
      return { success: false, error: 'Invalid args: mode is required.' };
    }
    const input = args as unknown as McpToolInput;

    if (input.mode === 'servers') {
      return { success: true, output: JSON.stringify({ servers: mcpRegistry.listServers() }) };
    }

    if (input.mode === 'tools') {
      const tools = await mcpRegistry.listAllTools();
      return { success: true, output: JSON.stringify({ count: tools.length, tools }) };
    }

    if (input.mode === 'schema') {
      if (!input.qualifiedName) return { success: false, error: 'schema requires qualifiedName.' };
      const schema = await mcpRegistry.getToolSchema(input.qualifiedName);
      if (!schema) return { success: false, error: `Unknown MCP tool: ${input.qualifiedName}` };
      return { success: true, output: JSON.stringify(schema) };
    }

    if (input.mode === 'resources') {
      return {
        success: true,
        output: JSON.stringify({
          servers: mcpRegistry.listServerSecurity().map((server) => ({
            name: server.name,
            resourceCount: 0,
            availableResources: [],
            note: 'resource inventory is not surfaced by the lightweight MCP registry path yet',
          })),
        }),
      };
    }

    if (input.mode === 'security') {
      return {
        success: true,
        output: JSON.stringify({
          servers: mcpRegistry.listServerSecurity(),
          recentDecisions: mcpRegistry.listRecentSecurityDecisions(),
        }),
      };
    }

    if (input.mode === 'auth') {
      return {
        success: true,
        output: JSON.stringify({
          servers: mcpRegistry.listServerSecurity().map((server) => ({
            name: server.name,
            trustMode: server.trustMode,
            role: server.role,
            connected: server.connected,
            schemaFreshness: server.schemaFreshness,
            quarantined: server.schemaFreshness === 'quarantined',
          })),
          recentDecisions: mcpRegistry.listRecentSecurityDecisions(),
        }),
      };
    }

    if (input.mode === 'approve-quarantine') {
      if (!input.serverName || !input.operatorId) {
        return { success: false, error: 'approve-quarantine requires serverName and operatorId.' };
      }
      mcpRegistry.approveSchemaQuarantine(input.serverName, input.operatorId);
      return { success: true, output: JSON.stringify({ serverName: input.serverName, approvedBy: input.operatorId }) };
    }

    if (input.mode === 'set-trust') {
      if (!input.serverName || !input.trustMode) {
        return { success: false, error: 'set-trust requires serverName and trustMode.' };
      }
      mcpRegistry.setServerTrustMode(input.serverName, input.trustMode);
      return { success: true, output: JSON.stringify({ serverName: input.serverName, trustMode: input.trustMode }) };
    }

    if (input.mode === 'set-role') {
      if (!input.serverName || !input.role) {
        return { success: false, error: 'set-role requires serverName and role.' };
      }
      mcpRegistry.setServerRole(input.serverName, input.role === 'deploy' ? 'ops' : input.role);
      return { success: true, output: JSON.stringify({ serverName: input.serverName, role: input.role }) };
    }

    return { success: false, error: `Unknown mode: ${input.mode}` };
  },
};
