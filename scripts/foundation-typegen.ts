import type {
  OperatorContractManifest,
  OperatorEventContract,
  OperatorMethodContract,
  PeerContractManifest,
  PeerEndpointContract,
  RuntimeEventDomain,
} from '../src/types/foundation-contract.ts';

type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function renderKey(value: string): string {
  return isIdentifier(value) ? value : JSON.stringify(value);
}

function wrapArrayItem(type: string): string {
  return /[|&{} ]/.test(type) ? `(${type})` : type;
}

function joinUnion(parts: readonly string[]): string {
  return [...new Set(parts.filter((part) => part && part !== 'never'))].sort().join(' | ') || 'unknown';
}

function renderEnum(schema: JsonSchema): string | null {
  const values = Array.isArray(schema.enum) ? schema.enum : null;
  if (!values || values.length === 0) return null;
  return joinUnion(values.map((value) => JSON.stringify(value)));
}

function renderObjectType(schema: JsonSchema, stack: readonly object[]): string {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : []);
  const propEntries = Object.entries(properties).map(([key, value]) => (
    `${renderKey(key)}${required.has(key) ? '' : '?'}: ${renderSchemaType(value as JsonSchema, [...stack, schema])};`
  ));
  const base = `{ ${propEntries.join(' ')} }`;
  if (!('additionalProperties' in schema) || schema.additionalProperties === false) {
    return base;
  }
  if (schema.additionalProperties === true) {
    return `(${base} & { readonly [key: string]: unknown })`;
  }
  if (isRecord(schema.additionalProperties)) {
    return `(${base} & { readonly [key: string]: ${renderSchemaType(schema.additionalProperties, [...stack, schema])} })`;
  }
  return base;
}

function renderSchemaType(schema: JsonSchema | undefined, stack: readonly object[] = []): string {
  if (!schema) return 'undefined';
  if (stack.includes(schema)) return 'JsonValue';
  if ('$ref' in schema) return 'JsonValue';

  const enumType = renderEnum(schema);
  if (enumType) return enumType;

  if (Array.isArray(schema.anyOf)) {
    return joinUnion(schema.anyOf.map((entry) => renderSchemaType(entry as JsonSchema, [...stack, schema])));
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    return joinUnion(type.map((entry) => renderSchemaType({ ...schema, type: entry } as JsonSchema, [...stack, schema])));
  }
  if (type === 'string') return 'string';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'null') return 'null';
  if (type === 'array') {
    return `readonly ${wrapArrayItem(renderSchemaType(isRecord(schema.items) ? schema.items : undefined, [...stack, schema]))}[]`;
  }
  if (type === 'object' || 'properties' in schema || 'additionalProperties' in schema) {
    return renderObjectType(schema, stack);
  }
  return 'unknown';
}

function renderMethodMap(
  methods: readonly OperatorMethodContract[],
  key: 'inputSchema' | 'outputSchema',
  name: string,
): string {
  const lines = methods
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((method) => `  ${JSON.stringify(method.id)}: ${renderSchemaType((method[key] as JsonSchema | undefined) ?? undefined)};`);
  return `export interface ${name} {\n${lines.join('\n')}\n}\n`;
}

function renderPeerMap(
  endpoints: readonly PeerEndpointContract[],
  key: 'inputSchema' | 'outputSchema',
  name: string,
): string {
  const lines = endpoints
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((endpoint) => `  ${JSON.stringify(endpoint.id)}: ${renderSchemaType((endpoint[key] as JsonSchema | undefined) ?? undefined)};`);
  return `export interface ${name} {\n${lines.join('\n')}\n}\n`;
}

function eventSchema(event: OperatorEventContract): JsonSchema | undefined {
  return (event.payloadSchema as JsonSchema | undefined) ?? (event.outputSchema as JsonSchema | undefined);
}

function renderEventPayloadMap(events: readonly OperatorEventContract[]): string {
  const lines = events
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((event) => `  ${JSON.stringify(event.id)}: ${renderSchemaType(eventSchema(event))};`);
  return `export interface OperatorEventPayloadMap {\n${lines.join('\n')}\n}\n`;
}

function renderRuntimeDomainEventMap(events: readonly OperatorEventContract[]): string {
  const byDomain = new Map<RuntimeEventDomain, Map<string, string[]>>();
  for (const event of events) {
    const payloadType = renderSchemaType(eventSchema(event));
    for (const domain of event.domains ?? []) {
      const eventMap = byDomain.get(domain) ?? new Map<string, string[]>();
      const eventNames = event.wireEvents && event.wireEvents.length > 0 ? event.wireEvents : [event.id];
      for (const eventName of eventNames) {
        const payloads = eventMap.get(eventName) ?? [];
        payloads.push(payloadType);
        eventMap.set(eventName, payloads);
      }
      byDomain.set(domain, eventMap);
    }
  }

  const domainBlocks = [...byDomain.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([domain, eventMap]) => {
      const eventLines = [...eventMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([eventName, payloads]) => `    ${JSON.stringify(eventName)}: ${joinUnion(payloads)};`);
      return `  ${JSON.stringify(domain)}: {\n${eventLines.join('\n')}\n  };`;
    });

  return `export interface RuntimeDomainEventPayloadMap {\n${domainBlocks.join('\n')}\n}\n`;
}

export function renderFoundationClientTypes(
  operatorContract: OperatorContractManifest,
  peerContract: PeerContractManifest,
): string {
  const methodInputs = renderMethodMap(operatorContract.operator.methods, 'inputSchema', 'OperatorMethodInputMap');
  const methodOutputs = renderMethodMap(operatorContract.operator.methods, 'outputSchema', 'OperatorMethodOutputMap');
  const eventPayloads = renderEventPayloadMap(operatorContract.operator.events);
  const domainEventPayloads = renderRuntimeDomainEventMap(operatorContract.operator.events);
  const peerInputs = renderPeerMap(peerContract.endpoints, 'inputSchema', 'PeerEndpointInputMap');
  const peerOutputs = renderPeerMap(peerContract.endpoints, 'outputSchema', 'PeerEndpointOutputMap');

  return [
    '// Generated by scripts/export-foundation-artifacts.ts. Do not edit manually.',
    '',
    'export type JsonPrimitive = string | number | boolean | null;',
    'export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];',
    '',
    methodInputs.trimEnd(),
    '',
    methodOutputs.trimEnd(),
    '',
    eventPayloads.trimEnd(),
    '',
    domainEventPayloads.trimEnd(),
    '',
    peerInputs.trimEnd(),
    '',
    peerOutputs.trimEnd(),
    '',
    'export type OperatorTypedMethodId = keyof OperatorMethodInputMap & string;',
    'export type OperatorMethodInput<TMethodId extends OperatorTypedMethodId> = OperatorMethodInputMap[TMethodId];',
    'export type OperatorMethodOutput<TMethodId extends OperatorTypedMethodId> = OperatorMethodOutputMap[TMethodId];',
    'export type OperatorTypedEventId = keyof OperatorEventPayloadMap & string;',
    'export type OperatorEventPayload<TEventId extends OperatorTypedEventId> = OperatorEventPayloadMap[TEventId];',
    "export type OperatorStreamMethodId = Extract<OperatorTypedMethodId, 'control.events.stream' | 'telemetry.stream'>;",
    'export type PeerTypedEndpointId = keyof PeerEndpointInputMap & string;',
    'export type PeerEndpointInput<TEndpointId extends PeerTypedEndpointId> = PeerEndpointInputMap[TEndpointId];',
    'export type PeerEndpointOutput<TEndpointId extends PeerTypedEndpointId> = PeerEndpointOutputMap[TEndpointId];',
    'export type RuntimeEventTypedDomain = keyof RuntimeDomainEventPayloadMap & string;',
    'export type RuntimeDomainEventType<TDomain extends RuntimeEventTypedDomain> = keyof RuntimeDomainEventPayloadMap[TDomain] & string;',
    'export type RuntimeDomainEventPayload<TDomain extends RuntimeEventTypedDomain, TEventType extends RuntimeDomainEventType<TDomain>> = RuntimeDomainEventPayloadMap[TDomain][TEventType];',
    '',
  ].join('\n');
}
