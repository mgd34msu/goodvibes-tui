/**
 * McpClient unit tests.
 *
 * Strategy: Tests that don't require a live process test buffer parsing and
 * instance behavior directly. Tests requiring a process use a minimal echo-style
 * MCP stub server embedded via bun's inline script capabilities.
 */
import { describe, test, expect } from 'bun:test';
import { McpClient } from '../../mcp/client.ts';
import type { McpServerConfig } from '../../mcp/config.ts';

// ---------------------------------------------------------------------------
// Helper: build a minimal server config for tests
// ---------------------------------------------------------------------------
function makeConfig(overrides?: Partial<McpServerConfig>): McpServerConfig {
  return {
    name: 'test-server',
    command: 'node',
    args: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// McpClient — instance state tests (no process needed)
// ---------------------------------------------------------------------------
describe('McpClient — instance behavior', () => {
  test('isConnected returns false before connect()', () => {
    const client = new McpClient(makeConfig());
    expect(client.isConnected).toBe(false);
  });

  test('name reflects config server name', () => {
    const client = new McpClient(makeConfig({ name: 'my-mcp' }));
    expect(client.name).toBe('my-mcp');
  });

  test('disconnect() is safe to call when not connected', async () => {
    const client = new McpClient(makeConfig());
    // Should not throw
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  test('listTools() throws when not connected', async () => {
    const client = new McpClient(makeConfig());
    await expect(client.listTools()).rejects.toThrow('not connected');
  });

  test('callTool() throws when not connected', async () => {
    const client = new McpClient(makeConfig());
    await expect(client.callTool('my-tool', {})).rejects.toThrow('not connected');
  });

  test('getToolSchema() throws when not connected', async () => {
    const client = new McpClient(makeConfig());
    await expect(client.getToolSchema('my-tool')).rejects.toThrow('not connected');
  });

  test('ping() returns false when not connected', async () => {
    const client = new McpClient(makeConfig());
    expect(await client.ping()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// McpClient — process lifecycle with a stub MCP server
// ---------------------------------------------------------------------------
describe('McpClient — with stub MCP server', () => {
  // Minimal stub server: responds to initialize and tools/list JSON-RPC calls.
  // Written as an inline Bun script.
  const stubScript = /* js */ `
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
      { name: 'say-hello', description: 'Say hello', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
      { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
    ]}}) + '\\n');
  } else if (msg.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n');
  } else if (msg.method === 'ping') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\\n');
  } else if (msg.method === 'notifications/initialized') {
    // Notification: no response
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
  }
});
`;

  function makeStubConfig(): McpServerConfig {
    return {
      name: 'stub',
      command: 'bun',
      args: ['--eval', stubScript],
    };
  }

  test('connect() succeeds and isConnected returns true', async () => {
    const client = new McpClient(makeStubConfig(), { timeout: 5000 });
    try {
      await client.connect();
      expect(client.isConnected).toBe(true);
    } finally {
      await client.disconnect();
    }
  });

  test('listTools() returns tool names and descriptions', async () => {
    const client = new McpClient(makeStubConfig(), { timeout: 5000 });
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('say-hello');
      expect(tools[0].description).toBe('Say hello');
      expect(tools[1].name).toBe('add');
    } finally {
      await client.disconnect();
    }
  });

  test('listTools() caches result on second call', async () => {
    const client = new McpClient(makeStubConfig(), { timeout: 5000 });
    try {
      await client.connect();
      const first = await client.listTools();
      const second = await client.listTools();
      // Same array reference (cached)
      expect(first).toBe(second);
    } finally {
      await client.disconnect();
    }
  });

  test('getToolSchema() returns full schema with inputSchema', async () => {
    const client = new McpClient(makeStubConfig(), { timeout: 5000 });
    try {
      await client.connect();
      const schema = await client.getToolSchema('say-hello');
      expect(schema).not.toBeNull();
      expect(schema!.name).toBe('say-hello');
      expect(schema!.inputSchema).toBeDefined();
      expect((schema!.inputSchema as { type: string }).type).toBe('object');
    } finally {
      await client.disconnect();
    }
  });

  test('getToolSchema() returns null for unknown tool', async () => {
    const client = new McpClient(makeStubConfig(), { timeout: 5000 });
    try {
      await client.connect();
      const schema = await client.getToolSchema('nonexistent-tool');
      expect(schema).toBeNull();
    } finally {
      await client.disconnect();
    }
  });

  test('callTool() sends tools/call and returns result', async () => {
    const client = new McpClient(makeStubConfig(), { timeout: 5000 });
    try {
      await client.connect();
      const result = await client.callTool('say-hello', { name: 'World' });
      expect(result).toBeDefined();
    } finally {
      await client.disconnect();
    }
  });

  test('ping() returns true when server is running', async () => {
    const client = new McpClient(makeStubConfig(), { timeout: 5000 });
    try {
      await client.connect();
      expect(await client.ping()).toBe(true);
    } finally {
      await client.disconnect();
    }
  });

  test('disconnect() sets isConnected to false', async () => {
    const client = new McpClient(makeStubConfig(), { timeout: 5000 });
    await client.connect();
    expect(client.isConnected).toBe(true);
    await client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  test('connect() is idempotent when already connected', async () => {
    const client = new McpClient(makeStubConfig(), { timeout: 5000 });
    try {
      await client.connect();
      // Second connect should be a no-op
      await client.connect();
      expect(client.isConnected).toBe(true);
    } finally {
      await client.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// McpClient — error responses
// ---------------------------------------------------------------------------
describe('McpClient — error handling', () => {
  const errorScript = /* js */ `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  const id = msg.id;
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\\n');
  } else if (msg.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Tool execution failed' } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }) + '\\n');
  } else if (msg.method === 'notifications/initialized') {
    // no-op
  }
});
`;

  test('callTool() rejects when server returns JSON-RPC error', async () => {
    const client = new McpClient(
      { name: 'err-server', command: 'bun', args: ['--eval', errorScript] },
      { timeout: 5000 },
    );
    try {
      await client.connect();
      await expect(client.callTool('broken-tool', {})).rejects.toThrow('Tool execution failed');
    } finally {
      await client.disconnect();
    }
  });
});
