import type { DaemonCredentialStore } from '../../credentials.ts';
import type { HandlerLogger } from '../../context.ts';
import type { PeerRecord } from '../peer-registry.ts';

/**
 * Payload accepted alongside a command on remote.peers.invoke. All fields are
 * optional; backends interpret what they support.
 */
export interface DispatchPayload {
  /** Positional args appended to the command (already tokenized). */
  args?: string[];
  /** Data piped to the process stdin. */
  stdin?: string;
  /** Per-invocation environment overlay (never includes secrets). */
  env?: Record<string, string>;
  /** Hard timeout for synchronous execution, in milliseconds. */
  timeoutMs?: number;
  /** Working directory override (backend-dependent). */
  cwd?: string;
}

export interface BackendDispatchResult {
  exitCode?: number;
  workId?: string;
  stdout: string;
  stderr: string;
}

export interface BackendContext {
  credentials: DaemonCredentialStore;
  logger: HandlerLogger;
  /** Daemon home dir — used for ephemeral key material under a 0700 subdir. */
  homeDirectory: string;
}

/**
 * A remote execution backend. Each backend dispatches a single command for a
 * given peer and returns the captured stdout/stderr plus an exit code.
 *
 * Backends must NEVER place raw credentials in the returned stdout/stderr or in
 * any thrown error message. Credentials are resolved internally from the daemon
 * credential store via secret references on the peer's backendConfig.
 */
export interface Backend {
  readonly kind: PeerRecord['backendKind'];
  dispatch(
    peer: PeerRecord,
    command: string,
    payload?: DispatchPayload,
  ): Promise<BackendDispatchResult>;
  /**
   * Best-effort cleanup of any on-disk material the backend created (ephemeral
   * key/credential files and their containing dirs). Called from the surface
   * teardown so secrets do not outlive the daemon process. Optional: backends
   * that write nothing to disk omit it.
   */
  teardown?(): Promise<void>;
}

export const DEFAULT_SYNC_TIMEOUT_MS = 120_000;
export const MAX_SYNC_TIMEOUT_MS = 600_000;

export function resolveTimeout(payload?: DispatchPayload): number {
  const requested = payload?.timeoutMs;
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    return Math.min(requested, MAX_SYNC_TIMEOUT_MS);
  }
  return DEFAULT_SYNC_TIMEOUT_MS;
}

export class BackendDispatchError extends Error {
  readonly code: string;
  constructor(message: string, code = 'REMOTE_BACKEND_DISPATCH_FAILED') {
    super(message);
    this.name = 'BackendDispatchError';
    this.code = code;
  }
}

/**
 * Compose the remote-shell command line for the shell-style backends
 * (docker `sh -c`, ssh remote command, cloud-CLI `--command`/`--scripts`).
 *
 * REMOTE-SHELL SEMANTICS (intentional, documented asymmetry vs local-process):
 * positional `payload.args` are joined onto the command with a single space and
 * are NOT shell-escaped, because these backends hand a single command STRING to
 * a remote shell — the operator's `command` may itself contain pipes, redirects,
 * globs, or quoting that must survive the hop verbatim. The local-process
 * backend, by contrast, never invokes a shell and passes args as discrete argv.
 *
 * This surface is operator/admin-gated (the SDK route enforces
 * confirmation/explicitUserRequest before dispatch), so callers that need
 * literal arguments must pre-quote them inside `command` or `args`.
 */
export function buildRemoteShellCommand(command: string, args?: string[]): string {
  return args && args.length > 0 ? `${command} ${args.join(' ')}` : command;
}
