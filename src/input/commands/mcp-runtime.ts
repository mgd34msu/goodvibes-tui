import type { CommandRegistry } from '../command-registry.ts';

export function registerMcpRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'mcp',
    aliases: [],
    description: 'List connected MCP servers and their tools',
    usage: '[review|tools [<server>]|auth-review|repair [server]]',
    argsHint: '[review|tools [server]|auth-review|repair [server]]',
    async handler(args, ctx) {
      const listServerSecurity = (): ReturnType<typeof ctx.mcpRegistry.listServerSecurity> => {
        const api = ctx.mcpRegistry as typeof ctx.mcpRegistry & {
          listServerSecurity?: () => ReturnType<typeof ctx.mcpRegistry.listServerSecurity>;
        };
        return api.listServerSecurity?.() ?? [];
      };
      const subcommand = args[0];
      if (!subcommand && ctx.openMcpPanel) {
        ctx.openMcpPanel();
      }
      if (subcommand === 'review') {
        const servers = listServerSecurity();
        const authRequired = servers.filter((server) => !server.connected || server.schemaFreshness === 'quarantined');
        ctx.print([
          'MCP Review',
          `  servers: ${servers.length}`,
          `  connected: ${servers.filter((server) => server.connected).length}`,
          `  auth or repair attention: ${authRequired.length}`,
          ...servers.map((server) => `  ${server.name}  trust=${server.trustMode}  role=${server.role}  freshness=${server.schemaFreshness}  connected=${server.connected ? 'yes' : 'no'}`),
          '  next: /mcp auth-review',
          '  next: /mcp repair <server>',
        ].join('\n'));
        return;
      }
      if (subcommand === 'tools') {
        const filterServer = args[1];
        ctx.print('Fetching MCP tool list...');
        let allTools;
        try {
          allTools = await ctx.mcpRegistry.listAllTools();
        } catch (e) {
          ctx.print(`Error listing tools: ${(e as Error).message}`);
          return;
        }
        const tools = filterServer ? allTools.filter(t => t.serverName === filterServer) : allTools;
        if (tools.length === 0) {
          ctx.print(filterServer
            ? `No tools found for server "${filterServer}". Is it connected? Run /mcp to see server status.`
            : 'No MCP tools available. Configure servers in .goodvibes/mcp.json or ~/.config/mcp/mcp.json.');
          return;
        }
        const lines: string[] = [`MCP Tools (${tools.length} total):`];
        let lastServer = '';
        for (const tool of tools) {
          if (tool.serverName !== lastServer) {
            lines.push(`\n  [${tool.serverName}]`);
            lastServer = tool.serverName;
          }
          lines.push(`    ${tool.toolName}${tool.description ? `  — ${tool.description}` : ''}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (subcommand === 'auth-review') {
        const servers = listServerSecurity();
        const needingAttention = servers.filter((server) => !server.connected || server.schemaFreshness === 'quarantined');
        ctx.print(needingAttention.length > 0
          ? [
              'MCP Auth Review',
              ...needingAttention.map((server) => (
                `  ${server.name}  connected=${server.connected ? 'yes' : 'no'}  freshness=${server.schemaFreshness}  trust=${server.trustMode}`
              )),
              '  next: /services auth-review',
              '  next: /mcp repair <server>',
            ].join('\n')
          : 'MCP Auth Review\n  No MCP servers currently need auth or quarantine recovery.');
        return;
      }

      if (subcommand === 'repair') {
        const serverName = args[1];
        const servers = listServerSecurity();
        const selected = serverName ? servers.find((server) => server.name === serverName) : servers.find((server) => !server.connected || server.schemaFreshness === 'quarantined');
        if (!selected) {
          ctx.print(serverName
            ? `Unknown MCP server: ${serverName}`
            : 'MCP Repair\n  No MCP server currently needs repair.');
          return;
        }
        const nextSteps = [
          selected.schemaFreshness === 'quarantined'
            ? `/mcp quarantine ${selected.name} approve operator`
            : null,
          !selected.connected ? '/services auth-review' : null,
          '/mcp review',
          '/health review',
        ].filter((entry): entry is string => entry !== null);
        ctx.print([
          `MCP Repair: ${selected.name}`,
          `  connected: ${selected.connected ? 'yes' : 'no'}`,
          `  trust: ${selected.trustMode}`,
          `  role: ${selected.role}`,
          `  freshness: ${selected.schemaFreshness}`,
          ...(selected.quarantineReason ? [`  quarantine: ${selected.quarantineReason}`] : []),
          ...(selected.quarantineDetail ? [`  detail: ${selected.quarantineDetail}`] : []),
          '  next:',
          ...nextSteps.map((step) => `    ${step}`),
        ].join('\n'));
        return;
      }

      if (subcommand === 'trust') {
        const serverName = args[1];
        const mode = args[2] as 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked' | undefined;
        if (serverName && mode) {
          if (mode === 'allow-all') {
            ctx.print(`Use /settings → MCP to explicitly enable allow-all for ${serverName}. Direct CLI escalation is blocked.`);
            ctx.openSettingsModal?.();
            return;
          }
          ctx.mcpRegistry.setServerTrustMode(serverName, mode);
          ctx.print(`Updated MCP trust mode for ${serverName} to ${mode}.`);
          return;
        }
        if (serverName || mode) {
          ctx.print('Usage: /mcp trust <server> <constrained|ask-on-risk|blocked>\nUse /settings → MCP to explicitly enable allow-all.');
          return;
        }
      }

      if (subcommand === 'role') {
        const serverName = args[1];
        const role = args[2] as 'general' | 'docs' | 'filesystem' | 'git' | 'database' | 'browser' | 'automation' | 'ops' | 'remote' | undefined;
        if (serverName && role) {
          ctx.mcpRegistry.setServerRole(serverName, role);
          ctx.print(`Updated MCP role for ${serverName} to ${role}.`);
          return;
        }
        if (serverName || role) {
          ctx.print('Usage: /mcp role <server> <general|docs|filesystem|git|database|browser|automation|ops|remote>');
          return;
        }
      }

      if (subcommand === 'quarantine') {
        const serverName = args[1];
        const action = args[2];
        if (!serverName) {
          ctx.print('Usage: /mcp quarantine <server> [detail]\n       /mcp quarantine <server> approve [operatorId]');
          return;
        }
        if (action === 'approve') {
          const operatorId = args[3] || 'operator';
          ctx.mcpRegistry.approveSchemaQuarantine(serverName, operatorId);
          ctx.print(`Approved MCP schema quarantine override for ${serverName} as ${operatorId}. Refresh is still recommended.`);
          return;
        }
        const detail = args.slice(2).join(' ') || 'quarantined by operator';
        ctx.mcpRegistry.quarantineSchema(serverName, 'operator_flagged', detail);
        ctx.print(`Quarantined MCP schema for ${serverName}.\nReason: ${detail}`);
        return;
      }

      const servers = listServerSecurity();
      if (servers.length === 0) {
        ctx.print(
          'No MCP servers configured.\n'
          + 'Add servers to one of these locations (scanned in order):\n'
          + '  ~/.config/mcp/mcp.json               (global XDG)\n'
          + '  ~/.mcp/mcp.json                      (global dotdir)\n'
          + '  ~/.config/claude/claude_desktop_config.json  (Claude Desktop)\n'
          + '  .mcp/mcp.json                        (project-local)\n'
          + '  .goodvibes/mcp.json                  (goodvibes project)\n'
          + '\nFormat: { "servers": [{ "name": "my-server", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }] }'
        );
        return;
      }

      const connected = servers.filter(s => s.connected);
      const disconnected = servers.filter(s => !s.connected);
      const lines: string[] = [`MCP Servers (${connected.length}/${servers.length} connected):`];
      for (const s of servers) {
        const pathScope = s.allowedPaths.length > 0 ? ` paths=${s.allowedPaths.length}` : '';
        const hostScope = s.allowedHosts.length > 0 ? ` hosts=${s.allowedHosts.length}` : '';
        const freshness = ` freshness=${s.schemaFreshness}`;
        const quarantine = s.schemaFreshness === 'quarantined' ? ` quarantine=${s.quarantineReason ?? 'unknown'}` : '';
        lines.push(`  ${s.connected ? '[connected]   ' : '[disconnected]'}  ${s.name}  trust=${s.trustMode}  role=${s.role}${freshness}${quarantine}${pathScope}${hostScope}`);
      }
      if (connected.length > 0) {
        lines.push('');
        lines.push('Run "/mcp tools" to list all tools, or "/mcp tools <server>" for a specific server.');
        lines.push('Run "/mcp trust <server> <mode>" to change trust mode, or "/mcp role <server> <role>" to change its coherence role.');
        lines.push('Run "/mcp quarantine <server> [detail]" to block a server, or "/mcp quarantine <server> approve [operatorId]" to approve a temporary override.');
        lines.push('Use /settings → MCP to explicitly enable allow-all for a server.');
      }
      if (disconnected.length > 0) {
        lines.push('');
        lines.push(`${disconnected.length} server(s) failed to connect. Check server command and args in your config.`);
      }
      ctx.print(lines.join('\n'));
    },
  });
}
