import {
  createFetch,
  createHttpTransport,
  createJsonInit,
  createJsonRequestInit,
  readJsonBody,
  requestJson,
  type HttpJsonRequestOptions,
  type HttpRetryPolicy,
  type HttpTransport,
  type HttpTransportOptions,
  type JsonObject,
  type JsonValue,
  type ResolvedContractRequest,
  type TransportJsonError,
} from '@pellux/goodvibes-sdk-beta/transport-http';

export type {
  HttpJsonRequestOptions,
  HttpRetryPolicy,
  JsonObject,
  JsonValue,
  ResolvedContractRequest,
  TransportJsonError,
};

export {
  createFetch,
  createJsonInit,
  createJsonRequestInit,
  readJsonBody,
  requestJson,
};

export type HttpJsonTransportOptions = HttpTransportOptions;
export type HttpJsonTransport = HttpTransport;

export function createHttpJsonTransport(options: HttpJsonTransportOptions): HttpJsonTransport {
  return createHttpTransport(options);
}
