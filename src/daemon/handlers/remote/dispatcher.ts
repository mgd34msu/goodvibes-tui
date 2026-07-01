import { createHash } from 'node:crypto';
import type { HandlerLogger } from '../context.ts';
import type { DaemonCredentialStore } from '../credentials.ts';
import { PeerRegistry, type PeerRecord } from './peer-registry.ts';
import {
  type Backend,
  type BackendContext,
  type DispatchPayload,
  BackendDispatchError,
  createBackends,
} from './backends/index.ts';

/** SHA-256 of input, truncated to the first `hexChars` hex characters. */
function sha256First(input: string, hexChars: number): string {
  const digest = createHash('sha256').update(input, 'utf-8').digest('hex');
  return digest.slice(0, Math.max(0, hexChars));
}

// ---------------------------------------------------------------------------
// Work-item hook — long-running invocations are enqueued as work items visible
// in remote.work.list. The dispatcher does not own the distributed runtime; the
// integrator wires this hook to the DistributedRuntimeManager work queue.
// ---------------------------------------------------------------------------

export interface RemoteWorkItemInput {
  peerId: string;
  command: string;
  payload?: DispatchPayload;
  /** Echoed onto the work item so the runner can pick the right backend. */
  backendKind: PeerRecord['backendKind'];
  queuedBy: string;
}

export interface RemoteWorkEnqueuer {
  enqueue(item: RemoteWorkItemInput): Promise<{ workId: string }>;
}

// ---------------------------------------------------------------------------
// Invoke result — returned to the agent through remote.peers.invoke. Includes
// stdoutDigest (sha256 of FULL stdout, 64 hex chars) per the receipt contract.
// The agent may receive only a truncated stdout preview.
// ---------------------------------------------------------------------------

export const STDOUT_PREVIEW_LIMIT = 4_096;

export interface RemoteInvokeResult {
  peerId: string;
  backendKind: PeerRecord['backendKind'];
  /** Present for synchronous completion. */
  exitCode?: number;
  /** Present for async/long-running dispatch. */
  workId?: string;
  completed: boolean;
  stdout: string;
  stderr: string;
  /** SHA-256 of the full stdout, 64 hex chars. */
  stdoutDigest: string;
}

export interface RemoteDispatcherOptions {
  registry: PeerRegistry;
  credentials: DaemonCredentialStore;
  logger: HandlerLogger;
  homeDirectory: string;
  /** Optional hook for enqueuing long-running work items. */
  workEnqueuer?: RemoteWorkEnqueuer;
  /** Override the backend map (tests inject fakes). */
  backends?: Map<PeerRecord['backendKind'], Backend>;
}

export interface DispatchRequest {
  peerId: string;
  command: string;
  payload?: DispatchPayload;
  /** Principal that requested the dispatch (for work-item attribution). */
  principalId: string;
  /** When true (and a work enqueuer exists), run as an async work item. */
  async?: boolean;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * Routes remote.peers.invoke commands to the correct execution backend.
 * Synchronous commands return an exitCode; long-running commands (async:true
 * with a configured work enqueuer) return a workId tracked via remote.work.list.
 */
export class RemoteDispatcher {
  private readonly registry: PeerRegistry;
  private readonly backends: Map<PeerRecord['backendKind'], Backend>;
  private readonly workEnqueuer?: RemoteWorkEnqueuer;
  private readonly logger: HandlerLogger;

  constructor(options: RemoteDispatcherOptions) {
    this.registry = options.registry;
    this.logger = options.logger;
    if (options.workEnqueuer) this.workEnqueuer = options.workEnqueuer;
    const backendContext: BackendContext = {
      credentials: options.credentials,
      logger: options.logger,
      homeDirectory: options.homeDirectory,
    };
    this.backends = options.backends ?? createBackends(backendContext);
  }

  async dispatch(request: DispatchRequest): Promise<RemoteInvokeResult> {
    const peerId = typeof request.peerId === 'string' ? request.peerId.trim() : '';
    if (peerId.length === 0) {
      throw new BackendDispatchError('peerId is required.', 'REMOTE_PEER_ID_REQUIRED');
    }
    const command = typeof request.command === 'string' ? request.command : '';
    if (command.trim().length === 0) {
      throw new BackendDispatchError('command is required.', 'REMOTE_COMMAND_REQUIRED');
    }
    const peer = this.registry.get(peerId);
    if (!peer) {
      throw new BackendDispatchError(
        `No registered peer with id '${peerId}'.`,
        'REMOTE_PEER_NOT_FOUND',
      );
    }
    const backend = this.backends.get(peer.backendKind);
    if (!backend) {
      throw new BackendDispatchError(
        `No backend available for kind '${peer.backendKind}'.`,
        'REMOTE_BACKEND_UNAVAILABLE',
      );
    }

    // Async path: enqueue a work item and return its id immediately.
    if (request.async === true && this.workEnqueuer) {
      const { workId } = await this.workEnqueuer.enqueue({
        peerId: peer.peerId,
        command,
        backendKind: peer.backendKind,
        queuedBy: request.principalId,
        ...(request.payload !== undefined ? { payload: request.payload } : {}),
      });
      this.logger.info('remote invoke enqueued', { peerId: peer.peerId, workId });
      return {
        peerId: peer.peerId,
        backendKind: peer.backendKind,
        workId,
        completed: false,
        stdout: '',
        stderr: '',
        stdoutDigest: sha256First('', 64),
      };
    }

    // Synchronous path: run on the backend and capture output.
    const result = await backend.dispatch(peer, command, request.payload);
    const fullStdout = result.stdout ?? '';
    return {
      peerId: peer.peerId,
      backendKind: peer.backendKind,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.workId !== undefined ? { workId: result.workId } : {}),
      completed: result.workId === undefined,
      stdout: truncate(fullStdout, STDOUT_PREVIEW_LIMIT),
      stderr: truncate(result.stderr ?? '', STDOUT_PREVIEW_LIMIT),
      stdoutDigest: sha256First(fullStdout, 64),
    };
  }

  /**
   * Best-effort teardown: invoke every backend's optional teardown so ephemeral
   * key/credential material (ssh-keys/, cloud-creds/) is swept from disk and
   * does not outlive the daemon. Failures are swallowed — teardown must never
   * throw during surface shutdown.
   */
  async teardown(): Promise<void> {
    await Promise.all(
      [...this.backends.values()].map((backend) =>
        backend.teardown ? backend.teardown().catch(() => {}) : Promise.resolve(),
      ),
    );
  }
}
