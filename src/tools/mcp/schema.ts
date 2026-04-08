import type { ToolDefinition } from '../../types/tools.ts';

export const MCP_TOOL_SCHEMA: ToolDefinition = {
  name: 'mcp',
  description: 'Inspect MCP servers, tools, security posture, and quarantine state.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['servers', 'tools', 'schema', 'resources', 'security', 'auth', 'approve-quarantine', 'set-trust', 'set-role'],
      },
      view: {
        type: 'string',
        enum: ['descriptor', 'preview', 'full'],
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

export interface McpToolInput {
  readonly mode: 'servers' | 'tools' | 'schema' | 'resources' | 'security' | 'auth' | 'approve-quarantine' | 'set-trust' | 'set-role';
  readonly view?: 'descriptor' | 'preview' | 'full';
  readonly qualifiedName?: string;
  readonly serverName?: string;
  readonly operatorId?: string;
  readonly trustMode?: 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked';
  readonly role?: 'general' | 'docs' | 'filesystem' | 'git' | 'database' | 'browser' | 'deploy' | 'automation';
}
