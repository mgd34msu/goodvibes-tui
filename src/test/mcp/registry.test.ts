import { describe, test, expect, afterEach } from 'bun:test';
import { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import type { McpServerConfig } from '@pellux/goodvibes-sdk/platform/mcp';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { SandboxSessionRegistry } from '@/runtime/index.ts';
import { createHookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks';

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

const SANDBOX_WORKSPACE_ROOT = join(tmpdir(), `gv-mcp-registry-workspace-${process.pid}-${Date.now()}`);
mkdirSync(SANDBOX_WORKSPACE_ROOT, { recursive: true });
process.on('exit', () => {
  if (existsSync(SANDBOX_WORKSPACE_ROOT)) {
    rmSync(SANDBOX_WORKSPACE_ROOT, { recursive: true, force: true });
  }
});

function stubServerConfig(name: string): McpServerConfig {
  return { name, command: 'bun', args: ['--eval', STUB_SCRIPT] };
}

function createRegistry(): McpRegistry {
  return new McpRegistry({ hookDispatcher: createHookDispatcher(), sandboxSessions: new SandboxSessionRegistry(SANDBOX_WORKSPACE_ROOT) });
}

// ---------------------------------------------------------------------------
// Registry — no servers
// ---------------------------------------------------------------------------
describe('McpRegistry — empty state', () => {
  test('serverNames is empty by default', () => {
    const registry = createRegistry();
    expect(registry.serverNames).toEqual([]);
  });

  test('listAllTools() returns empty array with no servers', async () => {
    const registry = createRegistry();
    const tools = await registry.listAllTools();
    expect(tools).toEqual([]);
  });

  test('callTool() throws for invalid qualified name', async () => {
    const registry = createRegistry();
    await expect(registry.callTool('bad-name', {})).rejects.toThrow('invalid qualified tool name');
  });

  test('callTool() throws for missing server', async () => {
    const registry = createRegistry();
    await expect(registry.callTool('mcp:ghost:tool', {})).rejects.toThrow("no server named 'ghost'");
  });

  test('getToolSchema() returns null for unknown qualified name', async () => {
    const registry = createRegistry();
    const schema = await registry.getToolSchema('mcp:ghost:tool');
    expect(schema).toBeNull();
  });

  test('getToolSchema() returns null for malformed name', async () => {
    const registry = createRegistry();
    const schema = await registry.getToolSchema('not-mcp-format');
    expect(schema).toBeNull();
  });

  test('disconnectAll() is safe with no servers', async () => {
    const registry = createRegistry();
    await expect(registry.disconnectAll()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Registry — qualified name parsing
// ---------------------------------------------------------------------------
describe('McpRegistry — qualified name parsing', () => {
  test('getClient() returns undefined for unknown server', () => {
    const registry = createRegistry();
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
    registry = createRegistry();
    await registry.connectServer(stubServerConfig('alpha'));
    expect(registry.serverNames).toContain('alpha');
    expect(registry.listServerSecurity()[0]?.trustMode).toBe('ask-on-risk');
  });

  test('connectServer() can route MCP startup through the sandbox session backend', async () => {
    registry = createRegistry();
    const sandboxSessions = new SandboxSessionRegistry(SANDBOX_WORKSPACE_ROOT);
    const configManager = {
      get(key: string) {
        const values: Record<string, unknown> = {
          'sandbox.replIsolation': 'shared-vm',
          'sandbox.mcpIsolation': 'shared-vm',
          'sandbox.windowsMode': 'native-basic',
          'sandbox.vmBackend': 'local',
          'sandbox.qemuBinary': 'qemu-system-x86_64',
          'sandbox.qemuImagePath': '',
          'sandbox.qemuExecWrapper': '',
        };
        return values[key];
      },
    };
    registry.setSandboxRuntime(configManager as never, sandboxSessions);

    await registry.connectServer(stubServerConfig('sandboxed'));

    expect(registry.serverNames).toContain('sandboxed');
    const sessions = sandboxSessions.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.profileId).toBe('mcp-shared');
    expect(sessions[0]?.state).toBe('running');
  });

  test('hybrid MCP isolation uses dedicated sessions for higher-risk servers', async () => {
    registry = createRegistry();
    const sandboxSessions = new SandboxSessionRegistry(SANDBOX_WORKSPACE_ROOT);
    const configManager = {
      get(key: string) {
        const values: Record<string, unknown> = {
          'sandbox.replIsolation': 'shared-vm',
          'sandbox.mcpIsolation': 'hybrid',
          'sandbox.windowsMode': 'native-basic',
          'sandbox.vmBackend': 'local',
          'sandbox.qemuBinary': 'qemu-system-x86_64',
          'sandbox.qemuImagePath': '',
          'sandbox.qemuExecWrapper': '',
        };
        return values[key];
      },
    };
    registry.setSandboxRuntime(configManager as never, sandboxSessions);

    await registry.connectServer({
      ...stubServerConfig('hybrid-risky'),
      role: 'ops',
      allowedHosts: ['api.example.com'],
    });

    const sessions = sandboxSessions.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.profileId).toBe('mcp-per-server');
  });

  test('getClient() returns the McpClient after connecting', async () => {
    registry = createRegistry();
    await registry.connectServer(stubServerConfig('beta'));
    const client = registry.getClient('beta');
    expect(client).toBeDefined();
    expect(client!.isConnected).toBe(true);
  });

  test('listAllTools() returns tools with qualified names', async () => {
    registry = createRegistry();
    await registry.connectServer(stubServerConfig('myserver'));
    const tools = await registry.listAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].qualifiedName).toBe('mcp:myserver:greet');
    expect(tools[0].serverName).toBe('myserver');
    expect(tools[0].toolName).toBe('greet');
    expect(tools[0].description).toBe('Greet someone');
  });

  test('listAllTools() aggregates tools from multiple servers', async () => {
    registry = createRegistry();
    await registry.connectServer(stubServerConfig('srv-a'));
    await registry.connectServer(stubServerConfig('srv-b'));
    const tools = await registry.listAllTools();
    const names = tools.map((t) => t.qualifiedName);
    expect(names).toContain('mcp:srv-a:greet');
    expect(names).toContain('mcp:srv-b:greet');
  });

  test('getToolSchema() returns full schema for a registered tool', async () => {
    registry = createRegistry();
    await registry.connectServer(stubServerConfig('schema-srv'));
    const schema = await registry.getToolSchema('mcp:schema-srv:greet');
    expect(schema).not.toBeNull();
    expect(schema!.name).toBe('greet');
    expect(schema!.inputSchema).toBeDefined();
  });

  test('callTool() executes a tool by qualified name', async () => {
    registry = createRegistry();
    await registry.connectServer(stubServerConfig('call-srv'));
    const result = await registry.callTool('mcp:call-srv:greet', { name: 'Alice' });
    expect(result).toBeDefined();
  });

  test('callTool() denies when server trust mode is blocked', async () => {
    registry = createRegistry();
    await registry.connectServer(stubServerConfig('blocked-srv'));
    registry.setServerTrustMode('blocked-srv', 'blocked');
    await expect(registry.callTool('mcp:blocked-srv:greet', {})).rejects.toThrow('denied');
  });

  test('quarantineSchema() blocks calls until an operator approves an override', async () => {
    registry = createRegistry();
    await registry.connectServer(stubServerConfig('quarantine-srv'));
    registry.quarantineSchema('quarantine-srv', 'operator_flagged', 'unexpected deploy surface');
    expect(registry.listServerSecurity()[0]?.schemaFreshness).toBe('quarantined');
    await expect(registry.callTool('mcp:quarantine-srv:greet', {})).rejects.toThrow('schema quarantined');

    registry.approveSchemaQuarantine('quarantine-srv', 'alice');
    const security = registry.listServerSecurity()[0];
    expect(security?.schemaFreshness).toBe('stale');
    expect(security?.quarantineApprovedBy).toBe('alice');
    await expect(registry.callTool('mcp:quarantine-srv:greet', {})).resolves.toBeDefined();
  });

  test('connectServer() is idempotent (skips duplicate name)', async () => {
    registry = createRegistry();
    await registry.connectServer(stubServerConfig('dup-srv'));
    await registry.connectServer(stubServerConfig('dup-srv')); // second call should be no-op
    expect(registry.serverNames.filter((n) => n === 'dup-srv')).toHaveLength(1);
  });

  test('disconnectAll() removes all clients', async () => {
    registry = createRegistry();
    await registry.connectServer(stubServerConfig('x'));
    await registry.connectServer(stubServerConfig('y'));
    await registry.disconnectAll();
    expect(registry.serverNames).toHaveLength(0);
    registry = createRegistry(); // avoid double-disconnect in afterEach
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
    registry = createRegistry();
    await registry.connectAll({ workingDirectory: tmpDir, homeDirectory: tmpDir });
    expect(registry.serverNames).toHaveLength(0);
  });

  test('connectAll() with missing config file connects nothing', async () => {
    tmpDir = join(tmpdir(), `mcp-reg-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    registry = createRegistry();
    await registry.connectAll({ workingDirectory: tmpDir, homeDirectory: tmpDir });
    expect(registry.serverNames).toHaveLength(0);
  });
});
