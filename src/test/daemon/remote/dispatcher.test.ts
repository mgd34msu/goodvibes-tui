import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';
import { PeerRegistry } from '../../../daemon/handlers/remote/peer-registry.ts';
import {
  RemoteDispatcher,
  STDOUT_PREVIEW_LIMIT,
  type RemoteWorkEnqueuer,
} from '../../../daemon/handlers/remote/dispatcher.ts';
import {
  type Backend,
  type BackendDispatchResult,
  type DispatchPayload,
  BackendDispatchError,
} from '../../../daemon/handlers/remote/backends/index.ts';
import type { DaemonCredentialStore } from '../../../daemon/handlers/credentials.ts';
import type { HandlerLogger } from '../../../daemon/handlers/context.ts';
import type { PeerRecord } from '../../../daemon/handlers/remote/peer-registry.ts';

const SECRET_REF = 'goodvibes://secrets/goodvibes/REMOTE_KEY';

const noopLogger: HandlerLogger = { info: () => {}, warn: () => {}, error: () => {} };
const stubCredentials: DaemonCredentialStore = {
  resolveRef: async () => null,
  resolveConfigSecret: async () => null,
  put: async () => {},
  has: async () => false,
};

function makeBackend(
  kind: PeerRecord['backendKind'],
  result: BackendDispatchResult,
  spy?: (peer: PeerRecord, command: string, payload?: DispatchPayload) => void,
): Backend {
  return {
    kind,
    async dispatch(peer, command, payload) {
      spy?.(peer, command, payload);
      return result;
    },
  };
}

async function registryWith(records: PeerRecord[]): Promise<PeerRegistry> {
  const registry = new PeerRegistry(makeProjectTempDir('remote-dispatch'));
  await registry.init();
  for (const record of records) {
    await registry.register({
      peerId: record.peerId,
      displayName: record.displayName,
      backendKind: record.backendKind,
      backendConfig: record.backendConfig as unknown as Record<string, unknown>,
    });
  }
  return registry;
}

describe('RemoteDispatcher', () => {
  it('routes by backendKind and returns a full-stdout digest with a truncated preview', async () => {
    const registry = await registryWith([
      { peerId: 'p1', displayName: 'P1', backendKind: 'ssh', backendConfig: { kind: 'ssh', sshHost: 'h', sshUser: 'u', identityRef: SECRET_REF } },
    ]);
    const bigStdout = 'a'.repeat(STDOUT_PREVIEW_LIMIT + 500);
    let seenCommand = '';
    const backends = new Map<PeerRecord['backendKind'], Backend>([
      ['ssh', makeBackend('ssh', { exitCode: 0, stdout: bigStdout, stderr: '' }, (_p, c) => { seenCommand = c; })],
    ]);
    const dispatcher = new RemoteDispatcher({
      registry,
      credentials: stubCredentials,
      logger: noopLogger,
      homeDirectory: makeProjectTempDir('remote-home'),
      backends,
    });

    const result = await dispatcher.dispatch({ peerId: 'p1', command: 'uptime', principalId: 'tester' });
    expect(seenCommand).toBe('uptime');
    expect(result.backendKind).toBe('ssh');
    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(STDOUT_PREVIEW_LIMIT);
    expect(result.stdoutDigest).toBe(createHash('sha256').update(bigStdout, 'utf-8').digest('hex'));
    registry.close();
  });

  it('routes a docker peer to the docker backend', async () => {
    const registry = await registryWith([
      { peerId: 'd1', displayName: 'D1', backendKind: 'docker', backendConfig: { kind: 'docker', containerName: 'web' } },
    ]);
    let used = '';
    const backends = new Map<PeerRecord['backendKind'], Backend>([
      ['ssh', makeBackend('ssh', { exitCode: 0, stdout: 'ssh', stderr: '' }, () => { used = 'ssh'; })],
      ['docker', makeBackend('docker', { exitCode: 0, stdout: 'docker', stderr: '' }, () => { used = 'docker'; })],
    ]);
    const dispatcher = new RemoteDispatcher({
      registry, credentials: stubCredentials, logger: noopLogger,
      homeDirectory: makeProjectTempDir('remote-home'), backends,
    });
    const result = await dispatcher.dispatch({ peerId: 'd1', command: 'ls', principalId: 'x' });
    expect(used).toBe('docker');
    expect(result.stdout).toBe('docker');
    registry.close();
  });

  it('rejects an empty peerId or command', async () => {
    const registry = await registryWith([]);
    const dispatcher = new RemoteDispatcher({
      registry, credentials: stubCredentials, logger: noopLogger,
      homeDirectory: makeProjectTempDir('remote-home'),
      backends: new Map(),
    });
    await expect(dispatcher.dispatch({ peerId: '  ', command: 'ls', principalId: 'x' })).rejects.toThrow(BackendDispatchError);
    await expect(dispatcher.dispatch({ peerId: 'p', command: '   ', principalId: 'x' })).rejects.toThrow(BackendDispatchError);
    registry.close();
  });

  it('throws REMOTE_PEER_NOT_FOUND for an unregistered peer', async () => {
    const registry = await registryWith([]);
    const dispatcher = new RemoteDispatcher({
      registry, credentials: stubCredentials, logger: noopLogger,
      homeDirectory: makeProjectTempDir('remote-home'),
      backends: new Map(),
    });
    await expect(dispatcher.dispatch({ peerId: 'ghost', command: 'ls', principalId: 'x' }))
      .rejects.toMatchObject({ code: 'REMOTE_PEER_NOT_FOUND' });
    registry.close();
  });

  it('enqueues async work and returns a workId without running the backend', async () => {
    const registry = await registryWith([
      { peerId: 'p1', displayName: 'P1', backendKind: 'local-process', backendConfig: { kind: 'local-process' } },
    ]);
    let ran = false;
    const backends = new Map<PeerRecord['backendKind'], Backend>([
      ['local-process', makeBackend('local-process', { exitCode: 0, stdout: 'should-not-run', stderr: '' }, () => { ran = true; })],
    ]);
    const enqueuer: RemoteWorkEnqueuer = {
      enqueue: async (item) => {
        expect(item.queuedBy).toBe('tester');
        expect(item.backendKind).toBe('local-process');
        return { workId: 'work-42' };
      },
    };
    const dispatcher = new RemoteDispatcher({
      registry, credentials: stubCredentials, logger: noopLogger,
      homeDirectory: makeProjectTempDir('remote-home'), backends, workEnqueuer: enqueuer,
    });
    const result = await dispatcher.dispatch({ peerId: 'p1', command: 'build', principalId: 'tester', async: true });
    expect(ran).toBe(false);
    expect(result.workId).toBe('work-42');
    expect(result.completed).toBe(false);
    registry.close();
  });

  it('teardown fans out to every backend that defines one, swallowing failures', async () => {
    const registry = await registryWith([]);
    let sshTornDown = false;
    let cloudTornDown = false;
    const sshBackend: Backend = {
      kind: 'ssh',
      dispatch: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      teardown: async () => { sshTornDown = true; },
    };
    const cloudBackend: Backend = {
      kind: 'cloud-terminal',
      dispatch: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      teardown: async () => { cloudTornDown = true; throw new Error('sweep failed'); },
    };
    // local-process backend has no teardown — must be skipped without error.
    const localBackend = makeBackend('local-process', { exitCode: 0, stdout: '', stderr: '' });
    const backends = new Map<PeerRecord['backendKind'], Backend>([
      ['ssh', sshBackend],
      ['cloud-terminal', cloudBackend],
      ['local-process', localBackend],
    ]);
    const dispatcher = new RemoteDispatcher({
      registry, credentials: stubCredentials, logger: noopLogger,
      homeDirectory: makeProjectTempDir('remote-home'), backends,
    });

    // Resolves despite the cloud backend's teardown throwing.
    await expect(dispatcher.teardown()).resolves.toBeUndefined();
    expect(sshTornDown).toBe(true);
    expect(cloudTornDown).toBe(true);
    registry.close();
  });
});
