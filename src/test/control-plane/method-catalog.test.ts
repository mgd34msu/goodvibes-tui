import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../../control-plane/index.ts';

describe('GatewayMethodCatalog', () => {
  test('lists built-in gateway methods', () => {
    const catalog = new GatewayMethodCatalog();
    const methods = catalog.list();

    expect(methods.some((method) => method.id === 'control.snapshot')).toBe(true);
    expect(methods.some((method) => method.id === 'automation.heartbeat')).toBe(true);
    expect(methods.some((method) => method.id === 'remote.node_host.contract')).toBe(true);
  });

  test('registers, invokes, and unregisters plugin methods', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    const unregister = catalog.register({
      id: 'plugin.test.echo',
      title: 'Echo',
      description: 'Echo test body',
      category: 'test',
      source: 'plugin',
      access: 'authenticated',
      transport: ['ws', 'internal'],
      scopes: ['test:echo'],
      pluginId: 'test',
    }, async (input) => ({ ok: true, body: input.body }));

    await expect(catalog.invoke('plugin.test.echo', {
      body: { value: 1 },
      context: { principalId: 'tester' },
    })).resolves.toEqual({ ok: true, body: { value: 1 } });

    unregister();
    expect(catalog.get('plugin.test.echo')).toBeNull();
  });
});
