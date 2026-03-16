/**
 * MCP server configuration — reads from .goodvibes/mcp.json
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
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
}

export interface McpConfig {
  servers: McpServerConfig[];
}

const DEFAULT_MCP_CONFIG: McpConfig = { servers: [] };

/**
 * loadMcpConfig - Read .goodvibes/mcp.json from the given base directory.
 * Returns empty config (no servers) if the file doesn't exist or is malformed.
 */
export function loadMcpConfig(baseDir = process.cwd()): McpConfig {
  const configPath = join(baseDir, '.goodvibes', 'mcp.json');
  if (!existsSync(configPath)) {
    return DEFAULT_MCP_CONFIG;
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isMcpConfig(parsed)) {
      logger.info('MCP config malformed, using empty config', { path: configPath });
      return DEFAULT_MCP_CONFIG;
    }
    return parsed;
  } catch (err) {
    logger.info('Failed to read MCP config', { path: configPath, err: String(err) });
    return DEFAULT_MCP_CONFIG;
  }
}

/** Type guard for McpConfig */
function isMcpConfig(v: unknown): v is McpConfig {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (!Array.isArray(obj['servers'])) return false;
  for (const s of obj['servers']) {
    if (typeof s !== 'object' || s === null) return false;
    const srv = s as Record<string, unknown>;
    if (typeof srv['name'] !== 'string' || !srv['name']) return false;
    if (typeof srv['command'] !== 'string' || !srv['command']) return false;
    if (srv['args'] !== undefined && !Array.isArray(srv['args'])) return false;
    if (srv['env'] !== undefined && (typeof srv['env'] !== 'object' || srv['env'] === null)) return false;
  }
  return true;
}
