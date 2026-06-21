import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PeerRegistry,
  RemoteDispatcher,
  STDOUT_PREVIEW_LIMIT,
  BackendDispatchError,
  type Backend,
  type BackendKind,
  type RemoteWorkEnqueuer,
} from '../../../daemon/remote/index.ts';
import type { DaemonCredentialStore, OperatorLogger } from '../../../daemon/operator/index.ts';

const silentLogger: OperatorLogger = { info() {}, warn() {}, error() {} };
const noopCredentials: DaemonCredentialStore = {
  async resolveRef() {
    return null;
  },
  async resolveConfigSecret() {
    return null;
  },
  async put() {},
  async has() {
    return false;
  },
};

function fakeBackend(
  kind: BackendKind,
  impl: (command: string) => { exitCode?: number; stdout: string; stderr: string },
): Backend {
  return {
    kind,
    async dispatch(_peer, command) {
      return impl(command);
    },
  };
}

function sha256Full(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

let workDir: string;
let registry: PeerRegistry;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'gv-remote-dispatch-'));
  registry = new PeerRegistry(workDir);
  await registry.init();
});

afterEach(async () => {
  registry.close();
  await rm(workDir, { recursive: true, force: true });
});

describe('RemoteDispatcher sync path', () => {
  test('routes to the right backend by backendKind and returns exitCode', async () => {
    await registry.register({
      peerId: 'docker-peer',
      displayName: 'D',
      backendKind: 'docker',
      backendConfig: { containerName: 'web' },
    });
    const backends = new Map<BackendKind, Backend>([
      ['docker', fakeBackend('docker', (cmd) => ({ exitCode: 0, stdout: `ran:${cmd}`, stderr: '' }))],
    ]);
    const dispatcher = new RemoteDispatcher({
      registry,
      credentials: noopCredentials,
      logger: silentLogger,
      homeDirectory: workDir,
      backends,
    });
    const result = await dispatcher.dispatch({
      peerId: 'docker-peer',
      command: 'ls -la',
      principalId: 'tester',
    });
    expect(result.backendKind).toBe('docker');
    expect(result.exitCode).toBe(0);
    expect(result.completed).toBe(true);
    expect(result.stdout).toBe('ran:ls -la');
    expect(result.workId).toBeUndefined();
  });

  test('stdoutDigest is the sha256 of the FULL stdout (64 hex), even when truncated', async () => {
    const big = 'x'.repeat(STDOUT_PREVIEW_LIMIT + 500);
    await registry.register({
      peerId: 'big',
      displayName: 'Big',
      backendKind: 'local-process',
      backendConfig: {},
    });
    const backends = new Map<BackendKind, Backend>([
      ['local-process', fakeBackend('local-process', () => ({ exitCode: 0, stdout: big, stderr: '' }))],
    ]);
    const dispatcher = new RemoteDispatcher({
      registry,
      credentials: noopCredentials,
      logger: silentLogger,
      homeDirectory: workDir,
      backends,
    });
    const result = await dispatcher.dispatch({
      peerId: 'big',
      command: 'cat big',
      principalId: 'tester',
    });
    expect(result.stdout.length).toBe(STDOUT_PREVIEW_LIMIT);
    expect(result.stdoutDigest).toHaveLength(64);
    expect(result.stdoutDigest).toBe(sha256Full(big));
  });

  test('throws REMOTE_PEER_NOT_FOUND for unknown peer', async () => {
    const dispatcher = new RemoteDispatcher({
      registry,
      credentials: noopCredentials,
      logger: silentLogger,
      homeDirectory: workDir,
      backends: new Map(),
    });
    await expect(
      dispatcher.dispatch({ peerId: 'nope', command: 'echo', principalId: 't' }),
    ).rejects.toMatchObject({ code: 'REMOTE_PEER_NOT_FOUND' });
  });

  test('throws REMOTE_BACKEND_UNAVAILABLE when kind has no backend', async () => {
    await registry.register({
      peerId: 'ssh-peer',
      displayName: 'S',
      backendKind: 'ssh',
      backendConfig: {
        sshHost: 'h',
        sshUser: 'u',
        identityRef: 'goodvibes://secrets/goodvibes/K',
      },
    });
    const dispatcher = new RemoteDispatcher({
      registry,
      credentials: noopCredentials,
      logger: silentLogger,
      homeDirectory: workDir,
      backends: new Map(),
    });
    await expect(
      dispatcher.dispatch({ peerId: 'ssh-peer', command: 'echo', principalId: 't' }),
    ).rejects.toMatchObject({ code: 'REMOTE_BACKEND_UNAVAILABLE' });
  });

  test('requires non-empty command', async () => {
    await registry.register({
      peerId: 'p',
      displayName: 'P',
      backendKind: 'local-process',
      backendConfig: {},
    });
    const dispatcher = new RemoteDispatcher({
      registry,
      credentials: noopCredentials,
      logger: silentLogger,
      homeDirectory: workDir,
      backends: new Map([
        ['local-process', fakeBackend('local-process', () => ({ exitCode: 0, stdout: '', stderr: '' }))],
      ]),
    });
    await expect(
      dispatcher.dispatch({ peerId: 'p', command: '   ', principalId: 't' }),
    ).rejects.toThrow(BackendDispatchError);
  });
});

describe('RemoteDispatcher async path', () => {
  test('enqueues a work item and returns a workId without running the backend', async () => {
    await registry.register({
      peerId: 'async-peer',
      displayName: 'A',
      backendKind: 'ssh',
      backendConfig: {
        sshHost: 'h',
        sshUser: 'u',
        identityRef: 'goodvibes://secrets/goodvibes/K',
      },
    });
    let backendCalled = false;
    const backends = new Map<BackendKind, Backend>([
      ['ssh', fakeBackend('ssh', () => {
        backendCalled = true;
        return { exitCode: 0, stdout: 'should-not-run', stderr: '' };
      })],
    ]);
    const enqueued: unknown[] = [];
    const workEnqueuer: RemoteWorkEnqueuer = {
      async enqueue(item) {
        enqueued.push(item);
        return { workId: 'work-123' };
      },
    };
    const dispatcher = new RemoteDispatcher({
      registry,
      credentials: noopCredentials,
      logger: silentLogger,
      homeDirectory: workDir,
      backends,
      workEnqueuer,
    });
    const result = await dispatcher.dispatch({
      peerId: 'async-peer',
      command: 'long-running-job',
      principalId: 'tester',
      async: true,
    });
    expect(result.workId).toBe('work-123');
    expect(result.completed).toBe(false);
    expect(result.exitCode).toBeUndefined();
    expect(backendCalled).toBe(false);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      peerId: 'async-peer',
      backendKind: 'ssh',
      queuedBy: 'tester',
    });
  });

  test('falls back to sync when async requested but no enqueuer configured', async () => {
    await registry.register({
      peerId: 'no-queue',
      displayName: 'N',
      backendKind: 'local-process',
      backendConfig: {},
    });
    const dispatcher = new RemoteDispatcher({
      registry,
      credentials: noopCredentials,
      logger: silentLogger,
      homeDirectory: workDir,
      backends: new Map([
        ['local-process', fakeBackend('local-process', () => ({ exitCode: 7, stdout: 'sync', stderr: '' }))],
      ]),
    });
    const result = await dispatcher.dispatch({
      peerId: 'no-queue',
      command: 'job',
      principalId: 't',
      async: true,
    });
    expect(result.workId).toBeUndefined();
    expect(result.exitCode).toBe(7);
    expect(result.completed).toBe(true);
  });
});
