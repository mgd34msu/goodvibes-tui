import { describe, test, expect, afterEach } from 'bun:test';
import { McpRegistry } from '../../mcp/registry.ts';
import type { McpServerConfig } from '../../mcp/config.ts';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';

// Minimal stub MCP server script for registry tests
const STUB_SCRIPT = /* js */ `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  const id = msg.id;
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: {} } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [
      { name: 'greet', description: 'Greet someone', inputSchema: { type: 'object', properties: {} } },
    ]}}) + '\\n');
  } else if (msg.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'hello' }] } }) + '\\n');
  } else if (msg.method === 'ping') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\\n');
  } else if (msg.method === 'notifications/initialized') {
    // no-op
  }
});
`;

function stubServerConfig(name: string): McpServerConfig {
  return { name, command: 'bun', args: ['--eval', STUB_SCRIPT] };
}

// ---------------------------------------------------------------------------
// Registry — no servers
// ---------------------------------------------------------------------------
describe('McpRegistry — empty state', () => {
  test('serverNames is empty by default', () => {
    const registry = new McpRegistry();
    expect(registry.serverNames).toEqual([]);
  });

  test('listAllTools() returns empty array with no servers', async () => {
    const registry = new McpRegistry();
    const tools = await registry.listAllTools();
    expect(tools).toEqual([]);
  });

  test('callTool() throws for invalid qualified name', async () => {
    const registry = new McpRegistry();
    await expect(registry.callTool('bad-name', {})).rejects.toThrow('invalid qualified tool name');
  });

  test('callTool() throws for missing server', async () => {
    const registry = new McpRegistry();
    await expect(registry.callTool('mcp:ghost:tool', {})).rejects.toThrow("no server named 'ghost'");
  });

  test('getToolSchema() returns null for unknown qualified name', async () => {
    const registry = new McpRegistry();
    const schema = await registry.getToolSchema('mcp:ghost:tool');
    expect(schema).toBeNull();
  });

  test('getToolSchema() returns null for malformed name', async () => {
    const registry = new McpRegistry();
    const schema = await registry.getToolSchema('not-mcp-format');
    expect(schema).toBeNull();
  });

  test('disconnectAll() is safe with no servers', async () => {
    const registry = new McpRegistry();
    await expect(registry.disconnectAll()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Registry — qualified name parsing
// ---------------------------------------------------------------------------
describe('McpRegistry — qualified name parsing', () => {
  test('getClient() returns undefined for unknown server', () => {
    const registry = new McpRegistry();
    expect(registry.getClient('unknown')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Registry — with a live stub server
// ---------------------------------------------------------------------------
describe('McpRegistry — with stub server', () => {
  let registry: McpRegistry;

  afterEach(async () => {
    if (registry) await registry.disconnectAll();
  });

  test('connectServer() registers a server', async () => {
    registry = new McpRegistry();
    await registry.connectServer(stubServerConfig('alpha'));
    expect(registry.serverNames).toContain('alpha');
  });

  test('getClient() returns the McpClient after connecting', async () => {
    registry = new McpRegistry();
    await registry.connectServer(stubServerConfig('beta'));
    const client = registry.getClient('beta');
    expect(client).toBeDefined();
    expect(client!.isConnected).toBe(true);
  });

  test('listAllTools() returns tools with qualified names', async () => {
    registry = new McpRegistry();
    await registry.connectServer(stubServerConfig('myserver'));
    const tools = await registry.listAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].qualifiedName).toBe('mcp:myserver:greet');
    expect(tools[0].serverName).toBe('myserver');
    expect(tools[0].toolName).toBe('greet');
    expect(tools[0].description).toBe('Greet someone');
  });

  test('listAllTools() aggregates tools from multiple servers', async () => {
    registry = new McpRegistry();
    await registry.connectServer(stubServerConfig('srv-a'));
    await registry.connectServer(stubServerConfig('srv-b'));
    const tools = await registry.listAllTools();
    const names = tools.map((t) => t.qualifiedName);
    expect(names).toContain('mcp:srv-a:greet');
    expect(names).toContain('mcp:srv-b:greet');
  });

  test('getToolSchema() returns full schema for a registered tool', async () => {
    registry = new McpRegistry();
    await registry.connectServer(stubServerConfig('schema-srv'));
    const schema = await registry.getToolSchema('mcp:schema-srv:greet');
    expect(schema).not.toBeNull();
    expect(schema!.name).toBe('greet');
    expect(schema!.inputSchema).toBeDefined();
  });

  test('callTool() executes a tool by qualified name', async () => {
    registry = new McpRegistry();
    await registry.connectServer(stubServerConfig('call-srv'));
    const result = await registry.callTool('mcp:call-srv:greet', { name: 'Alice' });
    expect(result).toBeDefined();
  });

  test('connectServer() is idempotent (skips duplicate name)', async () => {
    registry = new McpRegistry();
    await registry.connectServer(stubServerConfig('dup-srv'));
    await registry.connectServer(stubServerConfig('dup-srv')); // second call should be no-op
    expect(registry.serverNames.filter((n) => n === 'dup-srv')).toHaveLength(1);
  });

  test('disconnectAll() removes all clients', async () => {
    registry = new McpRegistry();
    await registry.connectServer(stubServerConfig('x'));
    await registry.connectServer(stubServerConfig('y'));
    await registry.disconnectAll();
    expect(registry.serverNames).toHaveLength(0);
    registry = new McpRegistry(); // avoid double-disconnect in afterEach
  });
});

// ---------------------------------------------------------------------------
// Registry — connectAll from config file
// ---------------------------------------------------------------------------
describe('McpRegistry — connectAll from file', () => {
  let tmpDir: string;
  let registry: McpRegistry;

  afterEach(async () => {
    if (registry) await registry.disconnectAll();
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('connectAll() with empty config connects nothing', async () => {
    tmpDir = join(tmpdir(), `mcp-reg-${Date.now()}`);
    mkdirSync(join(tmpDir, '.goodvibes'), { recursive: true });
    writeFileSync(join(tmpDir, '.goodvibes', 'mcp.json'), JSON.stringify({ servers: [] }));
    registry = new McpRegistry();
    await registry.connectAll(tmpDir);
    expect(registry.serverNames).toHaveLength(0);
  });

  test('connectAll() with missing config file connects nothing', async () => {
    tmpDir = join(tmpdir(), `mcp-reg-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    registry = new McpRegistry();
    await registry.connectAll(tmpDir);
    expect(registry.serverNames).toHaveLength(0);
  });
});
