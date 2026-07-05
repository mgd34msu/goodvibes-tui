/**
 * session-inbound-steer-daemon-integration.test.ts
 *
 * D3 acceptance evidence (the substantive one): drives the FULL live-surface
 * steer path against a REAL bootDaemon over a real HttpTransport — no mocked wire.
 *
 * Proves the charter end-to-end: a TUI registers a session (surface-managed, live
 * participant); a webui surface steers that session over the wire; the daemon
 * QUEUES the steer for the surface (not a daemon executor); the TUI's inbound
 * poller collects it, fires the surface-side injection callback, and ACKS delivery
 * on the wire (queued -> delivered). Plus D7b: with two live TUI sessions from
 * different projects, a steer to each lands only in the owning session's poller.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '@pellux/goodvibes-sdk/platform/daemon';
import { createHttpTransport } from '@/runtime/index.ts';
import { SessionSpineClient, type SpineSessionsClient } from '../../runtime/session-spine-client.ts';
import {
  SessionInboundInputPoller,
  type InboundSteer,
  type SpineInboundInputsClient,
} from '../../runtime/session-inbound-inputs.ts';

const TOKEN = 'inbound-steer-integration-token';
const SILENT = { debug: () => {}, info: () => {} };

async function waitFor<T>(fn: () => Promise<T | undefined | null>, timeoutMs = 2_000, intervalMs = 20): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

interface Harness {
  readonly daemon: BootedDaemon;
  readonly homeDirectory: string;
  readonly workingDir: string;
  readonly transport: ReturnType<typeof createHttpTransport>;
  readonly spineClient: SpineSessionsClient;
  readonly inboundClient: SpineInboundInputsClient;
}

async function startHarness(): Promise<Harness> {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'goodvibes-inbound-home-'));
  const workingDir = mkdtempSync(join(tmpdir(), 'goodvibes-inbound-project-'));
  const daemon = await bootDaemon({ homeDirectory, workingDir, port: 0, token: TOKEN });
  const transport = createHttpTransport({ baseUrl: daemon.url, authToken: TOKEN });
  const spineClient: SpineSessionsClient = {
    register: (input) => transport.operator.sessions.register(input),
    close: (sessionId) => transport.operator.sessions.close(sessionId),
  };
  const inboundClient: SpineInboundInputsClient = {
    listInputs: (sessionId, opts) => transport.operator.sessions.inputs.list(sessionId, opts) as unknown as Promise<{ inputs: readonly never[] }>,
    deliverInput: (sessionId, inputId, opts) => transport.operator.sessions.inputs.deliver(sessionId, inputId, opts),
  };
  return { daemon, homeDirectory, workingDir, transport, spineClient, inboundClient };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.daemon.stop();
  rmSync(harness.homeDirectory, { recursive: true, force: true });
  rmSync(harness.workingDir, { recursive: true, force: true });
}

/** Register a live TUI session and wait until the daemon lists it active. */
async function registerLiveTuiSession(harness: Harness, sessionId: string): Promise<void> {
  const client = new SessionSpineClient({ log: SILENT });
  client.activate(harness.spineClient);
  client.register({ sessionId, project: harness.workingDir, title: `TUI ${sessionId}` });
  await waitFor(async () => {
    const list = await harness.transport.operator.sessions.list(200) as unknown as { readonly sessions: readonly { id: string; status: string }[] };
    return list.sessions.find((s) => s.id === sessionId && s.status === 'active') ?? null;
  });
  client.dispose();
}

/** Fire a steer from the webui surface at a session over the wire. */
async function webuiSteer(harness: Harness, sessionId: string, body: string): Promise<void> {
  await harness.transport.operator.sessions.steer({
    sessionId,
    body,
    surfaceKind: 'webui',
    surfaceId: 'surface:webui',
    displayName: 'Alice',
  } as never);
}

describe('D3 — live-surface steer delivery against a real bootDaemon', () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) await stopHarness(harness);
    harness = null;
  });

  test('a webui steer is queued for the surface, collected by the TUI poller, injected, and acked delivered', async () => {
    harness = await startHarness();
    await registerLiveTuiSession(harness, 'tui-steer-1');

    await webuiSteer(harness, 'tui-steer-1', 'please resize the left panel');

    // The daemon must have QUEUED the steer for the surface (not spawned an executor):
    // it is visible as a queued input on the session.
    await waitFor(async () => {
      const res = await harness!.transport.operator.sessions.inputs.list('tui-steer-1', { state: 'queued' }) as unknown as { inputs: { id: string; intent: string; state: string; body: string }[] };
      return res.inputs.find((i) => i.intent === 'steer' && i.body === 'please resize the left panel') ?? null;
    });

    const received: InboundSteer[] = [];
    const poller = new SessionInboundInputPoller({ sessionId: () => 'tui-steer-1', onSteer: (s) => received.push(s), log: SILENT });
    poller.activate(harness.inboundClient);

    const delivered = await poller.pollOnce();

    // Injection callback fired with the steer body + originating surface.
    expect(received).toHaveLength(1);
    expect(received[0]!.body).toBe('please resize the left panel');
    expect(received[0]!.surfaceKind).toBe('webui');
    expect(delivered).toBe(1);

    // Wire acked: the input is no longer queued; it is delivered.
    const stillQueued = await harness.transport.operator.sessions.inputs.list('tui-steer-1', { state: 'queued' }) as unknown as { inputs: unknown[] };
    expect(stillQueued.inputs).toHaveLength(0);
    const deliveredInputs = await harness.transport.operator.sessions.inputs.list('tui-steer-1', { state: 'delivered' }) as unknown as { inputs: { body: string }[] };
    expect(deliveredInputs.inputs.some((i) => i.body === 'please resize the left panel')).toBe(true);

    poller.dispose();
  });

  test('D7b — two live TUI sessions (different projects): a steer to each lands only in the owning poller', async () => {
    harness = await startHarness();
    await registerLiveTuiSession(harness, 'tui-A');
    await registerLiveTuiSession(harness, 'tui-B');

    await webuiSteer(harness, 'tui-A', 'steer for A');
    await webuiSteer(harness, 'tui-B', 'steer for B');

    // Wait until both steers are queued.
    for (const [id, body] of [['tui-A', 'steer for A'], ['tui-B', 'steer for B']] as const) {
      await waitFor(async () => {
        const res = await harness!.transport.operator.sessions.inputs.list(id, { state: 'queued' }) as unknown as { inputs: { body: string }[] };
        return res.inputs.find((i) => i.body === body) ?? null;
      });
    }

    const recA: InboundSteer[] = [];
    const recB: InboundSteer[] = [];
    const pollerA = new SessionInboundInputPoller({ sessionId: () => 'tui-A', onSteer: (s) => recA.push(s), log: SILENT });
    const pollerB = new SessionInboundInputPoller({ sessionId: () => 'tui-B', onSteer: (s) => recB.push(s), log: SILENT });
    pollerA.activate(harness.inboundClient);
    pollerB.activate(harness.inboundClient);

    await pollerA.pollOnce();
    await pollerB.pollOnce();

    expect(recA.map((s) => s.body)).toEqual(['steer for A']);
    expect(recB.map((s) => s.body)).toEqual(['steer for B']);

    pollerA.dispose();
    pollerB.dispose();
  });
});
