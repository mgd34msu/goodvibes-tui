import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import {
  createRemoteSurface,
  registerRemoteDispatch,
  attachRemoteInvokeRoute,
  RemoteDispatcher,
  PeerRegistry,
  REMOTE_PEERS_INVOKE,
  REMOTE_PEERS_INVOKE_DESCRIPTOR,
  type Backend,
  type BackendKind,
} from '../../../daemon/remote/index.ts';
import type {
  OperatorContext,
  OperatorLogger,
  DaemonCredentialStore,
} from '../../../daemon/operator/index.ts';
import { OperatorError } from '../../../daemon/operator/index.ts';

// ---------------------------------------------------------------------------
// SEAM 1 — remote.peers.invoke route attachment.
//
// Verifies that attaching the dispatch adapter to the gateway-method catalog
// makes the route reachable end-to-end via catalog.invoke('remote.peers.invoke')
// (the path the SDK DaemonHttpRouter takes for POST
// /api/remote/peers/{peerId}/invoke), and that the confirmation posture
// (confirm:true + explicitUserRequest) is enforced through that path.
// ---------------------------------------------------------------------------

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
    ]),
  });
}

async function buildAttachedCatalog(): Promise<{
  catalog: GatewayMethodCatalog;
  registry: PeerRegistry;
  close: () => void;
}> {
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
  const unregister = attachRemoteInvokeRoute(catalog, dispatch);
  return {
    catalog,
    registry,
    close: () => {
      unregister();
      registry.close();
      surface.close();
    },
  };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'gv-remote-invoke-route-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('attachRemoteInvokeRoute', () => {
  test('registers remote.peers.invoke on the catalog with the http binding', async () => {
    const env = await buildAttachedCatalog();
    const method = env.catalog.get(REMOTE_PEERS_INVOKE);
    expect(method?.id).toBe(REMOTE_PEERS_INVOKE);
    expect(method?.access).toBe('admin');
    expect(method?.http).toEqual({ method: 'POST', path: '/api/remote/peers/{peerId}/invoke' });
    expect(REMOTE_PEERS_INVOKE_DESCRIPTOR.id).toBe(REMOTE_PEERS_INVOKE);
    expect(env.catalog.hasHandler(REMOTE_PEERS_INVOKE)).toBe(true);
    env.close();
  });

  test('catalog.invoke reaches the dispatch backend when confirmed', async () => {
    const env = await buildAttachedCatalog();
    const result = (await env.catalog.invoke(REMOTE_PEERS_INVOKE, {
      body: { peerId: 'box', command: 'echo hi', confirm: true },
      context: { principalId: 'op', metadata: { explicitUserRequest: true } },
    })) as { exitCode?: number; stdout: string; stdoutDigest: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello-from-backend');
    expect(result.stdoutDigest).toHaveLength(64);
    env.close();
  });

  test('catalog.invoke rejects when confirm is absent', async () => {
    const env = await buildAttachedCatalog();
    await expect(
      env.catalog.invoke(REMOTE_PEERS_INVOKE, {
        body: { peerId: 'box', command: 'echo hi' },
        context: { principalId: 'op', metadata: { explicitUserRequest: true } },
      }),
    ).rejects.toBeInstanceOf(OperatorError);
    env.close();
  });

  test('catalog.invoke rejects when explicitUserRequest is absent', async () => {
    const env = await buildAttachedCatalog();
    await expect(
      env.catalog.invoke(REMOTE_PEERS_INVOKE, {
        body: { peerId: 'box', command: 'echo hi', confirm: true },
        context: { principalId: 'op' },
      }),
    ).rejects.toBeInstanceOf(OperatorError);
    env.close();
  });

  test('replace:true overrides a pre-existing remote.peers.invoke stub', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    // Register a stub handler first that would throw if it were ever called.
    catalog.register(REMOTE_PEERS_INVOKE_DESCRIPTOR, async () => {
      throw new Error('stub must not be invoked');
    });
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
    attachRemoteInvokeRoute(catalog, registerRemoteDispatch(surface));

    const result = (await catalog.invoke(REMOTE_PEERS_INVOKE, {
      body: { peerId: 'box', command: 'echo hi', confirm: true },
      context: { principalId: 'op', metadata: { explicitUserRequest: true } },
    })) as { stdout: string };
    expect(result.stdout).toBe('hello-from-backend');
    registry.close();
    surface.close();
  });
});
