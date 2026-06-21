import { mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PeerRecord } from '../peer-registry.ts';
import type { CloudTerminalBackendConfig } from '../peer-registry.ts';
import {
  type Backend,
  type BackendContext,
  type BackendDispatchResult,
  type DispatchPayload,
  BackendDispatchError,
  resolveTimeout,
  buildRemoteShellCommand,
} from './types.ts';
import { runProcess } from './process-runner.ts';
import { tokenizeCommand } from './local-process.ts';

/**
 * Cloud-terminal backend: executes a command in a managed cloud shell / VM via
 * the provider CLI (gcloud / aws / az). The provider credential is resolved from
 * the daemon credential store and supplied to the CLI via a 0600 credentials
 * file or a provider-specific env var — never as an argv token, never logged.
 */
export function createCloudTerminalBackend(ctx: BackendContext): Backend {
  const credDir = join(ctx.homeDirectory, '.goodvibes', 'tui', 'operator', 'cloud-creds');

  async function writeCredentialFile(peerId: string, value: string): Promise<string> {
    await mkdir(credDir, { recursive: true });
    await chmod(credDir, 0o700).catch(() => {});
    const suffix = randomBytes(4).toString('hex');
    const path = join(credDir, `${peerId}.${suffix}.cred`);
    await writeFile(path, value, { mode: 0o600 });
    await chmod(path, 0o600).catch(() => {});
    return path;
  }

  function buildArgs(
    config: CloudTerminalBackendConfig,
    remoteCommand: string,
  ): { args: string[]; credEnvKey?: string } {
    switch (config.provider) {
      case 'gcp': {
        // gcloud compute ssh runs `command` on the target Cloud Shell / instance.
        const args = ['gcloud', 'compute', 'ssh'];
        if (config.projectId) args.push('--project', config.projectId);
        if (config.location) args.push('--zone', config.location);
        args.push(config.instance ?? 'cloudshell', '--command', remoteCommand);
        return { args, credEnvKey: 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE' };
      }
      case 'aws': {
        // aws ssm send-command style: run shell command on a managed instance.
        const args = ['aws', 'ssm', 'start-session'];
        if (config.location) args.push('--region', config.location);
        if (config.instance) args.push('--target', config.instance);
        args.push(
          '--document-name', 'AWS-StartInteractiveCommand',
          '--parameters', `command=${remoteCommand}`,
        );
        return { args, credEnvKey: 'AWS_SHARED_CREDENTIALS_FILE' };
      }
      case 'azure': {
        // az vm run-command invoke executes a script on the target VM.
        const args = ['az', 'vm', 'run-command', 'invoke'];
        if (config.projectId) args.push('--resource-group', config.projectId);
        if (config.instance) args.push('--name', config.instance);
        args.push(
          '--command-id', 'RunShellScript',
          '--scripts', remoteCommand,
        );
        return { args, credEnvKey: 'AZURE_AUTH_LOCATION' };
      }
      default:
        throw new BackendDispatchError(
          `Unsupported cloud provider: ${String(config.provider)}`,
          'REMOTE_BACKEND_UNSUPPORTED_PROVIDER',
        );
    }
  }

  return {
    kind: 'cloud-terminal',
    async dispatch(
      peer: PeerRecord,
      command: string,
      payload?: DispatchPayload,
    ): Promise<BackendDispatchResult> {
      if (peer.backendConfig.kind !== 'cloud-terminal') {
        throw new BackendDispatchError(
          `Peer '${peer.peerId}' is not a cloud-terminal peer.`,
          'REMOTE_BACKEND_KIND_MISMATCH',
        );
      }
      const config = peer.backendConfig as { kind: 'cloud-terminal' } & CloudTerminalBackendConfig;
      if (tokenizeCommand(command).length === 0) {
        throw new BackendDispatchError('Empty command.', 'REMOTE_BACKEND_BAD_COMMAND');
      }
      const credential = await ctx.credentials.resolveRef(config.credentialRef);
      if (!credential || credential.length === 0) {
        throw new BackendDispatchError(
          `Could not resolve cloud credential for peer '${peer.peerId}'.`,
          'REMOTE_BACKEND_CREDENTIAL_MISSING',
        );
      }
      const remoteCommand = buildRemoteShellCommand(command, payload?.args);
      const { args, credEnvKey } = buildArgs(config, remoteCommand);
      const credPath = await writeCredentialFile(peer.peerId, credential);
      const env: Record<string, string> = { ...(payload?.env ?? {}) };
      if (credEnvKey) env[credEnvKey] = credPath;

      ctx.logger.info('remote cloud-terminal dispatch', {
        peerId: peer.peerId,
        provider: config.provider,
      });
      try {
        const result = await runProcess({
          args,
          timeoutMs: resolveTimeout(payload),
          env,
          ...(payload?.stdin !== undefined ? { stdin: payload.stdin } : {}),
        });
        return {
          exitCode: result.timedOut ? 124 : result.exitCode,
          stdout: result.stdout,
          stderr: result.timedOut
            ? `${result.stderr}\n[remote] cloud command timed out`
            : result.stderr,
        };
      } finally {
        // The plaintext provider credential file is single-use: remove it as
        // soon as the CLI has run (or failed) so credentials never accumulate
        // on disk under cloud-creds/.
        await rm(credPath, { force: true }).catch(() => {});
      }
    },
    async teardown(): Promise<void> {
      // Per-invocation cred files are already removed in dispatch's finally;
      // sweep the cloud-creds/ dir on teardown to clear any file orphaned by a
      // hard crash mid-dispatch so no provider credential outlives the daemon.
      await rm(credDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
