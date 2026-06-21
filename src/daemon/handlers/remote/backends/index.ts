import type { PeerRecord } from '../peer-registry.ts';
import { type Backend, type BackendContext } from './types.ts';
import { createLocalProcessBackend } from './local-process.ts';
import { createDockerBackend } from './docker.ts';
import { createSshBackend } from './ssh.ts';
import { createCloudTerminalBackend } from './cloud-terminal.ts';

export type {
  Backend,
  BackendContext,
  BackendDispatchResult,
  DispatchPayload,
} from './types.ts';
export {
  BackendDispatchError,
  DEFAULT_SYNC_TIMEOUT_MS,
  MAX_SYNC_TIMEOUT_MS,
  resolveTimeout,
} from './types.ts';

/**
 * Build the full backend map keyed by backendKind. Each backend resolves its
 * own credentials lazily from the daemon credential store on dispatch; no
 * network or process work happens at construction time.
 */
export function createBackends(
  ctx: BackendContext,
): Map<PeerRecord['backendKind'], Backend> {
  const backends: Backend[] = [
    createLocalProcessBackend(ctx),
    createDockerBackend(ctx),
    createSshBackend(ctx),
    createCloudTerminalBackend(ctx),
  ];
  const map = new Map<PeerRecord['backendKind'], Backend>();
  for (const backend of backends) {
    map.set(backend.kind, backend);
  }
  return map;
}
