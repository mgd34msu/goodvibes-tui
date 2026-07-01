import { describe, expect, it } from 'bun:test';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';
import { registerRemoteSurface } from '../../../daemon/handlers/remote/index.ts';
import { PeerRegistry } from '../../../daemon/handlers/remote/peer-registry.ts';
import type { HandlerContext } from '../../../daemon/handlers/context.ts';
import type { DaemonCredentialStore } from '../../../daemon/handlers/credentials.ts';
import type { RegisterRemoteSurfaceOptions } from '../../../daemon/handlers/remote/index.ts';

const stubCredentials: DaemonCredentialStore = {
  resolveRef: async () => null,
  resolveConfigSecret: async () => null,
  put: async () => {},
  has: async () => false,
};

function makeCtx(): HandlerContext {
  const dir = makeProjectTempDir('remote-surface');
  return {
    catalog: {} as HandlerContext['catalog'],
    credentials: stubCredentials,
    configManager: { get: () => undefined, getCategory: () => ({}) } as unknown as HandlerContext['configManager'],
    workingDirectory: dir,
    homeDirectory: dir,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

/** Minimal injected manager so the surface does not construct/start its own. */
const injectedManager = {
  start: async () => {},
  listPeers: () => [],
} as unknown as NonNullable<RegisterRemoteSurfaceOptions['manager']>;

async function settle(): Promise<void> {
  // Allow the backgrounded registry.init() promise to resolve.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('registerRemoteSurface', () => {
  it('returns a service, a dispatch adapter, and a teardown', () => {
    const registration = registerRemoteSurface(makeCtx(), { manager: injectedManager });
    expect(typeof registration.service.invokePeer).toBe('function');
    expect(typeof registration.dispatch.invoke).toBe('function');
    expect(typeof registration.unregister).toBe('function');
    registration.unregister();
  });

  it('routes dispatch.invoke through the service to a registered local-process peer', async () => {
    const ctx = makeCtx();
    // Seed the persisted peer store the surface reads from, then build the surface.
    const registry = new PeerRegistry(ctx.workingDirectory);
    await registry.init();
    await registry.register({
      peerId: 'self',
      displayName: 'Self',
      backendKind: 'local-process',
      backendConfig: { allowedCommands: ['printf'] },
    });
    registry.close();

    const registration = registerRemoteSurface(ctx, { manager: injectedManager });
    await settle();
    const result = (await registration.dispatch.invoke({ peerId: 'self', command: 'printf done' })) as {
      stdout: string;
      completed: boolean;
    };
    expect(result.completed).toBe(true);
    expect(result.stdout).toBe('done');
    registration.unregister();
  });

  it('dispatch.invoke and service.invokePeer reach the same backend path', async () => {
    const ctx = makeCtx();
    const registry = new PeerRegistry(ctx.workingDirectory);
    await registry.init();
    await registry.register({
      peerId: 'self',
      displayName: 'Self',
      backendKind: 'local-process',
      backendConfig: { allowedCommands: ['printf'] },
    });
    registry.close();

    const registration = registerRemoteSurface(ctx, { manager: injectedManager });
    await settle();
    const viaAdapter = (await registration.dispatch.invoke({ peerId: 'self', command: 'printf hey' })) as { stdout: string };
    const viaService = (await registration.service.invokePeer({ peerId: 'self', command: 'printf hey' })) as { stdout: string };
    expect(viaAdapter.stdout).toBe('hey');
    expect(viaService.stdout).toBe('hey');
    registration.unregister();
  });

  it('async invoke creates a manager work item and returns its workId', async () => {
    const ctx = makeCtx();
    const registry = new PeerRegistry(ctx.workingDirectory);
    await registry.init();
    await registry.register({
      peerId: 'self',
      displayName: 'Self',
      backendKind: 'local-process',
      // No allowedCommands: the async path must enqueue, never execute.
      backendConfig: {},
    });
    registry.close();

    // Manager stub that records enqueued work in its own queue, mirroring the
    // SDK DistributedRuntimeManager.enqueueWork -> listWork relationship.
    const queued: Array<{ id: string; peerId: string; command: string; queuedBy: string }> = [];
    let nextId = 1;
    const recordingManager = {
      start: async () => {},
      listPeers: () => [],
      enqueueWork: async (input: { peerId: string; command: string; actor?: string }) => {
        const work = {
          id: `work-${nextId++}`,
          peerId: input.peerId,
          command: input.command,
          queuedBy: input.actor ?? 'remote',
        };
        queued.push(work);
        return work;
      },
      listWork: () => queued,
    } as unknown as NonNullable<RegisterRemoteSurfaceOptions['manager']>;

    const registration = registerRemoteSurface(ctx, { manager: recordingManager });
    await settle();
    const result = (await registration.dispatch.invoke({
      peerId: 'self',
      command: 'long-running build',
      async: true,
      actor: 'agent-7',
    })) as { workId?: string; completed: boolean };

    expect(typeof result.workId).toBe('string');
    expect(result.workId).toBe('work-1');
    expect(result.completed).toBe(false);

    // A work item is now visible in the manager work queue (remote.work.list).
    const work = (recordingManager.listWork() as Array<{ id: string; peerId: string; command: string; queuedBy: string }>);
    expect(work).toHaveLength(1);
    expect(work[0]?.id).toBe(result.workId);
    expect(work[0]?.peerId).toBe('self');
    expect(work[0]?.command).toBe('long-running build');
    expect(work[0]?.queuedBy).toBe('agent-7');
    registration.unregister();
  });
});
