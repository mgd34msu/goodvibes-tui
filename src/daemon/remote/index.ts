// Remote Execution Backends surface (Docker / SSH / Cloud Terminal / local).
//
// Publishes the daemon-internal `remote.peers.register` operator method and a
// dispatch adapter for the already-published `remote.peers.invoke` route. The
// integrator attaches the dispatch adapter to the existing invoke router and
// (optionally) wires the work enqueuer to the distributed runtime work queue.

export {
  PeerRegistry,
  PeerRegistryValidationError,
  normalizeBackendConfig,
} from './peer-registry.ts';
export type {
  BackendKind,
  CloudProvider,
  BackendConfig,
  DockerBackendConfig,
  SshBackendConfig,
  CloudTerminalBackendConfig,
  LocalProcessBackendConfig,
  PeerRecord,
  PeerRegistrationInput,
} from './peer-registry.ts';

export {
  createBackends,
  createLocalProcessBackend,
  createDockerBackend,
  createSshBackend,
  createCloudTerminalBackend,
  tokenizeCommand,
  runProcess,
  BackendDispatchError,
  resolveTimeout,
  DEFAULT_SYNC_TIMEOUT_MS,
  MAX_SYNC_TIMEOUT_MS,
} from './backends/index.ts';
export type {
  Backend,
  BackendContext,
  BackendDispatchResult,
  DispatchPayload,
  RunOptions,
  RunResult,
} from './backends/index.ts';

export {
  RemoteDispatcher,
  STDOUT_PREVIEW_LIMIT,
} from './dispatcher.ts';
export type {
  RemoteDispatcherOptions,
  RemoteInvokeResult,
  RemoteWorkEnqueuer,
  RemoteWorkItemInput,
  DispatchRequest,
} from './dispatcher.ts';

export {
  createRemoteSurface,
  registerRemoteMethods,
  registerRemoteDispatch,
  attachRemoteInvokeRoute,
  REMOTE_PEERS_REGISTER,
  REMOTE_PEERS_INVOKE,
  REMOTE_PEERS_INVOKE_DESCRIPTOR,
} from './register.ts';
export type {
  RemoteSurface,
  RemoteSurfaceOptions,
  RegisteredRemoteMethods,
  RemoteInvokeAdapter,
  RegisterPeerResult,
} from './register.ts';
