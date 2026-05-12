import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { McpConfigScope, McpReloadResult, McpServerConfig } from '@pellux/goodvibes-sdk/platform/mcp';
import { requireMcpApi, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

const MCP_ROLES = ['general', 'docs', 'filesystem', 'git', 'database', 'browser', 'automation', 'ops', 'remote'] as const;
const MCP_TRUST_MODES = ['constrained', 'ask-on-risk', 'allow-all', 'blocked'] as const;

interface ParsedMcpAddArgs {
  readonly scope: McpConfigScope;
  readonly server: McpServerConfig;
}

function isMcpRole(value: string): value is NonNullable<McpServerConfig['role']> {
  return MCP_ROLES.includes(value as NonNullable<McpServerConfig['role']>);
}

function isMcpTrustMode(value: string): value is NonNullable<McpServerConfig['trustMode']> {
  return MCP_TRUST_MODES.includes(value as NonNullable<McpServerConfig['trustMode']>);
}

function isMcpScope(value: string): value is McpConfigScope {
  return value === 'project' || value === 'global';
}

function validateServerName(name: string): string | null {
  if (!name.trim()) return 'MCP server name is required.';
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return 'MCP server names may contain letters, numbers, dot, underscore, and dash only.';
  }
  return null;
}

function readFlagValue(tokens: string[], index: number, flag: string): string {
  const value = tokens[index + 1];
  if (!value) {
    throw new Error(`Missing value after ${flag}.`);
  }
  return value;
}

function parseAddServerArgs(args: string[]): ParsedMcpAddArgs {
  const name = args[1]?.trim();
  const command = args[2]?.trim();
  if (!name || !command) {
    throw new Error('Usage: /mcp add <name> <command> [args...] [--scope project|global] [--role <role>] [--trust <mode>] [--env KEY=VALUE] [--path <path>] [--host <host>]');
  }
  const nameError = validateServerName(name);
  if (nameError) throw new Error(nameError);

  const serverArgs: string[] = [];
  const env: Record<string, string> = {};
  const allowedPaths: string[] = [];
  const allowedHosts: string[] = [];
  let role: McpServerConfig['role'];
  let trustMode: McpServerConfig['trustMode'];
  let scope: McpConfigScope = 'project';
  let passthrough = false;
  const tokens = args.slice(3);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (passthrough) {
      serverArgs.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }
    if (token === '--role') {
      const value = readFlagValue(tokens, index, token);
      if (!isMcpRole(value)) throw new Error(`Invalid MCP role "${value}". Expected one of: ${MCP_ROLES.join(', ')}`);
      role = value;
      index += 1;
      continue;
    }
    if (token === '--scope') {
      const value = readFlagValue(tokens, index, token);
      if (!isMcpScope(value)) throw new Error(`Invalid MCP scope "${value}". Expected project or global.`);
      scope = value;
      index += 1;
      continue;
    }
    if (token === '--trust') {
      const value = readFlagValue(tokens, index, token);
      if (!isMcpTrustMode(value)) throw new Error(`Invalid MCP trust mode "${value}". Expected one of: ${MCP_TRUST_MODES.join(', ')}`);
      trustMode = value;
      index += 1;
      continue;
    }
    if (token === '--env') {
      const value = readFlagValue(tokens, index, token);
      const eq = value.indexOf('=');
      if (eq <= 0) throw new Error('MCP env entries must use KEY=VALUE.');
      env[value.slice(0, eq)] = value.slice(eq + 1);
      index += 1;
      continue;
    }
    if (token === '--path') {
      allowedPaths.push(readFlagValue(tokens, index, token));
      index += 1;
      continue;
    }
    if (token === '--host') {
      allowedHosts.push(readFlagValue(tokens, index, token));
      index += 1;
      continue;
    }
    serverArgs.push(token);
  }

  return {
    scope,
    server: {
      name,
      command,
      ...(serverArgs.length > 0 ? { args: serverArgs } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(role ? { role } : {}),
      ...(trustMode ? { trustMode } : {}),
      ...(allowedPaths.length > 0 ? { allowedPaths } : {}),
      ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    },
  };
}

async function reloadMcpRuntime(ctx: CommandContext): Promise<McpReloadResult> {
  const result = await requireMcpApi(ctx).reload(requireShellPaths(ctx));
  ctx.renderRequest();
  return result;
}

export function registerMcpRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'mcp',
    aliases: [],
    description: 'Manage MCP servers and their tools',
    usage: '[add|remove|reload|config|review|tools [<server>]|auth-review|repair [server]]',
    argsHint: '[add|remove|reload|config|review|tools [server]]',
    async handler(args, ctx) {
      const mcpApi = requireMcpApi(ctx);
      const listServerSecurity = () => mcpApi.listServerSecurity();
      const subcommand = args[0];
      if (!subcommand && ctx.openMcpWorkspace) {
        ctx.openMcpWorkspace();
        return;
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
          allTools = await mcpApi.listAllTools();
        } catch (e) {
          ctx.print(`Error listing tools: ${summarizeError(e)}`);
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
          mcpApi.setServerTrustMode(serverName, mode);
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
          mcpApi.setServerRole(serverName, role);
          ctx.print(`Updated MCP role for ${serverName} to ${role}.`);
          return;
        }
        if (serverName || role) {
          ctx.print('Usage: /mcp role <server> <general|docs|filesystem|git|database|browser|automation|ops|remote>');
          return;
        }
      }

      if (subcommand === 'add') {
        let parsed: ParsedMcpAddArgs;
        try {
          parsed = parseAddServerArgs(args);
        } catch (error) {
          ctx.print(summarizeError(error));
          return;
        }
        const shellPaths = requireShellPaths(ctx);
        try {
          const result = await mcpApi.upsertServerConfig(shellPaths, parsed.scope, parsed.server);
          const connected = listServerSecurity().find((entry) => entry.name === parsed.server.name)?.connected ?? false;
          ctx.print([
            `MCP server "${parsed.server.name}" saved to ${parsed.scope} config: ${result.path}.`,
            `Runtime reload: ${connected ? 'connected' : 'server saved; connection needs attention'} (+${result.reload.added} ~${result.reload.changed} -${result.reload.removed}, unchanged ${result.reload.unchanged}).`,
            `Command: ${parsed.server.command}${parsed.server.args?.length ? ` ${parsed.server.args.join(' ')}` : ''}`,
            'Next: /mcp tools',
          ].join('\n'));
        } catch (error) {
          ctx.print(`MCP add failed: ${summarizeError(error)}`);
        }
        return;
      }

      if (subcommand === 'remove') {
        const serverName = args[1]?.trim();
        if (!serverName) {
          ctx.print('Usage: /mcp remove <server> [--scope project|global]');
          return;
        }
        let scope: McpConfigScope = 'project';
        try {
          for (let index = 2; index < args.length; index += 1) {
            if (args[index] === '--scope') {
              const value = readFlagValue(args, index, '--scope');
              if (!isMcpScope(value)) {
                ctx.print(`Invalid MCP scope "${value}". Expected project or global.`);
                return;
              }
              scope = value;
              index += 1;
            }
          }
        } catch (error) {
          ctx.print(summarizeError(error));
          return;
        }
        const shellPaths = requireShellPaths(ctx);
        try {
          const result = await mcpApi.removeServerConfig(shellPaths, scope, serverName);
          ctx.print(result.removed
            ? `Removed MCP server "${serverName}" from ${scope} config ${result.path}. Reload: +${result.reload.added} ~${result.reload.changed} -${result.reload.removed}, unchanged ${result.reload.unchanged}.`
            : `No ${scope} MCP server named "${serverName}" exists in ${result.path}.\nIf it still appears, it is coming from another config scope or external MCP config.`);
        } catch (error) {
          ctx.print(`MCP remove failed: ${summarizeError(error)}`);
        }
        return;
      }

      if (subcommand === 'reload') {
        try {
          const result = await reloadMcpRuntime(ctx);
          const servers = listServerSecurity();
          ctx.print(`Reloaded MCP runtime from config. ${servers.filter((server) => server.connected).length}/${servers.length} server(s) connected. Result: +${result.added} ~${result.changed} -${result.removed}, unchanged ${result.unchanged}.`);
        } catch (error) {
          ctx.print(`MCP reload failed: ${summarizeError(error)}`);
        }
        return;
      }

      if (subcommand === 'config') {
        const shellPaths = requireShellPaths(ctx);
        try {
          const effective = mcpApi.getEffectiveConfig(shellPaths);
          ctx.print([
            'MCP Config',
            '  locations:',
            ...effective.locations.map((location) => `    ${location.scope}/${location.kind}${location.writable ? ' writable' : ' read-only'}  ${location.path}`),
            `  effective servers: ${effective.servers.length}`,
            ...effective.servers.map((entry) => {
              const server = entry.server;
              const envKeys = Object.keys(server.env ?? {});
              return `  - ${server.name}: ${server.command}${server.args?.length ? ` ${server.args.join(' ')}` : ''}  source=${entry.source.scope}/${entry.source.kind}${envKeys.length ? ` envKeys=${envKeys.join(',')}` : ''}`;
            }),
            '',
            'Add or update from inside the TUI:',
            '  /mcp add <name> <command> [args...] [--scope project|global] [--role <role>] [--trust <mode>]',
            'Example:',
            '  /mcp add filesystem npx -y @modelcontextprotocol/server-filesystem . --scope project --role filesystem --trust constrained',
          ].join('\n'));
        } catch (error) {
          ctx.print(`MCP config read failed: ${summarizeError(error)}`);
        }
        return;
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
          mcpApi.approveSchemaQuarantine(serverName, operatorId);
          ctx.print(`Approved MCP schema quarantine override for ${serverName} as ${operatorId}. Refresh is still recommended.`);
          return;
        }
        const detail = args.slice(2).join(' ') || 'quarantined by operator';
        mcpApi.quarantineSchema(serverName, 'operator_flagged', detail);
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
          + '\nAdd one from inside the TUI:\n'
          + '  /mcp add filesystem npx -y @modelcontextprotocol/server-filesystem . --scope project --role filesystem\n'
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
        lines.push('Run "/mcp" to open the fullscreen MCP workspace, or "/mcp add <name> <command> [args...] [--scope project|global]" to add/update without restarting.');
        lines.push('Run "/mcp reload" after editing MCP config outside the TUI.');
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
