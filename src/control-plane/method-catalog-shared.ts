import type { RuntimeEventDomain } from '../runtime/events/index.ts';

export type GatewayMethodTransport = 'http' | 'ws' | 'internal';
export type GatewayMethodSource = 'builtin' | 'plugin';
export type GatewayMethodAccess = 'authenticated' | 'admin' | 'remote-peer';
export type GatewayEventTransport = 'sse' | 'ws' | 'internal';

export interface GatewayHttpBinding {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
}

export interface GatewayMethodDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly source: GatewayMethodSource;
  readonly access: GatewayMethodAccess;
  readonly transport: readonly GatewayMethodTransport[];
  readonly scopes: readonly string[];
  readonly http?: GatewayHttpBinding;
  readonly events?: readonly string[];
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly pluginId?: string;
  readonly dangerous?: boolean;
  readonly invokable?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface GatewayEventDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly source: GatewayMethodSource;
  readonly transport: readonly GatewayEventTransport[];
  readonly scopes: readonly string[];
  readonly domains?: readonly RuntimeEventDomain[];
  readonly wireEvents?: readonly string[];
  readonly outputSchema?: Record<string, unknown>;
  readonly pluginId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface GatewayMethodInvocationContext {
  readonly principalId?: string;
  readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer';
  readonly admin?: boolean;
  readonly scopes?: readonly string[];
  readonly clientKind?: string;
  readonly authToken?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface GatewayMethodInvocation {
  readonly body?: unknown;
  readonly query?: Record<string, unknown>;
  readonly context: GatewayMethodInvocationContext;
}

export type GatewayMethodHandler = (input: GatewayMethodInvocation) => unknown | Promise<unknown>;
export interface GatewayMethodListOptions {
  readonly category?: string;
  readonly source?: GatewayMethodSource;
  readonly pluginId?: string;
}

export interface GatewayEventListOptions {
  readonly category?: string;
  readonly source?: GatewayMethodSource;
  readonly pluginId?: string;
  readonly domain?: RuntimeEventDomain;
}

export const GENERIC_OBJECT_SCHEMA = { type: 'object', additionalProperties: true } as const;
export const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;
export const STRING_SCHEMA = { type: 'string' } as const;
export const BOOLEAN_SCHEMA = { type: 'boolean' } as const;
export const NUMBER_SCHEMA = { type: 'number' } as const;

export function arraySchema(itemSchema: Record<string, unknown> = GENERIC_OBJECT_SCHEMA): Record<string, unknown> {
  return { type: 'array', items: itemSchema };
}

export function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: readonly string[] = [],
  options: { readonly additionalProperties?: boolean } = {},
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    additionalProperties: options.additionalProperties ?? false,
  };
}

export function listOutputSchema(key: string): Record<string, unknown> {
  return objectSchema({ [key]: arraySchema(GENERIC_OBJECT_SCHEMA) }, [key], { additionalProperties: false });
}

export function entityOutputSchema(key: string): Record<string, unknown> {
  return objectSchema({ [key]: GENERIC_OBJECT_SCHEMA }, [key], { additionalProperties: false });
}

export function actionResultOutputSchema(key: string): Record<string, unknown> {
  return objectSchema({
    [key]: GENERIC_OBJECT_SCHEMA,
  }, [key], { additionalProperties: true });
}

export function bodyEnvelopeSchema(
  properties: Record<string, Record<string, unknown>> = {},
  required: readonly string[] = [],
): Record<string, unknown> {
  return objectSchema({
    ...properties,
  }, required, { additionalProperties: true });
}

export function methodDescriptor(input: Omit<GatewayMethodDescriptor, 'source' | 'transport' | 'access'> & Partial<Pick<GatewayMethodDescriptor, 'source' | 'transport' | 'access'>>): GatewayMethodDescriptor {
  return {
    source: input.source ?? 'builtin',
    transport: input.transport ?? ['http', 'ws'],
    access: input.access ?? 'authenticated',
    ...input,
  };
}

export function eventDescriptor(input: Omit<GatewayEventDescriptor, 'source'> & Partial<Pick<GatewayEventDescriptor, 'source'>>): GatewayEventDescriptor {
  return {
    source: input.source ?? 'builtin',
    ...input,
  };
}

export function runtimeEventId(domain: RuntimeEventDomain): string {
  return `runtime.${domain}`;
}

export function runtimeDomainEvent(domain: RuntimeEventDomain, description: string): GatewayEventDescriptor {
  return eventDescriptor({
    id: runtimeEventId(domain),
    title: `${domain} Domain Events`,
    description,
    category: 'runtime-domain',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    domains: [domain],
    wireEvents: [domain],
    outputSchema: GENERIC_OBJECT_SCHEMA,
  });
}
