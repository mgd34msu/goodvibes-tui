import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ReferenceNodeHostClient,
  createDefaultReferenceNodeHostConfig,
  type ReferenceNodeHostConfig,
} from '../src/index.ts';
import { makeProjectTempDir } from '../../../src/test/helpers/project-temp.ts';

function makeTempDir(): string {
  return makeProjectTempDir('gv-reference-node-host');
}

describe('ReferenceNodeHostClient', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let baseUrl = '';
  let tempDir = '';
  let approved = false;
  let recordedCompletions: Array<{ workId: string; body: Record<string, unknown> }> = [];

  beforeEach(() => {
    tempDir = makeTempDir();
    approved = false;
    recordedCompletions = [];
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/api/remote/node-host/contract' && req.method === 'GET') {
          return Response.json({
            contract: {
              schemaVersion: 1,
              transport: 'http-json',
              basePath: '/api/remote',
              peerKinds: ['node', 'device'],
              workTypes: ['invoke', 'status.request', 'location.request', 'session.message', 'automation.run'],
              scopes: ['remote:heartbeat', 'remote:pull', 'remote:complete'],
              recommendedHeartbeatMs: 10,
              recommendedWorkPullMs: 10,
              endpoints: [],
              workCompletionStatuses: ['completed', 'failed', 'cancelled'],
              metadata: { test: true },
            },
          });
        }
        if (url.pathname === '/api/remote/pair/request' && req.method === 'POST') {
          return Response.json({
            request: {
              id: 'pair-test',
              peerKind: 'node',
              requestedId: 'reference-node-host-test',
              label: 'reference-node-host-test',
              capabilities: ['files'],
              commands: ['status.request', 'location.request', 'session.message', 'automation.run', 'invoke'],
              requestedBy: 'remote',
              status: 'pending',
              challengePreview: 'gvpair_…test',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              expiresAt: Date.now() + 600_000,
              metadata: {},
            },
            challenge: 'pair-secret',
          });
        }
        if (url.pathname === '/api/remote/pair/requests/pair-test/approve' && req.method === 'POST') {
          approved = true;
          return Response.json({ ok: true });
        }
        if (url.pathname === '/api/remote/pair/verify' && req.method === 'POST') {
          const body = await req.json() as { requestId?: string; challenge?: string };
          if (!approved || body.requestId !== 'pair-test' || body.challenge !== 'pair-secret') {
            return new Response('not ready', { status: 404 });
          }
          return Response.json({
            peer: {
              id: 'peer-1',
              kind: 'node',
              label: 'reference-node-host-test',
              requestedId: 'reference-node-host-test',
              status: 'connected',
              pairedAt: Date.now(),
              tokens: [],
              capabilities: [],
              commands: [],
              metadata: {},
            },
            token: {
              id: 'token-1',
              label: 'pair-verified-token',
              scopes: ['remote:heartbeat', 'remote:pull', 'remote:complete'],
              issuedAt: Date.now(),
              fingerprint: 'token-1',
              value: 'peer-token',
            },
          });
        }
        if (url.pathname === '/api/remote/heartbeat' && req.method === 'POST') {
          const auth = req.headers.get('authorization');
          expect(auth).toBe('Bearer peer-token');
          return Response.json({
            peer: {
              id: 'peer-1',
              kind: 'node',
              label: 'reference-node-host-test',
              requestedId: 'reference-node-host-test',
              status: 'connected',
              pairedAt: Date.now(),
              lastSeenAt: Date.now(),
              tokens: [],
              capabilities: [],
              commands: [],
              metadata: {},
            },
          });
        }
        if (url.pathname === '/api/remote/work/pull' && req.method === 'POST') {
          const body = await req.json() as { maxItems?: number };
          expect(body.maxItems).toBe(4);
          expect(req.headers.get('authorization')).toBe('Bearer peer-token');
          return Response.json({
            work: [
              {
                id: 'work-status',
                peerId: 'peer-1',
                peerKind: 'node',
                type: 'status.request',
                command: 'status.request',
                priority: 'normal',
                status: 'queued',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                queuedBy: 'operator',
                metadata: {},
              },
              {
                id: 'work-location',
                peerId: 'peer-1',
                peerKind: 'node',
                type: 'location.request',
                command: 'location.request',
                priority: 'normal',
                status: 'queued',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                queuedBy: 'operator',
                metadata: {},
              },
              {
                id: 'work-session',
                peerId: 'peer-1',
                peerKind: 'node',
                type: 'session.message',
                command: 'session.message',
                priority: 'normal',
                status: 'queued',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                queuedBy: 'operator',
                sessionId: 'session-1',
                metadata: {},
                payload: { message: 'hello from operator' },
              },
              {
                id: 'work-automation',
                peerId: 'peer-1',
                peerKind: 'node',
                type: 'automation.run',
                command: 'automation.run',
                priority: 'normal',
                status: 'queued',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                queuedBy: 'operator',
                automationRunId: 'run-1',
                automationJobId: 'job-1',
                metadata: {},
                payload: { summary: 'demo automation' },
              },
            ],
          });
        }
        const completeMatch = url.pathname.match(/^\/api\/remote\/work\/([^/]+)\/complete$/);
        if (completeMatch && req.method === 'POST') {
          const body = await req.json() as Record<string, unknown>;
          expect(req.headers.get('authorization')).toBe('Bearer peer-token');
          recordedCompletions.push({ workId: completeMatch[1], body });
          return Response.json({
            work: {
              id: completeMatch[1],
              peerId: 'peer-1',
              peerKind: 'node',
              type: 'invoke',
              command: 'invoke',
              priority: 'normal',
              status: body.status ?? 'completed',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              queuedBy: 'operator',
              metadata: {},
            },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    if (server) server.stop(true);
    server = null;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('pairs, verifies, heartbeats, pulls work, and completes reference work items', async () => {
    const config: ReferenceNodeHostConfig = createDefaultReferenceNodeHostConfig({
      baseUrl,
      statePath: join(tempDir, 'state.json'),
      operatorToken: 'operator-token',
      verifyTimeoutMs: 60_000,
      verifyRetryMs: 10,
      pairingRetryMs: 10,
      heartbeatIntervalMs: 10,
      workPullIntervalMs: 10,
    });
    const client = new ReferenceNodeHostClient(config);

    const pair = await client.requestPairing();
    expect(pair.request.id).toBe('pair-test');
    expect(await client.approvePairRequest()).toBe(true);
    expect(await client.verifyPairing()).toBe(true);

    const summary = await client.runOnce();
    expect(summary.paired).toBe(true);
    expect(client.getState().lastHeartbeatAt).toBeDefined();
    expect(summary.claimed).toBe(4);
    expect(summary.completed).toBe(4);
    expect(summary.failed).toBe(0);
    expect(recordedCompletions).toHaveLength(4);
    expect(recordedCompletions[0]?.body.status).toBe('completed');
    expect(recordedCompletions[0]?.body.result).toBeDefined();
  });

  test('enforces a command allowlist for generic invoke work', async () => {
    const config = createDefaultReferenceNodeHostConfig({
      baseUrl,
      statePath: join(tempDir, 'state.json'),
      allowedCommands: ['status.request'],
    });
    const client = new ReferenceNodeHostClient(config);
    const outcome = await client.processWork({
      id: 'work-invoke',
      peerId: 'peer-1',
      peerKind: 'node',
      type: 'invoke',
      command: 'shell.exec',
      priority: 'normal',
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      queuedBy: 'operator',
      metadata: {},
      payload: { command: 'shell.exec' },
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('not allowlisted');
  });
});
