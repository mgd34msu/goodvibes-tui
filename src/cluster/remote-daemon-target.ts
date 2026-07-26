/**
 * remote-daemon-target.ts — how a subcommand reaches a daemon.
 *
 * Lives under src/cluster/ rather than src/daemon/ so the TUI can use it too:
 * `/cluster` and the `cluster` subcommands must reach the same daemon the same
 * way, and the architecture rules (rightly) forbid the input layer from
 * importing a CLI entrypoint.
 *
 * ── THE CONVENTION ────────────────────────────────────────────────────────
 *
 * This is the first daemon subcommand that talks to a RUNNING daemon rather
 * than to systemd, so it establishes the pattern every later one should follow.
 * If you are adding `goodvibes-daemon <something>` that needs the daemon
 * itself, use this module rather than inventing a second way.
 *
 *   --host <name>   default: the control plane's configured host, which for a
 *                   default install is 127.0.0.1
 *   --port <n>      default: the control plane's configured port
 *   --token <t>     default: this machine's operator token, read from
 *                   <daemon home>/operator-tokens.json
 *
 * Authentication is `Authorization: Bearer <operator token>` against the
 * control plane — the same credential the TUI and the web UI already use.
 *
 * The defaults are the whole point. A homelab box is headless: the operator has
 * SSHed into it and wants `cluster status` to work with no flags at all. Flags
 * exist for the other case — driving a machine in the next room from a laptop —
 * and for scripting.
 *
 * What this module deliberately does NOT do: hold any knowledge of what the
 * verbs mean. It resolves a target, makes a request, and returns the parsed
 * body. Every decision about what the answer MEANS belongs to the daemon.
 */
import { readControlPlaneBinding } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { readOperatorTokenFile } from '@pellux/goodvibes-sdk/platform/workspace';

/** Where to send a verb, and what to authenticate with. */
export interface RemoteDaemonTarget {
  readonly baseUrl: string;
  readonly token: string;
  /** True when the target is this machine's own daemon, for message wording. */
  readonly isLocal: boolean;
}

/** The flags every remote-capable daemon subcommand accepts. */
export interface RemoteTargetFlags {
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly token?: string | undefined;
}

export type RemoteTargetResolution =
  | { readonly ok: true; readonly target: RemoteDaemonTarget }
  | { readonly ok: false; readonly error: string; readonly fix: string };

export interface ResolveRemoteTargetInput {
  readonly flags: RemoteTargetFlags;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly daemonHomeDir: string;
  /** Injectable so tests never read a real token file. */
  readonly readToken?: ((daemonHomeDir: string) => string | undefined) | undefined;
}

/**
 * Pull the token out of the operator-token file's contents.
 *
 * `readOperatorTokenFile` hands back the FILE, and the file is a JSON record —
 * `{ token, peerId, createdAt }` — not a bare token. Sending the whole document
 * as a bearer credential produces a 401 that looks exactly like a stale token,
 * which is a genuinely confusing way to fail. A file that is not JSON is
 * treated as a bare token, which is what a hand-written one would be.
 */
export function extractOperatorToken(contents: string | undefined): string | undefined {
  const trimmed = contents?.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { token?: unknown };
    return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Work out which daemon to talk to.
 *
 * A missing token is a refusal rather than an anonymous attempt: sending an
 * unauthenticated request would come back 401 and the operator would be left
 * guessing whether the daemon was down or the credential was missing.
 */
export function resolveRemoteDaemonTarget(input: ResolveRemoteTargetInput): RemoteTargetResolution {
  const binding = readControlPlaneBinding((key) => input.configManager.get(key as never));
  const host = input.flags.host?.trim() || binding.host;
  const port = input.flags.port ?? binding.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return {
      ok: false,
      error: `'${String(port)}' is not a usable port`,
      fix: 'pass --port with a number between 1 and 65535',
    };
  }

  const isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
  const explicitToken = input.flags.token?.trim();
  const token = explicitToken
    || extractOperatorToken((input.readToken ?? readOperatorTokenFile)(input.daemonHomeDir));
  if (!token) {
    return {
      ok: false,
      error: 'no operator token was found for this machine',
      fix: isLocal
        ? 'start the daemon once so it creates its operator token, or pass --token'
        : 'pass --token with the operator token from the machine you are trying to reach',
    };
  }

  return { ok: true, target: { baseUrl: buildBaseUrl(host, port, binding.tlsMode), token, isLocal } };
}

/**
 * Build the URL to CALL.
 *
 * Deliberately not `deriveControlPlaneBaseUrl`. That function answers a
 * different question — where a daemon should BIND — and it applies the
 * `hostMode` policy while doing so: with the default `local` mode it forces
 * 127.0.0.1 and discards the host it was given. For a client that is precisely
 * wrong, and it silently turned `--host 10.0.0.7` into a call to this machine.
 *
 * Here the host the operator typed is the host, full stop. Only the scheme
 * comes from configuration.
 */
function buildBaseUrl(host: string, port: number, tlsMode: string | undefined): string {
  const scheme = tlsMode && tlsMode !== 'off' && tlsMode !== 'none' ? 'https' : 'http';
  // An IPv6 literal has to be bracketed or the port reads as part of the address.
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${scheme}://${authority}:${port}`;
}

/**
 * The one thing this module needs from `fetch`.
 *
 * Narrower than `typeof fetch` on purpose: the global carries runtime-specific
 * extras (Bun adds `preconnect`) that a test double has no business
 * implementing, and requiring them would push every test into an `any`.
 */
export type DaemonFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What a verb call came back with. */
export type DaemonVerbOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string; readonly fix: string };

/**
 * Call a daemon verb.
 *
 * Every failure shape becomes an `error`/`fix` pair in plain language, because
 * this is the layer where "ECONNREFUSED" has to turn into something an operator
 * can act on. The daemon's OWN refusals already carry a fix and are passed
 * through unchanged rather than being reworded here.
 */
export async function callDaemonVerb<T>(
  target: RemoteDaemonTarget,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' },
  fetchImpl: DaemonFetch = fetch,
): Promise<DaemonVerbOutcome<T>> {
  const where = target.isLocal ? 'the daemon on this machine' : `the daemon at ${target.baseUrl}`;
  let response: Response;
  try {
    response = await fetchImpl(`${target.baseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${target.token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    return {
      ok: false,
      error: `could not reach ${where}`,
      fix: target.isLocal
        ? 'check the daemon is running: goodvibes-daemon service-status'
        : `check that machine is switched on and reachable, and that its daemon is listening on ${target.baseUrl} `
          + `(${error instanceof Error ? error.message : 'no further detail'})`,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      error: `${where} refused the operator token`,
      fix: target.isLocal
        ? 'the token may be stale — restart the daemon, or pass --token'
        : 'pass --token with the operator token from that machine (its <daemon home>/operator-tokens.json)',
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      error: `${where} does not know this command`,
      fix: 'that daemon is running an older build — update it, then try again',
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      error: `${where} sent a reply this build could not read`,
      fix: 'check that both machines are running the same version',
    };
  }
  const body = payload as { ok?: unknown; data?: unknown; error?: unknown; fix?: unknown };
  if (body.ok === true) return { ok: true, data: body.data as T };
  return {
    ok: false,
    error: typeof body.error === 'string' ? body.error : `${where} refused the request`,
    fix: typeof body.fix === 'string' ? body.fix : 'run `cluster status` to see the current state',
  };
}
