import type { GatewayEventDescriptor, GatewayMethodCatalog, GatewayMethodDescriptor } from './method-catalog.ts';
import { getOperatorContract } from '@pellux/goodvibes-sdk/contracts';
import {
  BOOLEAN_SCHEMA,
  METHOD_DESCRIPTOR_SCHEMA,
  EVENT_DESCRIPTOR_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.ts';
import {
  CONTROL_AUTH_CURRENT_RESPONSE_SCHEMA,
  CONTROL_AUTH_LOGIN_REQUEST_SCHEMA,
  CONTROL_AUTH_LOGIN_RESPONSE_SCHEMA,
} from './operator-contract-schemas.ts';
import type { OperatorContractManifest } from '@pellux/goodvibes-sdk/platform/types/foundation-contract';
import { VERSION } from '../version.ts';
import { OPERATOR_SESSION_COOKIE_NAME } from '@pellux/goodvibes-sdk/platform/security/http-auth';

const OPERATOR_CONTRACT_VERSION = 1;
const OPERATOR_WS_PATH = '/api/control-plane/ws';
const OPERATOR_EVENTS_PATH = '/api/control-plane/events';
const OPERATOR_METHODS_PATH = '/api/control-plane/methods';
const OPERATOR_EVENTS_CATALOG_PATH = '/api/control-plane/events/catalog';
const OPERATOR_AUTH_CURRENT_PATH = '/api/control-plane/auth';
const OPERATOR_AUTH_CURRENT_ALIAS_PATHS = ['/api/control-plane/whoami'];
const PEER_CONTRACT_PATH = '/api/remote/node-host/contract';
const PEER_CONTRACT_ALIAS_PATHS = ['/api/remote/device/contract'];

export type { OperatorContractManifest } from '@pellux/goodvibes-sdk/platform/types/foundation-contract';

interface OperatorSchemaCoverage {
  readonly methods: number;
  readonly typedInputs: number;
  readonly genericInputs: number;
  readonly typedOutputs: number;
  readonly genericOutputs: number;
}

interface OperatorEventCoverage {
  readonly events: number;
  readonly withDomains: number;
  readonly withWireEvents: number;
}

const OPERATOR_CONTRACT_FRAME_SCHEMA = objectSchema({
  type: STRING_SCHEMA,
  fields: arraySchema(STRING_SCHEMA),
}, ['type']);

export const OPERATOR_CONTRACT_SCHEMA = objectSchema({
  version: NUMBER_SCHEMA,
  product: objectSchema({
    id: STRING_SCHEMA,
    surface: STRING_SCHEMA,
    version: STRING_SCHEMA,
  }, ['id', 'surface', 'version']),
  auth: objectSchema({
    modes: arraySchema(STRING_SCHEMA),
    login: objectSchema({
      method: STRING_SCHEMA,
      path: STRING_SCHEMA,
      requestSchema: CONTROL_AUTH_LOGIN_REQUEST_SCHEMA,
      responseSchema: CONTROL_AUTH_LOGIN_RESPONSE_SCHEMA,
    }, ['method', 'path', 'requestSchema', 'responseSchema']),
    current: objectSchema({
      method: STRING_SCHEMA,
      path: STRING_SCHEMA,
      aliasPaths: arraySchema(STRING_SCHEMA),
      responseSchema: CONTROL_AUTH_CURRENT_RESPONSE_SCHEMA,
    }, ['method', 'path', 'aliasPaths', 'responseSchema']),
    sessionCookie: objectSchema({
      name: STRING_SCHEMA,
      httpOnly: BOOLEAN_SCHEMA,
      sameSite: STRING_SCHEMA,
      path: STRING_SCHEMA,
    }, ['name', 'httpOnly', 'sameSite', 'path']),
    bearer: objectSchema({
      header: STRING_SCHEMA,
      queryParameters: arraySchema(STRING_SCHEMA),
    }, ['header', 'queryParameters']),
  }, ['modes', 'login', 'current', 'sessionCookie', 'bearer']),
  transports: objectSchema({
    http: objectSchema({
      statusPath: STRING_SCHEMA,
      methodsPath: STRING_SCHEMA,
      eventsCatalogPath: STRING_SCHEMA,
    }, ['statusPath', 'methodsPath', 'eventsCatalogPath']),
    sse: objectSchema({
      path: STRING_SCHEMA,
      query: objectSchema({
        domains: STRING_SCHEMA,
      }, ['domains']),
    }, ['path', 'query']),
    websocket: objectSchema({
      path: STRING_SCHEMA,
      clientFrames: arraySchema(OPERATOR_CONTRACT_FRAME_SCHEMA),
      serverFrames: arraySchema(OPERATOR_CONTRACT_FRAME_SCHEMA),
    }, ['path', 'clientFrames', 'serverFrames']),
  }, ['http', 'sse', 'websocket']),
  operator: objectSchema({
    methods: arraySchema(METHOD_DESCRIPTOR_SCHEMA),
    events: arraySchema(EVENT_DESCRIPTOR_SCHEMA),
    schemaCoverage: objectSchema({
      methods: NUMBER_SCHEMA,
      typedInputs: NUMBER_SCHEMA,
      genericInputs: NUMBER_SCHEMA,
      typedOutputs: NUMBER_SCHEMA,
      genericOutputs: NUMBER_SCHEMA,
    }, ['methods', 'typedInputs', 'genericInputs', 'typedOutputs', 'genericOutputs']),
    eventCoverage: objectSchema({
      events: NUMBER_SCHEMA,
      withDomains: NUMBER_SCHEMA,
      withWireEvents: NUMBER_SCHEMA,
    }, ['events', 'withDomains', 'withWireEvents']),
  }, ['methods', 'events', 'schemaCoverage', 'eventCoverage']),
  peer: objectSchema({
    contractPath: STRING_SCHEMA,
    aliasPaths: arraySchema(STRING_SCHEMA),
    relationship: STRING_SCHEMA,
  }, ['contractPath', 'aliasPaths', 'relationship']),
}, ['version', 'product', 'auth', 'transports', 'operator', 'peer']);

function isGenericObjectSchema(schema: Record<string, unknown> | undefined): boolean {
  return Boolean(schema && schema.type === 'object' && !Object.hasOwn(schema, 'properties'));
}

function summarizeSchemaCoverage(methods: readonly GatewayMethodDescriptor[]): OperatorSchemaCoverage {
  let genericInputs = 0;
  let genericOutputs = 0;
  for (const method of methods) {
    if (isGenericObjectSchema(method.inputSchema)) genericInputs += 1;
    if (isGenericObjectSchema(method.outputSchema)) genericOutputs += 1;
  }
  return {
    methods: methods.length,
    typedInputs: methods.length - genericInputs,
    genericInputs,
    typedOutputs: methods.length - genericOutputs,
    genericOutputs,
  };
}

function summarizeEventCoverage(events: readonly GatewayEventDescriptor[]): OperatorEventCoverage {
  return {
    events: events.length,
    withDomains: events.filter((event) => (event.domains?.length ?? 0) > 0).length,
    withWireEvents: events.filter((event) => (event.wireEvents?.length ?? 0) > 0).length,
  };
}

export function buildOperatorContract(catalog: GatewayMethodCatalog): OperatorContractManifest {
  void catalog;
  const contract = getOperatorContract();
  return {
    ...contract,
    product: {
      ...contract.product,
      version: VERSION,
    },
  };
}
