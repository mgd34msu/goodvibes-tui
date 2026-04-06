/**
 * MCP server configuration — scans multiple locations in precedence order.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.ts';

export interface McpServerConfig {
  /** Unique server name, used as namespace prefix: mcp:<name>:<tool> */
  name: string;
  /** Executable command to start the MCP server process */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Optional environment variables to merge with process.env */
  env?: Record<string, string>;
  /** Optional role used by runtime coherence checks. */
  role?: 'general' | 'docs' | 'filesystem' | 'git' | 'database' | 'browser' | 'automation' | 'ops' | 'remote';
  /** Optional initial trust mode for the runtime MCP trust layer. */
  trustMode?: 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked';
  /** Optional allowed path prefixes for filesystem-oriented tools. */
  allowedPaths?: string[];
  /** Optional allowed network hostnames for network-oriented tools. */
  allowedHosts?: string[];
}

export interface McpConfig {
  servers: McpServerConfig[];
}

/**
 * loadMcpConfig - Scan multiple locations in precedence order (later wins).
 * Returns merged config from all found files. Returns empty config on failure.
 */
export function loadMcpConfig(baseDir?: string): McpConfig {
  const cwd = baseDir ?? process.cwd();
  const home = homedir();

  // Scan locations in precedence order (later wins)
  const locations = [
    join(home, '.config', 'mcp', 'mcp.json'),                      // global XDG
    join(home, '.mcp', 'mcp.json'),                                  // global dotdir
    join(home, '.config', 'claude', 'claude_desktop_config.json'),  // Claude Desktop
    join(cwd, '.mcp', 'mcp.json'),                                   // project-local
    join(cwd, '.goodvibes', 'mcp.json'),                             // goodvibes project
  ];

  const merged: McpConfig = { servers: [] };
  const serversByName = new Map<string, McpServerConfig>();

  for (const path of locations) {
    try {
      if (!existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;

      // Handle Claude Desktop format
      if (typeof raw === 'object' && raw !== null && 'mcpServers' in raw) {
        const obj = raw as Record<string, unknown>;
        if (typeof obj['mcpServers'] === 'object' && obj['mcpServers'] !== null) {
          for (const [name, srv] of Object.entries(obj['mcpServers'] as Record<string, unknown>)) {
            const s = srv as Record<string, unknown>;
            if (typeof s.command === 'string') {
              serversByName.set(name, {
                name,
                command: s.command,
                args: Array.isArray(s.args) ? s.args.filter((a: unknown) => typeof a === 'string') : [],
                env: typeof s.env === 'object' && s.env ? Object.fromEntries(
                  Object.entries(s.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string')
                ) as Record<string, string> : undefined,
                role: typeof s.role === 'string' ? s.role as McpServerConfig['role'] : undefined,
                trustMode: typeof s.trustMode === 'string' ? s.trustMode as McpServerConfig['trustMode'] : undefined,
                allowedPaths: Array.isArray(s.allowedPaths) ? s.allowedPaths.filter((v: unknown) => typeof v === 'string') : undefined,
                allowedHosts: Array.isArray(s.allowedHosts) ? s.allowedHosts.filter((v: unknown) => typeof v === 'string') : undefined,
              });
            }
          }
        }
        continue;
      }

      // Handle goodvibes format
      if (isMcpConfig(raw)) {
        for (const srv of raw.servers) {
          serversByName.set(srv.name, srv);
        }
      }
    } catch (err) {
      logger.warn(`[MCP] Failed to read ${path}`, { error: String(err) });
    }
  }

  merged.servers = [...serversByName.values()];
  return merged;
}

/** Type guard for McpConfig (goodvibes format) */
function isMcpConfig(v: unknown): v is McpConfig {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (!Array.isArray(obj['servers'])) return false;
  for (const s of obj['servers']) {
    if (typeof s !== 'object' || s === null) return false;
    const srv = s as Record<string, unknown>;
    if (typeof srv['name'] !== 'string' || !srv['name']) return false;
    if (typeof srv['command'] !== 'string' || !srv['command']) return false;
    if (srv['args'] !== undefined) {
      if (!Array.isArray(srv['args'])) return false;
      if (!srv['args'].every((a: unknown) => typeof a === 'string')) return false;
    }
    if (srv['env'] !== undefined && (typeof srv['env'] !== 'object' || srv['env'] === null)) return false;
    if (srv['role'] !== undefined && typeof srv['role'] !== 'string') return false;
    if (srv['trustMode'] !== undefined && typeof srv['trustMode'] !== 'string') return false;
    if (srv['allowedPaths'] !== undefined && (!Array.isArray(srv['allowedPaths']) || !srv['allowedPaths'].every((a: unknown) => typeof a === 'string'))) return false;
    if (srv['allowedHosts'] !== undefined && (!Array.isArray(srv['allowedHosts']) || !srv['allowedHosts'].every((a: unknown) => typeof a === 'string'))) return false;
  }
  return true;
}
