import type { PeerContractManifest, PeerEndpointContract } from '../../types/foundation-contract.ts';
import type {
  PeerEndpointInput,
  PeerEndpointOutput,
  PeerTypedEndpointId,
} from '../../types/generated/foundation-client-types.ts';
import type { HttpJsonTransport } from './http-json-transport.ts';
import {
  buildContractInput,
  invokeContractRoute,
  requireContractRoute,
  type ContractInvokeOptions,
} from './contract-http-client.ts';

export interface PeerRemoteClientInvokeOptions extends ContractInvokeOptions {}

type RequiredKeys<T extends object> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

type MethodArgs<TInput, TOptions> =
  [TInput] extends [undefined]
    ? [input?: undefined, options?: TOptions]
    : TInput extends object
      ? [RequiredKeys<TInput>] extends [never]
        ? [input?: TInput, options?: TOptions]
        : [input: TInput, options?: TOptions]
      : [input: TInput, options?: TOptions];

type WithoutKeys<TInput, TKeys extends PropertyKey> =
  [TInput] extends [undefined]
    ? undefined
    : TInput extends object
      ? Omit<TInput, Extract<keyof TInput, TKeys>>
      : TInput;

type KnownEndpointArgs<TEndpointId extends PeerTypedEndpointId> = MethodArgs<
  PeerEndpointInput<TEndpointId>,
  PeerRemoteClientInvokeOptions
>;

type KnownPathEndpointArgs<
  TEndpointId extends PeerTypedEndpointId,
  TKeys extends PropertyKey,
> = MethodArgs<
  WithoutKeys<PeerEndpointInput<TEndpointId>, TKeys>,
  PeerRemoteClientInvokeOptions
>;

function splitArgs<TInput, TOptions>(
  args: readonly [TInput?, TOptions?],
): readonly [TInput | undefined, TOptions | undefined] {
  return args as readonly [TInput | undefined, TOptions | undefined];
}

export interface PeerRemoteClient {
  readonly transport: HttpJsonTransport;
  readonly contract: PeerContractManifest;
  listEndpoints(): readonly PeerEndpointContract[];
  getEndpoint(endpointId: string): PeerEndpointContract;
  invoke<TEndpointId extends PeerTypedEndpointId>(
    endpointId: TEndpointId,
    ...args: KnownEndpointArgs<TEndpointId>
  ): Promise<PeerEndpointOutput<TEndpointId>>;
  invoke<T = unknown>(
    endpointId: string,
    input?: Record<string, unknown>,
    options?: PeerRemoteClientInvokeOptions,
  ): Promise<T>;
  readonly pairing: {
    request(...args: KnownEndpointArgs<'pair.request'>): Promise<PeerEndpointOutput<'pair.request'>>;
    verify(...args: KnownEndpointArgs<'pair.verify'>): Promise<PeerEndpointOutput<'pair.verify'>>;
  };
  readonly peer: {
    heartbeat(...args: KnownEndpointArgs<'peer.heartbeat'>): Promise<PeerEndpointOutput<'peer.heartbeat'>>;
  };
  readonly work: {
    pull(...args: KnownEndpointArgs<'work.pull'>): Promise<PeerEndpointOutput<'work.pull'>>;
    complete(workId: string, ...args: KnownPathEndpointArgs<'work.complete', 'workId'>): Promise<PeerEndpointOutput<'work.complete'>>;
  };
  readonly operator: {
    snapshot(...args: KnownEndpointArgs<'operator.snapshot'>): Promise<PeerEndpointOutput<'operator.snapshot'>>;
  };
}

function requireEndpoint(
  contract: PeerContractManifest,
  endpointId: string,
): PeerEndpointContract {
  return requireContractRoute(contract.endpoints, endpointId, 'peer endpoint');
}

export function createPeerRemoteClient(
  transport: HttpJsonTransport,
  contract: PeerContractManifest,
): PeerRemoteClient {
  function invokeTyped<TEndpointId extends PeerTypedEndpointId>(
    endpointId: TEndpointId,
    ...args: KnownEndpointArgs<TEndpointId>
  ): Promise<PeerEndpointOutput<TEndpointId>>;
  function invokeTyped<T = unknown>(
    endpointId: string,
    input?: Record<string, unknown>,
    options?: PeerRemoteClientInvokeOptions,
  ): Promise<T>;
  function invokeTyped<T = unknown>(
    endpointId: string,
    input?: Record<string, unknown>,
    options: PeerRemoteClientInvokeOptions = {},
  ): Promise<T> {
    return invokeContractRoute<T>(transport, requireEndpoint(contract, endpointId), input, options);
  }

  const client: PeerRemoteClient = {
    transport,
    contract,
    listEndpoints(): readonly PeerEndpointContract[] {
      return contract.endpoints;
    },
    getEndpoint(endpointId: string): PeerEndpointContract {
      return requireEndpoint(contract, endpointId);
    },
    invoke: invokeTyped,
    pairing: {
      request: (...args) => invokeTyped('pair.request', ...args),
      verify: (...args) => invokeTyped('pair.verify', ...args),
    },
    peer: {
      heartbeat: (...args) => invokeTyped('peer.heartbeat', ...args),
    },
    work: {
      pull: (...args) => invokeTyped('work.pull', ...args),
      complete: (workId, ...args) => {
        const [input, options] = splitArgs(args as readonly [WithoutKeys<PeerEndpointInput<'work.complete'>, 'workId'>?, PeerRemoteClientInvokeOptions?]);
        return invokeTyped('work.complete', buildContractInput('workId', workId, input as Record<string, unknown> | undefined), options);
      },
    },
    operator: {
      snapshot: (...args) => invokeTyped('operator.snapshot', ...args),
    },
  };

  return client;
}
