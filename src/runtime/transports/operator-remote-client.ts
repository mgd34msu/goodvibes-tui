import type { OperatorContractManifest, OperatorMethodContract } from '../../types/foundation-contract.ts';
import type {
  OperatorMethodInput,
  OperatorMethodOutput,
  OperatorStreamMethodId,
  OperatorTypedMethodId,
} from '../../types/generated/foundation-client-types.ts';
import type { HttpJsonTransport } from './http-json-transport.ts';
import {
  buildContractInput,
  invokeContractRoute,
  openContractRouteStream,
  requireContractRoute,
  type ContractRouteDefinition,
  type ContractInvokeOptions,
  type ContractStreamOptions,
} from './contract-http-client.ts';

export interface OperatorRemoteClientInvokeOptions extends ContractInvokeOptions {}

export interface OperatorRemoteClientStreamOptions extends ContractStreamOptions {}

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

type KnownMethodArgs<TMethodId extends OperatorTypedMethodId> = MethodArgs<
  OperatorMethodInput<TMethodId>,
  OperatorRemoteClientInvokeOptions
>;

type KnownPathMethodArgs<
  TMethodId extends OperatorTypedMethodId,
  TKeys extends PropertyKey,
> = MethodArgs<
  WithoutKeys<OperatorMethodInput<TMethodId>, TKeys>,
  OperatorRemoteClientInvokeOptions
>;

type KnownStreamArgs<TMethodId extends OperatorStreamMethodId> = MethodArgs<
  OperatorMethodInput<TMethodId>,
  OperatorRemoteClientStreamOptions
>;

function splitArgs<TInput, TOptions>(
  args: readonly [TInput?, TOptions?],
): readonly [TInput | undefined, TOptions | undefined] {
  return args as readonly [TInput | undefined, TOptions | undefined];
}

export interface OperatorRemoteClient {
  readonly transport: HttpJsonTransport;
  readonly contract: OperatorContractManifest;
  listMethods(): readonly OperatorMethodContract[];
  getMethod(methodId: string): OperatorMethodContract;
  invoke<TMethodId extends OperatorTypedMethodId>(
    methodId: TMethodId,
    ...args: KnownMethodArgs<TMethodId>
  ): Promise<OperatorMethodOutput<TMethodId>>;
  invoke<T = unknown>(
    methodId: string,
    input?: Record<string, unknown>,
    options?: OperatorRemoteClientInvokeOptions,
  ): Promise<T>;
  stream<TMethodId extends OperatorStreamMethodId>(
    methodId: TMethodId,
    ...args: KnownStreamArgs<TMethodId>
  ): Promise<() => void>;
  readonly sessions: {
    create(...args: KnownMethodArgs<'sessions.create'>): Promise<OperatorMethodOutput<'sessions.create'>>;
    get(sessionId: string, ...args: KnownPathMethodArgs<'sessions.get', 'sessionId'>): Promise<OperatorMethodOutput<'sessions.get'>>;
    list(...args: KnownMethodArgs<'sessions.list'>): Promise<OperatorMethodOutput<'sessions.list'>>;
    messages: {
      create(sessionId: string, ...args: KnownPathMethodArgs<'sessions.messages.create', 'sessionId'>): Promise<OperatorMethodOutput<'sessions.messages.create'>>;
      list(sessionId: string, ...args: KnownPathMethodArgs<'sessions.messages.list', 'sessionId'>): Promise<OperatorMethodOutput<'sessions.messages.list'>>;
    };
    inputs: {
      cancel(sessionId: string, inputId: string, ...args: KnownPathMethodArgs<'sessions.inputs.cancel', 'sessionId' | 'inputId'>): Promise<OperatorMethodOutput<'sessions.inputs.cancel'>>;
    };
    followUp(...args: KnownMethodArgs<'sessions.followUp'>): Promise<OperatorMethodOutput<'sessions.followUp'>>;
    steer(...args: KnownMethodArgs<'sessions.steer'>): Promise<OperatorMethodOutput<'sessions.steer'>>;
    close(sessionId: string, ...args: KnownPathMethodArgs<'sessions.close', 'sessionId'>): Promise<OperatorMethodOutput<'sessions.close'>>;
    reopen(sessionId: string, ...args: KnownPathMethodArgs<'sessions.reopen', 'sessionId'>): Promise<OperatorMethodOutput<'sessions.reopen'>>;
  };
  readonly tasks: {
    create(...args: KnownMethodArgs<'tasks.create'>): Promise<OperatorMethodOutput<'tasks.create'>>;
    get(taskId: string, ...args: KnownPathMethodArgs<'tasks.get', 'taskId'>): Promise<OperatorMethodOutput<'tasks.get'>>;
    list(...args: KnownMethodArgs<'tasks.list'>): Promise<OperatorMethodOutput<'tasks.list'>>;
    status(...args: KnownMethodArgs<'tasks.status'>): Promise<OperatorMethodOutput<'tasks.status'>>;
    cancel(taskId: string, ...args: KnownPathMethodArgs<'tasks.cancel', 'taskId'>): Promise<OperatorMethodOutput<'tasks.cancel'>>;
    retry(taskId: string, ...args: KnownPathMethodArgs<'tasks.retry', 'taskId'>): Promise<OperatorMethodOutput<'tasks.retry'>>;
  };
  readonly approvals: {
    list(...args: KnownMethodArgs<'approvals.list'>): Promise<OperatorMethodOutput<'approvals.list'>>;
    claim(approvalId: string, ...args: KnownPathMethodArgs<'approvals.claim', 'approvalId'>): Promise<OperatorMethodOutput<'approvals.claim'>>;
    approve(approvalId: string, ...args: KnownPathMethodArgs<'approvals.approve', 'approvalId'>): Promise<OperatorMethodOutput<'approvals.approve'>>;
    deny(approvalId: string, ...args: KnownPathMethodArgs<'approvals.deny', 'approvalId'>): Promise<OperatorMethodOutput<'approvals.deny'>>;
    cancel(approvalId: string, ...args: KnownPathMethodArgs<'approvals.cancel', 'approvalId'>): Promise<OperatorMethodOutput<'approvals.cancel'>>;
  };
  readonly providers: {
    list(...args: KnownMethodArgs<'providers.list'>): Promise<OperatorMethodOutput<'providers.list'>>;
    get(providerId: string, ...args: KnownPathMethodArgs<'providers.get', 'providerId'>): Promise<OperatorMethodOutput<'providers.get'>>;
    usage(providerId: string, ...args: KnownPathMethodArgs<'providers.usage.get', 'providerId'>): Promise<OperatorMethodOutput<'providers.usage.get'>>;
  };
  readonly accounts: {
    snapshot(...args: KnownMethodArgs<'accounts.snapshot'>): Promise<OperatorMethodOutput<'accounts.snapshot'>>;
  };
  readonly localAuth: {
    status(...args: KnownMethodArgs<'local_auth.status'>): Promise<OperatorMethodOutput<'local_auth.status'>>;
  };
  readonly control: {
    snapshot(...args: KnownMethodArgs<'control.snapshot'>): Promise<OperatorMethodOutput<'control.snapshot'>>;
    status(...args: KnownMethodArgs<'control.status'>): Promise<OperatorMethodOutput<'control.status'>>;
    contract(...args: KnownMethodArgs<'control.contract'>): Promise<OperatorMethodOutput<'control.contract'>>;
    methods: {
      list(...args: KnownMethodArgs<'control.methods.list'>): Promise<OperatorMethodOutput<'control.methods.list'>>;
      get(methodId: string, ...args: KnownPathMethodArgs<'control.methods.get', 'methodId'>): Promise<OperatorMethodOutput<'control.methods.get'>>;
    };
    auth: {
      current(...args: KnownMethodArgs<'control.auth.current'>): Promise<OperatorMethodOutput<'control.auth.current'>>;
      login(...args: KnownMethodArgs<'control.auth.login'>): Promise<OperatorMethodOutput<'control.auth.login'>>;
    };
    events: {
      catalog(...args: KnownMethodArgs<'control.events.catalog'>): Promise<OperatorMethodOutput<'control.events.catalog'>>;
      stream(...args: KnownStreamArgs<'control.events.stream'>): Promise<() => void>;
    };
  };
  readonly telemetry: {
    snapshot(...args: KnownMethodArgs<'telemetry.snapshot'>): Promise<OperatorMethodOutput<'telemetry.snapshot'>>;
    events(...args: KnownMethodArgs<'telemetry.events.list'>): Promise<OperatorMethodOutput<'telemetry.events.list'>>;
    errors(...args: KnownMethodArgs<'telemetry.errors.list'>): Promise<OperatorMethodOutput<'telemetry.errors.list'>>;
    traces(...args: KnownMethodArgs<'telemetry.traces.list'>): Promise<OperatorMethodOutput<'telemetry.traces.list'>>;
    metrics(...args: KnownMethodArgs<'telemetry.metrics.get'>): Promise<OperatorMethodOutput<'telemetry.metrics.get'>>;
    otlp: {
      traces(...args: KnownMethodArgs<'telemetry.otlp.traces'>): Promise<OperatorMethodOutput<'telemetry.otlp.traces'>>;
      logs(...args: KnownMethodArgs<'telemetry.otlp.logs'>): Promise<OperatorMethodOutput<'telemetry.otlp.logs'>>;
      metrics(...args: KnownMethodArgs<'telemetry.otlp.metrics'>): Promise<OperatorMethodOutput<'telemetry.otlp.metrics'>>;
    };
    stream(...args: KnownStreamArgs<'telemetry.stream'>): Promise<() => void>;
  };
}

function requireMethod(
  contract: OperatorContractManifest,
  methodId: string,
): OperatorMethodContract {
  return requireContractRoute(contract.operator.methods, methodId, 'operator method');
}

function requireMethodRoute(
  contract: OperatorContractManifest,
  methodId: string,
): ContractRouteDefinition {
  const method = requireMethod(contract, methodId);
  if (!method.http) {
    throw new Error(`Operator method "${methodId}" does not expose an HTTP binding`);
  }
  return method.http;
}

export function createOperatorRemoteClient(
  transport: HttpJsonTransport,
  contract: OperatorContractManifest,
): OperatorRemoteClient {
  function invokeTyped<TMethodId extends OperatorTypedMethodId>(
    methodId: TMethodId,
    ...args: KnownMethodArgs<TMethodId>
  ): Promise<OperatorMethodOutput<TMethodId>>;
  function invokeTyped<T = unknown>(
    methodId: string,
    input?: Record<string, unknown>,
    options?: OperatorRemoteClientInvokeOptions,
  ): Promise<T>;
  function invokeTyped<T = unknown>(
    methodId: string,
    input?: Record<string, unknown>,
    options: OperatorRemoteClientInvokeOptions = {},
  ): Promise<T> {
    return invokeContractRoute<T>(transport, requireMethodRoute(contract, methodId), input, options);
  }

  function streamTyped<TMethodId extends OperatorStreamMethodId>(
    methodId: TMethodId,
    ...args: KnownStreamArgs<TMethodId>
  ): Promise<() => void> {
    const [input, options] = splitArgs(args as readonly [OperatorMethodInput<TMethodId>?, OperatorRemoteClientStreamOptions?]);
    return openContractRouteStream(
      transport,
      requireMethodRoute(contract, methodId),
      input as Record<string, unknown> | undefined,
      options ?? { handlers: {} },
    );
  }

  const client: OperatorRemoteClient = {
    transport,
    contract,
    listMethods(): readonly OperatorMethodContract[] {
      return contract.operator.methods;
    },
    getMethod(methodId: string): OperatorMethodContract {
      return requireMethod(contract, methodId);
    },
    invoke: invokeTyped,
    stream: streamTyped,
    sessions: {
      create: (...args) => invokeTyped('sessions.create', ...args),
      get: (sessionId, ...args) => {
        const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'sessions.get'>, 'sessionId'>?, OperatorRemoteClientInvokeOptions?]);
        return invokeTyped('sessions.get', buildContractInput('sessionId', sessionId, input as Record<string, unknown> | undefined), options);
      },
      list: (...args) => invokeTyped('sessions.list', ...args),
      messages: {
        create: (sessionId, ...args) => {
          const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'sessions.messages.create'>, 'sessionId'>?, OperatorRemoteClientInvokeOptions?]);
          return invokeTyped('sessions.messages.create', buildContractInput('sessionId', sessionId, input as Record<string, unknown> | undefined), options);
        },
        list: (sessionId, ...args) => {
          const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'sessions.messages.list'>, 'sessionId'>?, OperatorRemoteClientInvokeOptions?]);
          return invokeTyped('sessions.messages.list', buildContractInput('sessionId', sessionId, input as Record<string, unknown> | undefined), options);
        },
      },
      inputs: {
        cancel: (sessionId, inputId, ...args) => {
          const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'sessions.inputs.cancel'>, 'sessionId' | 'inputId'>?, OperatorRemoteClientInvokeOptions?]);
          return invokeTyped('sessions.inputs.cancel', {
            sessionId,
            inputId,
            ...(input as Record<string, unknown> | undefined ?? {}),
          }, options);
        },
      },
      followUp: (...args) => invokeTyped('sessions.followUp', ...args),
      steer: (...args) => invokeTyped('sessions.steer', ...args),
      close: (sessionId, ...args) => {
        const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'sessions.close'>, 'sessionId'>?, OperatorRemoteClientInvokeOptions?]);
        return invokeTyped('sessions.close', {
          sessionId,
          ...(input as Record<string, unknown> | undefined ?? {}),
        }, options);
      },
      reopen: (sessionId, ...args) => {
        const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'sessions.reopen'>, 'sessionId'>?, OperatorRemoteClientInvokeOptions?]);
        return invokeTyped('sessions.reopen', {
          sessionId,
          ...(input as Record<string, unknown> | undefined ?? {}),
        }, options);
      },
    },
    tasks: {
      create: (...args) => invokeTyped('tasks.create', ...args),
      get: (taskId, ...args) => {
        const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'tasks.get'>, 'taskId'>?, OperatorRemoteClientInvokeOptions?]);
        return invokeTyped('tasks.get', {
          taskId,
          ...(input as Record<string, unknown> | undefined ?? {}),
        }, options);
      },
      list: (...args) => invokeTyped('tasks.list', ...args),
      status: (...args) => invokeTyped('tasks.status', ...args),
      cancel: (taskId, ...args) => {
        const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'tasks.cancel'>, 'taskId'>?, OperatorRemoteClientInvokeOptions?]);
        return invokeTyped('tasks.cancel', {
          taskId,
          ...(input as Record<string, unknown> | undefined ?? {}),
        }, options);
      },
      retry: (taskId, ...args) => {
        const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'tasks.retry'>, 'taskId'>?, OperatorRemoteClientInvokeOptions?]);
        return invokeTyped('tasks.retry', {
          taskId,
          ...(input as Record<string, unknown> | undefined ?? {}),
        }, options);
      },
    },
    approvals: {
      list: (...args) => invokeTyped('approvals.list', ...args),
      claim: (approvalId, ...args) => {
        const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'approvals.claim'>, 'approvalId'>?, OperatorRemoteClientInvokeOptions?]);
        return invokeTyped('approvals.claim', buildContractInput('approvalId', approvalId, input as Record<string, unknown> | undefined), options);
      },
      approve: (approvalId, ...args) => {
        const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'approvals.approve'>, 'approvalId'>?, OperatorRemoteClientInvokeOptions?]);
        return invokeTyped('approvals.approve', buildContractInput('approvalId', approvalId, input as Record<string, unknown> | undefined), options);
      },
      deny: (approvalId, ...args) => {
        const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'approvals.deny'>, 'approvalId'>?, OperatorRemoteClientInvokeOptions?]);
        return invokeTyped('approvals.deny', buildContractInput('approvalId', approvalId, input as Record<string, unknown> | undefined), options);
      },
      cancel: (approvalId, ...args) => {
        const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'approvals.cancel'>, 'approvalId'>?, OperatorRemoteClientInvokeOptions?]);
        return invokeTyped('approvals.cancel', buildContractInput('approvalId', approvalId, input as Record<string, unknown> | undefined), options);
      },
    },
    providers: {
      list: (...args) => invokeTyped('providers.list', ...args),
      get: (providerId, ...args) => {
        const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'providers.get'>, 'providerId'>?, OperatorRemoteClientInvokeOptions?]);
        return invokeTyped('providers.get', {
          providerId,
          ...(input as Record<string, unknown> | undefined ?? {}),
        }, options);
      },
      usage: (providerId, ...args) => {
        const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'providers.usage.get'>, 'providerId'>?, OperatorRemoteClientInvokeOptions?]);
        return invokeTyped('providers.usage.get', {
          providerId,
          ...(input as Record<string, unknown> | undefined ?? {}),
        }, options);
      },
    },
    accounts: {
      snapshot: (...args) => invokeTyped('accounts.snapshot', ...args),
    },
    localAuth: {
      status: (...args) => invokeTyped('local_auth.status', ...args),
    },
    control: {
      snapshot: (...args) => invokeTyped('control.snapshot', ...args),
      status: (...args) => invokeTyped('control.status', ...args),
      contract: (...args) => invokeTyped('control.contract', ...args),
      methods: {
        list: (...args) => invokeTyped('control.methods.list', ...args),
        get: (methodId, ...args) => {
          const [input, options] = splitArgs(args as readonly [WithoutKeys<OperatorMethodInput<'control.methods.get'>, 'methodId'>?, OperatorRemoteClientInvokeOptions?]);
          return invokeTyped('control.methods.get', {
            methodId,
            ...(input as Record<string, unknown> | undefined ?? {}),
          }, options);
        },
      },
      auth: {
        current: (...args) => invokeTyped('control.auth.current', ...args),
        login: (...args) => invokeTyped('control.auth.login', ...args),
      },
      events: {
        catalog: (...args) => invokeTyped('control.events.catalog', ...args),
        stream: (...args) => streamTyped('control.events.stream', ...args),
      },
    },
    telemetry: {
      snapshot: (...args) => invokeTyped('telemetry.snapshot', ...args),
      events: (...args) => invokeTyped('telemetry.events.list', ...args),
      errors: (...args) => invokeTyped('telemetry.errors.list', ...args),
      traces: (...args) => invokeTyped('telemetry.traces.list', ...args),
      metrics: (...args) => invokeTyped('telemetry.metrics.get', ...args),
      otlp: {
        traces: (...args) => invokeTyped('telemetry.otlp.traces', ...args),
        logs: (...args) => invokeTyped('telemetry.otlp.logs', ...args),
        metrics: (...args) => invokeTyped('telemetry.otlp.metrics', ...args),
      },
      stream: (...args) => streamTyped('telemetry.stream', ...args),
    },
  };

  return client;
}
