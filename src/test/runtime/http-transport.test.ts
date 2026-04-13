import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../config/manager.ts';
import { DaemonServer } from '../../daemon/server.ts';
import type { AgentEvent } from '../../runtime/events/index.ts';
import { RuntimeEventBus } from '../../runtime/events/index.ts';
import { createHttpTransport } from '../../runtime/transports/http.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { UserAuthManager } from '../../security/user-auth.ts';

const TEST_TOKEN = 'http-transport-token-abc123';

async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 2_000, intervalMs = 10): Promise<T> {
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

describe('HttpTransport', () => {
  let daemon: DaemonServer;
  let tempRoot: string;
  let workingDir: string;
  let homeDir: string;
  let port: number;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'gv-http-transport-'));
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
      getConversationTitle: () => 'http-transport-test',
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

  test('exposes the daemon contract over HTTP and SSE', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const transport = createHttpTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      authToken: TEST_TOKEN,
    });

    const session = await transport.operator.sessions.ensureSession({
      sessionId: 'http-transport-session',
      title: 'HTTP Transport Session',
      participant: {
        surfaceKind: 'tui',
        surfaceId: 'http-shell',
      },
    });
    expect(session.id).toBe('http-transport-session');
    expect((await transport.operator.sessions.list()).some((entry) => entry.id === session.id)).toBe(true);

    const providers = await transport.operator.providers.snapshot();
    expect(providers.providerIds.length).toBeGreaterThanOrEqual(0);
    expect((await transport.peer.getNodeHostContract()).basePath).toBe('/api/remote');

    const pair = await transport.peer.pairing.request({
      peerKind: 'node',
      label: 'http transport peer',
      requestedId: 'http-transport-peer',
      capabilities: ['invoke'],
      commands: ['sync'],
    });
    await transport.peer.pairing.approve(pair.request.id, 'tester', 'paired for http transport test');
    const verified = await transport.peer.pairing.verify(pair.request.id, pair.challenge, '10.0.0.71');
    expect(verified?.peer.id).toBeTruthy();
    expect(verified?.token.value ?? '').toContain('gvrt_');

    const invoked = await transport.peer.work.invoke({
      peerId: verified!.peer.id,
      command: 'sync-status',
      payload: { source: 'http-transport-test' },
    });
    expect(invoked.work.id).toBeTruthy();

    const seen: Array<{ type: string; agentId: string }> = [];
    const unsubscribe = transport.operator.events.agents.on('AGENT_SPAWNING', (event: Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>) => {
      seen.push({ type: event.type, agentId: event.agentId });
    });
    const task = await transport.operator.tasks.submit({ task: 'cancel me over http transport' });
    expect(task.agentId ?? '').toBeTruthy();
    const taskRecord = await waitFor(async () => {
      const tasks = await transport.operator.tasks.list();
      return tasks.find((entry) => entry.title === 'cancel me over http transport') ?? null;
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
    expect(snapshot.kind).toBe('http');
    expect(snapshot.operator.sessions.some((entry: { readonly id: string }) => entry.id === session.id)).toBe(true);
    expect(snapshot.peer.peers.some((entry: { readonly id: string }) => entry.id === verified!.peer.id)).toBe(true);
  });
});
