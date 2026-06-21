import type { PeerRecord } from '../peer-registry.ts';
import type { DockerBackendConfig } from '../peer-registry.ts';
import {
  type Backend,
  type BackendContext,
  type BackendDispatchResult,
  type DispatchPayload,
  BackendDispatchError,
  resolveTimeout,
} from './types.ts';
import { runProcess } from './process-runner.ts';
import { tokenizeCommand } from './local-process.ts';

/**
 * Docker backend: runs `docker exec {containerName} {command}` against the local
 * Docker socket (or a configured DOCKER_HOST). The command is executed inside
 * the target container via `sh -c` so shell semantics survive the hop, while the
 * docker argv itself is fully tokenized (no shell on the daemon side).
 */
export function createDockerBackend(ctx: BackendContext): Backend {
  return {
    kind: 'docker',
    async dispatch(
      peer: PeerRecord,
      command: string,
      payload?: DispatchPayload,
    ): Promise<BackendDispatchResult> {
      if (peer.backendConfig.kind !== 'docker') {
        throw new BackendDispatchError(
          `Peer '${peer.peerId}' is not a docker peer.`,
          'REMOTE_BACKEND_KIND_MISMATCH',
        );
      }
      const config = peer.backendConfig as { kind: 'docker' } & DockerBackendConfig;
      if (tokenizeCommand(command).length === 0) {
        throw new BackendDispatchError('Empty command.', 'REMOTE_BACKEND_BAD_COMMAND');
      }

      // Resolve DOCKER_HOST. When it is a secret reference, pull the real value
      // from the credential store and pass it via env (never argv).
      const env: Record<string, string> = { ...(payload?.env ?? {}) };
      if (config.dockerHost) {
        const resolved = config.dockerHost.startsWith('goodvibes://')
          ? await ctx.credentials.resolveRef(config.dockerHost)
          : config.dockerHost;
        if (!resolved) {
          throw new BackendDispatchError(
            `Could not resolve dockerHost for peer '${peer.peerId}'.`,
            'REMOTE_BACKEND_CREDENTIAL_MISSING',
          );
        }
        env.DOCKER_HOST = resolved;
      }

      const innerCommand = payload?.args && payload.args.length > 0
        ? `${command} ${payload.args.join(' ')}`
        : command;

      const args = ['docker', 'exec'];
      if (payload?.stdin !== undefined) args.push('-i');
      args.push(config.containerName, 'sh', '-c', innerCommand);

      ctx.logger.info('remote docker dispatch', {
        peerId: peer.peerId,
        container: config.containerName,
      });
      const result = await runProcess({
        args,
        timeoutMs: resolveTimeout(payload),
        env,
        ...(payload?.stdin !== undefined ? { stdin: payload.stdin } : {}),
      });
      return {
        exitCode: result.timedOut ? 124 : result.exitCode,
        stdout: result.stdout,
        stderr: result.timedOut ? `${result.stderr}\n[remote] docker exec timed out` : result.stderr,
      };
    },
  };
}
