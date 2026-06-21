import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import {
  createRemoteSurface,
  registerRemoteMethods,
  registerRemoteDispatch,
  RemoteDispatcher,
  PeerRegistry,
  REMOTE_PEERS_REGISTER,
  type Backend,
  type BackendKind,
} from '../../../daemon/remote/index.ts';
import type {
  OperatorContext,
  OperatorLogger,
  DaemonCredentialStore,
} from '../../../daemon/operator/index.ts';
import { OperatorError } from '../../../daemon/operator/index.ts';

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

function fakeBackend(kind: BackendKind, stdout: string): Backend {
  return {
    kind,
    async dispatch() {
      return { exitCode: 0, stdout, stderr: '' };
    },
  };
}

let workDir: string;

// The surface only touches ctx.secrets when it must build its own credential
// store; tests always inject a dispatcher, so a stub secrets object suffices.
function makeContext(catalog: GatewayMethodCatalog): OperatorContext {
  return {
    catalog,
    secrets: {} as OperatorContext['secrets'],
    configManager: { get: () => undefined, getCategory: () => ({}) } as OperatorContext['configManager'],
    workingDirectory: workDir,
    homeDirectory: workDir,
    logger: silentLogger,
  };
}

function buildDispatcher(registry: PeerRegistry): RemoteDispatcher {
  return new RemoteDispatcher({
    registry,
    credentials: noopCredentials,
    logger: silentLogger,
    homeDirectory: workDir,
    backends: new Map<BackendKind, Backend>([
      ['local-process', fakeBackend('local-process', 'hello-from-backend')],
      ['docker', fakeBackend('docker', 'docker-out')],
    ]),
  });
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'gv-remote-register-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('remote.peers.register catalog method', () => {
  test('registers exactly remote.peers.register on the catalog', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    const ctx = makeContext(catalog);
    const registry = new PeerRegistry(workDir);
    const surface = createRemoteSurface(ctx, { peerRegistry: registry, dispatcher: buildDispatcher(registry) });
    await surface.init();
    const unregister = surface.register();

    const method = catalog.get(REMOTE_PEERS_REGISTER);
    expect(method?.id).toBe(REMOTE_PEERS_REGISTER);
    // remote.peers.invoke is NOT registered by this surface.
    expect(catalog.get('remote.peers.invoke')).toBeNull();
    // operator access maps to admin in the SDK descriptor.
    expect(method?.access).toBe('admin');

    unregister();
    expect(catalog.get(REMOTE_PEERS_REGISTER)).toBeNull();
    surface.close();
  });

  test('invoking register with confirm + explicitUserRequest persists the peer', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    const ctx = makeContext(catalog);
    const registry = new PeerRegistry(workDir);
    const surface = createRemoteSurface(ctx, { peerRegistry: registry, dispatcher: buildDispatcher(registry) });
    await surface.init();
    surface.register();

    const result = await catalog.invoke(REMOTE_PEERS_REGISTER, {
      body: {
        peerId: 'box',
        displayName: 'Box',
        backendKind: 'docker',
        backendConfig: { containerName: 'web' },
        confirm: true,
      },
      context: { principalId: 'operator', metadata: { explicitUserRequest: true } },
    });
    expect(result).toMatchObject({ peerId: 'box', registered: true, backendKind: 'docker' });
    expect(registry.get('box')?.backendConfig).toMatchObject({ containerName: 'web' });
    surface.close();
  });

  test('register rejects without confirmation', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    const ctx = makeContext(catalog);
    const registry = new PeerRegistry(workDir);
    const surface = createRemoteSurface(ctx, { peerRegistry: registry, dispatcher: buildDispatcher(registry) });
    await surface.init();
    surface.register();

    await expect(
      catalog.invoke(REMOTE_PEERS_REGISTER, {
        body: {
          peerId: 'box',
          displayName: 'Box',
          backendKind: 'docker',
          backendConfig: { containerName: 'web' },
        },
        context: { principalId: 'operator' },
      }),
    ).rejects.toThrow();
    expect(registry.get('box')).toBeNull();
    surface.close();
  });

  test('register rejects a raw credential in backendConfig', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    const ctx = makeContext(catalog);
    const registry = new PeerRegistry(workDir);
    const surface = createRemoteSurface(ctx, { peerRegistry: registry, dispatcher: buildDispatcher(registry) });
    await surface.init();
    surface.register();

    await expect(
      catalog.invoke(REMOTE_PEERS_REGISTER, {
        body: {
          peerId: 'ssh',
          displayName: 'SSH',
          backendKind: 'ssh',
          backendConfig: { sshHost: 'h', sshUser: 'u', identityRef: '-----BEGIN OPENSSH KEY-----' },
          confirm: true,
        },
        context: { principalId: 'operator', metadata: { explicitUserRequest: true } },
      }),
    ).rejects.toThrow();
    surface.close();
  });
});

describe('remote.peers.invoke dispatch adapter', () => {
  test('rejects when confirm/explicitUserRequest are absent', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    const ctx = makeContext(catalog);
    const registry = new PeerRegistry(workDir);
    await registry.init();
    await registry.register({
      peerId: 'box',
      displayName: 'Box',
      backendKind: 'local-process',
      backendConfig: {},
    });
    const surface = createRemoteSurface(ctx, { peerRegistry: registry, dispatcher: buildDispatcher(registry) });
    const dispatch = registerRemoteDispatch(surface);

    await expect(
      dispatch({ body: { peerId: 'box', command: 'echo hi' }, context: { principalId: 'op' } }),
    ).rejects.toBeInstanceOf(OperatorError);
    // missing explicitUserRequest even though confirm present
    await expect(
      dispatch({
        body: { peerId: 'box', command: 'echo hi', confirm: true },
        context: { principalId: 'op', explicitUserRequest: false },
      }),
    ).rejects.toBeInstanceOf(OperatorError);
    registry.close();
    surface.close();
  });

  test('dispatches when confirmed and returns digest + exitCode', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    const ctx = makeContext(catalog);
    const registry = new PeerRegistry(workDir);
    await registry.init();
    await registry.register({
      peerId: 'box',
      displayName: 'Box',
      backendKind: 'local-process',
      backendConfig: {},
    });
    const surface = createRemoteSurface(ctx, { peerRegistry: registry, dispatcher: buildDispatcher(registry) });
    const dispatch = registerRemoteDispatch(surface);

    const result = await dispatch({
      body: { peerId: 'box', command: 'echo hi', confirm: true },
      context: { principalId: 'op', explicitUserRequest: true },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello-from-backend');
    expect(result.stdoutDigest).toHaveLength(64);
    registry.close();
    surface.close();
  });

  test('accepts the raw SDK context.metadata.explicitUserRequest shape', async () => {
    // The unwrapped invoke adapter is wired to the existing remote.peers.invoke
    // route, which (like the SDK) delivers explicitUserRequest under
    // context.metadata. The adapter must normalize this exactly as the wrapped
    // register method does, otherwise confirmed invokes from the raw gateway
    // would be rejected.
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    const ctx = makeContext(catalog);
    const registry = new PeerRegistry(workDir);
    await registry.init();
    await registry.register({
      peerId: 'box',
      displayName: 'Box',
      backendKind: 'local-process',
      backendConfig: {},
    });
    const surface = createRemoteSurface(ctx, { peerRegistry: registry, dispatcher: buildDispatcher(registry) });
    const dispatch = registerRemoteDispatch(surface);

    const result = await dispatch({
      body: { peerId: 'box', command: 'echo hi', confirm: true },
      context: { principalId: 'op', metadata: { explicitUserRequest: true } },
    } as Parameters<typeof dispatch>[0]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello-from-backend');

    // And it still rejects when metadata says the request was not explicit.
    await expect(
      dispatch({
        body: { peerId: 'box', command: 'echo hi', confirm: true },
        context: { principalId: 'op', metadata: { explicitUserRequest: false } },
      } as Parameters<typeof dispatch>[0]),
    ).rejects.toBeInstanceOf(OperatorError);
    registry.close();
    surface.close();
  });

  test('maps unknown peer to a 404 OperatorError', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    const ctx = makeContext(catalog);
    const registry = new PeerRegistry(workDir);
    await registry.init();
    const surface = createRemoteSurface(ctx, { peerRegistry: registry, dispatcher: buildDispatcher(registry) });
    const dispatch = registerRemoteDispatch(surface);

    await expect(
      dispatch({
        body: { peerId: 'ghost', command: 'echo hi', confirm: true },
        context: { principalId: 'op', explicitUserRequest: true },
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_PEER_NOT_FOUND', status: 404 });
    registry.close();
    surface.close();
  });
});

describe('registerRemoteMethods convenience entry point', () => {
  test('initializes, registers the method, and returns a working dispatch adapter', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    const ctx = makeContext(catalog);
    const registry = new PeerRegistry(workDir);
    const registered = await registerRemoteMethods(ctx, {
      peerRegistry: registry,
      dispatcher: buildDispatcher(registry),
    });
    expect(catalog.get(REMOTE_PEERS_REGISTER)?.id).toBe(REMOTE_PEERS_REGISTER);

    await catalog.invoke(REMOTE_PEERS_REGISTER, {
      body: {
        peerId: 'box',
        displayName: 'Box',
        backendKind: 'local-process',
        backendConfig: {},
        confirm: true,
      },
      context: { principalId: 'op', metadata: { explicitUserRequest: true } },
    });

    const result = await registered.dispatch({
      body: { peerId: 'box', command: 'echo hi', confirm: true },
      context: { principalId: 'op', explicitUserRequest: true },
    });
    expect(result.stdout).toBe('hello-from-backend');

    registered.unregister();
    expect(catalog.get(REMOTE_PEERS_REGISTER)).toBeNull();
  });
});
