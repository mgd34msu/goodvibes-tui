import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerMcpRuntimeCommands } from '../../input/commands/mcp-runtime.ts';
import {
  loadMcpEffectiveConfig,
  removeMcpServerConfig,
  upsertMcpServerConfig,
} from '@pellux/goodvibes-sdk/platform/mcp';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeShellPaths(root: string) {
  return {
    workingDirectory: root,
    homeDirectory: root,
    resolveProjectPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
    resolveUserPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
    resolveWorkspacePath: (...parts: string[]) => join(root, ...parts),
    isWithinWorkingDirectory: (path: string) => path.startsWith(root),
  };
}

function makeContext(root: string, out: string[]): CommandContext {
  const shellPaths = makeShellPaths(root);
  let connectedNames: string[] = [];
  const reload = async () => {
    const effective = loadMcpEffectiveConfig(shellPaths);
    connectedNames = effective.servers.map((entry) => entry.server.name);
    return {
      added: connectedNames.length,
      changed: 0,
      removed: 0,
      unchanged: 0,
      servers: connectedNames.map((name) => ({ name, action: 'added' as const, connected: true })),
    };
  };
  const mcpApi = {
    getEffectiveConfig: () => loadMcpEffectiveConfig(shellPaths),
    reload,
    async upsertServerConfig(_roots: unknown, scope: 'project' | 'global', server: Parameters<typeof upsertMcpServerConfig>[2]) {
      const result = upsertMcpServerConfig(shellPaths, scope, server);
      return { path: result.path, reload: await reload() };
    },
    async removeServerConfig(_roots: unknown, scope: 'project' | 'global', serverName: string) {
      const result = removeMcpServerConfig(shellPaths, scope, serverName);
      return { path: result.path, removed: result.removed, reload: await reload() };
    },
    listServerSecurity: () => connectedNames.map((name) => ({
      name,
      connected: true,
      role: 'general' as const,
      trustMode: 'constrained' as const,
      allowedPaths: [],
      allowedHosts: [],
      schemaFreshness: 'fresh' as const,
    })),
    listAllTools: async () => [],
    listServers: () => [],
    listServerNames: () => connectedNames,
    listSandboxBindings: () => [],
    listRecentSecurityDecisions: () => [],
    setServerTrustMode: () => {},
    setServerRole: () => {},
    quarantineSchema: () => {},
    approveSchemaQuarantine: () => {},
  };

  return {
    session: {} as never,
    provider: {} as never,
    workspace: { shellPaths } as never,
    platform: {} as never,
    ops: {} as never,
    extensions: {} as never,
    clients: { mcpApi } as never,
    renderRequest: () => {},
    print: (text: string) => out.push(text),
    exit: () => {},
  } as CommandContext;
}

describe('/mcp runtime config commands', () => {
  test('adds project-local MCP server and reloads runtime registry', async () => {
    const root = makeProjectTempDir('gv-mcp-command');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      const ctx = makeContext(root, out);

      await registry.get('mcp')!.handler([
        'add',
        'filesystem',
        'npx',
        '-y',
        '@modelcontextprotocol/server-filesystem',
        '.',
        '--role',
        'filesystem',
        '--trust',
        'constrained',
        '--env',
        'FOO=bar',
      ], ctx);

      const config = JSON.parse(readFileSync(join(root, '.goodvibes', 'mcp.json'), 'utf-8')) as {
        servers: Array<{ name: string; command: string; args?: string[]; role?: string; trustMode?: string; env?: Record<string, string> }>;
      };
      expect(config.servers).toHaveLength(1);
      expect(config.servers[0]).toMatchObject({
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        role: 'filesystem',
        trustMode: 'constrained',
        env: { FOO: 'bar' },
      });
      expect(out.join('\n')).toContain('Runtime reload: connected');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('removes project-local MCP server and reloads runtime registry', async () => {
    const root = makeProjectTempDir('gv-mcp-command');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      const ctx = makeContext(root, out);

      await registry.get('mcp')!.handler(['add', 'docs', 'node', 'server.js'], ctx);
      await registry.get('mcp')!.handler(['remove', 'docs'], ctx);

      const config = JSON.parse(readFileSync(join(root, '.goodvibes', 'mcp.json'), 'utf-8')) as { servers: unknown[] };
      expect(config.servers).toEqual([]);
      expect(out.join('\n')).toContain('Removed MCP server "docs"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('adds global MCP server when scope is selected', async () => {
    const root = makeProjectTempDir('gv-mcp-command');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      const ctx = makeContext(root, out);

      await registry.get('mcp')!.handler([
        'add',
        'docs',
        'node',
        'server.js',
        '--scope',
        'global',
        '--env',
        'SECRET=hidden',
      ], ctx);
      await registry.get('mcp')!.handler(['config'], ctx);

      const config = JSON.parse(readFileSync(join(root, '.config', 'mcp', 'mcp.json'), 'utf-8')) as {
        servers: Array<{ name: string; command: string; env?: Record<string, string> }>;
      };
      expect(config.servers[0]).toMatchObject({ name: 'docs', command: 'node', env: { SECRET: 'hidden' } });
      expect(out.join('\n')).toContain('global config');
      expect(out.join('\n')).toContain('envKeys=SECRET');
      expect(out.join('\n')).not.toContain('hidden');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
