import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../config/manager.ts';
import { DaemonServer } from '../../daemon/server.ts';
import type { AgentEvent } from '../../runtime/events/index.ts';
import { RuntimeEventBus } from '../../runtime/events/index.ts';
import { createRealtimeTransport } from '../../runtime/transports/realtime.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { UserAuthManager } from '../../security/user-auth.ts';

const TEST_TOKEN = 'realtime-transport-token-abc123';

async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 3_000, intervalMs = 10): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null) return value;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for value');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function createUserAuth(homeDir: string): UserAuthManager {
  return new UserAuthManager({
    bootstrapFilePath: join(homeDir, 'auth-users.json'),
    bootstrapCredentialPath: join(homeDir, 'auth-bootstrap.txt'),
    users: [{
      username: 'admin',
      passwordHash: UserAuthManager.hashPassword('admin'),
      roles: ['admin'],
    }],
  });
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to reserve test port')));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

describe('RealtimeTransport', () => {
  let daemon: DaemonServer;
  let tempRoot: string;
  let workingDir: string;
  let homeDir: string;
  let port: number;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'gv-realtime-transport-'));
    workingDir = join(tempRoot, 'workspace');
    homeDir = join(tempRoot, 'home');
    port = await reservePort();
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const runtimeServices = createRuntimeServices({
      runtimeStore: createRuntimeStore(),
      runtimeBus: new RuntimeEventBus(),
      configManager: new ConfigManager({
        configDir: join(homeDir, '.goodvibes', 'tui'),
        workingDir,
        homeDir,
      }),
      workingDir,
      homeDirectory: homeDir,
      getConversationTitle: () => 'realtime-transport-test',
    });
    daemon = new DaemonServer({
      port,
      host: '127.0.0.1',
      runtimeServices,
      userAuth: createUserAuth(homeDir),
    });
  });

  afterEach(async () => {
    await daemon?.stop();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('streams operator events over WebSocket while keeping HTTP query semantics', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const transport = createRealtimeTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      authToken: TEST_TOKEN,
    });

    const session = await transport.operator.sessions.ensureSession({
      sessionId: 'realtime-transport-session',
      title: 'Realtime Transport Session',
      participant: {
        surfaceKind: 'web',
        surfaceId: 'realtime-shell',
      },
    });
    expect((await transport.peer.getNodeHostContract()).basePath).toBe('/api/remote');

    const pair = await transport.peer.pairing.request({
      peerKind: 'device',
      label: 'realtime transport peer',
      requestedId: 'realtime-transport-peer',
      capabilities: ['invoke'],
      commands: ['sync'],
    });
    await transport.peer.pairing.approve(pair.request.id, 'tester', 'paired for realtime transport test');
    const verified = await transport.peer.pairing.verify(pair.request.id, pair.challenge, '10.0.0.72');
    expect(verified?.peer.id).toBeTruthy();

    const seen: Array<{ type: string; agentId: string }> = [];
    const unsubscribe = transport.operator.events.agents.on('AGENT_SPAWNING', (event: Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>) => {
      seen.push({ type: event.type, agentId: event.agentId });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const task = await transport.operator.tasks.submit({ task: 'cancel me over realtime transport' });
    expect(task.agentId ?? '').toBeTruthy();
    const taskRecord = await waitFor(async () => {
      const tasks = await transport.operator.tasks.list();
      return tasks.find((entry) => entry.title === 'cancel me over realtime transport') ?? null;
    });
    expect(taskRecord).toBeTruthy();
    try {
      await waitFor(() => seen[0]);
      await transport.operator.tasks.cancel(taskRecord!.id);
    } finally {
      unsubscribe();
    }

    expect(seen[0]).toBeDefined();
    expect(seen[0]!.type).toBe('AGENT_SPAWNING');
    expect(seen[0]!.agentId).toBe(task.agentId ?? '');
    const snapshot = await transport.snapshot();
    expect(snapshot.kind).toBe('realtime');
    expect(snapshot.peer.peers.some((entry: { readonly id: string }) => entry.id === verified!.peer.id)).toBe(true);
    expect(snapshot.operator.sessions.some((entry: { readonly id: string }) => entry.id === session.id)).toBe(true);
  });
});
