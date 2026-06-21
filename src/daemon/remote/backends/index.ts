import type { BackendKind } from '../peer-registry.ts';
import { type Backend, type BackendContext } from './types.ts';
import { createLocalProcessBackend } from './local-process.ts';
import { createDockerBackend } from './docker.ts';
import { createSshBackend } from './ssh.ts';
import { createCloudTerminalBackend } from './cloud-terminal.ts';

export type { Backend, BackendContext, BackendDispatchResult, DispatchPayload } from './types.ts';
export { BackendDispatchError, DEFAULT_SYNC_TIMEOUT_MS, MAX_SYNC_TIMEOUT_MS, resolveTimeout } from './types.ts';
export { createLocalProcessBackend } from './local-process.ts';
export { createDockerBackend } from './docker.ts';
export { createSshBackend } from './ssh.ts';
export { createCloudTerminalBackend } from './cloud-terminal.ts';
export { tokenizeCommand } from './local-process.ts';
export { runProcess } from './process-runner.ts';
export type { RunOptions, RunResult } from './process-runner.ts';

/**
 * Build the full backend registry keyed by backendKind. The dispatcher selects
 * a backend by the peer's backendKind.
 */
export function createBackends(ctx: BackendContext): Map<BackendKind, Backend> {
  const backends: Backend[] = [
    createLocalProcessBackend(ctx),
    createDockerBackend(ctx),
    createSshBackend(ctx),
    createCloudTerminalBackend(ctx),
  ];
  const registry = new Map<BackendKind, Backend>();
  for (const backend of backends) {
    registry.set(backend.kind, backend);
  }
  return registry;
}
