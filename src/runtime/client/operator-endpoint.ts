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
 * A verb caller bound to one config manager + home directory: the shape every
 * runtime client seam takes, so a seam under test is handed a fake instead of
 * reaching a real port.
 */
export interface DaemonVerbCaller {
  /** Whether a daemon is reachable in principle, with the honest reason when not. */
  probe(): OperatorRpc;
  /**
   * Invoke a verb. Throws `GoodVibesSdkError` on a non-2xx, and a plain Error
   * carrying the refusal reason when no daemon is configured at all — a seam
   * that wants to degrade instead of failing should call `probe()` first.
   */
  invoke<T = unknown>(methodId: string, input?: unknown): Promise<T>;
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
      return await rpc.sdk.operator.invoke(methodId as never, (input ?? {}) as never) as T;
    },
  };
}
