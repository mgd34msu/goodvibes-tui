import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonServer } from '../../daemon/server.ts';
import { HttpListener } from '../../daemon/http-listener.ts';
import { UserAuthManager } from '../../security/user-auth.ts';
import { RuntimeEventBus } from '../../runtime/events/index.ts';
import type { TransportEvent } from '../../runtime/events/transport.ts';
import { setIntegrationHelpersContext, clearIntegrationHelpersContext } from '../../runtime/integration/helpers.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { getPanelManager } from '../../panels/panel-manager.ts';
import { AutomationManager } from '../../automation/index.ts';
import { ApprovalBroker, SharedSessionBroker } from '../../control-plane/index.ts';
import { normalizeEverySchedule } from '../../automation/schedules.ts';
import { ConfigManager } from '../../config/manager.ts';
import { ChannelPolicyManager } from '../../channels/index.ts';
import { resetDistributedRuntimeManagerForTesting } from '../../runtime/remote/index.ts';

const TEST_TOKEN = 'test-secret-token-abc123';

function waitForSocketFrame(
  socket: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      reject(new Error('Timed out waiting for WebSocket frame'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
    };

    const onError = () => {
      cleanup();
      reject(new Error('WebSocket error'));
    };

    const onMessage = (event: MessageEvent<string>) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!predicate(frame)) return;
      cleanup();
      resolve(frame);
    };

    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
  });
}

// ---------------------------------------------------------------------------
// DaemonServer
// ---------------------------------------------------------------------------

describe('DaemonServer', () => {
  let daemon: DaemonServer;

  beforeEach(() => {
    AutomationManager.resetInstance();
    ApprovalBroker.resetInstance();
    SharedSessionBroker.resetInstance();
    ChannelPolicyManager.resetInstance();
    resetDistributedRuntimeManagerForTesting();
    rmSync(join(process.cwd(), '.goodvibes', 'tui', 'remote'), { recursive: true, force: true });
    rmSync(join(process.cwd(), '.goodvibes', 'tui', 'channels'), { recursive: true, force: true });
    // Use a high port to avoid conflicts with system services
    const userAuth = new UserAuthManager({
      users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
    });
    daemon = new DaemonServer({ port: 39421, host: '127.0.0.1', userAuth });
    setIntegrationHelpersContext({
      runtimeStore: createRuntimeStore(),
      runtimeBus: new RuntimeEventBus(),
      getConversationTitle: () => 'Daemon Test',
    });
    getPanelManager().registerType({
      id: 'test-helper-panel',
      name: 'Test Helper Panel',
      icon: 'T',
      category: 'monitoring',
      description: 'Test integration helper panel',
      factory: () => ({
        id: 'test-helper-panel',
        name: 'Test Helper Panel',
        icon: 'T',
        category: 'monitoring',
        isTransient: false,
        isPinned: false,
        needsRender: false,
        onActivate() {},
        onDeactivate() {},
        onDestroy() {},
        render: () => [],
      }),
    });
  });

  afterEach(async () => {
    await daemon.stop();
    AutomationManager.resetInstance();
    ApprovalBroker.resetInstance();
    SharedSessionBroker.resetInstance();
    ChannelPolicyManager.resetInstance();
    resetDistributedRuntimeManagerForTesting();
    rmSync(join(process.cwd(), '.goodvibes', 'tui', 'remote'), { recursive: true, force: true });
    rmSync(join(process.cwd(), '.goodvibes', 'tui', 'channels'), { recursive: true, force: true });
    clearIntegrationHelpersContext();
  });

  test('isRunning is false before start', () => {
    expect(daemon.isRunning).toBe(false);
  });

  test('refuses to start when disabled (default state)', async () => {
    await daemon.start();
    expect(daemon.isRunning).toBe(false);
  });

  test('enable returns false when danger.daemon is false', () => {
    const result = daemon.enable({ daemon: false }, TEST_TOKEN);
    expect(result).toBe(false);
  });

  test('enable returns true when danger.daemon is true', () => {
    const result = daemon.enable({ daemon: true }, TEST_TOKEN);
    expect(result).toBe(true);
  });

  test('starts when enabled', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    expect(daemon.isRunning).toBe(true);
  });

  test('emits transport lifecycle when starting and stopping', async () => {
    const runtimeBus = new RuntimeEventBus();
    const transportEvents: TransportEvent[] = [];
    runtimeBus.onDomain('transport', ({ payload }) => transportEvents.push(payload));
    daemon = new DaemonServer({ port: 39421, host: '127.0.0.1', userAuth: new UserAuthManager({
      users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
    }), runtimeBus });

    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    await daemon.stop();

    expect(transportEvents).toEqual([
      {
        type: 'TRANSPORT_INITIALIZING',
        transportId: 'daemon:http:127.0.0.1:39421',
        protocol: 'http-daemon',
      },
      {
        type: 'TRANSPORT_CONNECTED',
        transportId: 'daemon:http:127.0.0.1:39421',
        endpoint: 'http://127.0.0.1:39421',
      },
      {
        type: 'TRANSPORT_DISCONNECTED',
        transportId: 'daemon:http:127.0.0.1:39421',
        reason: 'Daemon server stopped',
        willRetry: false,
      },
    ]);
  });

  test('start is idempotent — does not throw when called twice', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    await daemon.start(); // second call should be a no-op
    expect(daemon.isRunning).toBe(true);
  });

  test('stop works when running', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    await daemon.stop();
    expect(daemon.isRunning).toBe(false);
  });

  test('stop is safe when not running', async () => {
    // Should not throw
    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(daemon.isRunning).toBe(false);
  });

  test('GET /status returns 401 without token', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    const res = await fetch('http://127.0.0.1:39421/status');
    expect(res.status).toBe(401);
  });

  test('POST /login returns session token for valid credentials', async () => {
    daemon.enable({ daemon: true });
    await daemon.start();
    const res = await fetch('http://127.0.0.1:39421/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(typeof body.token).toBe('string');
  });

  test('local auth admin API can inspect, add users, rotate password, and revoke sessions', async () => {
    daemon.enable({ daemon: true });
    await daemon.start();

    const login = await fetch('http://127.0.0.1:39421/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const loginBody = await login.json() as { token: string };
    const authz = { Authorization: `Bearer ${loginBody.token}`, 'Content-Type': 'application/json' };

    const inspect = await fetch('http://127.0.0.1:39421/api/local-auth', { headers: authz });
    expect(inspect.status).toBe(200);
    const inspectBody = await inspect.json() as { userCount: number };
    expect(inspectBody.userCount).toBe(1);

    const add = await fetch('http://127.0.0.1:39421/api/local-auth/users', {
      method: 'POST',
      headers: authz,
      body: JSON.stringify({ username: 'ops', password: 'supersecret', roles: ['admin', 'operator'] }),
    });
    expect(add.status).toBe(201);

    const rotate = await fetch('http://127.0.0.1:39421/api/local-auth/users/admin/password', {
      method: 'POST',
      headers: authz,
      body: JSON.stringify({ password: 'newadminpass' }),
    });
    expect(rotate.status).toBe(200);

    const relogin = await fetch('http://127.0.0.1:39421/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'newadminpass' }),
    });
    expect(relogin.status).toBe(200);
    const reloginBody = await relogin.json() as { token: string };

    const revoke = await fetch(`http://127.0.0.1:39421/api/local-auth/sessions/${reloginBody.token}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${reloginBody.token}`,
        'Content-Type': 'application/json',
      },
    });
    expect(revoke.status).toBe(200);
  });

  test('GET /status returns 401 with wrong token', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    const res = await fetch('http://127.0.0.1:39421/status', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  test('GET /status returns running status with valid token', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    const res = await fetch('http://127.0.0.1:39421/status', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('running');
  });

  test('integration helper API exposes review and panel operations', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const review = await fetch('http://127.0.0.1:39421/api/review', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(review.status).toBe(200);
    const reviewBody = await review.json() as Record<string, unknown>;
    expect(Array.isArray(reviewBody.apiFamilies)).toBe(true);
    expect(Array.isArray(reviewBody.routes)).toBe(true);
    expect((reviewBody.routes as string[]).includes('GET /api/settings')).toBe(true);

    const panels = await fetch('http://127.0.0.1:39421/api/panels', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(panels.status).toBe(200);
    const panelsBody = await panels.json() as { panels: Array<{ id: string }> };
    expect(panelsBody.panels.some((panel) => panel.id === 'test-helper-panel')).toBe(true);

    const open = await fetch('http://127.0.0.1:39421/api/panels/open', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({ id: 'test-helper-panel', pane: 'top' }),
    });
    expect(open.status).toBe(200);
    const openBody = await open.json() as Record<string, unknown>;
    expect(openBody.opened).toBe(true);

    const settings = await fetch('http://127.0.0.1:39421/api/settings', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(settings.status).toBe(200);

    const continuity = await fetch('http://127.0.0.1:39421/api/continuity', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(continuity.status).toBe(200);

    const remote = await fetch('http://127.0.0.1:39421/api/remote', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(remote.status).toBe(200);
    const remoteBody = await remote.json() as { registry: { contractEntries: unknown[] } };
    expect(Array.isArray(remoteBody.registry.contractEntries)).toBe(true);
  });

  test('remote distributed runtime supports pairing, invoke, and token rotation', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const requestPair = await fetch('http://127.0.0.1:39421/api/remote/pair/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        peerKind: 'node',
        label: 'daemon-test-node',
        requestedId: 'node-daemon-test',
        capabilities: ['invoke'],
        commands: ['status'],
      }),
    });
    expect(requestPair.status).toBe(201);
    const requested = await requestPair.json() as {
      request: { id: string };
      challenge: string;
    };

    const approve = await fetch(`http://127.0.0.1:39421/api/remote/pair/requests/${requested.request.id}/approve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ note: 'approved in test' }),
    });
    expect(approve.status).toBe(200);

    const verify = await fetch('http://127.0.0.1:39421/api/remote/pair/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: requested.request.id,
        challenge: requested.challenge,
      }),
    });
    expect(verify.status).toBe(200);
    const verified = await verify.json() as {
      peer: { id: string };
      token: { id: string; value: string };
    };

    const heartbeat = await fetch('http://127.0.0.1:39421/api/remote/heartbeat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${verified.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ version: '1.0.0' }),
    });
    expect(heartbeat.status).toBe(200);

    const invokePromise = fetch(`http://127.0.0.1:39421/api/remote/peers/${verified.peer.id}/invoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        command: 'status',
        payload: { target: 'daemon' },
        waitMs: 1_000,
      }),
    });

    const pull = await fetch('http://127.0.0.1:39421/api/remote/work/pull', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${verified.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ maxItems: 1 }),
    });
    expect(pull.status).toBe(200);
    const pulled = await pull.json() as { work: Array<{ id: string; status: string }> };
    expect(pulled.work).toHaveLength(1);
    expect(pulled.work[0]?.status).toBe('claimed');

    const complete = await fetch(`http://127.0.0.1:39421/api/remote/work/${pulled.work[0]!.id}/complete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${verified.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        result: { ok: true, summary: 'status collected' },
      }),
    });
    expect(complete.status).toBe(200);

    const invoke = await invokePromise;
    expect(invoke.status).toBe(202);
    const invokeBody = await invoke.json() as { completed: boolean; work: { status: string } };
    expect(invokeBody.completed).toBe(true);
    expect(invokeBody.work.status).toBe('completed');

    const rotate = await fetch(`http://127.0.0.1:39421/api/remote/peers/${verified.peer.id}/token/rotate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ label: 'rotated-token' }),
    });
    expect(rotate.status).toBe(200);
    const rotated = await rotate.json() as { token: { value: string } };

    const oldHeartbeat = await fetch('http://127.0.0.1:39421/api/remote/heartbeat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${verified.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(oldHeartbeat.status).toBe(401);

    const newHeartbeat = await fetch('http://127.0.0.1:39421/api/remote/heartbeat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rotated.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(newHeartbeat.status).toBe(200);

    const limitedRotate = await fetch(`http://127.0.0.1:39421/api/remote/peers/${verified.peer.id}/token/rotate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ label: 'heartbeat-only', scopes: ['remote:heartbeat'] }),
    });
    expect(limitedRotate.status).toBe(200);
    const limited = await limitedRotate.json() as { token: { value: string } };

    const limitedHeartbeat = await fetch('http://127.0.0.1:39421/api/remote/heartbeat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${limited.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(limitedHeartbeat.status).toBe(200);

    const limitedPull = await fetch('http://127.0.0.1:39421/api/remote/work/pull', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${limited.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ maxItems: 1 }),
    });
    expect(limitedPull.status).toBe(403);
  });

  test('remote peer disconnect requeues claimed work for later pulls', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const requestPair = await fetch('http://127.0.0.1:39421/api/remote/pair/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        peerKind: 'device',
        label: 'daemon-test-device',
        requestedId: 'device-daemon-test',
      }),
    });
    const requested = await requestPair.json() as { request: { id: string }; challenge: string };

    await fetch(`http://127.0.0.1:39421/api/remote/pair/requests/${requested.request.id}/approve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const verify = await fetch('http://127.0.0.1:39421/api/remote/pair/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: requested.request.id,
        challenge: requested.challenge,
      }),
    });
    const verified = await verify.json() as { peer: { id: string }; token: { value: string } };

    const invoke = await fetch(`http://127.0.0.1:39421/api/remote/peers/${verified.peer.id}/invoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        command: 'status',
      }),
    });
    expect(invoke.status).toBe(202);

    const pull = await fetch('http://127.0.0.1:39421/api/remote/work/pull', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${verified.token.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ maxItems: 1 }),
    });
    const pulled = await pull.json() as { work: Array<{ id: string; status: string }> };
    expect(pulled.work[0]?.status).toBe('claimed');

    const disconnect = await fetch(`http://127.0.0.1:39421/api/remote/peers/${verified.peer.id}/disconnect`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requeueClaimedWork: true }),
    });
    expect(disconnect.status).toBe(200);

    const work = await fetch('http://127.0.0.1:39421/api/remote/work', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const workBody = await work.json() as { work: Array<{ status: string }> };
    expect(workBody.work.some((entry) => entry.status === 'queued')).toBe(true);
  });

  test('automation helper API exposes jobs and recent runs', async () => {
    await AutomationManager.getInstance().createJob({
      name: 'API Heartbeat',
      prompt: 'Send a daemon heartbeat',
      schedule: normalizeEverySchedule('15m'),
      enabled: true,
    });

    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const automation = await fetch('http://127.0.0.1:39421/api/automation', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(automation.status).toBe(200);
    const body = await automation.json() as { totals: { jobs: number }; jobs: Array<{ name: string }> };
    expect(body.totals.jobs).toBeGreaterThanOrEqual(1);
    expect(body.jobs.some((job) => job.name === 'API Heartbeat')).toBe(true);
  });

  test('automation control-plane API can create and run jobs', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const create = await fetch('http://127.0.0.1:39421/api/automation/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        kind: 'every',
        every: '30m',
        name: 'API Created Job',
        prompt: 'Run API-created automation',
      }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { id: string; name: string };
    expect(created.name).toBe('API Created Job');

    const run = await fetch(`http://127.0.0.1:39421/api/automation/jobs/${created.id}/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(run.status).toBe(200);
    const runBody = await run.json() as { jobId: string; runId: string };
    expect(runBody.jobId).toBe(created.id);
    expect(typeof runBody.runId).toBe('string');
  });

  test('automation API can update execution and delivery policy', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const create = await fetch('http://127.0.0.1:39421/api/automation/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        kind: 'every',
        every: '45m',
        name: 'Patchable Job',
        prompt: 'Ship the morning report',
      }),
    });
    const created = await create.json() as { id: string };

    const patch = await fetch(`http://127.0.0.1:39421/api/automation/jobs/${created.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        target: {
          kind: 'route',
          routeId: 'route-1',
          preserveThread: true,
        },
        delivery: {
          mode: 'webhook',
          targets: [{ kind: 'webhook', address: 'https://example.invalid/automation' }],
          fallbackTargets: [],
          includeSummary: true,
          includeTranscript: false,
          includeLinks: true,
        },
        failure: {
          action: 'dead_letter',
          maxConsecutiveFailures: 5,
          cooldownMs: 60_000,
          retryPolicy: {
            maxAttempts: 4,
            delayMs: 1_000,
            strategy: 'linear',
          },
        },
        deleteAfterRun: true,
      }),
    });
    expect(patch.status).toBe(200);
    const updated = await patch.json() as {
      execution: { target: { kind: string; routeId: string } };
      delivery: { mode: string; targets: Array<{ address: string }> };
      failure: { action: string; retryPolicy: { maxAttempts: number } };
      deleteAfterRun: boolean;
    };
    expect(updated.execution.target.kind).toBe('route');
    expect(updated.execution.target.routeId).toBe('route-1');
    expect(updated.delivery.mode).toBe('webhook');
    expect(updated.delivery.targets[0]?.address).toContain('example.invalid');
    expect(updated.failure.action).toBe('dead_letter');
    expect(updated.failure.retryPolicy.maxAttempts).toBe(4);
    expect(updated.deleteAfterRun).toBe(true);
  });

  test('control-plane gateway exposes snapshot, web shell, and event stream', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const stream = await fetch(`http://127.0.0.1:39421/api/control-plane/events?token=${TEST_TOKEN}&domains=control-plane`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await reader!.read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain('event: ready');

    const snapshot = await fetch('http://127.0.0.1:39421/api/control-plane', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(snapshot.status).toBe(200);
    const snapshotBody = await snapshot.json() as { totals: { clients: number } };
    expect(snapshotBody.totals.clients).toBeGreaterThanOrEqual(1);

    const clients = await fetch('http://127.0.0.1:39421/api/control-plane/clients', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(clients.status).toBe(200);
    const clientsBody = await clients.json() as { clients: Array<{ surface: string }> };
    expect(clientsBody.clients.some((client) => client.surface === 'web')).toBe(true);

    const web = await fetch(`http://127.0.0.1:39421/api/control-plane/web?token=${TEST_TOKEN}`);
    expect(web.status).toBe(200);
    expect(web.headers.get('content-type')).toContain('text/html');
    const html = await web.text();
    expect(html).toContain('goodvibes control plane');
    expect(html).toContain('Approvals');
    expect(html).toContain('Sessions');
    expect(html).toContain('Deliveries');

    await reader!.cancel();
  });

  test('control-plane gateway exposes websocket transport and method calls', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const socket = new WebSocket(`ws://127.0.0.1:39421/api/control-plane/ws?token=${TEST_TOKEN}&clientKind=web&domains=control-plane,automation`);
    const ready = await waitForSocketFrame(socket, (frame) => frame.type === 'event' && frame.event === 'ready');
    expect(ready.type).toBe('event');

    socket.send(JSON.stringify({ type: 'ping' }));
    const pong = await waitForSocketFrame(socket, (frame) => frame.type === 'pong');
    expect(pong.type).toBe('pong');

    socket.send(JSON.stringify({
      type: 'call',
      id: 'snapshot-1',
      method: 'GET',
      path: '/api/control-plane',
    }));
    const snapshot = await waitForSocketFrame(socket, (frame) => frame.type === 'response' && frame.id === 'snapshot-1');
    expect(snapshot.ok).toBe(true);
    expect(((snapshot.body as { totals?: { clients?: number } }).totals?.clients ?? 0)).toBeGreaterThanOrEqual(1);

    socket.send(JSON.stringify({
      type: 'subscribe',
      domains: ['routes'],
    }));
    const subscribed = await waitForSocketFrame(socket, (frame) => frame.type === 'subscribed');
    expect(subscribed.type).toBe('subscribed');

    socket.close();
  });

  test('shared session APIs can create, inspect, and continue sessions', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const create = await fetch('http://127.0.0.1:39421/api/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Ops session',
        surfaceKind: 'web',
        surfaceId: 'surface:web',
      }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { session: { id: string } };
    expect(typeof created.session.id).toBe('string');

    const send = await fetch(`http://127.0.0.1:39421/api/sessions/${created.session.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        body: 'Summarize the session state',
        surfaceKind: 'web',
        surfaceId: 'surface:web',
      }),
    });
    expect(send.status).toBe(202);
    const sendBody = await send.json() as { session: { id: string }; agentId: string };
    expect(sendBody.session.id).toBe(created.session.id);
    expect(typeof sendBody.agentId).toBe('string');

    const inspect = await fetch(`http://127.0.0.1:39421/api/sessions/${created.session.id}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(inspect.status).toBe(200);
    const inspectBody = await inspect.json() as { messages: Array<{ role: string }> };
    expect(inspectBody.messages.some((message) => message.role === 'user')).toBe(true);
  });

  test('approval APIs expose pending approvals and allow resolution', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const broker = ApprovalBroker.getInstance();
    const pendingDecision = broker.requestApproval({
      request: {
        callId: 'call-approval-test',
        tool: 'write',
        args: { path: '/tmp/demo.txt' },
        category: 'write',
        analysis: {
          classification: 'write',
          riskLevel: 'medium',
          summary: 'Write demo file',
          reasons: ['Needs operator approval'],
          target: '/tmp/demo.txt',
          targetKind: 'path',
        },
      },
      sessionId: 'sess-approval',
    });

    const approvals = await fetch('http://127.0.0.1:39421/api/approvals', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(approvals.status).toBe(200);
    const approvalsBody = await approvals.json() as { approvals: Array<{ id: string; callId: string; status: string }> };
    const approval = approvalsBody.approvals.find((entry) => entry.callId === 'call-approval-test');
    expect(approval).toBeDefined();
    expect(approval?.status).toBe('pending');

    const approve = await fetch(`http://127.0.0.1:39421/api/approvals/${approval!.id}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(approve.status).toBe(200);
    const decision = await pendingDecision;
    expect(decision.approved).toBe(true);
  });

  test('route bindings API can upsert and delete bindings', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const create = await fetch('http://127.0.0.1:39421/api/routes/bindings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        kind: 'thread',
        surfaceKind: 'webhook',
        surfaceId: 'test-surface',
        externalId: 'external-1',
        threadId: 'thread-1',
        sessionId: 'session-1',
      }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { id: string };
    expect(created.id).toMatch(/^route-/);

    const duplicate = await fetch('http://127.0.0.1:39421/api/routes/bindings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        kind: 'thread',
        surfaceKind: 'webhook',
        surfaceId: 'test-surface',
        externalId: 'external-1',
        threadId: 'thread-1',
        sessionId: 'session-2',
      }),
    });
    expect(duplicate.status).toBe(201);
    const duplicated = await duplicate.json() as { id: string };
    expect(duplicated.id).toBe(created.id);

    const list = await fetch('http://127.0.0.1:39421/api/routes/bindings', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(list.status).toBe(200);
    const listBody = await list.json() as { bindings: Array<{ id: string; surfaceKind: string }> };
    expect(listBody.bindings.some((binding) => binding.id === created.id && binding.surfaceKind === 'webhook')).toBe(true);
    expect(listBody.bindings.filter((binding) => binding.id === created.id)).toHaveLength(1);

    const remove = await fetch(`http://127.0.0.1:39421/api/routes/bindings/${created.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(remove.status).toBe(200);
  });

  test('channel policy APIs expose group-aware policy state, status, directory, and block webhook ingress', async () => {
    const config = new ConfigManager();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-test-secret');
    daemon = new DaemonServer({
      port: 39421,
      host: '127.0.0.1',
      userAuth: new UserAuthManager({
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
      }),
    }, config);
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const policyUpdate = await fetch('http://127.0.0.1:39421/api/channels/policies/webhook', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        allowlistUserIds: ['alice'],
        allowDirectMessages: false,
        allowlistGroupIds: ['policy-channel'],
        groupPolicies: [{
          id: 'policy-group',
          groupId: 'policy-channel',
          requireMention: true,
          allowedCommands: ['/run'],
        }],
      }),
    });
    expect(policyUpdate.status).toBe(200);
    const updatedPolicy = await policyUpdate.json() as { allowDirectMessages: boolean; groupPolicies: Array<{ id: string }> };
    expect(updatedPolicy.allowDirectMessages).toBe(false);
    expect(updatedPolicy.groupPolicies[0]?.id).toBe('policy-group');

    const policies = await fetch('http://127.0.0.1:39421/api/channels/policies', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(policies.status).toBe(200);
    const policyBody = await policies.json() as { policies: Array<{ surface: string }> };
    expect(policyBody.policies.some((policy) => policy.surface === 'webhook')).toBe(true);

    const blocked = await fetch('http://127.0.0.1:39421/webhook/generic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Webhook-Secret': 'webhook-test-secret',
      },
      body: JSON.stringify({
        userId: 'bob',
        externalId: 'policy-blocked',
        conversationKind: 'direct',
        message: 'blocked by policy',
      }),
    });
    expect(blocked.status).toBe(403);

    const blockedCommand = await fetch('http://127.0.0.1:39421/webhook/generic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Webhook-Secret': 'webhook-test-secret',
      },
      body: JSON.stringify({
        userId: 'alice',
        externalId: 'policy-blocked-command',
        channelId: 'policy-channel',
        groupId: 'policy-channel',
        conversationKind: 'channel',
        message: '/status',
      }),
    });
    expect(blockedCommand.status).toBe(403);

    const allowed = await fetch('http://127.0.0.1:39421/webhook/generic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Webhook-Secret': 'webhook-test-secret',
      },
      body: JSON.stringify({
        userId: 'alice',
        externalId: 'policy-allowed',
        channelId: 'policy-channel',
        groupId: 'policy-channel',
        conversationKind: 'channel',
        message: '/run policy',
        title: 'Policy Allowed',
        mentioned: true,
        members: [
          { id: 'alice', label: 'Alice Example', handle: '@alice' },
          { id: 'ops-bot', label: 'Ops Bot', handle: '@ops-bot' },
        ],
      }),
    });
    expect(allowed.status).toBe(200);

    const directory = await fetch('http://127.0.0.1:39421/api/channels/directory/webhook?q=policy&scope=groups&groupId=policy-channel&limit=1', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(directory.status).toBe(200);
    const directoryBody = await directory.json() as { entries: Array<{ id: string; groupId?: string; isGroupConversation?: boolean }> };
    expect(directoryBody.entries).toHaveLength(1);
    expect(directoryBody.entries[0]?.groupId).toBe('policy-channel');
    expect(directoryBody.entries[0]?.isGroupConversation).toBe(true);

    const members = await fetch('http://127.0.0.1:39421/api/channels/directory/webhook?scope=members&groupId=policy-channel', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(members.status).toBe(200);
    const membersBody = await members.json() as { entries: Array<{ kind: string; label: string }> };
    expect(membersBody.entries.some((entry) => entry.kind === 'member' && entry.label === 'Alice Example')).toBe(true);

    const status = await fetch('http://127.0.0.1:39421/api/channels/status', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(status.status).toBe(200);
    const statusBody = await status.json() as { channels: Array<{ surface: string }> };
    expect(statusBody.channels.some((channel) => channel.surface === 'webhook')).toBe(true);

    const audit = await fetch('http://127.0.0.1:39421/api/channels/policies/audit', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(audit.status).toBe(200);
    const auditBody = await audit.json() as { audit: Array<{ surface: string; allowed: boolean; reason: string; conversationKind?: string; matchedGroupPolicyId?: string }> };
    expect(auditBody.audit.some((entry) => entry.surface === 'webhook' && entry.allowed === false && entry.reason === 'direct-messages-disabled')).toBe(true);
    expect(auditBody.audit.some((entry) => entry.matchedGroupPolicyId === 'policy-group' && entry.conversationKind === 'channel')).toBe(true);
  });

  test('channel policy APIs allow authorized control commands to bypass mention gating when configured', async () => {
    const config = new ConfigManager();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-test-secret');
    daemon = new DaemonServer({
      port: 39421,
      host: '127.0.0.1',
      userAuth: new UserAuthManager({
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
      }),
    }, config);
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const policyUpdate = await fetch('http://127.0.0.1:39421/api/channels/policies/webhook', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requireMention: true,
        allowTextCommandsWithoutMention: true,
        allowedCommands: ['status'],
      }),
    });
    expect(policyUpdate.status).toBe(200);

    const allowed = await fetch('http://127.0.0.1:39421/webhook/generic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Webhook-Secret': 'webhook-test-secret',
      },
      body: JSON.stringify({
        externalId: 'policy-bypass-allowed',
        channelId: 'ops-room',
        groupId: 'ops-room',
        conversationKind: 'channel',
        mentioned: false,
        hasAnyMention: false,
        controlCommand: 'status',
        message: 'status run-123',
      }),
    });
    expect(allowed.status).toBe(200);

    const blocked = await fetch('http://127.0.0.1:39421/webhook/generic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Webhook-Secret': 'webhook-test-secret',
      },
      body: JSON.stringify({
        externalId: 'policy-bypass-blocked',
        channelId: 'ops-room',
        groupId: 'ops-room',
        conversationKind: 'channel',
        mentioned: false,
        hasAnyMention: false,
        controlCommand: 'retry',
        message: 'retry run-123',
      }),
    });
    expect(blocked.status).toBe(403);
  });

  test('channel account APIs expose surface auth and secret posture', async () => {
    const config = new ConfigManager();
    config.setDynamic('surfaces.slack.enabled', true);
    config.setDynamic('surfaces.slack.workspaceId', 'workspace-1');
    config.setDynamic('surfaces.slack.botToken', 'xoxb-local');
    config.setDynamic('surfaces.slack.signingSecret', 'signing-secret');
    config.setDynamic('surfaces.slack.defaultChannel', 'ops-alerts');
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.defaultTarget', 'https://example.com/hook');
    config.setDynamic('surfaces.webhook.secret', 'shared-secret');
    daemon = new DaemonServer({
      port: 39421,
      host: '127.0.0.1',
      userAuth: new UserAuthManager({
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
      }),
    }, config);
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const accounts = await fetch('http://127.0.0.1:39421/api/channels/accounts', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(accounts.status).toBe(200);
    const accountsBody = await accounts.json() as {
      accounts: Array<{ surface: string; configured: boolean; linked: boolean; authState: string; secrets: Array<{ field: string; source: string }> }>;
    };
    const slackAccount = accountsBody.accounts.find((entry) => entry.surface === 'slack');
    expect(slackAccount?.configured).toBe(true);
    expect(slackAccount?.linked).toBe(true);
    expect(slackAccount?.authState).toBe('linked');
    expect(slackAccount?.secrets.some((entry) => entry.field === 'primary' && entry.source === 'config')).toBe(true);

    const slackAccounts = await fetch('http://127.0.0.1:39421/api/channels/accounts/slack', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(slackAccounts.status).toBe(200);
    const slackAccountsBody = await slackAccounts.json() as { accounts: Array<{ accountId?: string }> };
    expect(slackAccountsBody.accounts[0]?.accountId).toBe('workspace-1');

    const slackSingle = await fetch('http://127.0.0.1:39421/api/channels/accounts/slack/workspace-1', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(slackSingle.status).toBe(200);
    const slackSingleBody = await slackSingle.json() as {
      surface: string;
      state: string;
      actions: Array<{ id: string; available: boolean }>;
      metadata: { defaultChannel?: string };
    };
    expect(slackSingleBody.surface).toBe('slack');
    expect(slackSingleBody.state).toBe('healthy');
    expect(slackSingleBody.actions.some((action) => action.id === 'inspect' && action.available)).toBe(true);
    expect(slackSingleBody.metadata.defaultChannel).toBe('ops-alerts');

    const capabilities = await fetch('http://127.0.0.1:39421/api/channels/capabilities/slack', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(capabilities.status).toBe(200);
    const capabilitiesBody = await capabilities.json() as { capabilities: Array<{ id: string; supported: boolean }> };
    expect(capabilitiesBody.capabilities.some((entry) => entry.id === 'tooling' && entry.supported)).toBe(true);

    const tools = await fetch('http://127.0.0.1:39421/api/channels/tools/slack', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(tools.status).toBe(200);
    const toolsBody = await tools.json() as { tools: Array<{ name: string; id: string }> };
    expect(toolsBody.tools.some((entry) => entry.name === 'slack_account' && entry.id === 'slack:account')).toBe(true);

    const toolRun = await fetch('http://127.0.0.1:39421/api/channels/tools/slack/slack%3Aaccount', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accountId: 'workspace-1' }),
    });
    expect(toolRun.status).toBe(200);
    const toolRunBody = await toolRun.json() as { result: { accountId?: string } };
    expect(toolRunBody.result.accountId).toBe('workspace-1');

    const actions = await fetch('http://127.0.0.1:39421/api/channels/actions/slack', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(actions.status).toBe(200);
    const actionsBody = await actions.json() as { actions: Array<{ id: string }> };
    expect(actionsBody.actions.some((entry) => entry.id === 'inspect-account')).toBe(true);

    const actionRun = await fetch('http://127.0.0.1:39421/api/channels/actions/slack/inspect-account', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accountId: 'workspace-1' }),
    });
    expect(actionRun.status).toBe(200);
    const actionRunBody = await actionRun.json() as { result: { accountId?: string } };
    expect(actionRunBody.result.accountId).toBe('workspace-1');

    const accountAction = await fetch('http://127.0.0.1:39421/api/channels/accounts/slack/workspace-1/actions/retest', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(accountAction.status).toBe(200);
    const accountActionBody = await accountAction.json() as { result: { action: string; ok: boolean } };
    expect(accountActionBody.result.action).toBe('retest');
    expect(accountActionBody.result.ok).toBe(true);

    const setupAction = await fetch('http://127.0.0.1:39421/api/channels/accounts/slack/workspace-1/actions/login', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ clientId: 'C123', redirectUri: 'https://goodvibes.local/oauth/slack' }),
    });
    expect(setupAction.status).toBe(200);
    const setupActionBody = await setupAction.json() as { result: { login?: { kind: string; url?: string }; ok: boolean } };
    expect(setupActionBody.result.ok).toBe(true);
    expect(setupActionBody.result.login?.kind).toBe('browser');
    expect(setupActionBody.result.login?.url).toContain('slack.com/oauth/v2/authorize');

    const targetResolve = await fetch('http://127.0.0.1:39421/api/channels/targets/slack/resolve', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ target: '#ops-alerts', createIfMissing: true }),
    });
    expect(targetResolve.status).toBe(200);
    const targetResolveBody = await targetResolve.json() as { target: { kind: string; to: string; sessionTarget: string; source: string } };
    expect(targetResolveBody.target.kind).toBe('channel');
    expect(targetResolveBody.target.to).toBe('ops-alerts');
    expect(targetResolveBody.target.sessionTarget).toBe('channel:slack:ops-alerts');

    const agentTools = await fetch('http://127.0.0.1:39421/api/channels/agent-tools/slack', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(agentTools.status).toBe(200);
    const agentToolsBody = await agentTools.json() as { tools: Array<{ name: string }> };
    expect(agentToolsBody.tools.some((entry) => entry.name === 'slack_target')).toBe(true);

    const authorize = await fetch('http://127.0.0.1:39421/api/channels/authorize/slack', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ actionId: 'inspect', accountId: 'workspace-1', target: '#ops-alerts' }),
    });
    expect(authorize.status).toBe(200);
    const authorizeBody = await authorize.json() as { result: { allowed: boolean; actionAvailable: boolean } };
    expect(authorizeBody.result.allowed).toBe(true);
    expect(authorizeBody.result.actionAvailable).toBe(true);

    const providerApi = await fetch('http://127.0.0.1:39421/api/channels/actions/slack/provider-api', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operation: 'oauth_url', clientId: 'C123' }),
    });
    expect(providerApi.status).toBe(200);
    const providerApiBody = await providerApi.json() as { result: { ok: boolean; url?: string } };
    expect(providerApiBody.result.ok).toBe(true);
    expect(providerApiBody.result.url).toContain('slack.com/oauth/v2/authorize');

    const integratedAccounts = await fetch('http://127.0.0.1:39421/api/accounts', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(integratedAccounts.status).toBe(200);
    const integratedBody = await integratedAccounts.json() as {
      channelCount: number;
      channels: Array<{ surface: string }>;
    };
    expect(integratedBody.channelCount).toBeGreaterThan(0);
    expect(integratedBody.channels.some((entry) => entry.surface === 'slack')).toBe(true);
  });

  test('surface, watcher, and service APIs expose control-plane support state', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const surfaces = await fetch('http://127.0.0.1:39421/api/surfaces', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(surfaces.status).toBe(200);
    const surfacesBody = await surfaces.json() as { surfaces: Array<{ kind: string }> };
    expect(surfacesBody.surfaces.some((surface) => surface.kind === 'tui')).toBe(true);
    expect(surfacesBody.surfaces.some((surface) => surface.kind === 'web')).toBe(true);

    const watchers = await fetch('http://127.0.0.1:39421/api/watchers', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(watchers.status).toBe(200);
    const watchersBody = await watchers.json() as { watchers: unknown[] };
    expect(Array.isArray(watchersBody.watchers)).toBe(true);

    const service = await fetch('http://127.0.0.1:39421/api/service/status', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(service.status).toBe(200);
    const serviceBody = await service.json() as { platform: string; suggestedCommands: string[] };
    expect(typeof serviceBody.platform).toBe('string');
    expect(Array.isArray(serviceBody.suggestedCommands)).toBe(true);
  });

  test('watcher control APIs can register, run, stop, and delete watchers', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const create = await fetch('http://127.0.0.1:39421/api/watchers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        id: 'watcher-api-test',
        label: 'API watcher',
        intervalMs: 50,
      }),
    });
    expect(create.status).toBe(201);

    const update = await fetch('http://127.0.0.1:39421/api/watchers/watcher-api-test', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        label: 'API watcher updated',
        kind: 'manual',
        sourceKind: 'api',
      }),
    });
    expect(update.status).toBe(200);
    const updated = await update.json() as { label?: string; kind?: string };
    expect(updated.label).toBe('API watcher updated');
    expect(updated.kind).toBe('manual');

    const start = await fetch('http://127.0.0.1:39421/api/watchers/watcher-api-test/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(start.status).toBe(200);
    const started = await start.json() as { state: string };
    expect(started.state).toBe('running');

    const run = await fetch('http://127.0.0.1:39421/api/watchers/watcher-api-test/run', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(run.status).toBe(200);
    const ran = await run.json() as { lastCheckpoint?: string };
    expect(typeof ran.lastCheckpoint).toBe('string');

    const stop = await fetch('http://127.0.0.1:39421/api/watchers/watcher-api-test/stop', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(stop.status).toBe(200);

    const remove = await fetch('http://127.0.0.1:39421/api/watchers/watcher-api-test', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(remove.status).toBe(200);
  });

  test('generic webhook can create bindings and queue callback-based replies', async () => {
    const config = new ConfigManager();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-test-secret');
    daemon = new DaemonServer({
      port: 39421,
      host: '127.0.0.1',
      userAuth: new UserAuthManager({
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
      }),
    }, config);
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    await fetch('http://127.0.0.1:39421/api/channels/policies/webhook', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ allowlistUserIds: [] }),
    });

    const generic = await fetch('http://127.0.0.1:39421/webhook/generic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Webhook-Secret': 'webhook-test-secret',
      },
      body: JSON.stringify({
        surfaceId: 'ci-gateway',
        externalId: 'build-123',
        callbackUrl: 'https://example.com/callback',
        message: 'summarize the current build failure',
        title: 'CI gateway',
      }),
    });
    expect(generic.status).toBe(200);
    const genericBody = await generic.json() as { acknowledged: boolean; queued: boolean; bindingId: string; agentId: string };
    expect(genericBody.acknowledged).toBe(true);
    expect(genericBody.queued).toBe(true);
    expect(typeof genericBody.bindingId).toBe('string');
    expect(typeof genericBody.agentId).toBe('string');

    const list = await fetch('http://127.0.0.1:39421/api/routes/bindings', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const listBody = await list.json() as { bindings: Array<{ id: string; surfaceKind: string; externalId: string }> };
    expect(listBody.bindings.some((binding) => binding.id === genericBody.bindingId && binding.surfaceKind === 'webhook' && binding.externalId === 'build-123')).toBe(true);
  });

  test('generic webhook requires explicit ingress configuration', async () => {
    const config = new ConfigManager();
    config.setDynamic('surfaces.webhook.enabled', false);
    config.setDynamic('surfaces.webhook.secret', '');
    daemon = new DaemonServer({
      port: 39421,
      host: '127.0.0.1',
      userAuth: new UserAuthManager({
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
      }),
    }, config);
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const generic = await fetch('http://127.0.0.1:39421/webhook/generic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        surfaceId: 'ci-gateway',
        externalId: 'build-unconfigured',
        message: 'this should not spawn without configuration',
      }),
    });
    expect(generic.status).toBe(503);
  });

  test('generic webhook rejects unsafe callback URLs', async () => {
    const config = new ConfigManager();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-test-secret');
    daemon = new DaemonServer({
      port: 39421,
      host: '127.0.0.1',
      userAuth: new UserAuthManager({
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
      }),
    }, config);
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const generic = await fetch('http://127.0.0.1:39421/webhook/generic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Webhook-Secret': 'webhook-test-secret',
      },
      body: JSON.stringify({
        surfaceId: 'ci-gateway',
        externalId: 'build-unsafe',
        callbackUrl: 'https://127.0.0.1/callback',
        message: 'attempt callback SSRF',
      }),
    });
    expect(generic.status).toBe(400);
  });

  test('generic webhook accepts HMAC signature and preserves correlation metadata', async () => {
    const config = new ConfigManager();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-hmac-secret');
    daemon = new DaemonServer({
      port: 39421,
      host: '127.0.0.1',
      userAuth: new UserAuthManager({
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
      }),
    }, config);
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    await fetch('http://127.0.0.1:39421/api/channels/policies/webhook', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ allowlistUserIds: [] }),
    });

    const payload = JSON.stringify({
      surfaceId: 'ci-gateway',
      externalId: 'build-124',
      message: 'summarize build 124',
      callbackUrl: 'https://example.com/callback',
      callbackSignature: 'hmac-sha256',
      correlationId: 'corr-124',
    });
    const signature = (daemon as unknown as {
      signWebhookPayload: (body: string, secret: string) => string;
    }).signWebhookPayload(payload, 'webhook-hmac-secret');

    const res = await fetch('http://127.0.0.1:39421/webhook/generic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Signature': signature,
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { correlationId: string | null; bindingId: string; acknowledged: boolean };
    expect(body.acknowledged).toBe(true);
    expect(body.correlationId).toBe('corr-124');
    expect(typeof body.bindingId).toBe('string');
  });

  test('generic webhook rejects invalid HMAC signatures when configured', async () => {
    const config = new ConfigManager();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-hmac-secret');
    daemon = new DaemonServer({
      port: 39421,
      host: '127.0.0.1',
      userAuth: new UserAuthManager({
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
      }),
    }, config);
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const res = await fetch('http://127.0.0.1:39421/webhook/generic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Signature': 'invalid-signature',
      },
      body: JSON.stringify({
        surfaceId: 'ci-gateway',
        externalId: 'build-125',
        message: 'summarize build 125',
      }),
    });
    expect(res.status).toBe(401);
  });

  test('control-plane message API exposes published web-surface messages', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const messages = await fetch('http://127.0.0.1:39421/api/control-plane/messages', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(messages.status).toBe(200);
    const body = await messages.json() as { messages: unknown[] };
    expect(Array.isArray(body.messages)).toBe(true);
  });

  test('ntfy webhook creates route bindings and can spawn agents', async () => {
    const config = new ConfigManager();
    config.setDynamic('surfaces.ntfy.enabled', true);
    config.setDynamic('surfaces.ntfy.token', 'ntfy-test-token');
    daemon = new DaemonServer({
      port: 39421,
      host: '127.0.0.1',
      userAuth: new UserAuthManager({
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
      }),
    }, config);
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const ntfy = await fetch('http://127.0.0.1:39421/webhook/ntfy?topic=ops-alerts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Ntfy-Token': 'ntfy-test-token',
      },
      body: JSON.stringify({
        topic: 'ops-alerts',
        message: 'summarize the latest deployment status',
        title: 'Ops alerts',
      }),
    });
    expect(ntfy.status).toBe(200);
    const ntfyBody = await ntfy.json() as { acknowledged: boolean; queued: boolean; bindingId: string };
    expect(ntfyBody.acknowledged).toBe(true);
    expect(ntfyBody.queued).toBe(true);
    expect(typeof ntfyBody.bindingId).toBe('string');

    const list = await fetch('http://127.0.0.1:39421/api/routes/bindings', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const listBody = await list.json() as { bindings: Array<{ id: string; surfaceKind: string; externalId: string }> };
    expect(listBody.bindings.some((binding) => binding.id === ntfyBody.bindingId && binding.surfaceKind === 'ntfy' && binding.externalId === 'ops-alerts')).toBe(true);
  });

  test('ntfy webhook rejects invalid ingress tokens', async () => {
    const config = new ConfigManager();
    config.setDynamic('surfaces.ntfy.enabled', true);
    config.setDynamic('surfaces.ntfy.token', 'ntfy-test-token');
    daemon = new DaemonServer({
      port: 39421,
      host: '127.0.0.1',
      userAuth: new UserAuthManager({
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
      }),
    }, config);
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const ntfy = await fetch('http://127.0.0.1:39421/webhook/ntfy?topic=ops-alerts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goodvibes-Ntfy-Token': 'wrong-token',
      },
      body: JSON.stringify({
        topic: 'ops-alerts',
        message: 'this should not spawn',
        title: 'Ops alerts',
      }),
    });
    expect(ntfy.status).toBe(401);
  });

  test('slack interactive approval callbacks resolve approvals through signed actions', async () => {
    const previousSigningSecret = process.env.SLACK_SIGNING_SECRET;
    process.env.SLACK_SIGNING_SECRET = 'slack-signing-secret-test';
    try {
      daemon.enable({ daemon: true }, TEST_TOKEN);
      await daemon.start();

      const broker = ApprovalBroker.getInstance();
      const decisionPromise = broker.requestApproval({
        request: {
          callId: 'call-slack-approval',
          tool: 'exec',
          args: { cmd: 'git status' },
          category: 'execute',
          analysis: {
            classification: 'execute',
            riskLevel: 'high',
            summary: 'Slack approval test',
            reasons: ['Requires operator approval from Slack.'],
            target: 'git status',
            targetKind: 'command',
          },
        },
        sessionId: 'sess-slack-approval',
        routeId: 'route-slack-approval',
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const approval = broker.listApprovals().find((entry) => entry.callId === 'call-slack-approval');
      expect(approval).toBeDefined();

      const payloadObject = {
        type: 'block_actions',
        user: { id: 'U123' },
        channel: { id: 'C123' },
        actions: [{ action_id: `gv:approval:approve:${approval!.id}` }],
      };
      const rawBody = new URLSearchParams({
        payload: JSON.stringify(payloadObject),
      }).toString();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac('sha256', process.env.SLACK_SIGNING_SECRET!).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;

      const res = await fetch('http://127.0.0.1:39421/webhook/slack', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Slack-Request-Timestamp': timestamp,
          'X-Slack-Signature': signature,
        },
        body: rawBody,
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { text: string };
      expect(body.text).toContain(`Approval approved: ${approval!.id}`);

      const decision = await decisionPromise;
      expect(decision.approved).toBe(true);
      expect(broker.getApproval(approval!.id)?.status).toBe('approved');
    } finally {
      if (previousSigningSecret === undefined) {
        delete process.env.SLACK_SIGNING_SECRET;
      } else {
        process.env.SLACK_SIGNING_SECRET = previousSigningSecret;
      }
    }
  });

  test('POST /task returns 401 without token', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    const res = await fetch('http://127.0.0.1:39421/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'do something' }),
    });
    expect(res.status).toBe(401);
  });

  test('POST /task returns 202 acknowledgement with valid token', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    const res = await fetch('http://127.0.0.1:39421/task', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({ task: 'do something' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as Record<string, unknown>;
    expect(body.acknowledged).toBe(true);
  });

  test('daemon-spawned agents are visible through runtime task APIs', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const submit = await fetch('http://127.0.0.1:39421/task', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({ task: 'inspect daemon runtime task visibility' }),
    });
    expect(submit.status).toBe(202);
    const submitBody = await submit.json() as { agentId: string };
    expect(typeof submitBody.agentId).toBe('string');

    const detail = await fetch(`http://127.0.0.1:39421/api/tasks/${submitBody.agentId}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as { task: { id: string; kind: string } };
    expect(detailBody.task.id).toBe(submitBody.agentId);
    expect(detailBody.task.kind).toBe('agent');
  });

  test('unknown route returns 404 with valid token', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    const res = await fetch('http://127.0.0.1:39421/does-not-exist', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// HttpListener
// ---------------------------------------------------------------------------

describe('HttpListener', () => {
  let listener: HttpListener;

  beforeEach(() => {
    const userAuth = new UserAuthManager({
      users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
    });
    listener = new HttpListener({ port: 39422, host: '127.0.0.1', userAuth });
  });

  afterEach(async () => {
    await listener.stop();
  });

  test('isRunning is false before start', () => {
    expect(listener.isRunning).toBe(false);
  });

  test('refuses to start when disabled (default state)', async () => {
    await listener.start();
    expect(listener.isRunning).toBe(false);
  });

  test('enable returns false when danger.httpListener is false', () => {
    const result = listener.enable({ httpListener: false }, TEST_TOKEN);
    expect(result).toBe(false);
  });

  test('enable returns true when danger.httpListener is true', () => {
    const result = listener.enable({ httpListener: true }, TEST_TOKEN);
    expect(result).toBe(true);
  });

  test('starts when enabled', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    expect(listener.isRunning).toBe(true);
  });

  test('stop works when running', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    await listener.stop();
    expect(listener.isRunning).toBe(false);
  });

  test('stop is safe when not running', async () => {
    await expect(listener.stop()).resolves.toBeUndefined();
    expect(listener.isRunning).toBe(false);
  });

  test('POST /webhook returns 401 without token', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    const res = await fetch('http://127.0.0.1:39422/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'push' }),
    });
    expect(res.status).toBe(401);
  });

  test('POST /login returns session token for valid credentials', async () => {
    listener.enable({ httpListener: true });
    await listener.start();
    const res = await fetch('http://127.0.0.1:39422/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(typeof body.token).toBe('string');
  });

  test('POST /webhook returns 401 with wrong token', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    const res = await fetch('http://127.0.0.1:39422/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ event: 'push' }),
    });
    expect(res.status).toBe(401);
  });

  test('POST /webhook returns 202 acknowledgement with valid token', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    const res = await fetch('http://127.0.0.1:39422/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({ event: 'push' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as Record<string, unknown>;
    expect(body.acknowledged).toBe(true);
  });

  test('GET /health returns 200 with valid token', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    const res = await fetch('http://127.0.0.1:39422/health', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
  });

  test('GET /health returns 401 without token', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    const res = await fetch('http://127.0.0.1:39422/health');
    expect(res.status).toBe(401);
  });

  test('unknown route returns 404 with valid token', async () => {
    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();
    const res = await fetch('http://127.0.0.1:39422/unknown-path', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test('rate limit: 61st request within window returns 429', async () => {
    // Use a fresh instance to get a clean rate-limit counter
    const rl = new HttpListener({
      port: 39423,
      host: '127.0.0.1',
      userAuth: new UserAuthManager({
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
      }),
    });
    rl.enable({ httpListener: true }, TEST_TOKEN);
    await rl.start();
    try {
      // Send 60 requests — all should succeed (or 404, not 429)
      for (let i = 0; i < 60; i++) {
        await fetch('http://127.0.0.1:39423/health', {
          headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        });
      }
      // 61st request should be throttled
      const res = await fetch('http://127.0.0.1:39423/health', {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status).toBe(429);
    } finally {
      await rl.stop();
    }
  });
});
