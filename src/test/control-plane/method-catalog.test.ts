import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../../control-plane/index.ts';
import { buildOperatorContract } from '../../control-plane/operator-contract.ts';

function schemaProperty(schema: unknown, ...path: string[]): unknown {
  let current: unknown = schema;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    const properties = record.properties as Record<string, unknown> | undefined;
    const items = record.items as Record<string, unknown> | undefined;
    const itemProperties = items?.properties as Record<string, unknown> | undefined;
    current = properties?.[segment] ?? itemProperties?.[segment] ?? record[segment];
  }
  return current;
}

describe('GatewayMethodCatalog', () => {
  test('lists built-in gateway methods', () => {
    const catalog = new GatewayMethodCatalog();
    const methods = catalog.list();

    expect(methods.some((method) => method.id === 'control.snapshot')).toBe(true);
    expect(methods.some((method) => method.id === 'control.auth.current')).toBe(true);
    expect(methods.some((method) => method.id === 'automation.heartbeat.run')).toBe(true);
    expect(methods.some((method) => method.id === 'telemetry.snapshot')).toBe(true);
    expect(methods.some((method) => method.id === 'telemetry.stream')).toBe(true);
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
    expect(catalog.findByHttpBinding('GET', '/api/control-plane/whoami')?.id).toBe('control.auth.current');
    expect(catalog.findByHttpBinding('GET', '/api/telemetry')?.id).toBe('telemetry.snapshot');
    expect(catalog.findByHttpBinding('GET', '/api/v1/telemetry/events')?.id).toBe('telemetry.events.list');
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

  test('exposes structured operator contract payloads instead of generic objects', () => {
    const catalog = new GatewayMethodCatalog();
    const contract = buildOperatorContract(catalog);

    expect(contract.product.id).toBe('goodvibes');
    expect(contract.operator.methods).toHaveLength(catalog.list().length);
    expect(contract.operator.events).toHaveLength(catalog.listEvents().length);
    expect(contract.operator.schemaCoverage.methods).toBe(catalog.list().length);

    expect(schemaProperty(catalog.get('control.contract')?.outputSchema, 'contract', 'product', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('control.contract')?.outputSchema, 'contract', 'auth', 'current', 'path')).toBeDefined();
    expect(schemaProperty(catalog.get('control.contract')?.outputSchema, 'contract', 'operator', 'methods', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('control.contract')?.outputSchema, 'contract', 'operator', 'events', 'id')).toBeDefined();

    expect(schemaProperty(catalog.get('control.auth.current')?.outputSchema, 'principalId')).toBeDefined();
    expect(schemaProperty(catalog.get('control.methods.list')?.outputSchema, 'methods', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('control.methods.get')?.outputSchema, 'method', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('control.events.catalog')?.outputSchema, 'events', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('control.messages.list')?.outputSchema, 'messages', 'attachments', 'artifactId')).toBeDefined();
    expect(schemaProperty(catalog.get('control.clients.list')?.outputSchema, 'clients', 'surface')).toBeDefined();
    expect(schemaProperty(catalog.get('telemetry.snapshot')?.outputSchema, 'capabilities', 'signals', 'events')).toBeDefined();
    expect(schemaProperty(catalog.get('telemetry.events.list')?.outputSchema, 'items', 'traceId')).toBeDefined();
    expect(schemaProperty(catalog.get('telemetry.traces.list')?.outputSchema, 'items', 'spanContext', 'traceId')).toBeDefined();
    expect(schemaProperty(catalog.get('telemetry.metrics.get')?.outputSchema, 'aggregates', 'totalEvents')).toBeDefined();

    expect(schemaProperty(catalog.get('panels.list')?.outputSchema, 'panels', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('surfaces.list')?.outputSchema, 'surfaces', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('routes.bindings.list')?.outputSchema, 'bindings', 'id')).toBeDefined();

    expect(schemaProperty(catalog.get('channels.status')?.outputSchema, 'channels', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('channels.capabilities.list')?.outputSchema, 'capabilities', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('channels.tools.list')?.outputSchema, 'tools', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('channels.actions.list')?.outputSchema, 'actions', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('channels.repairs.list')?.outputSchema, 'actions', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('channels.policies.list')?.outputSchema, 'policies', 'surface')).toBeDefined();
    expect(schemaProperty(catalog.get('channels.policies.audit')?.outputSchema, 'audit', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('channels.directory.query')?.outputSchema, 'entries', 'id')).toBeDefined();

    expect(schemaProperty(catalog.get('voice.providers.list')?.outputSchema, 'providers', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('voice.voices.list')?.outputSchema, 'voices', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('web_search.providers.list')?.outputSchema, 'providers', 'id')).toBeDefined();
    expect(schemaProperty(catalog.get('media.providers.list')?.outputSchema, 'providers', 'id')).toBeDefined();
  });
});
