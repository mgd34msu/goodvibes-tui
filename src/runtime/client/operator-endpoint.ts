/**
 * operator-endpoint.ts — the one place this product resolves "the daemon I talk
 * to", for every seam that talks to it.
 *
 * The terminal app is a pure client: it runs its own conversation loop and asks
 * a separately-running daemon for everything else. Every one of those asks is
 * an operator verb over HTTP, and every one of them needs the same three
 * things — is the daemon enabled, what base URL does it answer on, and what
 * bearer token proves this surface may call it. Resolving that in each seam is
 * how the old composition ended up with a DirectTransport in one place and a
 * real fetch in another.
 *
 * `resolveOperatorRpc` was previously the command layer's private helper
 * (input/commands/operator-rpc.ts). It moved here unchanged in behaviour so the
 * runtime seams — approvals, config, credentials, sessions, fleet, tasks,
 * devices, checkpoints — reach the daemon through the SAME resolution the
 * commands already used, and the command module now re-exports it.
 *
 * Refusals are values, never throws: a disabled daemon or an underivable base
 * URL comes back as `{ available: false, reason }` so a caller prints an honest
 * line instead of guessing. Once a call is made, a non-2xx (including the 404 a
 * daemon that has not wired a verb returns) throws `GoodVibesSdkError` and
 * `describeOperatorRpcError` renders it.
 *
 * Auth is the loopback file-token bootstrap, unchanged by the split: the token
 * is read (or minted) from the daemon's own state directory. A daemon on
 * another machine is reached by the network-adopt path, which writes that
 * daemon's bearer into the same file — so this resolution covers both.
 */
import { join } from 'node:path';
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
import type { GoodVibesSdk } from '@pellux/goodvibes-sdk';
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { resolveDaemonEnabled } from '@pellux/goodvibes-sdk/platform/config';
import { getOrCreateCompanionToken } from '@pellux/goodvibes-sdk/platform/pairing';
import type { DaemonVerbCaller } from '@pellux/goodvibes-sdk/platform/runtime/client';

/** Re-exported so this repo's importers keep one import site for the shape
 * every client seam takes. See the doc comment further down for why
 * `OperatorRpc`/`OperatorRpcAvailable` (declared below, carrying `sdk`)
 * structurally satisfy the SDK's `DaemonReachability`, and so `DaemonVerbCaller`
 * built here still type-checks as the SDK's own. */
export type { DaemonVerbCaller };

export interface OperatorRpcUnavailable {
  readonly available: false;
  readonly reason: string;
}

export interface OperatorRpcAvailable {
  readonly available: true;
  readonly sdk: GoodVibesSdk;
}

export type OperatorRpc = OperatorRpcUnavailable | OperatorRpcAvailable;

/**
 * Derive the dial address of the configured control-plane daemon.
 *
 * An explicitly declared external address wins; otherwise the URL is DERIVED
 * from hostMode/host/port/tls.mode. This deliberately does not prefer a stored
 * `controlPlane.baseUrl`: that key had no writers and so drifted from the bind
 * on port, scheme, and host at once.
 */
export function resolveControlPlaneBaseUrl(configManager: ConfigManager): string | null {
  const explicit = String(configManager.get('controlPlane.publicBaseUrl' as never) ?? '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const host = String(configManager.get('controlPlane.host') ?? '').trim();
  const port = configManager.get('controlPlane.port');
  if (host && typeof port === 'number' && port > 0) {
    const scheme = String(configManager.get('controlPlane.tls.mode') ?? 'off') !== 'off' ? 'https' : 'http';
    // A wildcard bind is not a dial target; loopback is the interface it answers on.
    const dialHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return `${scheme}://${dialHost.includes(':') && !dialHost.startsWith('[') ? `[${dialHost}]` : dialHost}:${port}`;
  }
  return null;
}

/** The daemon's own state directory — where the shared bearer token lives. */
export function resolveDaemonStateDirectory(homeDirectory: string): string {
  return join(homeDirectory, '.goodvibes', 'daemon');
}

/**
 * Resolve (or honestly refuse to resolve) an operator SDK client wired to this
 * workspace's control-plane daemon, from just the two things the resolution
 * actually needs — the config manager and the home directory.
 */
export function resolveOperatorRpc(deps: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}): OperatorRpc {
  const { configManager } = deps;
  // A refusal is a VALUE here, never a throw — that is the whole contract of
  // this function, and callers rely on it to print an honest line rather than
  // crash a keystroke. A context whose config manager cannot answer (a narrow
  // embed, a partially-wired test double) is one more case of "no daemon can be
  // resolved", not an exception to raise from a probe.
  if (typeof (configManager as { get?: unknown } | null)?.get !== 'function') {
    return { available: false, reason: 'no config manager is wired here, so no control-plane daemon can be resolved.' };
  }
  if (!resolveDaemonEnabled(configManager)) {
    return { available: false, reason: 'the daemon is disabled (daemon.enabled=false) — no operator surface to reach. Enable it in /settings, then retry.' };
  }
  const baseUrl = resolveControlPlaneBaseUrl(configManager);
  if (!baseUrl) {
    return { available: false, reason: 'no control-plane base URL is configured (controlPlane.publicBaseUrl / controlPlane.host+port) — cannot reach the operator surface.' };
  }
  // Resolve the home directory only AFTER the static refusals — a caller whose
  // shell paths are not wired (a disabled-daemon path) must still get the honest
  // unavailable reason above, never a "shell paths not wired" throw.
  const homeDirectory = typeof deps.homeDirectory === 'function' ? deps.homeDirectory() : deps.homeDirectory;
  const token = getOrCreateCompanionToken('tui', { daemonHomeDir: resolveDaemonStateDirectory(homeDirectory) }).token;
  const sdk = createGoodVibesSdk({ baseUrl, authToken: token });
  return { available: true, sdk };
}

/**
 * Render a thrown operator-rpc error honestly: a 404 means this daemon has not
 * wired a handler for the verb (a live daemon that simply doesn't implement it
 * yet), never "no result" or a fabricated empty state.
 */
export function describeOperatorRpcError(error: unknown): string {
  if (error instanceof GoodVibesSdkError) {
    if (error.status === 404) {
      return 'the connected daemon returned 404 — this operator verb is not wired up on that daemon yet.';
    }
    if (error.status === 401 || error.status === 403) {
      return `the connected daemon rejected the request (${error.status}): ${error.message}`;
    }
    return `operator request failed${error.status ? ` (${error.status})` : ''}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The generic gateway-method route, for a verb the contract carries with a
 * WEBSOCKET binding only.
 *
 * This matters more than it looks. `sdk.operator.invoke` resolves a method's
 * declared `http` route and refuses — with a contract error, before any request
 * is made — when the method has none. A large part of what this client needs is
 * exactly that class: `approvals.raise`, `credentials.set`/`delete`,
 * `checkpoints.*`, `rewind.*` and the `fleet.*` reads are all `transport: ws`
 * in the operator contract, with no REST path of their own.
 *
 * The daemon serves every catalogued verb over one generic route regardless of
 * its declared transport, which is what a client that is not holding a
 * websocket uses. Calling that route directly is not a workaround for a missing
 * binding: it IS the binding for a ws-declared verb reached over HTTP.
 */
async function invokeGatewayMethodOverHttp<T>(
  rpc: OperatorRpcAvailable,
  baseUrl: string,
  authToken: string,
  methodId: string,
  input: unknown,
): Promise<T> {
  void rpc;
  const response = await fetch(`${baseUrl}/api/control-plane/methods/${encodeURIComponent(methodId)}/invoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
    // The envelope the route requires: `body` must be PRESENT even when empty,
    // or the route refuses with a 400 naming the shape it wanted.
    body: JSON.stringify({ body: input ?? {} }),
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const described = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : `HTTP ${response.status}`;
    throw new GoodVibesSdkError(`'${methodId}' failed: ${described}`, {
      // Mapped from the status rather than fixed, so `describeOperatorRpcError`
      // and every caller that branches on category sees the same classification
      // it would have seen through the typed client path.
      category: response.status === 401 || response.status === 403
        ? 'authorization'
        : response.status === 404 ? 'not_found' : response.status >= 500 ? 'service' : 'bad_request',
      source: 'runtime',
      recoverable: response.status >= 500,
      status: response.status,
    });
  }
  return payload as T;
}

export function createDaemonVerbCaller(deps: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}): DaemonVerbCaller {
  return {
    probe: () => resolveOperatorRpc(deps),
    invoke: async <T,>(methodId: string, input?: unknown): Promise<T> => {
      const rpc = resolveOperatorRpc(deps);
      if (!rpc.available) throw new Error(`cannot invoke '${methodId}': ${rpc.reason}`);
      try {
        return await rpc.sdk.operator.invoke(methodId as never, (input ?? {}) as never) as T;
      } catch (error) {
        // A CONTRACT_MISMATCH here means exactly one thing: this verb declares
        // no HTTP route. That is a routing fact, not a failure of the call, so
        // it falls through to the generic gateway route rather than surfacing
        // as "the daemon refused" to a user who did nothing wrong.
        if (!(error instanceof GoodVibesSdkError) || error.code !== 'CONTRACT_MISMATCH') throw error;
        const baseUrl = resolveControlPlaneBaseUrl(deps.configManager);
        if (!baseUrl) throw error;
        const homeDirectory = typeof deps.homeDirectory === 'function' ? deps.homeDirectory() : deps.homeDirectory;
        const token = getOrCreateCompanionToken('tui', { daemonHomeDir: resolveDaemonStateDirectory(homeDirectory) }).token;
        return await invokeGatewayMethodOverHttp<T>(rpc, baseUrl, token, methodId, input);
      }
    },
  };
}
