import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts/index';
import { DaemonServer } from '@pellux/goodvibes-sdk/platform/daemon/server';
import { HttpListener } from '@pellux/goodvibes-sdk/platform/daemon/http-listener';
import { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security/user-auth';
import { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { TransportEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/transport';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { MultimodalService } from '@pellux/goodvibes-sdk/platform/multimodal/index';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { KnowledgeService, KnowledgeStore } from '@pellux/goodvibes-sdk/platform/knowledge/index';
import { resetTestRuntimeServices } from '../helpers/runtime-services.ts';
import { buildOperatorContract } from '@pellux/goodvibes-sdk/platform/control-plane/operator-contract';

const TEST_TOKEN = 'test-secret-token-abc123';

async function waitFor<T>(fn: () => Promise<T | undefined | null> | T | undefined | null, timeoutMs = 5_000, intervalMs = 25): Promise<T> {
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
  let tempRoot: string;
  let workingDir: string;
  let homeDir: string;
  let configDir: string;
  let runtimeServices: ReturnType<typeof createRuntimeServices>;
  const makeConfig = () => new ConfigManager({ surfaceRoot: 'tui',  configDir, workingDir, homeDir });
  const makeUserAuth = () => new UserAuthManager({
    bootstrapFilePath: join(homeDir, 'auth-users.json'),
    bootstrapCredentialPath: join(homeDir, 'auth-bootstrap.txt'),
    users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
  });
  const createTestDaemon = (options: {
    readonly configManager?: ConfigManager;
    readonly runtimeServices?: ReturnType<typeof createRuntimeServices>;
    readonly userAuth?: UserAuthManager;
    readonly serveFactory?: typeof Bun.serve;
    readonly runtimeBus?: RuntimeEventBus | null;
    readonly port?: number;
    readonly host?: string;
  } = {}): DaemonServer => new DaemonServer({
    port: options.port ?? 39421,
    host: options.host ?? '127.0.0.1',
    userAuth: options.userAuth ?? makeUserAuth(),
    ...(options.runtimeServices
      ? { runtimeServices: options.runtimeServices }
      : {
          configManager: options.configManager ?? makeConfig(),
          workingDir,
          homeDirectory: homeDir,
        }),
    ...(options.serveFactory ? { serveFactory: options.serveFactory } : {}),
    ...(options.runtimeBus !== undefined ? { runtimeBus: options.runtimeBus } : {}),
  });

  beforeEach(() => {
    resetTestRuntimeServices();
    tempRoot = mkdtempSync(join(tmpdir(), 'gv-daemon-config-'));
    workingDir = join(tempRoot, 'workspace');
    homeDir = join(tempRoot, 'home');
    configDir = join(homeDir, '.goodvibes', 'tui');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    // Use a high port to avoid conflicts with system services
    const userAuth = makeUserAuth();
    runtimeServices = createRuntimeServices({
      runtimeStore: createRuntimeStore(),
      runtimeBus: new RuntimeEventBus(),
      configManager: makeConfig(),
      workingDir,
      homeDirectory: homeDir,
      getConversationTitle: () => 'Daemon Test',
    });
    daemon = createTestDaemon({ userAuth, runtimeServices });
    runtimeServices.panelManager.registerType({
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
        invalidate() { this.needsRender = true; },
        markRendered() { this.needsRender = false; },
      }),
    });
  });

  afterEach(async () => {
    await daemon?.stop();
    resetTestRuntimeServices();
    rmSync(tempRoot, { recursive: true, force: true });
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

  test('passes TLS options to Bun.serve when direct daemon TLS is enabled', async () => {
    const certDir = join(homeDir, '.goodvibes', 'tui', 'certs');
    mkdirSync(certDir, { recursive: true });
    const certFile = join(certDir, 'fullchain.pem');
    const keyFile = join(certDir, 'privkey.pem');
    writeFileSync(certFile, 'CERT\n', 'utf-8');
    writeFileSync(keyFile, 'KEY\n', 'utf-8');
    const config = makeConfig();
    config.set('controlPlane.tls.mode', 'direct');
    let capturedOptions: Record<string, unknown> | null = null;
    const serveFactory = mock((options: unknown) => {
      capturedOptions = options as Record<string, unknown>;
      return {
      stop: mock(() => {}),
      port: (capturedOptions as Record<string, unknown>).port,
      hostname: (capturedOptions as Record<string, unknown>).hostname,
    };
    });
    daemon = createTestDaemon({
      configManager: config,
      userAuth: makeUserAuth(),
      serveFactory: serveFactory as unknown as typeof Bun.serve,
    });

    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    expect(serveFactory).toHaveBeenCalledTimes(1);
    expect(capturedOptions).toMatchObject({
      port: 39421,
      hostname: '127.0.0.1',
      tls: {
        cert: Bun.file(certFile),
        key: Bun.file(keyFile),
      },
    });
  });

  test('emits transport lifecycle when starting and stopping', async () => {
    const runtimeBus = new RuntimeEventBus();
    const transportEvents: TransportEvent[] = [];
    runtimeBus.onDomain('transport', ({ payload }) => transportEvents.push(payload));
    daemon = createTestDaemon({
      userAuth: makeUserAuth(),
      runtimeBus,
    });

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
    expect(res.headers.get('set-cookie')).toContain('goodvibes_session=');
  });

  test('session cookies authenticate REST and SSE control-plane requests', async () => {
    daemon.enable({ daemon: true });
    await daemon.start();
    const login = await fetch('http://127.0.0.1:39421/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    expect(login.status).toBe(200);
    const sessionCookie = login.headers.get('set-cookie');
    expect(sessionCookie).toContain('goodvibes_session=');
    const cookieHeader = sessionCookie!.split(';', 1)[0];

    const snapshot = await fetch('http://127.0.0.1:39421/api/control-plane', {
      headers: { Cookie: cookieHeader },
    });
    expect(snapshot.status).toBe(200);

    const stream = await fetch('http://127.0.0.1:39421/api/control-plane/events?domains=control-plane', {
      headers: { Cookie: cookieHeader },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body?.getReader();
    const firstChunk = await reader!.read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain('event: ready');
    await reader!.cancel();
  });

  test('control-plane auth introspection reports anonymous, shared-token, and session-cookie principals', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const anonymous = await fetch('http://127.0.0.1:39421/api/control-plane/auth');
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toEqual({
      authenticated: false,
      authMode: 'anonymous',
      tokenPresent: false,
      authorizationHeaderPresent: false,
      sessionCookiePresent: false,
      principalId: null,
      principalKind: null,
      admin: false,
      scopes: [],
      roles: [],
    });

    const shared = await fetch('http://127.0.0.1:39421/api/control-plane/whoami', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(shared.status).toBe(200);
    const sharedBody = await shared.json() as {
      authenticated: boolean;
      authMode: string;
      principalId: string | null;
      principalKind: string | null;
      admin: boolean;
      scopes: string[];
    };
    expect(sharedBody.authenticated).toBe(true);
    expect(sharedBody.authMode).toBe('shared-token');
    expect(sharedBody.principalId).toBe('shared-token');
    expect(sharedBody.principalKind).toBe('token');
    expect(sharedBody.admin).toBe(true);
    expect(sharedBody.scopes).toContain('read:control-plane');
    expect(sharedBody.scopes).toContain('read:telemetry');

    await daemon.stop();
    daemon.enable({ daemon: true });
    await daemon.start();

    const login = await fetch('http://127.0.0.1:39421/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const sessionCookie = login.headers.get('set-cookie');
    expect(sessionCookie).toContain('goodvibes_session=');
    const cookieHeader = sessionCookie!.split(';', 1)[0];

    const session = await fetch('http://127.0.0.1:39421/api/control-plane/auth', {
      headers: { Cookie: cookieHeader },
    });
    expect(session.status).toBe(200);
    const sessionBody = await session.json() as {
      authenticated: boolean;
      authMode: string;
      sessionCookiePresent: boolean;
      principalId: string | null;
      principalKind: string | null;
      roles: string[];
    };
    expect(sessionBody.authenticated).toBe(true);
    expect(sessionBody.authMode).toBe('session');
    expect(sessionBody.sessionCookiePresent).toBe(true);
    expect(sessionBody.principalId).toBe('admin');
    expect(sessionBody.principalKind).toBe('user');
    expect(sessionBody.roles).toContain('admin');
  });

  test('control-plane event streams no longer accept auth tokens in query parameters', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    const stream = await fetch(`http://127.0.0.1:39421/api/control-plane/events?token=${TEST_TOKEN}&domains=control-plane`);
    expect(stream.status).toBe(401);
  });

  test('knowledge routes ingest and query structured knowledge', async () => {
    const sourceUrl = 'https://example.com/knowledge-route-page';
    const sourceUrlList = `${sourceUrl}?connector=1`;
    const sourceHtml = '<html><head><title>Knowledge Route Page</title></head><body><h1>Knowledge</h1><p>Daemon route coverage.</p></body></html>';
    const originalFetch = globalThis.fetch;
    const mockFetch = async (input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === sourceUrl || url === sourceUrlList) {
        return new Response(sourceHtml, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: originalFetch.preconnect.bind(originalFetch),
    }) as typeof fetch;
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    try {
      const ingest = await fetch('http://127.0.0.1:39421/api/knowledge/ingest/url', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: sourceUrl, sessionId: 'session-1' }),
    });
    expect(ingest.status).toBe(201);
    const ingested = await ingest.json() as { source: { id: string } };
    expect(ingested.source.id).toBeTruthy();

    await waitFor(() => {
      const results = runtimeServices.knowledgeService.search('Knowledge Route Page');
      return results.length > 0 ? results : null;
    });
    const search = await fetch('http://127.0.0.1:39421/api/knowledge/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'Knowledge Route Page' }),
    });
    expect(search.status).toBe(200);
    const searchJson = await search.json() as { results: Array<{ id: string }> };
    expect(searchJson.results.length).toBeGreaterThan(0);

    const connectors = await fetch('http://127.0.0.1:39421/api/knowledge/connectors', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(connectors.status).toBe(200);
    const connectorsJson = await connectors.json() as { connectors: Array<{ id: string }> };
    expect(connectorsJson.connectors.some((connector) => connector.id === 'bookmark')).toBe(true);

    const connectorDoctor = await fetch('http://127.0.0.1:39421/api/knowledge/connectors/bookmark/doctor', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(connectorDoctor.status).toBe(200);
    const connectorDoctorJson = await connectorDoctor.json() as { report: { ready: boolean } };
    expect(connectorDoctorJson.report.ready).toBe(true);

    const connectorIngest = await fetch('http://127.0.0.1:39421/api/knowledge/ingest/connector', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        connectorId: 'url-list',
        content: `${sourceUrlList}\n`,
        sessionId: 'session-connector',
      }),
    });
    expect(connectorIngest.status).toBe(201);
    const connectorIngestJson = await connectorIngest.json() as {
      imported: number;
      failed: number;
      errors: string[];
      sources: Array<{ id: string }>;
    };
    expect(connectorIngestJson.imported + connectorIngestJson.failed).toBeGreaterThan(0);
    expect(Array.isArray(connectorIngestJson.sources)).toBe(true);

    const csvPath = join(workingDir, 'knowledge.csv');
    writeFileSync(csvPath, 'project,owner\nGoodVibes,buzzkill\n');
    const ingestArtifact = await fetch('http://127.0.0.1:39421/api/knowledge/ingest/artifact', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: csvPath, connectorId: 'artifact', sessionId: 'session-artifact' }),
    });
    expect(ingestArtifact.status).toBe(201);
    const ingestArtifactJson = await ingestArtifact.json() as { source: { id: string } };
    expect(ingestArtifactJson.source.id).toBeTruthy();

    const extractions = await fetch('http://127.0.0.1:39421/api/knowledge/extractions?limit=10', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(extractions.status).toBe(200);
    const extractionsJson = await extractions.json() as { extractions: Array<{ id: string; format: string }> };
    expect(extractionsJson.extractions.some((extraction) => extraction.format === 'csv')).toBe(true);

    const projections = await fetch('http://127.0.0.1:39421/api/knowledge/projections?limit=5', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(projections.status).toBe(200);
    const projectionsJson = await projections.json() as { targets: Array<{ kind: string }> };
    expect(projectionsJson.targets.some((target) => target.kind === 'overview')).toBe(true);

    const packet = await fetch('http://127.0.0.1:39421/api/knowledge/packet', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task: 'Knowledge Route Page' }),
    });
    expect(packet.status).toBe(200);
    const packetJson = await packet.json() as { items: Array<{ id: string }> };
    expect(packetJson.items.length).toBeGreaterThan(0);

    for (let index = 0; index < 3; index += 1) {
      await fetch('http://127.0.0.1:39421/api/knowledge/search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: 'daemon route coverage' }),
      });
      await fetch('http://127.0.0.1:39421/api/knowledge/packet', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ task: 'daemon route coverage' }),
      });
    }

    const usage = await fetch('http://127.0.0.1:39421/api/knowledge/usage?limit=10', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(usage.status).toBe(200);
    expect(((await usage.json()) as { usage: Array<{ usageKind: string }> }).usage.length).toBeGreaterThan(0);

    const jobs = await fetch('http://127.0.0.1:39421/api/knowledge/jobs', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(jobs.status).toBe(200);
    const jobsJson = await jobs.json() as { jobs: Array<{ id: string }> };
    expect(jobsJson.jobs.some((job) => job.id === 'knowledge-lint')).toBe(true);
    expect(jobsJson.jobs.some((job) => job.id === 'knowledge-light-consolidation')).toBe(true);

    const runJob = await fetch('http://127.0.0.1:39421/api/knowledge/jobs/knowledge-light-consolidation/run', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'inline' }),
    });
    expect(runJob.status).toBe(200);
    const runJobJson = await runJob.json() as { run: { id: string; status: string } };
    expect(runJobJson.run.status).toBe('completed');

    const candidates = await fetch('http://127.0.0.1:39421/api/knowledge/candidates?limit=10', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(candidates.status).toBe(200);
    const candidatesJson = await candidates.json() as { candidates: Array<{ candidateType: string }> };
    expect(Array.isArray(candidatesJson.candidates)).toBe(true);

    const schedules = await fetch('http://127.0.0.1:39421/api/knowledge/schedules?limit=10', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(schedules.status).toBe(200);
    const schedulesJson = await schedules.json() as { schedules: Array<{ jobId: string }> };
    expect(schedulesJson.schedules.some((schedule) => schedule.jobId === 'knowledge-light-consolidation')).toBe(true);

    const jobRuns = await fetch('http://127.0.0.1:39421/api/knowledge/job-runs?limit=10', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(jobRuns.status).toBe(200);
    const jobRunsJson = await jobRuns.json() as { runs: Array<{ id: string; jobId: string }> };
    expect(jobRunsJson.runs.some((run) => run.id === runJobJson.run.id && run.jobId === 'knowledge-light-consolidation')).toBe(true);

    const renderProjection = await fetch('http://127.0.0.1:39421/api/knowledge/projections/render', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kind: 'source', id: ingested.source.id }),
    });
    expect(renderProjection.status).toBe(200);
    const renderJson = await renderProjection.json() as { pageCount: number; pages: Array<{ content: string }> };
    expect(renderJson.pageCount).toBe(1);
    expect(renderJson.pages[0]?.content).toContain('Knowledge Route Page');

    const materializeProjection = await fetch('http://127.0.0.1:39421/api/knowledge/projections/materialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kind: 'source', id: ingested.source.id }),
    });
    expect(materializeProjection.status).toBe(201);
    const materializeJson = await materializeProjection.json() as { artifact: { id: string; mimeType: string } };
    expect(materializeJson.artifact.id).toBeTruthy();
    expect(materializeJson.artifact.mimeType).toBe('text/markdown');

    const graphqlSchema = await fetch('http://127.0.0.1:39421/api/knowledge/graphql/schema', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(graphqlSchema.status).toBe(200);
    const graphqlSchemaJson = await graphqlSchema.json() as { schema: string };
    expect(graphqlSchemaJson.schema).toContain('type Query');

    const graphql = await fetch('http://127.0.0.1:39421/api/knowledge/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `
          query KnowledgeRouteGraph($sourceId: String!) {
            status { sourceCount }
            projection(kind: SOURCE, id: $sourceId) {
              target { kind }
              pageCount
            }
          }
        `,
        variables: { sourceId: ingested.source.id },
      }),
    });
    expect(graphql.status).toBe(200);
    const graphqlJson = await graphql.json() as {
      data: {
        status: { sourceCount: number };
        projection: { target: { kind: string }; pageCount: number };
      };
    };
    expect(graphqlJson.data.status.sourceCount).toBeGreaterThan(0);
    expect(graphqlJson.data.projection.target.kind).toBe('SOURCE');
    expect(graphqlJson.data.projection.pageCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  test('multimodal routes analyze documents and write results back into knowledge', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const createArtifact = await fetch('http://127.0.0.1:39421/api/artifacts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mimeType: 'text/markdown',
        filename: 'multimodal-notes.md',
        text: '# Multimodal Notes\n\nThe knowledge system should improve itself over time.\n',
      }),
    });
    expect(createArtifact.status).toBe(201);
    const created = await createArtifact.json() as { artifact: { id: string } };

    const analyze = await fetch('http://127.0.0.1:39421/api/multimodal/analyze', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        artifactId: created.artifact.id,
        includePacket: true,
        writeback: true,
        sessionId: 'session-mm-route',
      }),
    });
    expect(analyze.status).toBe(201);
    const analyzeJson = await analyze.json() as {
      analysis: { kind: string; providerIds: string[] };
      packet: { rendered: string };
      writeback: { knowledgeSourceId?: string };
    };
    expect(analyzeJson.analysis.kind).toBe('document');
    expect(analyzeJson.analysis.providerIds).toContain('knowledge-extractors');
    expect(analyzeJson.packet.rendered).toContain('Multimodal Analysis');
    expect(typeof analyzeJson.writeback.knowledgeSourceId).toBe('string');
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
        every: '15m',
        name: 'API Heartbeat',
        prompt: 'Send a daemon heartbeat',
      }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { id: string; name: string };
    expect(created.name).toBe('API Heartbeat');

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

  test('automation API accepts cron stagger, main target, and upstream-compatible execution metadata', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const create = await fetch('http://127.0.0.1:39421/api/automation/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        kind: 'cron',
        cron: '0 * * * *',
        timezone: 'UTC',
        staggerMs: 0,
        name: 'API Metadata Job',
        prompt: 'Run metadata automation',
        target: { kind: 'main', createIfMissing: true },
        wakeMode: 'now',
        fallbacks: ['openrouter/gpt-4.1-mini'],
        reasoningEffort: 'high',
        thinking: 'high',
        externalContentSource: 'webhook',
        allowUnsafeExternalContent: false,
        lightContext: true,
      }),
    });

    expect(create.status).toBe(201);
    const created = await create.json() as {
      schedule: { kind: string; staggerMs?: number };
      execution: {
        target: { kind: string };
        wakeMode?: string;
        fallbackModels?: string[];
        reasoningEffort?: string;
        thinking?: string;
        externalContentSource?: string;
        allowUnsafeExternalContent?: boolean;
        lightContext?: boolean;
      };
    };
    expect(created.schedule.staggerMs).toBe(0);
    expect(created.execution.target.kind).toBe('main');
    expect(created.execution.wakeMode).toBe('now');
    expect(created.execution.fallbackModels).toEqual(['openrouter/gpt-4.1-mini']);
    expect(created.execution.reasoningEffort).toBe('high');
    expect(created.execution.thinking).toBe('high');
    expect(created.execution.externalContentSource).toBe('webhook');
    expect(created.execution.allowUnsafeExternalContent).toBe(false);
    expect(created.execution.lightContext).toBe(true);
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

    const stream = await fetch('http://127.0.0.1:39421/api/control-plane/events?domains=control-plane', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
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

    const web = await fetch('http://127.0.0.1:39421/api/control-plane/web');
    expect(web.status).toBe(200);
    expect(web.headers.get('content-type')).toContain('text/html');
    const html = await web.text();
    expect(html).toContain('goodvibes control plane');
    expect(html).toContain('Approvals');
    expect(html).toContain('Sessions');
    expect(html).toContain('Deliveries');
    expect(html).not.toContain(TEST_TOKEN);

    await reader!.cancel();
  });

  test('control-plane gateway exposes websocket transport and method calls', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const socket = new WebSocket('ws://127.0.0.1:39421/api/control-plane/ws?clientKind=web&domains=control-plane,automation');
    const ready = await waitForSocketFrame(socket, (frame) => frame.type === 'event' && frame.event === 'ready');
    expect(ready.type).toBe('event');

    socket.send(JSON.stringify({
      type: 'auth',
      token: TEST_TOKEN,
      domains: ['control-plane', 'automation'],
    }));
    const authenticated = await waitForSocketFrame(socket, (frame) => frame.type === 'auth' && frame.ok === true);
    expect(authenticated.ok).toBe(true);

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
      type: 'call',
      id: 'status-method-1',
      methodId: 'control.status',
    }));
    const methodStatus = await waitForSocketFrame(socket, (frame) => frame.type === 'response' && frame.id === 'status-method-1');
    expect(methodStatus.ok).toBe(true);
    expect((methodStatus.body as { status?: string }).status).toBe('running');

    socket.send(JSON.stringify({
      type: 'subscribe',
      domains: ['routes'],
    }));
    const subscribed = await waitForSocketFrame(socket, (frame) => frame.type === 'subscribed');
    expect(subscribed.type).toBe('subscribed');

    socket.close();
  });

  test('exposes gap-closure contracts for methods, voice, web search, artifacts, media, multimodal, memory, heartbeat, and node hosts', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const auth = { Authorization: `Bearer ${TEST_TOKEN}` };
    const methods = runtimeServices.gatewayMethods.list();
    expect(methods.some((method) => method.id === 'control.contract')).toBe(true);
    expect(methods.some((method) => method.id === 'remote.node_host.contract')).toBe(true);

    const events = runtimeServices.gatewayMethods.listEvents();
    expect(events.some((event) => event.id === 'runtime.automation')).toBe(true);
    expect(events.some((event) => event.id === 'control.ready')).toBe(true);

    const operatorContract = buildOperatorContract(runtimeServices.gatewayMethods);
    expect(operatorContract.auth.login.path).toBe('/login');
    expect(operatorContract.auth.current.path).toBe('/api/control-plane/auth');
    expect(operatorContract.auth.current.aliasPaths).toContain('/api/control-plane/whoami');
    expect(operatorContract.auth.sessionCookie.name).toBe('goodvibes_session');
    expect(operatorContract.auth.bearer.queryParameters).toEqual([]);
    expect(operatorContract.transports.websocket.path).toBe('/api/control-plane/ws');
    expect(operatorContract.peer.contractPath).toBe('/api/remote/node-host/contract');
    expect(operatorContract.operator.methods.some((method) => method.id === 'control.contract')).toBe(true);
    expect(operatorContract.operator.methods.some((method) => method.id === 'telemetry.snapshot')).toBe(true);
    expect(operatorContract.operator.events.some((event) => event.id === 'runtime.automation')).toBe(true);

    const statusInvoke = await fetch('http://127.0.0.1:39421/api/control-plane/methods/control.status/invoke', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(statusInvoke.status).toBe(200);
    expect((await statusInvoke.json() as { status?: string }).status).toBe('running');

    const voice = await fetch('http://127.0.0.1:39421/api/voice', { headers: auth });
    expect(voice.status).toBe(200);
    expect((await voice.json() as { note?: string }).note).toContain('Voice capture');

    const voiceProviders = await fetch('http://127.0.0.1:39421/api/voice/providers', { headers: auth });
    expect(voiceProviders.status).toBe(200);
    const voiceProvidersBody = await voiceProviders.json() as { providers: Array<{ id: string }> };
    expect(voiceProvidersBody.providers.some((provider) => provider.id === 'openai')).toBe(true);
    expect(voiceProvidersBody.providers.some((provider) => provider.id === 'deepgram')).toBe(true);
    expect(voiceProvidersBody.providers.some((provider) => provider.id === 'google')).toBe(true);
    expect(voiceProvidersBody.providers.some((provider) => provider.id === 'elevenlabs')).toBe(true);
    expect(voiceProvidersBody.providers.some((provider) => provider.id === 'microsoft')).toBe(true);
    expect(voiceProvidersBody.providers.some((provider) => provider.id === 'vydra')).toBe(true);

    const webSearch = await fetch('http://127.0.0.1:39421/api/web-search/providers', { headers: auth });
    expect(webSearch.status).toBe(200);
    const webSearchBody = await webSearch.json() as { providers: Array<{ id: string }> };
    expect(webSearchBody.providers.some((provider) => provider.id === 'duckduckgo')).toBe(true);
    expect(webSearchBody.providers.some((provider) => provider.id === 'perplexity')).toBe(true);

    const artifacts = await fetch('http://127.0.0.1:39421/api/artifacts', { headers: auth });
    expect(artifacts.status).toBe(200);
    expect(await artifacts.json()).toHaveProperty('artifacts');

    const media = await fetch('http://127.0.0.1:39421/api/media/providers', { headers: auth });
    expect(media.status).toBe(200);
    const mediaBody = await media.json() as { providers: Array<{ id: string }> };
    expect(mediaBody.providers.some((provider) => provider.id === 'builtin:image-understanding')).toBe(true);
    expect(mediaBody.providers.some((provider) => provider.id === 'fal')).toBe(true);
    expect(mediaBody.providers.some((provider) => provider.id === 'comfy')).toBe(true);
    expect(mediaBody.providers.some((provider) => provider.id === 'runway')).toBe(true);
    expect(mediaBody.providers.some((provider) => provider.id === 'alibaba')).toBe(true);
    expect(mediaBody.providers.some((provider) => provider.id === 'byteplus')).toBe(true);

    const multimodal = await fetch('http://127.0.0.1:39421/api/multimodal', { headers: auth });
    expect(multimodal.status).toBe(200);
    expect((await multimodal.json() as { note?: string }).note).toContain('Multimodal analysis');

    const multimodalProviders = await fetch('http://127.0.0.1:39421/api/multimodal/providers', { headers: auth });
    expect(multimodalProviders.status).toBe(200);
    const multimodalBody = await multimodalProviders.json() as { providers: Array<{ id: string }> };
    expect(multimodalBody.providers.some((provider) => provider.id === 'knowledge-extractors')).toBe(true);
    expect(multimodalBody.providers.some((provider) => provider.id === 'openai')).toBe(true);

    const memory = await fetch('http://127.0.0.1:39421/api/memory/doctor', { headers: auth });
    expect(memory.status).toBe(200);
    const memoryBody = await memory.json() as { embeddings: { activeProviderId: string } };
    expect(memoryBody.embeddings.activeProviderId).toBe('hashed-local');

    const heartbeat = await fetch('http://127.0.0.1:39421/api/automation/heartbeat', { headers: auth });
    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toHaveProperty('pending');

    const contract = await fetch('http://127.0.0.1:39421/api/remote/node-host/contract', { headers: auth });
    expect(contract.status).toBe(200);
    const contractBody = await contract.json() as { contract: { scopes: string[]; endpoints: Array<{ id: string }> } };
    expect(contractBody.contract.scopes).toContain('remote:heartbeat');
    expect(contractBody.contract.endpoints.some((endpoint) => endpoint.id === 'work.pull')).toBe(true);
  });

  test('control-plane exposes the event catalog and resolves templated method routes through invoke', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const auth = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };
    const events = runtimeServices.gatewayMethods.listEvents();
    expect(events.some((event) => event.id === 'runtime.automation')).toBe(true);
    expect(events.some((event) => event.id === 'control.ready')).toBe(true);

    const method = await fetch('http://127.0.0.1:39421/api/control-plane/methods/control.methods.get/invoke', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        query: { methodId: 'control.status' },
      }),
    });
    expect(method.status).toBe(200);
    const methodBody = await method.json() as { method: { id: string } };
    expect(methodBody.method.id).toBe('control.status');
  });

  test('gateway method invocation enforces scopes for local-auth sessions, including raw websocket route calls', async () => {
    daemon.enable({ daemon: true });
    await daemon.start();

    const adminLogin = await fetch('http://127.0.0.1:39421/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    expect(adminLogin.status).toBe(200);
    const adminToken = (await adminLogin.json() as { token: string }).token;

    const createUser = await fetch('http://127.0.0.1:39421/api/local-auth/users', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'operator', password: 'operator-pass', roles: ['operator'] }),
    });
    expect(createUser.status).toBe(201);

    const operatorLogin = await fetch('http://127.0.0.1:39421/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'operator-pass' }),
    });
    expect(operatorLogin.status).toBe(200);
    const operatorToken = (await operatorLogin.json() as { token: string }).token;

    const readInvoke = await fetch('http://127.0.0.1:39421/api/control-plane/methods/control.status/invoke', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${operatorToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(readInvoke.status).toBe(200);

    const writeInvoke = await fetch('http://127.0.0.1:39421/api/control-plane/methods/automation.heartbeat.run/invoke', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${operatorToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: { source: 'scope-test' } }),
    });
    expect(writeInvoke.status).toBe(403);
    const writeInvokeBody = await writeInvoke.json() as { error: string; missingScopes?: string[] };
    expect(writeInvokeBody.error).toContain('Missing required scope');
    expect(writeInvokeBody.missingScopes).toContain('write:automation');

    const socket = new WebSocket('ws://127.0.0.1:39421/api/control-plane/ws?clientKind=web&domains=control-plane');
    const ready = await waitForSocketFrame(socket, (frame) => frame.type === 'event' && frame.event === 'ready');
    expect(ready.type).toBe('event');

    socket.send(JSON.stringify({
      type: 'auth',
      token: operatorToken,
      domains: ['control-plane'],
    }));
    const authenticated = await waitForSocketFrame(socket, (frame) => frame.type === 'auth' && frame.ok === true);
    expect(authenticated.ok).toBe(true);

    socket.send(JSON.stringify({
      type: 'call',
      id: 'raw-write-1',
      method: 'POST',
      path: '/api/automation/heartbeat',
      body: { source: 'raw-ws-scope-test' },
    }));
    const denied = await waitForSocketFrame(socket, (frame) => frame.type === 'response' && frame.id === 'raw-write-1');
    expect(denied.status).toBe(403);
    expect((denied.body as { error?: string }).error).toContain('Missing required scope');
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

    const broker = runtimeServices.approvalBroker;
    const approvalCallId = `call-approval-test-${randomUUID().slice(0, 8)}`;
    const pendingDecision = broker.requestApproval({
      request: {
        callId: approvalCallId,
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

    for (let i = 0; i < 50 && !broker.listApprovals().some((entry) => entry.callId === approvalCallId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const approvals = await fetch('http://127.0.0.1:39421/api/approvals', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(approvals.status).toBe(200);
    const approvalsBody = await approvals.json() as { approvals: Array<{ id: string; callId: string; status: string }> };
    const approval = approvalsBody.approvals.find((entry) => entry.callId === approvalCallId);
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
    const config = makeConfig();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-test-secret');
    daemon = createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
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
    const config = makeConfig();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-test-secret');
    daemon = createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
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
    const config = makeConfig();
    config.setDynamic('surfaces.slack.enabled', true);
    config.setDynamic('surfaces.slack.workspaceId', 'workspace-1');
    config.setDynamic('surfaces.slack.botToken', 'xoxb-local');
    config.setDynamic('surfaces.slack.signingSecret', 'signing-secret');
    config.setDynamic('surfaces.slack.defaultChannel', 'ops-alerts');
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.defaultTarget', 'https://example.com/hook');
    config.setDynamic('surfaces.webhook.secret', 'shared-secret');
    daemon = createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
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

    const providers = await fetch('http://127.0.0.1:39421/api/providers', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(providers.status).toBe(200);
    const providersBody = await providers.json() as {
      providers: Array<{ providerId: string; runtime: { auth?: { routes?: Array<{ route: string }> } } }>;
    };
    expect(providersBody.providers.some((entry) => entry.providerId === 'openai')).toBe(true);
    expect(providersBody.providers.find((entry) => entry.providerId === 'openai')?.runtime.auth?.routes?.some((route) => route.route === 'subscription-oauth')).toBe(true);
    expect(providersBody.providers.some((entry) => entry.providerId === 'amazon-bedrock')).toBe(true);
    expect(providersBody.providers.some((entry) => entry.providerId === 'anthropic-vertex')).toBe(true);
    expect(providersBody.providers.some((entry) => entry.providerId === 'github-copilot')).toBe(true);
    expect(providersBody.providers.some((entry) => entry.providerId === 'xai')).toBe(true);
    expect(providersBody.providers.some((entry) => entry.providerId === 'litellm')).toBe(true);

    const provider = await fetch('http://127.0.0.1:39421/api/providers/openai', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(provider.status).toBe(200);
    const providerBody = await provider.json() as { providerId: string; models: Array<{ id: string }> };
    expect(providerBody.providerId).toBe('openai');
    expect(Array.isArray(providerBody.models)).toBe(true);

    const usage = await fetch('http://127.0.0.1:39421/api/providers/openai/usage', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(usage.status).toBe(200);
    const usageBody = await usage.json() as { providerId: string; usage: { streaming: boolean } };
    expect(usageBody.providerId).toBe('openai');
    expect(usageBody.usage.streaming).toBe(true);
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

  test('channel setup, doctor, lifecycle, and allowlist APIs expose expanded surface contracts', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.telegram.enabled', true);
    config.setDynamic('surfaces.telegram.botToken', 'telegram-token');
    config.setDynamic('surfaces.telegram.botUsername', 'goodvibes_bot');
    config.setDynamic('surfaces.telegram.defaultChatId', '-100200300');
    config.setDynamic('surfaces.signal.enabled', true);
    config.setDynamic('surfaces.signal.bridgeUrl', 'https://signal-bridge.example.test');
    config.setDynamic('surfaces.signal.account', '+15551234567');
    daemon = createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const auth = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

    const setup = await fetch('http://127.0.0.1:39421/api/channels/setup/telegram', { headers: auth });
    expect(setup.status).toBe(200);
    const setupBody = await setup.json() as {
      surface: string;
      version: number;
      fields: Array<{ id: string }>;
      secretTargets: Array<{ id: string; required: boolean }>;
    };
    expect(setupBody.surface).toBe('telegram');
    expect(setupBody.version).toBe(1);
    expect(setupBody.fields.some((field) => field.id === 'mode')).toBe(true);
    expect(setupBody.secretTargets.some((target) => target.id === 'primary' && target.required)).toBe(true);

    const doctor = await fetch('http://127.0.0.1:39421/api/channels/doctor/signal', { headers: auth });
    expect(doctor.status).toBe(200);
    const doctorBody = await doctor.json() as {
      surface: string;
      checks: Array<{ id: string; status: string }>;
      repairActions: Array<{ id: string }>;
    };
    expect(doctorBody.surface).toBe('signal');
    expect(doctorBody.checks.some((check) => check.id === 'configured')).toBe(true);
    expect(doctorBody.repairActions.some((action) => action.id === 'migrate-lifecycle')).toBe(true);

    const repairs = await fetch('http://127.0.0.1:39421/api/channels/repair-actions/telegram', { headers: auth });
    expect(repairs.status).toBe(200);
    const repairsBody = await repairs.json() as { actions: Array<{ id: string }> };
    expect(repairsBody.actions.some((action) => action.id === 'inspect')).toBe(true);

    const lifecycleBefore = await fetch('http://127.0.0.1:39421/api/channels/lifecycle/telegram', { headers: auth });
    expect(lifecycleBefore.status).toBe(200);
    const lifecycleBeforeBody = await lifecycleBefore.json() as { currentVersion: number; targetVersion: number };
    expect(lifecycleBeforeBody.currentVersion).toBe(0);
    expect(lifecycleBeforeBody.targetVersion).toBe(1);

    const migrate = await fetch('http://127.0.0.1:39421/api/channels/lifecycle/telegram/migrate', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(migrate.status).toBe(200);
    const migrateBody = await migrate.json() as { currentVersion: number };
    expect(migrateBody.currentVersion).toBe(1);

    const allowlistResolve = await fetch('http://127.0.0.1:39421/api/channels/allowlist/telegram/resolve', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ add: ['@alice', '#ops-room'] }),
    });
    expect(allowlistResolve.status).toBe(200);
    const allowlistResolveBody = await allowlistResolve.json() as { resolved: Array<{ kind: string; id: string }> };
    expect(allowlistResolveBody.resolved.some((entry) => entry.kind === 'user' && entry.id === 'alice')).toBe(true);
    expect(allowlistResolveBody.resolved.some((entry) => entry.kind === 'channel' && entry.id === 'ops-room')).toBe(true);

    const allowlistEdit = await fetch('http://127.0.0.1:39421/api/channels/allowlist/telegram/edit', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ add: ['@alice', '#ops-room'] }),
    });
    expect(allowlistEdit.status).toBe(200);
    const allowlistEditBody = await allowlistEdit.json() as {
      updatedPolicy: { surface: string; allowlistUserIds: string[]; allowlistChannelIds: string[] };
    };
    expect(allowlistEditBody.updatedPolicy.surface).toBe('telegram');
    expect(allowlistEditBody.updatedPolicy.allowlistUserIds).toContain('alice');
    expect(allowlistEditBody.updatedPolicy.allowlistChannelIds).toContain('ops-room');
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
    const config = makeConfig();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-test-secret');
    daemon = createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
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
    const config = makeConfig();
    config.setDynamic('surfaces.webhook.enabled', false);
    config.setDynamic('surfaces.webhook.secret', '');
    daemon = createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
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
    const config = makeConfig();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-test-secret');
    daemon = createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
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
    const config = makeConfig();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-hmac-secret');
    daemon = createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
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
    const config = makeConfig();
    config.setDynamic('surfaces.webhook.enabled', true);
    config.setDynamic('surfaces.webhook.secret', 'webhook-hmac-secret');
    daemon = createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
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

  test('artifact APIs can create metadata records and stream stored content', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const create = await fetch('http://127.0.0.1:39421/api/artifacts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: 'notes.md',
        text: '# shipped\n',
        metadata: { ticket: 'GV-1' },
      }),
    });
    expect(create.status).toBe(201);
    const createBody = await create.json() as { artifact: { id: string; filename?: string } };
    expect(createBody.artifact.filename).toBe('notes.md');

    const inspect = await fetch(`http://127.0.0.1:39421/api/artifacts/${createBody.artifact.id}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(inspect.status).toBe(200);
    expect((await inspect.json() as { artifact: { metadata: { ticket: string } } }).artifact.metadata.ticket).toBe('GV-1');

    const content = await fetch(`http://127.0.0.1:39421/api/artifacts/${createBody.artifact.id}/content?download=0`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toContain('text/markdown');
    expect(await content.text()).toBe('# shipped\n');
  });

  test('ntfy webhook creates route bindings and can spawn agents', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.ntfy.enabled', true);
    config.setDynamic('surfaces.ntfy.token', 'ntfy-test-token');
    daemon = createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
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
    const config = makeConfig();
    config.setDynamic('surfaces.ntfy.enabled', true);
    config.setDynamic('surfaces.ntfy.token', 'ntfy-test-token');
    daemon = createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
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

  test('telegram and Google Chat webhook ingress create route bindings and queue agents', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.telegram.enabled', true);
    config.setDynamic('surfaces.telegram.botUsername', 'goodvibes_bot');
    config.setDynamic('surfaces.googleChat.enabled', true);
    config.setDynamic('surfaces.googleChat.verificationToken', 'google-chat-token');
    daemon = createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const telegram = await fetch('http://127.0.0.1:39421/webhook/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: 10,
        message: {
          message_id: 44,
          text: '/goodvibes summarize the deploy status',
          message_thread_id: 99,
          chat: { id: -100777, type: 'supergroup', title: 'Ops' },
          from: { id: 42, username: 'alice' },
        },
      }),
    });
    expect(telegram.status).toBe(200);
    const telegramBody = await telegram.json() as { queued: boolean; bindingId: string };
    expect(telegramBody.queued).toBe(true);

    const googleChat = await fetch('http://127.0.0.1:39421/webhook/google-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'MESSAGE',
        token: 'google-chat-token',
        message: {
          text: 'summarize the release notes',
          argumentText: 'summarize the release notes',
          thread: { name: 'spaces/AAA/threads/BBB' },
        },
        space: { name: 'spaces/AAA', displayName: 'Ops Space' },
        user: { name: 'users/123', displayName: 'Alice' },
      }),
    });
    expect(googleChat.status).toBe(200);
    const googleChatBody = await googleChat.json() as { text: string };
    expect(googleChatBody.text).toContain('Running');

    const list = await fetch('http://127.0.0.1:39421/api/routes/bindings', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const listBody = await list.json() as {
      bindings: Array<{ id: string; surfaceKind: string; externalId: string; channelId?: string }>;
    };
    expect(listBody.bindings.some((binding) => binding.id === telegramBody.bindingId && binding.surfaceKind === 'telegram' && binding.externalId === '99')).toBe(true);
    expect(listBody.bindings.some((binding) => binding.surfaceKind === 'google-chat' && binding.externalId === 'spaces/AAA/threads/BBB')).toBe(true);
  });

  test('signal, WhatsApp, and iMessage ingress paths queue work and expose verification flows', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.signal.enabled', true);
    config.setDynamic('surfaces.signal.token', 'signal-bridge-token');
    config.setDynamic('surfaces.signal.account', '+15550001111');
    config.setDynamic('surfaces.whatsapp.enabled', true);
    config.setDynamic('surfaces.whatsapp.verifyToken', 'whatsapp-verify-token');
    config.setDynamic('surfaces.whatsapp.signingSecret', 'whatsapp-signing-secret');
    config.setDynamic('surfaces.whatsapp.phoneNumberId', '106540352242922');
    config.setDynamic('surfaces.imessage.enabled', true);
    config.setDynamic('surfaces.imessage.token', 'imessage-bridge-token');
    config.setDynamic('surfaces.imessage.account', 'me@icloud.test');
    daemon = createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const challenge = await fetch('http://127.0.0.1:39421/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=whatsapp-verify-token&hub.challenge=abc123');
    expect(challenge.status).toBe(200);
    expect(await challenge.text()).toBe('abc123');

    const signal = await fetch('http://127.0.0.1:39421/webhook/signal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer signal-bridge-token',
      },
      body: JSON.stringify({
        recipient: '+15551212',
        message: 'signal deploy summary',
      }),
    });
    expect(signal.status).toBe(200);
    const signalBody = await signal.json() as { queued: boolean; bindingId: string };
    expect(signalBody.queued).toBe(true);

    const whatsappPayload = {
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: '106540352242922' },
            contacts: [{ profile: { name: 'Alice' } }],
            messages: [{
              id: 'wamid-123',
              from: '+15552323',
              text: { body: 'whatsapp deploy summary' },
            }],
          },
        }],
      }],
    };
    const whatsappBodyRaw = JSON.stringify(whatsappPayload);
    const whatsapp = await fetch('http://127.0.0.1:39421/webhook/whatsapp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'whatsapp-signing-secret').update(whatsappBodyRaw).digest('hex')}`,
      },
      body: whatsappBodyRaw,
    });
    expect(whatsapp.status).toBe(200);
    const whatsappBody = await whatsapp.json() as { queued: boolean; bindingId: string };
    expect(whatsappBody.queued).toBe(true);

    const imessage = await fetch('http://127.0.0.1:39421/webhook/imessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer imessage-bridge-token',
      },
      body: JSON.stringify({
        chatId: 'chat-123',
        message: 'imessage deploy summary',
      }),
    });
    expect(imessage.status).toBe(200);
    const imessageBody = await imessage.json() as { queued: boolean; bindingId: string };
    expect(imessageBody.queued).toBe(true);

    const list = await fetch('http://127.0.0.1:39421/api/routes/bindings', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const listBody = await list.json() as {
      bindings: Array<{ id: string; surfaceKind: string; externalId: string }>;
    };
    expect(listBody.bindings.some((binding) => binding.id === signalBody.bindingId && binding.surfaceKind === 'signal' && binding.externalId === '+15551212')).toBe(true);
    expect(listBody.bindings.some((binding) => binding.id === whatsappBody.bindingId && binding.surfaceKind === 'whatsapp' && binding.externalId === '+15552323')).toBe(true);
    expect(listBody.bindings.some((binding) => binding.id === imessageBody.bindingId && binding.surfaceKind === 'imessage' && binding.externalId === 'chat-123')).toBe(true);
  });

  test('msteams, BlueBubbles, Mattermost, and Matrix ingress paths queue work and persist route bindings', async () => {
    const config = makeConfig();
    config.setDynamic('surfaces.msteams.enabled', true);
    config.setDynamic('surfaces.msteams.appId', 'teams-app-id');
    config.setDynamic('surfaces.msteams.appPassword', 'teams-app-password');
    config.setDynamic('surfaces.bluebubbles.enabled', true);
    config.setDynamic('surfaces.bluebubbles.password', 'bb-pass');
    config.setDynamic('surfaces.bluebubbles.account', 'me@icloud.test');
    config.setDynamic('surfaces.mattermost.enabled', true);
    config.setDynamic('surfaces.mattermost.botToken', 'mattermost-bot-token');
    config.setDynamic('surfaces.mattermost.baseUrl', 'https://mattermost.example.test');
    config.setDynamic('surfaces.matrix.enabled', true);
    config.setDynamic('surfaces.matrix.accessToken', 'matrix-access-token');
    config.setDynamic('surfaces.matrix.homeserverUrl', 'https://matrix.example.test');
    daemon = createTestDaemon({ configManager: config, userAuth: makeUserAuth() });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const teams = await fetch('http://127.0.0.1:39421/webhook/msteams', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer teams-app-password',
      },
      body: JSON.stringify({
        type: 'message',
        serviceUrl: 'https://smba.trafficmanager.net/teams',
        conversation: { id: 'a:conversation-1', conversationType: 'personal' },
        from: { id: '29:user-1', name: 'Alice' },
        text: 'teams deployment summary',
      }),
    });
    expect(teams.status).toBe(200);
    const teamsBody = await teams.json() as { queued: boolean; bindingId: string };
    expect(teamsBody.queued).toBe(true);

    const bluebubbles = await fetch('http://127.0.0.1:39421/webhook/bluebubbles?password=bb-pass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'bluebubbles deployment summary',
        chatGuid: 'iMessage;-;+15551234567',
        senderId: '+15551234567',
      }),
    });
    expect(bluebubbles.status).toBe(200);
    const bluebubblesBody = await bluebubbles.json() as { queued: boolean; bindingId: string };
    expect(bluebubblesBody.queued).toBe(true);

    const mattermost = await fetch('http://127.0.0.1:39421/webhook/mattermost', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer mattermost-bot-token',
      },
      body: JSON.stringify({
        channel_id: 'channel-123',
        team_id: 'team-ops',
        user_id: 'user-123',
        text: 'mattermost deployment summary',
      }),
    });
    expect(mattermost.status).toBe(200);
    const mattermostBody = await mattermost.json() as { queued: boolean; bindingId: string };
    expect(mattermostBody.queued).toBe(true);

    const matrix = await fetch('http://127.0.0.1:39421/webhook/matrix', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer matrix-access-token',
      },
      body: JSON.stringify({
        room_id: '!room:example.test',
        sender: '@alice:example.test',
        content: {
          body: 'matrix deployment summary',
          msgtype: 'm.text',
        },
      }),
    });
    expect(matrix.status).toBe(200);
    const matrixBody = await matrix.json() as { queued: boolean; bindingId: string };
    expect(matrixBody.queued).toBe(true);

    const list = await fetch('http://127.0.0.1:39421/api/routes/bindings', {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const listBody = await list.json() as {
      bindings: Array<{ id: string; surfaceKind: string; externalId: string }>;
    };
    expect(listBody.bindings.some((binding) => binding.id === teamsBody.bindingId && binding.surfaceKind === 'msteams' && binding.externalId === 'a:conversation-1')).toBe(true);
    expect(listBody.bindings.some((binding) => binding.id === bluebubblesBody.bindingId && binding.surfaceKind === 'bluebubbles' && binding.externalId === 'iMessage;-;+15551234567')).toBe(true);
    expect(listBody.bindings.some((binding) => binding.id === mattermostBody.bindingId && binding.surfaceKind === 'mattermost' && binding.externalId === 'channel-123')).toBe(true);
    expect(listBody.bindings.some((binding) => binding.id === matrixBody.bindingId && binding.surfaceKind === 'matrix' && binding.externalId === '!room:example.test')).toBe(true);
  });

  test('slack interactive approval callbacks resolve approvals through signed actions', async () => {
    const previousSigningSecret = process.env.SLACK_SIGNING_SECRET;
    process.env.SLACK_SIGNING_SECRET = 'slack-signing-secret-test';
    try {
      daemon.enable({ daemon: true }, TEST_TOKEN);
      await daemon.start();

      const broker = runtimeServices.approvalBroker;
      const approvalCallId = `call-slack-approval-${randomUUID().slice(0, 8)}`;
      const pendingApproval = broker.requestApproval({
        request: {
          callId: approvalCallId,
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

      let approval = broker.listApprovals().find((entry) => entry.callId === approvalCallId);
      for (let i = 0; i < 50 && !approval; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        approval = broker.listApprovals().find((entry) => entry.callId === approvalCallId);
      }
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
      for (let i = 0; i < 50 && broker.getApproval(approval!.id)?.status !== 'approved'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(broker.getApproval(approval!.id)?.status).toBe('approved');
      await expect(pendingApproval).resolves.toEqual(expect.objectContaining({ approved: true }));
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
  let userAuth: UserAuthManager;
  let tempRoot: string;
  let workingDir: string;
  let homeDir: string;
  let configDir: string;
  const makeConfig = () => new ConfigManager({ surfaceRoot: 'tui',  configDir, workingDir, homeDir });
  const createTestListener = (options: {
    readonly configManager?: ConfigManager;
    readonly userAuth?: UserAuthManager;
    readonly serveFactory?: typeof Bun.serve;
    readonly port?: number;
    readonly host?: string;
  } = {}): HttpListener => new HttpListener({
    port: options.port ?? 39422,
    host: options.host ?? '127.0.0.1',
    configManager: options.configManager ?? makeConfig(),
    userAuth: options.userAuth ?? userAuth,
    ...(options.serveFactory ? { serveFactory: options.serveFactory } : {}),
  });

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'gv-listener-config-'));
    workingDir = join(tempRoot, 'workspace');
    homeDir = join(tempRoot, 'home');
    configDir = join(homeDir, '.goodvibes', 'tui');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    userAuth = new UserAuthManager({
      bootstrapFilePath: join(configDir, 'auth-users.json'),
      bootstrapCredentialPath: join(configDir, 'auth-bootstrap.txt'),
      users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
    });
    listener = createTestListener();
  });

  afterEach(async () => {
    await listener.stop();
    rmSync(tempRoot, { recursive: true, force: true });
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

  test('passes TLS options to Bun.serve when direct listener TLS is enabled', async () => {
    const certDir = join(homeDir, '.goodvibes', 'tui', 'certs');
    mkdirSync(certDir, { recursive: true });
    const certFile = join(certDir, 'fullchain.pem');
    const keyFile = join(certDir, 'privkey.pem');
    writeFileSync(certFile, 'CERT\n', 'utf-8');
    writeFileSync(keyFile, 'KEY\n', 'utf-8');
    const config = makeConfig();
    config.set('httpListener.tls.mode', 'direct');
    let capturedOptions: Record<string, unknown> | null = null;
    const serveFactory = mock((options: unknown) => {
      capturedOptions = options as Record<string, unknown>;
      return {
      stop: mock(() => {}),
      port: (capturedOptions as Record<string, unknown>).port,
      hostname: (capturedOptions as Record<string, unknown>).hostname,
    };
    });
    listener = createTestListener({
      configManager: config,
      serveFactory: serveFactory as unknown as typeof Bun.serve,
    });

    listener.enable({ httpListener: true }, TEST_TOKEN);
    await listener.start();

    expect(serveFactory).toHaveBeenCalledTimes(1);
    expect(capturedOptions).toMatchObject({
      port: 39422,
      hostname: '127.0.0.1',
      tls: {
        cert: Bun.file(certFile),
        key: Bun.file(keyFile),
      },
    });
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
    expect(res.headers.get('set-cookie')).toContain('goodvibes_session=');
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
      configManager: makeConfig(),
      userAuth: new UserAuthManager({
        bootstrapFilePath: join(configDir, 'auth-users.json'),
        bootstrapCredentialPath: join(configDir, 'auth-bootstrap.txt'),
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
