import type { PeerRecord } from '../peer-registry.ts';
import type { LocalProcessBackendConfig } from '../peer-registry.ts';
import {
  type Backend,
  type BackendContext,
  type BackendDispatchResult,
  type DispatchPayload,
  BackendDispatchError,
  resolveTimeout,
} from './types.ts';
import { runProcess } from './process-runner.ts';

/** Split a command string into argv, honoring single/double quotes. */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let started = false;
  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  if (quote) {
    throw new BackendDispatchError('Unterminated quote in command string.', 'REMOTE_BACKEND_BAD_COMMAND');
  }
  return tokens;
}

/**
 * Local-process backend: spawns the command directly on the daemon host. This is
 * the lowest-friction backend, used for self-hosted peers. An optional
 * allowlist on backendConfig restricts which executables may run.
 */
export function createLocalProcessBackend(ctx: BackendContext): Backend {
  return {
    kind: 'local-process',
    async dispatch(
      peer: PeerRecord,
      command: string,
      payload?: DispatchPayload,
    ): Promise<BackendDispatchResult> {
      if (peer.backendConfig.kind !== 'local-process') {
        throw new BackendDispatchError(
          `Peer '${peer.peerId}' is not a local-process peer.`,
          'REMOTE_BACKEND_KIND_MISMATCH',
        );
      }
      const config = peer.backendConfig as { kind: 'local-process' } & LocalProcessBackendConfig;
      const tokens = tokenizeCommand(command);
      if (tokens.length === 0) {
        throw new BackendDispatchError('Empty command.', 'REMOTE_BACKEND_BAD_COMMAND');
      }
      const executable = tokens[0]!;
      if (config.allowedCommands && config.allowedCommands.length > 0) {
        if (!config.allowedCommands.includes(executable)) {
          throw new BackendDispatchError(
            `Command '${executable}' is not in the peer allowlist.`,
            'REMOTE_BACKEND_COMMAND_DENIED',
          );
        }
      }
      const args = [...tokens, ...(payload?.args ?? [])];
      const cwd = payload?.cwd ?? config.cwd;
      ctx.logger.info('remote local-process dispatch', { peerId: peer.peerId, executable });
      const result = await runProcess({
        args,
        timeoutMs: resolveTimeout(payload),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(payload?.env !== undefined ? { env: payload.env } : {}),
        ...(payload?.stdin !== undefined ? { stdin: payload.stdin } : {}),
      });
      return {
        exitCode: result.timedOut ? 124 : result.exitCode,
        stdout: result.stdout,
        stderr: result.timedOut ? `${result.stderr}\n[remote] command timed out` : result.stderr,
      };
    },
  };
}
