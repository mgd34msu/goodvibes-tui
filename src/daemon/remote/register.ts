import {
  declareOperatorMethod,
  createDaemonCredentialStore,
  assertConfirmed,
  OperatorError,
  type OperatorContext,
  type OperatorInvocation,
  type Unregister,
} from '../operator/index.ts';
import type {
  GatewayMethodCatalog,
  GatewayMethodDescriptor,
  GatewayMethodInvocation,
} from '@pellux/goodvibes-sdk/platform/control-plane';
import {
  PeerRegistry,
  type BackendKind,
  type PeerRecord,
} from './peer-registry.ts';
import {
  RemoteDispatcher,
  type RemoteDispatcherOptions,
  type RemoteInvokeResult,
  type RemoteWorkEnqueuer,
} from './dispatcher.ts';
import { BackendDispatchError, type DispatchPayload } from './backends/index.ts';

// ---------------------------------------------------------------------------
// Method ids
// ---------------------------------------------------------------------------

export const REMOTE_PEERS_REGISTER = 'remote.peers.register';
export const REMOTE_PEERS_INVOKE = 'remote.peers.invoke';

// ---------------------------------------------------------------------------
// remote.peers.register input/output
// ---------------------------------------------------------------------------

interface RegisterPeerBody {
  peerId?: unknown;
  displayName?: unknown;
  backendKind?: unknown;
  backendConfig?: unknown;
  confirm?: unknown;
}

export interface RegisterPeerResult {
  peerId: string;
  registered: true;
  backendKind: BackendKind;
}

const REGISTER_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['peerId', 'displayName', 'backendKind', 'backendConfig', 'confirm'],
  additionalProperties: false,
  properties: {
    peerId: { type: 'string', minLength: 1 },
    displayName: { type: 'string', minLength: 1 },
    backendKind: { type: 'string', enum: ['docker', 'ssh', 'cloud-terminal', 'local-process'] },
    backendConfig: { type: 'object' },
    confirm: { type: 'boolean', const: true },
  },
};

const REGISTER_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['peerId', 'registered', 'backendKind'],
  properties: {
    peerId: { type: 'string' },
    registered: { type: 'boolean' },
    backendKind: { type: 'string' },
  },
};

const VALID_KINDS: ReadonlySet<string> = new Set([
  'docker',
  'ssh',
  'cloud-terminal',
  'local-process',
]);

function parseBackendKind(value: unknown): BackendKind {
  if (typeof value !== 'string' || !VALID_KINDS.has(value)) {
    throw new OperatorError(
      "Field 'backendKind' must be one of 'docker' | 'ssh' | 'cloud-terminal' | 'local-process'.",
      'REMOTE_INVALID_BACKEND_KIND',
      400,
    );
  }
  return value as BackendKind;
}

function parseConfig(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new OperatorError("Field 'backendConfig' must be an object.", 'REMOTE_INVALID_CONFIG', 400);
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// remote.peers.invoke dispatch adapter
// ---------------------------------------------------------------------------

interface InvokeBody {
  peerId?: unknown;
  command?: unknown;
  payload?: unknown;
  async?: unknown;
  confirm?: unknown;
}

/**
 * The dispatch adapter the integrator attaches to the already-registered
 * remote.peers.invoke route. It enforces confirm:true + explicitUserRequest via
 * assertConfirmed before routing to the execution backend layer.
 */
export type RemoteInvokeAdapter = (
  input: OperatorInvocation<unknown>,
) => Promise<RemoteInvokeResult>;

function normalizePayload(value: unknown): DispatchPayload | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new OperatorError("Field 'payload' must be an object.", 'REMOTE_INVALID_PAYLOAD', 400);
  }
  const raw = value as Record<string, unknown>;
  const payload: DispatchPayload = {};
  if (Array.isArray(raw.args)) {
    payload.args = raw.args.filter((a): a is string => typeof a === 'string');
  }
  if (typeof raw.stdin === 'string') payload.stdin = raw.stdin;
  if (typeof raw.cwd === 'string') payload.cwd = raw.cwd;
  if (typeof raw.timeoutMs === 'number') payload.timeoutMs = raw.timeoutMs;
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v;
    }
    payload.env = env;
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

/**
 * Normalize the invocation context for the UNWRAPPED invoke dispatch adapter.
 *
 * The wrapped register method goes through declareOperatorMethod, which lifts
 * `context.metadata.explicitUserRequest` (the raw SDK / gateway shape) up to a
 * top-level `context.explicitUserRequest` before any confirm guard runs. The
 * invoke dispatch adapter is attached directly to the existing
 * remote.peers.invoke route and is therefore NOT wrapped, so it must perform
 * the same normalization itself. We accept BOTH shapes:
 *   - already-normalized: context.explicitUserRequest === true
 *   - raw SDK/catalog:     context.metadata.explicitUserRequest === true
 * so the adapter behaves identically whether wired to the raw gateway
 * invocation or handed a pre-normalized context (e.g. by tests).
 */
function normalizeInvokeContext(
  context: OperatorInvocation<unknown>['context'],
): { principalId: string; explicitUserRequest: boolean } {
  const raw = context as {
    principalId?: unknown;
    explicitUserRequest?: unknown;
    metadata?: { explicitUserRequest?: unknown } | undefined;
  };
  const explicitUserRequest =
    raw.explicitUserRequest === true || raw.metadata?.explicitUserRequest === true;
  const principalId = typeof raw.principalId === 'string' ? raw.principalId : '';
  return { principalId, explicitUserRequest };
}

function mapDispatchError(error: unknown): never {
  if (error instanceof OperatorError) throw error;
  if (error instanceof BackendDispatchError) {
    const status = error.code === 'REMOTE_PEER_NOT_FOUND' ? 404 : 400;
    throw new OperatorError(error.message, error.code, status);
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new OperatorError(message, 'REMOTE_DISPATCH_FAILED', 500);
}

// ---------------------------------------------------------------------------
// Surface factory
// ---------------------------------------------------------------------------

export interface RemoteSurfaceOptions {
  /** Hook the integrator wires to the existing distributed runtime work queue. */
  workEnqueuer?: RemoteWorkEnqueuer;
  /** Inject a pre-built dispatcher (tests). When set, registry/credentials are ignored. */
  dispatcher?: RemoteDispatcher;
  /** Inject a pre-built registry (tests / shared instance). */
  peerRegistry?: PeerRegistry;
}

export interface RemoteSurface {
  readonly peerRegistry: PeerRegistry;
  readonly dispatcher: RemoteDispatcher;
  /** Async one-time init for the peer registry store. */
  init(): Promise<void>;
  /** Registers remote.peers.register only. Returns its Unregister. */
  register(): Unregister;
  /**
   * Builds the dispatch adapter for the EXISTING remote.peers.invoke route.
   * The integrator attaches this to the upstream invoke router rather than
   * re-registering the method.
   */
  registerDispatch(): RemoteInvokeAdapter;
  close(): void;
}

/**
 * Create the remote execution surface: peer registry + dispatcher + the two
 * registration entry points. Touches only src/daemon/remote.
 */
export function createRemoteSurface(
  ctx: OperatorContext,
  options: RemoteSurfaceOptions = {},
): RemoteSurface {
  const peerRegistry = options.peerRegistry ?? new PeerRegistry(ctx.workingDirectory);

  let dispatcher: RemoteDispatcher;
  if (options.dispatcher) {
    dispatcher = options.dispatcher;
  } else {
    const credentials = createDaemonCredentialStore(ctx.secrets);
    const dispatcherOptions: RemoteDispatcherOptions = {
      registry: peerRegistry,
      credentials,
      logger: ctx.logger,
      homeDirectory: ctx.homeDirectory,
      ...(options.workEnqueuer ? { workEnqueuer: options.workEnqueuer } : {}),
    };
    dispatcher = new RemoteDispatcher(dispatcherOptions);
  }

  return {
    peerRegistry,
    dispatcher,

    async init(): Promise<void> {
      await peerRegistry.init();
    },

    register(): Unregister {
      return declareOperatorMethod<RegisterPeerBody, RegisterPeerResult>(
        ctx,
        {
          id: REMOTE_PEERS_REGISTER,
          title: 'Register Remote Peer',
          description:
            'Register or update a remote execution peer with a backend kind and ref-only backend config.',
          category: 'remote',
          source: 'daemon',
          access: 'operator',
          transport: ['ws', 'internal'],
          scopes: ['remote:peers:write'],
          effect: 'confirmed-connected-host-state',
          confirm: true,
          inputSchema: REGISTER_INPUT_SCHEMA,
          outputSchema: REGISTER_OUTPUT_SCHEMA,
        },
        async ({ body }) => {
          const peerId = typeof body.peerId === 'string' ? body.peerId : '';
          const displayName = typeof body.displayName === 'string' ? body.displayName : '';
          const backendKind = parseBackendKind(body.backendKind);
          const backendConfig = parseConfig(body.backendConfig);
          let record: PeerRecord;
          try {
            record = await peerRegistry.register({
              peerId,
              displayName,
              backendKind,
              backendConfig,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new OperatorError(message, 'REMOTE_PEER_REGISTER_FAILED', 400);
          }
          return { peerId: record.peerId, registered: true, backendKind: record.backendKind };
        },
      );
    },

    registerDispatch(): RemoteInvokeAdapter {
      return async (input: OperatorInvocation<unknown>): Promise<RemoteInvokeResult> => {
        // Effect: confirmed-connected-host-state. Reject anything that lacks an
        // explicit, confirmed user request BEFORE touching a backend. The
        // context is normalized so the unwrapped adapter accepts both the raw
        // SDK metadata shape and an already-normalized top-level context.
        const normalizedContext = normalizeInvokeContext(input.context);
        assertConfirmed({ body: input.body, context: normalizedContext });
        const body = (input.body ?? {}) as InvokeBody;
        const peerId = typeof body.peerId === 'string' ? body.peerId : '';
        const command = typeof body.command === 'string' ? body.command : '';
        const payload = normalizePayload(body.payload);
        const asyncFlag = body.async === true;
        try {
          return await dispatcher.dispatch({
            peerId,
            command,
            principalId: normalizedContext.principalId,
            async: asyncFlag,
            ...(payload !== undefined ? { payload } : {}),
          });
        } catch (error) {
          mapDispatchError(error);
        }
      };
    },

    close(): void {
      peerRegistry.close();
    },
  };
}

/**
 * Convenience entry point for the integrator. Builds the remote surface,
 * initializes the peer registry, registers remote.peers.register, and returns
 * the surface handle plus the dispatch adapter for the existing
 * remote.peers.invoke route and a combined Unregister.
 *
 * Integration: attach `dispatch` to the upstream remote.peers.invoke handler.
 */
export interface RegisteredRemoteMethods {
  surface: RemoteSurface;
  /** Dispatch adapter to wire to the existing remote.peers.invoke route. */
  dispatch: RemoteInvokeAdapter;
  /** Tears down remote.peers.register and closes the peer registry store. */
  unregister: Unregister;
}

export async function registerRemoteMethods(
  ctx: OperatorContext,
  options: RemoteSurfaceOptions = {},
): Promise<RegisteredRemoteMethods> {
  const surface = createRemoteSurface(ctx, options);
  await surface.init();
  const unregisterMethod = surface.register();
  const dispatch = surface.registerDispatch();
  return {
    surface,
    dispatch,
    unregister: () => {
      try {
        unregisterMethod();
      } finally {
        surface.close();
      }
    },
  };
}

/**
 * Standalone helper for integrators who only need the invoke dispatch adapter
 * bound to an already-built surface (e.g. when remote.peers.register is wired
 * elsewhere). Enforces confirm:true + explicitUserRequest.
 */
export function registerRemoteDispatch(surface: RemoteSurface): RemoteInvokeAdapter {
  return surface.registerDispatch();
}

// ---------------------------------------------------------------------------
// remote.peers.invoke catalog route attachment
// ---------------------------------------------------------------------------

/**
 * Full gateway descriptor for the remote.peers.invoke route. The SDK control
 * plane already declares this method in its builtin catalog (HTTP binding
 * POST /api/remote/peers/{peerId}/invoke, admin access). We re-declare the same
 * descriptor here so the route can be (re)registered against any catalog with a
 * concrete handler — `access: 'admin'` mirrors the operator-tier mapping used by
 * remote.peers.register, and the http binding matches the upstream route so the
 * DaemonHttpRouter dispatches POSTs to this handler.
 */
export const REMOTE_PEERS_INVOKE_DESCRIPTOR: GatewayMethodDescriptor = {
  id: REMOTE_PEERS_INVOKE,
  title: 'Invoke Remote Peer',
  description:
    'Execute a command on a registered remote execution peer (Docker / SSH / cloud-terminal / local-process). Requires explicit user confirmation.',
  category: 'remote',
  source: 'builtin',
  access: 'admin',
  transport: ['http', 'ws', 'internal'],
  scopes: ['remote:peers:invoke'],
  http: { method: 'POST', path: '/api/remote/peers/{peerId}/invoke' },
};

/**
 * Attach the remote dispatch adapter to the `remote.peers.invoke` route on the
 * gateway-method catalog. This is the single faithful integration point: the
 * SDK's DaemonHttpRouter resolves POST /api/remote/peers/{peerId}/invoke to
 * `catalog.invoke('remote.peers.invoke', invocation)`, which calls the handler
 * registered here. The handler hands the raw gateway invocation straight to the
 * dispatch adapter, which normalizes the context (lifting
 * `context.metadata.explicitUserRequest`), enforces confirm:true +
 * explicitUserRequest via assertConfirmed, and routes to the backend layer.
 *
 * `replace: true` overrides the builtin stub the SDK ships for this method.
 * Returns the catalog Unregister for the route.
 */
export function attachRemoteInvokeRoute(
  catalog: GatewayMethodCatalog,
  dispatch: RemoteInvokeAdapter,
): Unregister {
  const handler = async (invocation: GatewayMethodInvocation): Promise<RemoteInvokeResult> =>
    dispatch(invocation as OperatorInvocation<unknown>);
  return catalog.register(REMOTE_PEERS_INVOKE_DESCRIPTOR, handler, { replace: true });
}
