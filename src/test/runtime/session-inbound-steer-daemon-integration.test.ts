/**
 * session-inbound-steer-daemon-integration.test.ts
 *
 * Acceptance evidence (the substantive one): drives the FULL live-surface
 * steer path against a REAL bootDaemon over a real HttpTransport — no mocked wire.
 *
 * Proves the charter end-to-end: a TUI registers a session (surface-managed, live
 * participant); a webui surface steers that session over the wire; the daemon
 * QUEUES the steer for the surface (not a daemon executor); the TUI's inbound
 * poller collects it, fires the surface-side injection callback, and ACKS delivery
 * on the wire (queued -> delivered). Plus, with two live TUI sessions from
 * different projects, a steer to each lands only in the owning session's poller.
 */
import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { bootDaemon, type BootedDaemon } from '@pellux/goodvibes-sdk/platform/daemon';
import { createHttpTransport } from '@/runtime/index.ts';
import { SessionSpineClient, TUI_SPINE_PARTICIPANT } from '@pellux/goodvibes-sdk/platform/runtime/session-spine';
import { createTuiSpineTransport, type SpineSessionsClient } from '../../runtime/session-spine-transport.ts';
import {
  SessionInboundInputPoller,
  type InboundSteer,
  type SpineInboundInputsClient,
} from '../../runtime/session-inbound-inputs.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const TOKEN = 'inbound-steer-integration-token';
const SILENT = { debug: () => {}, info: () => {} };

// 8s (not 2s): a real bootDaemon() + real HTTP round trips are sensitive to host
// load (observed flaky timeouts under load despite the daemon-side plumbing being
// correct) — both tests below also raise bun's own per-test timeout accordingly.
async function waitFor<T>(fn: () => Promise<T | undefined | null>, timeoutMs = 8_000, intervalMs = 20): Promise<T> {
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
  const homeDirectory = makeProjectTempDir('goodvibes-inbound-home');
  const workingDir = makeProjectTempDir('goodvibes-inbound-project');
  const daemon = await bootDaemon({ homeDirectory, workingDir, port: 0, token: TOKEN });
  const transport = createHttpTransport({ baseUrl: daemon.url, authToken: TOKEN });
  const spineClient: SpineSessionsClient = {
    register: (input) => transport.operator.sessions.register(input),
    close: (sessionId) => transport.operator.sessions.close(sessionId),
  };
  const inboundClient: SpineInboundInputsClient = {
    listInputs: async (sessionId, opts) => ({
      inputs: await transport.operator.sessions.inputs(sessionId, opts.limit, { state: opts.state, since: opts.since }),
    }),
    deliverInput: (sessionId, inputId, opts) => transport.operator.sessions.deliverInput(sessionId, inputId, opts),
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
  const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: SILENT });
  client.activate(createTuiSpineTransport(harness.spineClient));
  client.register({ sessionId, project: harness.workingDir, title: `TUI ${sessionId}` });
  await waitFor(async () => {
    const sessions = await harness.transport.operator.sessions.list(200) as unknown as readonly { id: string; status: string }[];
    return sessions.find((s) => s.id === sessionId && s.status === 'active') ?? null;
  });
  client.dispose();
}

/** Fire a steer from the webui surface at a session over the wire. */
async function webuiSteer(harness: Harness, sessionId: string, body: string): Promise<void> {
  await harness.transport.operator.sessions.steerMessage(sessionId, {
    body,
    surfaceKind: 'webui',
    surfaceId: 'surface:webui',
    displayName: 'Alice',
  });
}

/** Read a session's inputs filtered by state, via the real HttpTransport wire. */
async function listInputsByState(
  harness: Harness,
  sessionId: string,
  state: string,
): Promise<readonly { readonly id: string; readonly intent: string; readonly state: string; readonly body: string }[]> {
  return harness.transport.operator.sessions.inputs(sessionId, 100, { state }) as unknown as Promise<
    readonly { readonly id: string; readonly intent: string; readonly state: string; readonly body: string }[]
  >;
}

// Each test owns a LOCAL `harness` const (never a shared describe-block `let`)
// and tears down via try/finally, including any poller it activated — a leftover
// setInterval or a stale closure over a shared mutable `harness` variable is
// exactly the class of cross-test flake this file must never reintroduce.
describe('live-surface steer delivery against a real bootDaemon', () => {
  test('a webui steer is queued for the surface, collected by the TUI poller, injected, and acked delivered', async () => {
    const harness = await startHarness();
    let poller: SessionInboundInputPoller | null = null;
    try {
      await registerLiveTuiSession(harness, 'tui-steer-1');

      await webuiSteer(harness, 'tui-steer-1', 'please resize the left panel');

      // The daemon must have QUEUED the steer for the surface (not spawned an executor):
      // it is visible as a queued input on the session.
      try {
        await waitFor(async () => {
          const inputs = await listInputsByState(harness, 'tui-steer-1', 'queued');
          return inputs.find((i) => i.intent === 'steer' && i.body === 'please resize the left panel') ?? null;
        });
      } catch (waitErr) {
        // Dump the real session/input state on failure — this is a real-daemon
        // wire test, so a timeout here is either a genuine regression or an
        // environmental slowdown; either way the state dump is worth more than
        // a bare "timed out".
        const session = await harness.transport.operator.sessions.get('tui-steer-1');
        const allInputs = await harness.transport.operator.sessions.inputs('tui-steer-1', 100);
        // eslint-disable-next-line no-console -- diagnostic-on-failure, not routine output
        console.error('session state at failure:', JSON.stringify(session, null, 2), 'inputs:', JSON.stringify(allInputs, null, 2));
        throw waitErr;
      }

      const received: InboundSteer[] = [];
      poller = new SessionInboundInputPoller({ sessionId: () => 'tui-steer-1', onSteer: (s) => received.push(s), log: SILENT });
      poller.activate(harness.inboundClient);

      const delivered = await poller.pollOnce();

      // Injection callback fired with the steer body + originating surface.
      expect(received).toHaveLength(1);
      expect(received[0]!.body).toBe('please resize the left panel');
      expect(received[0]!.surfaceKind).toBe('webui');
      expect(delivered).toBe(1);

      // Wire acked: the input is no longer queued; it is delivered.
      const stillQueued = await listInputsByState(harness, 'tui-steer-1', 'queued');
      expect(stillQueued).toHaveLength(0);
      const deliveredInputs = await listInputsByState(harness, 'tui-steer-1', 'delivered');
      expect(deliveredInputs.some((i) => i.body === 'please resize the left panel')).toBe(true);
    } finally {
      poller?.dispose();
      await stopHarness(harness);
    }
  }, 15_000);

  test('D7b — two live TUI sessions (different projects): a steer to each lands only in the owning poller', async () => {
    const harness = await startHarness();
    let pollerA: SessionInboundInputPoller | null = null;
    let pollerB: SessionInboundInputPoller | null = null;
    try {
      await registerLiveTuiSession(harness, 'tui-A');
      await registerLiveTuiSession(harness, 'tui-B');

      await webuiSteer(harness, 'tui-A', 'steer for A');
      await webuiSteer(harness, 'tui-B', 'steer for B');

      // Wait until both steers are queued.
      for (const [id, body] of [['tui-A', 'steer for A'], ['tui-B', 'steer for B']] as const) {
        await waitFor(async () => {
          const inputs = await listInputsByState(harness, id, 'queued');
          return inputs.find((i) => i.body === body) ?? null;
        });
      }

      const recA: InboundSteer[] = [];
      const recB: InboundSteer[] = [];
      pollerA = new SessionInboundInputPoller({ sessionId: () => 'tui-A', onSteer: (s) => recA.push(s), log: SILENT });
      pollerB = new SessionInboundInputPoller({ sessionId: () => 'tui-B', onSteer: (s) => recB.push(s), log: SILENT });
      pollerA.activate(harness.inboundClient);
      pollerB.activate(harness.inboundClient);

      await pollerA.pollOnce();
      await pollerB.pollOnce();

      expect(recA.map((s) => s.body)).toEqual(['steer for A']);
      expect(recB.map((s) => s.body)).toEqual(['steer for B']);
    } finally {
      pollerA?.dispose();
      pollerB?.dispose();
      await stopHarness(harness);
    }
  }, 15_000);
});
