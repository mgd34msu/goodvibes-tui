import type { ToolDefinition } from '../../types/tools.ts';

export const MCP_RESOURCE_TOOL_SCHEMA: ToolDefinition = {
  name: 'mcp_resource',
  description: 'Inspect MCP servers, tools, security posture, and quarantine state.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['servers', 'tools', 'schema', 'resources', 'security', 'auth', 'approve-quarantine', 'set-trust', 'set-role'],
      },
      qualifiedName: { type: 'string' },
      serverName: { type: 'string' },
      operatorId: { type: 'string' },
      trustMode: {
        type: 'string',
        enum: ['constrained', 'ask-on-risk', 'allow-all', 'blocked'],
      },
      role: {
        type: 'string',
        enum: ['general', 'docs', 'filesystem', 'git', 'database', 'browser', 'deploy', 'automation'],
      },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface McpResourceToolInput {
  readonly mode: 'servers' | 'tools' | 'schema' | 'resources' | 'security' | 'auth' | 'approve-quarantine' | 'set-trust' | 'set-role';
  readonly qualifiedName?: string;
  readonly serverName?: string;
  readonly operatorId?: string;
  readonly trustMode?: 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked';
  readonly role?: 'general' | 'docs' | 'filesystem' | 'git' | 'database' | 'browser' | 'deploy' | 'automation';
}
