import { describe, expect, test } from 'bun:test';
import { McpPanel } from '../../panels/mcp-panel.ts';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

function makeRegistry(entries: Array<{
  name: string;
  connected: boolean;
  role: 'general' | 'docs' | 'filesystem' | 'git' | 'database' | 'browser' | 'automation' | 'ops' | 'remote';
  trustMode: 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked';
  allowedPaths: string[];
  allowedHosts: string[];
  schemaFreshness: 'fresh' | 'stale' | 'unknown' | 'fetch_failed' | 'quarantined';
  quarantineReason?: string;
  quarantineDetail?: string;
  quarantineApprovedBy?: string;
}>, decisions: Array<{
  serverName: string;
  toolName: string;
  verdict: 'allow' | 'ask' | 'deny';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  capability: 'metadata' | 'read_fs' | 'write_fs' | 'exec' | 'network_read' | 'network_write' | 'secret_read' | 'spawn_agent' | 'config_mutation' | 'system_mutation' | 'generic';
  incoherent: boolean;
  reason: string;
  profileMode: 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked';
  evaluatedAt: number;
}> = []) {
  return {
    listServerSecurity: () => entries,
    listRecentSecurityDecisions: () => decisions,
    listServerSandboxBindings: () => entries.map((entry) => ({
      name: entry.name,
      sessionId: `sandbox-${entry.name}`,
      profileId: entry.role === 'ops' ? 'mcp-per-server' : 'mcp-shared',
      state: entry.connected ? 'running' : 'planned',
      backend: 'local',
      startupStatus: entry.connected ? 'verified' : 'planned',
    })),
  } as const;
}

describe('McpPanel', () => {
  test('renders empty guidance when no servers exist', () => {
    const panel = new McpPanel(makeRegistry([]) as never);
    const text = linesText(panel.render(100, 12));
    expect(text).toContain('No MCP servers configured or connected');
  });

  test('renders trust and scope details for selected server', () => {
    const panel = new McpPanel(makeRegistry([
      {
        name: 'docs-server',
        connected: true,
        role: 'docs',
        trustMode: 'constrained',
        allowedPaths: [],
        allowedHosts: ['docs.example.com'],
        schemaFreshness: 'fresh',
      },
      {
        name: 'ops-server',
        connected: false,
        role: 'ops',
        trustMode: 'allow-all',
        allowedPaths: ['/workspace'],
        allowedHosts: [],
        schemaFreshness: 'quarantined',
        quarantineReason: 'operator_flagged',
        quarantineDetail: 'unexpected deploy surface',
        quarantineApprovedBy: 'alice',
      },
    ], [
      {
        serverName: 'docs-server',
        toolName: 'search_docs',
        verdict: 'allow',
        riskLevel: 'medium',
        capability: 'read_fs',
        incoherent: false,
        reason: 'ok',
        profileMode: 'constrained',
        evaluatedAt: Date.now(),
      },
      {
        serverName: 'ops-server',
        toolName: 'exec_shell',
        verdict: 'deny',
        riskLevel: 'critical',
        capability: 'exec',
        incoherent: true,
        reason: 'incoherent',
        profileMode: 'ask-on-risk',
        evaluatedAt: Date.now(),
      },
    ]) as never);

    const first = linesText(panel.render(120, 20));
    expect(first).toContain('MCP Control Room');
    expect(first).toContain('docs-server');
    expect(first).toContain('constrained');
    expect(first).toContain('docs.example.com');
    expect(first).toContain('fresh');
    expect(first).toContain('Posture');

    panel.handleInput('down');
    const second = linesText(panel.render(120, 20));
    expect(second).toContain('ops-server');
    expect(second).toContain('allow-all');
    expect(second).toContain('quarantined');
    expect(second).toContain('operator_flagged');
    expect(second).toContain('alice');
    expect(second).toContain('/workspace');
    expect(second).toContain('sandbox-ops-server');
  });
});
