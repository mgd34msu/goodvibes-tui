import { describe, expect, test } from 'bun:test';
import { McpLifecycleManager } from '../../../runtime/mcp/manager.ts';

describe('McpLifecycleManager trust profiles', () => {
  test('can update and inspect trust profiles for registered servers', async () => {
    const manager = new McpLifecycleManager();
    await manager.startServer({
      name: 'test-server',
      command: 'does-not-matter',
      role: 'docs',
      trustMode: 'constrained',
      allowedHosts: ['docs.example.com'],
    } as never);

    const profile = manager.listTrustProfiles().find((entry) => entry.serverName === 'test-server');
    expect(profile).toBeDefined();
    expect(profile?.role).toBe('docs');
    expect(profile?.mode).toBe('constrained');

    manager.setTrustMode('test-server', 'allow-all');
    manager.setServerRole('test-server', 'ops');

    const updated = manager.getServerPermissions('test-server');
    expect(updated?.profile.mode).toBe('allow-all');
    expect(updated?.profile.role).toBe('ops');
  });
});
