import { mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PeerRecord } from '../peer-registry.ts';
import type { SshBackendConfig } from '../peer-registry.ts';
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
 * Persistent-key material is written to {homeDirectory}/.goodvibes/tui/operator/
 * ssh-keys/{peerId}.key with 0600 permissions and reused across invocations
 * (connection pooling via the OpenSSH ControlMaster multiplexer). The key value
 * itself comes only from the daemon credential store — never argv, never logs.
 */
interface PooledIdentity {
  keyPath: string;
  controlPath: string;
  identityRef: string;
}

export function createSshBackend(ctx: BackendContext): Backend {
  const pool = new Map<string, PooledIdentity>();
  const keyDir = join(ctx.homeDirectory, '.goodvibes', 'tui', 'operator', 'ssh-keys');

  async function ensureIdentity(
    peer: PeerRecord,
    config: SshBackendConfig,
  ): Promise<PooledIdentity> {
    const existing = pool.get(peer.peerId);
    if (existing && existing.identityRef === config.identityRef) {
      return existing;
    }
    const key = await ctx.credentials.resolveRef(config.identityRef);
    if (!key || key.length === 0) {
      throw new BackendDispatchError(
        `Could not resolve SSH identity for peer '${peer.peerId}'.`,
        'REMOTE_BACKEND_CREDENTIAL_MISSING',
      );
    }
    await mkdir(keyDir, { recursive: true });
    await chmod(keyDir, 0o700).catch(() => {});
    const suffix = randomBytes(4).toString('hex');
    const keyPath = join(keyDir, `${peer.peerId}.${suffix}.key`);
    const normalizedKey = key.endsWith('\n') ? key : `${key}\n`;
    await writeFile(keyPath, normalizedKey, { mode: 0o600 });
    await chmod(keyPath, 0o600).catch(() => {});
    const controlPath = join(keyDir, `${peer.peerId}.${suffix}.ctl`);
    const identity: PooledIdentity = { keyPath, controlPath, identityRef: config.identityRef };
    // Replace any prior identity for this peer and clean up its key file.
    if (existing) await rm(existing.keyPath, { force: true }).catch(() => {});
    pool.set(peer.peerId, identity);
    return identity;
  }

  return {
    kind: 'ssh',
    async dispatch(
      peer: PeerRecord,
      command: string,
      payload?: DispatchPayload,
    ): Promise<BackendDispatchResult> {
      if (peer.backendConfig.kind !== 'ssh') {
        throw new BackendDispatchError(
          `Peer '${peer.peerId}' is not an ssh peer.`,
          'REMOTE_BACKEND_KIND_MISMATCH',
        );
      }
      const config = peer.backendConfig as { kind: 'ssh' } & SshBackendConfig;
      if (tokenizeCommand(command).length === 0) {
        throw new BackendDispatchError('Empty command.', 'REMOTE_BACKEND_BAD_COMMAND');
      }
      const identity = await ensureIdentity(peer, config);
      const port = config.sshPort ?? 22;
      const target = `${config.sshUser}@${config.sshHost}`;
      const remoteCommand = payload?.args && payload.args.length > 0
        ? `${command} ${payload.args.join(' ')}`
        : command;

      const args = [
        'ssh',
        '-i', identity.keyPath,
        '-p', String(port),
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=15',
        // Connection pooling: reuse a multiplexed master for ~60s.
        '-o', 'ControlMaster=auto',
        '-o', `ControlPath=${identity.controlPath}`,
        '-o', 'ControlPersist=60',
        target,
        remoteCommand,
      ];

      ctx.logger.info('remote ssh dispatch', {
        peerId: peer.peerId,
        host: config.sshHost,
        port,
      });
      const result = await runProcess({
        args,
        timeoutMs: resolveTimeout(payload),
        ...(payload?.env !== undefined ? { env: payload.env } : {}),
        ...(payload?.stdin !== undefined ? { stdin: payload.stdin } : {}),
      });
      return {
        exitCode: result.timedOut ? 124 : result.exitCode,
        stdout: result.stdout,
        stderr: result.timedOut ? `${result.stderr}\n[remote] ssh command timed out` : result.stderr,
      };
    },
  };
}
