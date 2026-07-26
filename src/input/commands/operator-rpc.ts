/**
 * operator-rpc.ts
 *
 * Generic operator-verb dispatch for gateway methods that do not (yet) have a
 * named facade on the in-process `OperatorClient` (`ctx.clients.operator`,
 * always DirectTransport-backed in this TUI — see bootstrap-shell.ts). The
 * initiative cluster (`ci.*`, `checkin.*`, `principals.*`,
 * `channels.profiles.*`) ships in the operator contract but has not been
 * promoted to that narrow facade, so commands reach it the same way any
 * external operator client would: a real HTTP round-trip to the currently
 * configured control-plane daemon, using `createGoodVibesSdk`'s generic
 * `sdk.operator.invoke(methodId, input)` (typed against the installed
 * contract — see `@pellux/goodvibes-contracts`).
 *
 * This is deliberately a fresh, lightweight connection per call (no pooling,
 * no persistent socket) — these are low-frequency, operator-initiated admin
 * calls, not hot-path session traffic. `getOperatorRpc` never throws: it
 * returns `{ available: false, reason }` up front for every case the caller
 * can decide about statically (daemon disabled, no reachable base URL), so
 * commands can print an honest "not available" line instead of guessing.
 * Once a call is made, a non-2xx response (including the 404 a not-yet-wired
 * verb returns) surfaces to the caller as a thrown `GoodVibesSdkError` —
 * callers should catch and render `describeOperatorRpcError` rather than
 * pretend the request succeeded.
 */
import { join } from 'node:path';
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
import type { GoodVibesSdk } from '@pellux/goodvibes-sdk';
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { resolveDaemonEnabled } from '@pellux/goodvibes-sdk/platform/config';
import { getOrCreateCompanionToken } from '@pellux/goodvibes-sdk/platform/pairing';
import type { CommandContext } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';

export interface OperatorRpcUnavailable {
  readonly available: false;
  readonly reason: string;
}

export interface OperatorRpcAvailable {
  readonly available: true;
  readonly sdk: GoodVibesSdk;
}

export type OperatorRpc = OperatorRpcUnavailable | OperatorRpcAvailable;

function resolveControlPlaneBaseUrl(configManager: ConfigManager): string | null {
  // An explicitly declared external address wins; otherwise the URL is DERIVED
  // from hostMode/host/port/tls.mode. This used to prefer a stored
  // `controlPlane.baseUrl`, which had no writers and so drifted from the bind
  // on port, scheme, and host at once.
  // The cast drops once a published SDK carries this key in ConfigKey; the
  // installed 1.14.0 predates it (same idiom cloudflare-control-plane.ts uses).
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

/**
 * Context-free core of {@link getOperatorRpc}: resolve (or honestly refuse to
 * resolve) an operator SDK client wired to this workspace's control-plane
 * daemon from just the two things the resolution actually needs — the config
 * manager and the home directory. Shared by the command layer (via
 * getOperatorRpc) and the Fleet panel's gateway (fleet-gateway.ts) so both
 * reach the same daemon over the same generic invoke path, never two divergent
 * clients. Refusal reasons are surfaced verbatim so callers print them directly.
 */
export function resolveOperatorRpc(deps: { readonly configManager: ConfigManager; readonly homeDirectory: string | (() => string) }): OperatorRpc {
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
  const daemonHomeDir = join(homeDirectory, '.goodvibes', 'daemon');
  const token = getOrCreateCompanionToken('tui', { daemonHomeDir }).token;
  const sdk = createGoodVibesSdk({ baseUrl, authToken: token });
  return { available: true, sdk };
}

/**
 * Resolve (or honestly refuse to resolve) an operator SDK client wired to
 * this workspace's control-plane daemon. Reasons for refusal are surfaced
 * verbatim to the caller so `/ci`, `/checkin`, and `/principals` can print
 * them directly rather than inventing their own wording.
 */
export function getOperatorRpc(context: CommandContext): OperatorRpc {
  return resolveOperatorRpc({
    configManager: context.platform.configManager,
    // Lazy: only resolved once the daemon-enabled + base-URL refusals pass, so a
    // disabled-daemon context with no shell paths still returns the honest reason.
    homeDirectory: () => requireShellPaths(context).homeDirectory,
  });
}

/**
 * Render a thrown operator-rpc error honestly: a 404 means this daemon has
 * not wired a handler for the verb (a live local runtime that simply doesn't
 * implement it yet), never "no result" or a fabricated empty state.
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
