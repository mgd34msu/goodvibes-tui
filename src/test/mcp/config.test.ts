import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { loadMcpConfig } from '@pellux/goodvibes-sdk/platform/mcp/config';

describe('loadMcpConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mcp-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, '.goodvibes'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns empty config when mcp.json does not exist', () => {
    const cfg = loadMcpConfig({ workingDirectory: tmpDir, homeDirectory: tmpDir });
    expect(cfg.servers).toEqual([]);
  });

  test('parses valid mcp.json with single server', () => {
    const data = {
      servers: [{ name: 'my-server', command: 'node', args: ['server.js'] }],
    };
    writeFileSync(join(tmpDir, '.goodvibes', 'mcp.json'), JSON.stringify(data));
    const cfg = loadMcpConfig({ workingDirectory: tmpDir, homeDirectory: tmpDir });
    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0].name).toBe('my-server');
    expect(cfg.servers[0].command).toBe('node');
    expect(cfg.servers[0].args).toEqual(['server.js']);
  });

  test('parses server with env vars', () => {
    const data = {
      servers: [{ name: 'env-server', command: 'python', args: ['-m', 'server'], env: { FOO: 'bar' } }],
    };
    writeFileSync(join(tmpDir, '.goodvibes', 'mcp.json'), JSON.stringify(data));
    const cfg = loadMcpConfig({ workingDirectory: tmpDir, homeDirectory: tmpDir });
    expect(cfg.servers[0].env).toEqual({ FOO: 'bar' });
  });

  test('parses multiple servers', () => {
    const data = {
      servers: [
        { name: 'server-a', command: 'node', args: ['a.js'] },
        { name: 'server-b', command: 'python', args: ['b.py'] },
      ],
    };
    writeFileSync(join(tmpDir, '.goodvibes', 'mcp.json'), JSON.stringify(data));
    const cfg = loadMcpConfig({ workingDirectory: tmpDir, homeDirectory: tmpDir });
    expect(cfg.servers).toHaveLength(2);
    expect(cfg.servers[0].name).toBe('server-a');
    expect(cfg.servers[1].name).toBe('server-b');
  });

  test('returns empty config when mcp.json is malformed JSON', () => {
    writeFileSync(join(tmpDir, '.goodvibes', 'mcp.json'), '{invalid json}');
    const cfg = loadMcpConfig({ workingDirectory: tmpDir, homeDirectory: tmpDir });
    expect(cfg.servers).toEqual([]);
  });

  test('returns empty config when servers array is missing', () => {
    writeFileSync(join(tmpDir, '.goodvibes', 'mcp.json'), JSON.stringify({ foo: 'bar' }));
    const cfg = loadMcpConfig({ workingDirectory: tmpDir, homeDirectory: tmpDir });
    expect(cfg.servers).toEqual([]);
  });

  test('returns empty config when a server entry has no name', () => {
    const data = { servers: [{ command: 'node' }] };
    writeFileSync(join(tmpDir, '.goodvibes', 'mcp.json'), JSON.stringify(data));
    const cfg = loadMcpConfig({ workingDirectory: tmpDir, homeDirectory: tmpDir });
    expect(cfg.servers).toEqual([]);
  });

  test('returns empty config when a server entry has no command', () => {
    const data = { servers: [{ name: 'x' }] };
    writeFileSync(join(tmpDir, '.goodvibes', 'mcp.json'), JSON.stringify(data));
    const cfg = loadMcpConfig({ workingDirectory: tmpDir, homeDirectory: tmpDir });
    expect(cfg.servers).toEqual([]);
  });

  test('args defaults to undefined when not provided', () => {
    const data = { servers: [{ name: 'minimal', command: 'echo' }] };
    writeFileSync(join(tmpDir, '.goodvibes', 'mcp.json'), JSON.stringify(data));
    const cfg = loadMcpConfig({ workingDirectory: tmpDir, homeDirectory: tmpDir });
    expect(cfg.servers[0].args).toBeUndefined();
  });
});
