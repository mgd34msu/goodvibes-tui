import type { Tool } from '@pellux/goodvibes-sdk/platform/types/tools';
import type { McpDecisionRecord } from '@pellux/goodvibes-sdk/platform/runtime/mcp/types';
import type { McpRegistry } from '../../mcp/registry.ts';
import { MCP_TOOL_SCHEMA, type McpToolInput } from '@pellux/goodvibes-sdk/platform/tools/mcp/schema';

type McpServerSecurity = ReturnType<McpRegistry['listServerSecurity']>[number];

function summarizeServer(server: McpServerSecurity) {
  return {
    name: server.name,
    connected: server.connected,
    role: server.role,
    trustMode: server.trustMode,
    schemaFreshness: server.schemaFreshness,
    quarantined: server.schemaFreshness === 'quarantined',
  };
}

function previewServer(server: McpServerSecurity) {
  return {
    ...summarizeServer(server),
    allowedPathCount: server.allowedPaths.length,
    allowedHostCount: server.allowedHosts.length,
    quarantineReason: server.quarantineReason,
    quarantineDetail: server.quarantineDetail,
    quarantineApprovedBy: server.quarantineApprovedBy,
  };
}

function summarizeDecision(decision: McpDecisionRecord) {
  return {
    serverName: decision.serverName,
    toolName: decision.toolName,
    verdict: decision.verdict,
    reason: decision.reason,
    evaluatedAt: decision.evaluatedAt,
  };
}

export function createMcpTool(mcpRegistry: McpRegistry): Tool {
  return {
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
    const view = input.view ?? 'descriptor';

    if (input.mode === 'servers') {
      const security = mcpRegistry.listServerSecurity();
      const filtered = input.serverName
        ? security.filter((server) => server.name === input.serverName)
        : security;
      const payload = filtered.map((server) => {
        if (view === 'full') return server;
        if (view === 'preview') return previewServer(server);
        return summarizeServer(server);
      });
      return { success: true, output: JSON.stringify({ view, count: payload.length, servers: payload }) };
    }

    if (input.mode === 'tools') {
      const tools = await mcpRegistry.listAllTools();
      const filtered = input.serverName
        ? tools.filter((tool) => tool.serverName === input.serverName)
        : tools;
      const summarized = filtered.map((tool) => ({
        qualifiedName: tool.qualifiedName,
        serverName: tool.serverName,
        toolName: tool.toolName,
        description: tool.description,
      }));
      return { success: true, output: JSON.stringify({ view, count: summarized.length, tools: summarized }) };
    }

    if (input.mode === 'schema') {
      if (!input.qualifiedName) return { success: false, error: 'schema requires qualifiedName.' };
      const schema = await mcpRegistry.getToolSchema(input.qualifiedName);
      if (!schema) return { success: false, error: `Unknown MCP tool: ${input.qualifiedName}` };
      return { success: true, output: JSON.stringify(schema) };
    }

    if (input.mode === 'resources') {
      const security = mcpRegistry.listServerSecurity();
      const filtered = input.serverName
        ? security.filter((server) => server.name === input.serverName)
        : security;
      return {
        success: true,
        output: JSON.stringify({
          view,
          count: filtered.length,
          servers: filtered.map((server) => ({
            name: server.name,
            resourceCount: 0,
            availableResources: [],
            note: 'resource inventory is not surfaced by the lightweight MCP registry path yet',
            trustMode: server.trustMode,
            schemaFreshness: server.schemaFreshness,
          })),
        }),
      };
    }

    if (input.mode === 'security') {
      const servers = mcpRegistry.listServerSecurity();
      const filtered = input.serverName
        ? servers.filter((server) => server.name === input.serverName)
        : servers;
      const recentDecisions = mcpRegistry.listRecentSecurityDecisions();
      return {
        success: true,
        output: JSON.stringify({
          view,
          servers: filtered.map((server) => {
            if (view === 'full') return server;
            if (view === 'preview') return previewServer(server);
            return summarizeServer(server);
          }),
          recentDecisions: view === 'full'
            ? recentDecisions
            : recentDecisions.slice(0, 8).map(summarizeDecision),
        }),
      };
    }

    if (input.mode === 'auth') {
      const servers = mcpRegistry.listServerSecurity();
      const filtered = input.serverName
        ? servers.filter((server) => server.name === input.serverName)
        : servers;
      const recentDecisions = mcpRegistry.listRecentSecurityDecisions();
      return {
        success: true,
        output: JSON.stringify({
          view,
          servers: filtered.map((server) => {
            if (view === 'full') {
              return {
                ...server,
                allowedPaths: server.allowedPaths,
                allowedHosts: server.allowedHosts,
              };
            }
            if (view === 'preview') return previewServer(server);
            return summarizeServer(server);
          }),
          recentDecisions: view === 'full'
            ? recentDecisions
            : recentDecisions.slice(0, 8).map(summarizeDecision),
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
}
