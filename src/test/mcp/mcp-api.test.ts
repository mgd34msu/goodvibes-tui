import { describe, expect, test } from 'bun:test';
import { createMcpApi } from '@pellux/goodvibes-sdk/platform/mcp';

describe('McpApi', () => {
  test('wraps MCP security and tool inspection behind a stable api', async () => {
    const calls: string[] = [];
    const api = createMcpApi({
      serverNames: ['docs-server'],
      listServers: () => [{ name: 'docs-server', connected: true }],
      listServerSecurity: () => [{
        name: 'docs-server',
        connected: true,
        role: 'docs',
        trustMode: 'ask-on-risk',
        allowedPaths: ['/workspace'],
        allowedHosts: [],
        schemaFreshness: 'fresh',
      }],
      listServerSandboxBindings: () => [{
        name: 'docs-server',
        sessionId: 'sandbox-1',
        profileId: 'mcp-per-server',
        state: 'running',
        backend: 'local',
        startupStatus: 'verified',
      }],
      listRecentSecurityDecisions: () => [],
      listAllTools: async () => [{
        qualifiedName: 'mcp:docs-server:search',
        serverName: 'docs-server',
        toolName: 'search',
        description: 'Search documentation',
      }],
      setServerTrustMode: (serverName, mode) => {
        calls.push(`trust:${serverName}:${mode}`);
      },
      setServerRole: (serverName, role) => {
        calls.push(`role:${serverName}:${role}`);
      },
      quarantineSchema: (serverName, reason, detail) => {
        calls.push(`quarantine:${serverName}:${reason}:${detail ?? ''}`);
      },
      approveSchemaQuarantine: (serverName, operatorId) => {
        calls.push(`approve:${serverName}:${operatorId}`);
      },
    });

    expect(api.listServerNames()).toEqual(['docs-server']);
    expect(api.listServerSecurity()).toHaveLength(1);
    expect(api.listSandboxBindings()).toHaveLength(1);
    expect(await api.listAllTools()).toHaveLength(1);

    api.setServerTrustMode('docs-server', 'blocked');
    api.setServerRole('docs-server', 'automation');
    api.quarantineSchema('docs-server', 'operator_flagged', 'manual review');
    api.approveSchemaQuarantine('docs-server', 'operator');

    expect(calls).toEqual([
      'trust:docs-server:blocked',
      'role:docs-server:automation',
      'quarantine:docs-server:operator_flagged:manual review',
      'approve:docs-server:operator',
    ]);
  });
});
