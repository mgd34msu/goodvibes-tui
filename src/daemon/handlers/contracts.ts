/**
 * Single SDK-contract import seam for the daemon handler layer.
 *
 * Every other module under `src/daemon/handlers/` imports SDK contract
 * identifiers from HERE and nowhere else. Concentrating the SDK imports in one
 * concrete-submodule module keeps the rest of the layer free of barrel cycles
 * and guarantees the host NEVER re-declares an SDK id, descriptor, or schema —
 * it only attaches handlers to the descriptors the SDK already registered.
 */

// Catalog + invocation contract types (concrete control-plane subpath, not a project barrel).
export type {
  GatewayMethodCatalog,
  GatewayMethodDescriptor,
  GatewayMethodInvocation,
  GatewayMethodInvocationContext,
  GatewayMethodHandler,
} from '@pellux/goodvibes-sdk/platform/control-plane';

// Channel domain types reused in handler signatures (read-only SDK interfaces; never re-declared).
export type {
  ChannelIdentity,
  ChannelResolvedTarget,
  ChannelAccountRecord,
} from '@pellux/goodvibes-sdk/platform/channels';

/**
 * Per-peer authentication envelope passed to peer-scoped remote routes.
 *
 * The daemon-sdk ships `RemotePeerAuth` only as an UNEXPORTED local alias
 * inside `@pellux/goodvibes-daemon-sdk/remote-routes` (it is `unknown` there),
 * so it cannot be re-exported. We mirror that exact shape here for the host
 * implementation. This is an implementable runtime contract, not a method
 * descriptor or schema — declaring it does not violate the no-re-declaration
 * rule for catalog methods.
 */
export type RemotePeerAuth = unknown;

/**
 * Remote distributed-runtime route service the HOST must implement and supply
 * as `RuntimeServices.distributedRuntime`. The SDK facade injects the instance
 * into `DaemonRemoteRouteContext.distributedRuntime` so the published
 * `remote.peers.*` HTTP routes can dispatch to it.
 *
 * The daemon-sdk declares this interface locally in
 * `@pellux/goodvibes-daemon-sdk/remote-routes` but does NOT export it (the
 * module ends with `export {}`), so it cannot be imported. This declaration
 * mirrors the SDK's exact structural shape (17 methods, verbatim signatures)
 * so a host implementation is assignable to the SDK's context field. The SDK
 * ships no docker/ssh/cloud backend — the host owns the implementation.
 */
export interface DistributedRuntimeRouteService {
  listPairRequests(): unknown;
  approvePairRequest(requestId: string, input: Record<string, unknown>): Promise<unknown | null>;
  rejectPairRequest(requestId: string, input: Record<string, unknown>): Promise<unknown | null>;
  listPeers(): unknown;
  rotatePeerToken(peerId: string, input: Record<string, unknown>): Promise<unknown | null>;
  revokePeerToken(peerId: string, input: Record<string, unknown>): Promise<unknown | null>;
  disconnectPeer(peerId: string, input: Record<string, unknown>): Promise<unknown | null>;
  listWork(): unknown;
  invokePeer(input: Record<string, unknown>): Promise<unknown>;
  cancelWork(workId: string, input: Record<string, unknown>): Promise<unknown | null>;
  getNodeHostContract(): unknown;
  requestPairing(input: Record<string, unknown>): Promise<unknown>;
  verifyPairRequest(
    requestId: string,
    challenge: string,
    input: Record<string, unknown>,
  ): Promise<unknown | null>;
  heartbeatPeer(auth: RemotePeerAuth, input: Record<string, unknown>): Promise<unknown>;
  claimWork(auth: RemotePeerAuth, input: Record<string, unknown>): Promise<unknown>;
  completeWork(
    auth: RemotePeerAuth,
    workId: string,
    input: Record<string, unknown>,
  ): Promise<unknown | null>;
}
