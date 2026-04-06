import { describe, expect, test } from 'bun:test';
import { McpPermissionManager } from '../../../runtime/mcp/permissions.ts';

describe('McpPermissionManager coherence evaluation', () => {
  test('constrained docs server denies incoherent write request', () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', 'standard', { role: 'docs', mode: 'constrained' });
    const result = manager.evaluateToolCall('docs', 'write_file', { path: '/tmp/output.md' });
    expect(result.allowed).toBe(false);
    expect(result.verdict).toBe('deny');
    expect(result.incoherent).toBe(true);
  });

  test('ask-on-risk server asks for high-risk coherent request', () => {
    const manager = new McpPermissionManager();
    manager.registerServer('fs', 'standard', { role: 'filesystem', mode: 'ask-on-risk', allowedPaths: ['/workspace'] });
    const result = manager.evaluateToolCall('fs', 'write_file', { path: '/workspace/file.txt' });
    expect(result.allowed).toBe(false);
    expect(result.verdict).toBe('ask');
    expect(result.incoherent).toBe(false);
  });

  test('allow-all bypasses coherence denial while still surfacing risk metadata', () => {
    const manager = new McpPermissionManager();
    manager.registerServer('elevated', 'trusted', { role: 'docs', mode: 'allow-all' });
    const result = manager.evaluateToolCall('elevated', 'exec_shell', { command: 'rm -rf /tmp/x' });
    expect(result.allowed).toBe(true);
    expect(result.verdict).toBe('allow');
    expect(result.profileMode).toBe('allow-all');
    expect(result.capability).toBe('exec');
  });

  test('records recent MCP decisions with risk metadata', () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', 'standard', { role: 'docs', mode: 'constrained' });
    manager.evaluateToolCall('docs', 'read_docs', { path: '/workspace/README.md' });
    manager.evaluateToolCall('docs', 'write_file', { path: '/workspace/out.md' });

    const decisions = manager.listRecentDecisions();
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.toolName).toBe('write_file');
    expect(decisions[0]?.verdict).toBe('deny');
    expect(decisions[0]?.capability).toBe('write_fs');
    expect(decisions[1]?.toolName).toBe('read_docs');
    expect(decisions[1]?.riskLevel).toBe('medium');
  });

  test('buildAttackPathReview surfaces posture and incoherent decisions', () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', 'standard', { role: 'docs', mode: 'allow-all' });
    manager.registerServer('ops', 'standard', { role: 'ops', mode: 'ask-on-risk', allowedPaths: ['/srv'] });
    manager.evaluateToolCall('docs', 'write_file', { path: '/workspace/out.md' });

    const review = manager.buildAttackPathReview([
      {
        name: 'docs',
        role: 'docs',
        trustMode: 'allow-all',
        allowedPaths: [],
        allowedHosts: ['docs.example.com'],
        schemaFreshness: 'fresh',
        connected: true,
      },
      {
        name: 'ops',
        role: 'ops',
        trustMode: 'ask-on-risk',
        allowedPaths: ['/srv'],
        allowedHosts: [],
        schemaFreshness: 'quarantined',
        quarantineReason: 'operator_flagged',
        quarantineDetail: 'unexpected deploy surface',
        connected: false,
      },
    ], manager.listRecentDecisions());

    expect(review.totalServers).toBe(2);
    expect(review.allowAllServers).toBe(1);
    expect(review.quarantinedServers).toBe(1);
    expect(review.incoherentFindings).toBeGreaterThan(0);
    expect(review.criticalFindings).toBeGreaterThan(0);
    expect(review.summary).toContain('incoherent decision');
    const opsFinding = review.findings.find((finding) => finding.serverName === 'ops');
    expect(opsFinding?.severity).toBe('critical');
    expect(review.findings.some((finding) => finding.kind === 'recent-decision' && finding.incoherent)).toBe(true);
  });
});
