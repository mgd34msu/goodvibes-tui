import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../../control-plane/index.ts';

describe('GatewayMethodCatalog', () => {
  test('lists built-in gateway methods', () => {
    const catalog = new GatewayMethodCatalog();
    const methods = catalog.list();

    expect(methods.some((method) => method.id === 'control.snapshot')).toBe(true);
    expect(methods.some((method) => method.id === 'automation.heartbeat.run')).toBe(true);
    expect(methods.some((method) => method.id === 'remote.node_host.contract')).toBe(true);
    expect(methods.some((method) => method.id === 'control.events.catalog')).toBe(true);
    expect(methods.some((method) => method.id === 'local_auth.status')).toBe(true);
    expect(methods.some((method) => method.id === 'providers.list')).toBe(true);
    expect(methods.some((method) => method.id === 'providers.usage.get')).toBe(true);
    expect(methods.some((method) => method.id === 'knowledge.status')).toBe(true);
    expect(methods.some((method) => method.id === 'knowledge.packet')).toBe(true);
    expect(methods.some((method) => method.id === 'knowledge.connectors.list')).toBe(true);
    expect(methods.some((method) => method.id === 'knowledge.connector.doctor')).toBe(true);
    expect(methods.some((method) => method.id === 'knowledge.extractions.list')).toBe(true);
    expect(methods.some((method) => method.id === 'knowledge.usage.list')).toBe(true);
    expect(methods.some((method) => method.id === 'knowledge.candidates.list')).toBe(true);
    expect(methods.some((method) => method.id === 'knowledge.schedules.list')).toBe(true);
    expect(methods.some((method) => method.id === 'knowledge.job.run')).toBe(true);
    expect(methods.some((method) => method.id === 'knowledge.projection.materialize')).toBe(true);
    expect(methods.some((method) => method.id === 'knowledge.graphql.execute')).toBe(true);
    expect(methods.some((method) => method.id === 'multimodal.analyze')).toBe(true);
    expect(methods.some((method) => method.id === 'multimodal.writeback')).toBe(true);
  });

  test('lists built-in gateway events and matches HTTP route templates', () => {
    const catalog = new GatewayMethodCatalog();
    const events = catalog.listEvents();

    expect(events.some((event) => event.id === 'runtime.automation')).toBe(true);
    expect(events.some((event) => event.id === 'runtime.knowledge')).toBe(true);
    expect(events.some((event) => event.id === 'control.ready')).toBe(true);

    expect(catalog.findByHttpBinding('GET', '/api/control-plane/methods/control.status')?.id).toBe('control.methods.get');
    expect(catalog.findByHttpBinding('GET', '/api/artifacts/art-123/content')?.id).toBe('artifacts.content.get');
    expect(catalog.findByHttpBinding('GET', '/api/remote/device/contract')?.id).toBe('remote.node_host.contract');
    expect(catalog.findByHttpBinding('GET', '/api/channels/setup/telegram')?.id).toBe('channels.setup.get');
    expect(catalog.findByHttpBinding('POST', '/api/channels/allowlist/signal/edit')?.id).toBe('channels.allowlist.edit');
    expect(catalog.findByHttpBinding('GET', '/api/providers/openai')?.id).toBe('providers.get');
    expect(catalog.findByHttpBinding('GET', '/api/providers/openai/usage')?.id).toBe('providers.usage.get');
    expect(catalog.findByHttpBinding('GET', '/api/knowledge/items/source-123')?.id).toBe('knowledge.item.get');
    expect(catalog.findByHttpBinding('POST', '/api/knowledge/packet')?.id).toBe('knowledge.packet');
    expect(catalog.findByHttpBinding('GET', '/api/knowledge/connectors/bookmark')?.id).toBe('knowledge.connector.get');
    expect(catalog.findByHttpBinding('GET', '/api/knowledge/connectors/bookmark/doctor')?.id).toBe('knowledge.connector.doctor');
    expect(catalog.findByHttpBinding('GET', '/api/knowledge/extractions/extract-123')?.id).toBe('knowledge.extraction.get');
    expect(catalog.findByHttpBinding('GET', '/api/knowledge/usage')?.id).toBe('knowledge.usage.list');
    expect(catalog.findByHttpBinding('GET', '/api/knowledge/candidates')?.id).toBe('knowledge.candidates.list');
    expect(catalog.findByHttpBinding('GET', '/api/knowledge/schedules')?.id).toBe('knowledge.schedules.list');
    expect(catalog.findByHttpBinding('POST', '/api/knowledge/jobs/knowledge-lint/run')?.id).toBe('knowledge.job.run');
    expect(catalog.findByHttpBinding('POST', '/api/knowledge/projections/materialize')?.id).toBe('knowledge.projection.materialize');
    expect(catalog.findByHttpBinding('POST', '/api/knowledge/graphql')?.id).toBe('knowledge.graphql.execute');
    expect(catalog.findByHttpBinding('POST', '/api/multimodal/analyze')?.id).toBe('multimodal.analyze');
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
