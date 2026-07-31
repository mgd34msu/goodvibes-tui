/**
 * client-adopt-e2e.test.ts — this app's client seams against a REAL daemon.
 *
 * ── Why a real daemon and not a mock ──────────────────────────────────────
 *
 * Every other test in this repository can now only prove that this process
 * does NOT answer a verb. That is the correct claim for a client, and it is
 * also a claim that would keep passing if the wire calls this app makes were
 * wrong in every detail — wrong verb id, wrong parameter names, wrong shape
 * read back off the response. A mock gateway that answers whatever it is asked
 * proves the same nothing.
 *
 * So this suite boots the actual `goodvibes-daemon` binary, built from the
 * daemon repository, and drives the seams the split retargeted against it:
 * session registration, an approval raised and decided, a config write, a task
 * listing, and the honest refusal path when a verb is not available.
 *
 * ── Isolation, which is not optional ──────────────────────────────────────
 *
 * The daemon under test gets its own home directory, its own working
 * directory, and an ephemeral high port. It never touches `~/.goodvibes`, the
 * owner's live daemon, or port 3421. The token it mints lives in the throwaway
 * home and is read from there, which is also the loopback file-token bootstrap
 * this app uses in production — so the auth path is exercised rather than
 * bypassed.
 *
 * ── When it skips, and why that is honest ─────────────────────────────────
 *
 * The binary is built out of a sibling repository. When it is not present the
 * suite reports skipped with the path it looked for, rather than passing on a
 * daemon it never started. Set GOODVIBES_DAEMON_E2E_BINARY to point at one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/surface.ts';
import { createDaemonVerbCaller, type DaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';
import {
  createClientPhoneTool,
  createConversationRewindHost,
  createDaemonConfigClient,
  createDaemonCredentialsClient,
  createDevicesClient,
  createTasksClient,
} from '@pellux/goodvibes-sdk/platform/runtime/client';
import { createFleetUnionReadModel } from '../../runtime/client/fleet-union.ts';
import { buildFleetSnapshot, createStaticFleetReadModel } from '../../panels/fleet-read-model.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { createHostedSessionsClient, terminalHostedClientId } from '../../runtime/client/hosted-sessions.ts';
import { watchHostedSession } from '../../runtime/client/hosted-session-stream.ts';
import { createTerminalApprovalUpdateSubscriber } from '../../runtime/client/approval-updates.ts';
import { HostedSessionFeed } from '../../panels/hosted-session-feed.ts';

/** A port well clear of the daemon's default 3421 and of anything an install uses. */
const E2E_PORT = 39_471;
/** The stub model a hosted turn actually calls. Also clear of everything real. */
const STUB_MODEL_PORT = 39_472;
const STUB_PROVIDER_NAME = 'adopt-e2e-stub';
const STUB_MODEL_NAME = 'adopt-e2e-model';
const BOOT_TIMEOUT_MS = 45_000;
const BOOT_POLL_MS = 250;

/**
 * What the stub answers with next.
 *
 * A hosted turn is driven by whatever the model says, so the test decides that
 * per case: a plain sentence for the streaming check, a tool call for the case
 * that must make the run ASK for permission.
 */
let stubNextReply: { readonly content: string } | { readonly toolCall: { name: string; args: unknown } } =
  { content: 'a hosted answer' };
let stubCalls = 0;

/** Everything the daemon under test said, kept so a failure can quote it. */
const daemonLog: string[] = [];

/**
 * A minimal OpenAI-compatible server: the models listing plus one completion.
 *
 * It answers as a STREAM when asked to, which is not a nicety — a hosted turn
 * runs the ordinary orchestrator, which streams, and a provider that answers a
 * streaming request with a plain JSON body errors the turn and gets dropped from
 * the daemon's routable models. (Observed exactly that way while writing this:
 * a non-streaming stub made every later `sessions.hosted.create` refuse with
 * "not in this daemon's model registry".)
 */
function startStubModelServer(): { stop: () => void } {
  const chunk = (delta: unknown, finishReason: string | null): string => `data: ${JSON.stringify({
    id: `chatcmpl-${stubCalls}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: STUB_MODEL_NAME,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason ? { usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } } : {}),
  })}\n\n`;

  const server = Bun.serve({
    port: STUB_MODEL_PORT,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      if (new URL(request.url).pathname.endsWith('/models')) {
        return Response.json({ data: [{ id: STUB_MODEL_NAME }] });
      }
      stubCalls += 1;
      const body = await request.json().catch(() => ({})) as { stream?: boolean };
      const reply = stubNextReply;
      const isToolCall = 'toolCall' in reply;
      const finalDelta = isToolCall
        ? {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: `call-${stubCalls}`,
              type: 'function',
              function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) },
            }],
          }
        : { role: 'assistant', content: reply.content };

      if (body.stream) {
        return new Response(
          chunk(finalDelta, null) + chunk({}, isToolCall ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return Response.json({
        id: `chatcmpl-${stubCalls}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: STUB_MODEL_NAME,
        choices: [{
          index: 0,
          message: isToolCall ? { ...finalDelta, content: null } : finalDelta,
          finish_reason: isToolCall ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      });
    },
  });
  return { stop: () => server.stop(true) };
}

/** Poll a condition rather than sleeping a guessed interval. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(200);
  }
  return false;
}

function resolveDaemonBinary(): string | null {
  const configured = process.env['GOODVIBES_DAEMON_E2E_BINARY'];
  if (configured) return existsSync(configured) ? configured : null;
  // The daemon repository sits beside this one; its compiled binary is what the
  // installer places, so it is what this drives.
  // The release artifact carries the os-arch suffix `resolveArtifactNames`
  // produces, which is what a plain `bun run build` in the daemon repo leaves
  // in dist/ — looked for by that name too, so a developer who just built the
  // daemon does not also have to set an env var to run this suite.
  const platformSuffix: Record<string, string> = {
    'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64',
    'darwin-x64': 'macos-x64', 'darwin-arm64': 'macos-arm64',
  };
  const artifactName = `goodvibes-daemon-${platformSuffix[`${process.platform}-${process.arch}`] ?? 'linux-x64'}`;
  const candidates = [
    join(process.cwd(), '..', 'daemon-e2e', 'dist', 'goodvibes-daemon-e2e'),
    join(process.cwd(), '..', '..', 'goodvibes-daemon', 'dist', 'goodvibes-daemon'),
    join(process.cwd(), '..', '..', 'goodvibes-daemon', 'dist', artifactName),
    join(process.cwd(), '..', '..', '.gv-worktrees', 'daemon-e2e', 'dist', 'goodvibes-daemon-e2e'),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Find the conversation half of a rewind plan, wherever the plan nests it.
 *
 * Searched by SHAPE rather than by a fixed path: the assertion that matters is
 * "the numbers this surface answered with came back", and pinning the plan's
 * internal layout here would make this test fail for a reorganisation that
 * broke nothing. A record carrying both message counts is the conversation part.
 */
function findConversationPart(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if ('messagesToDrop' in record && 'messagesRemaining' in record) return record;
  for (const nested of Object.values(record)) {
    const found = findConversationPart(nested);
    if (found) return found;
  }
  return null;
}

/**
 * Read a list off a response that may be the array itself or a one-key wrapper.
 *
 * Both shapes are real in this contract — `sessions.list` answers bare, the
 * approval action verbs wrap — and a caller that assumes one gets an empty list
 * from the other with no error at all. Naming the key here means a shape change
 * shows up as a failing assertion rather than as silence.
 */
function readList<T>(payload: unknown, key: string): readonly T[] {
  if (Array.isArray(payload)) return payload as readonly T[];
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as readonly T[];
  }
  return [];
}

interface BootedDaemon {
  readonly child: ChildProcess;
  readonly home: string;
  readonly baseUrl: string;
  readonly token: string;
}

async function bootIsolatedDaemon(binary: string): Promise<BootedDaemon> {
  const home = makeProjectTempDir('gv-adopt-e2e');
  const workingDir = join(home, 'work');
  const daemonHome = join(home, '.goodvibes', 'daemon');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(daemonHome, { recursive: true });
  // A hosted turn calls a REAL model, so the daemon needs a routable provider
  // before it boots — this is the daemon repo's own proof-script vocabulary
  // (scripts/hosted-session-proof.ts): a discovered-provider record pointing at
  // a local OpenAI-compatible stub, read at boot and registered.
  const surfaceDir = join(home, '.goodvibes', GOODVIBES_TUI_SURFACE_ROOT);
  mkdirSync(surfaceDir, { recursive: true });
  writeFileSync(join(surfaceDir, 'discovered-providers.json'), JSON.stringify([{
    name: STUB_PROVIDER_NAME,
    host: '127.0.0.1',
    port: STUB_MODEL_PORT,
    baseURL: `http://127.0.0.1:${STUB_MODEL_PORT}/v1`,
    models: [STUB_MODEL_NAME],
    serverType: 'vllm',
    lastSeen: Date.now(),
  }], null, 2));
  writeFileSync(join(workingDir, 'note.txt'), 'the note a hosted session can read\n');
  const child = spawn(binary, ['--daemon-home', daemonHome, '--working-dir', workingDir, '--port', String(E2E_PORT)], {
    // A pristine environment: an ambient GOODVIBES_HOME in the developer's
    // shell would move the tree this daemon reads, which is the one thing this
    // suite must never let happen.
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, GOODVIBES_HOME: home },
    // Captured rather than discarded: when a hosted turn takes the daemon down
    // the reason is in here, and a suite that threw the daemon's own words away
    // can only report that something stopped answering.
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  child.stdout?.on('data', (chunk: Buffer) => { daemonLog.push(chunk.toString()); });
  child.stderr?.on('data', (chunk: Buffer) => { daemonLog.push(chunk.toString()); });
  child.on('exit', (code, signal) => { daemonLog.push(`\n[daemon exited code=${code} signal=${signal}]\n`); });

  const baseUrl = `http://127.0.0.1:${E2E_PORT}`;
  const tokenPath = join(daemonHome, 'operator-tokens.json');
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(BOOT_POLL_MS);
    if (!existsSync(tokenPath)) continue;
    let token: string;
    try {
      token = (JSON.parse(readFileSync(tokenPath, 'utf8')) as { token: string }).token;
    } catch {
      continue; // mid-write
    }
    try {
      const response = await fetch(`${baseUrl}/status`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) return { child, home, baseUrl, token };
    } catch {
      // not listening yet
    }
  }
  child.kill('SIGKILL');
  throw new Error(`the daemon did not answer on ${baseUrl} within ${BOOT_TIMEOUT_MS}ms`);
}

const binary = resolveDaemonBinary();

// A missing binary is reported, never silently passed over: a suite that
// vanishes is a suite nobody notices has stopped covering anything.
if (!binary) {
  describe('client seams against a real daemon', () => {
    test('SKIPPED — no goodvibes-daemon binary found; set GOODVIBES_DAEMON_E2E_BINARY', () => {
      expect(binary).toBeNull();
    });
  });
} else {
  describe('client seams against a real daemon', () => {
    let daemon: BootedDaemon;
    let verbs: DaemonVerbCaller;
    let stubModel: { stop: () => void } | null = null;

    beforeAll(async () => {
      // Up BEFORE the daemon: the discovered-provider record the boot writes is
      // read at startup and probed, so a stub that is not yet listening means a
      // provider the daemon never registers.
      stubModel = startStubModelServer();
      daemon = await bootIsolatedDaemon(binary);
      // THE PRODUCT'S OWN SEAM, not a hand-rolled client. `createDaemonVerbCaller`
      // is what every retargeted seam calls through, so what this suite exercises
      // is the base-URL derivation, the loopback token read, the operator client
      // construction and the ws-only fallback the product actually ships — not a
      // parallel implementation that could be right while the product is wrong.
      const configManager = new ConfigManager({
        surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
        configDir: join(daemon.home, 'client-config'),
        workingDir: join(daemon.home, 'work'),
        homeDir: daemon.home,
      });
      configManager.setDynamic('daemon.enabled' as never, true as never);
      configManager.setDynamic('controlPlane.host' as never, '127.0.0.1' as never);
      configManager.setDynamic('controlPlane.port' as never, E2E_PORT as never);
      verbs = createDaemonVerbCaller({ configManager, homeDirectory: daemon.home });
    }, BOOT_TIMEOUT_MS + 10_000);

    afterAll(() => {
      if (process.env['GOODVIBES_DAEMON_E2E_LOG']) {
        writeFileSync(process.env['GOODVIBES_DAEMON_E2E_LOG'], daemonLog.join(''));
      }
      daemon?.child.kill('SIGTERM');
      stubModel?.stop();
    });

    test('the daemon answers on its isolated port, and it is not the default one', () => {
      expect(daemon.baseUrl).toBe(`http://127.0.0.1:${E2E_PORT}`);
      expect(E2E_PORT).not.toBe(3421);
      expect(daemon.token.length).toBeGreaterThan(0);
      // The product's own resolution finds it: base URL derived from
      // controlPlane.host+port, token read from the daemon's state directory.
      expect(verbs.probe().available).toBe(true);
    });

    test('S2 sessions: a session registered here is listed back by the daemon', async () => {
      const sessionId = `e2e-session-${Date.now()}`;
      await verbs.invoke('sessions.register', {
        sessionId,
        project: join(daemon.home, 'work'),
        title: 'Adopt e2e session',
        participant: { surfaceKind: 'tui', surfaceId: 'surface:tui', displayName: 'Terminal UI' },
      });
      const rows = readList<{ id: string }>(await verbs.invoke('sessions.list', { limit: 50 }), 'sessions');
      expect(rows.some((row) => row.id === sessionId)).toBe(true);
    });

    test('S3 approvals: an ask raised over the wire comes back as a pending record and decides', async () => {
      const raised = await verbs.invoke<{ approval?: { id: string; status: string }; decided?: boolean }>('approvals.raise', {
        request: {
          callId: `e2e-${Date.now()}`,
          tool: 'bash',
          args: { command: 'ls -la' },
          category: 'execute',
          analysis: { riskLevel: 'low', reasons: ['end-to-end check'], classification: 'read', summary: 'list files' },
        },
      });

      expect(raised.approval?.id).toBeTruthy();
      // The verb does not park the request across a person's attention span —
      // it hands back the PENDING record and the decision arrives separately.
      expect(raised.decided).toBe(false);
      const approvalId = raised.approval?.id as string;

      // The action verbs answer with the RECORD wrapped, not bare: the daemon
      // is the authority on what it recorded, and the wrapper is what carries
      // the rest of that receipt.
      const decided = await verbs.invoke<{ approval?: { status?: string } } | null>('approvals.approve', {
        approvalId, actor: 'tui', actorSurface: 'tui',
      });
      expect(decided?.approval?.status).toBe('approved');

      // And the daemon's own list is what says so — the parity contract the
      // client raiser depends on when it reads a decision made elsewhere.
      const rows = readList<{ id: string; status: string }>(
        await verbs.invoke('approvals.list', { includeResolved: true }), 'approvals');
      expect(rows.find((row) => row.id === approvalId)?.status).toBe('approved');
    });

    test('S4 config: a daemon-owned key written over the wire reads back changed', async () => {
      // watchers.* is daemon-owned (the daemon runs the watcher framework), so
      // this is exactly the class of write that would have silently landed in
      // this surface's own settings file before the split.
      const config = createDaemonConfigClient(verbs);
      expect(config.ownsKey('watchers.enabled')).toBe(true);
      await config.set('watchers.enabled', false);
      expect(await config.get('watchers.enabled')).toBe(false);
    });

    test('S5 credentials: the daemon stores the value AND points the config key at it', async () => {
      // The verb takes the CONFIG key, not a store key, and does the whole
      // sequence: derive the store name, write, read back and compare, then
      // replace the config value with its reference. That ordering is why this
      // is one call rather than a config write plus a secret write from here —
      // the two halves must not be separable across a process boundary.
      const credentials = createDaemonCredentialsClient(verbs);
      const configKey = 'surfaces.telegram.botToken';
      const receipt = await credentials.set(configKey, 'e2e-not-a-real-token');
      expect(receipt).toBeTruthy();

      // The config key now holds a REFERENCE, and the reference is what the
      // daemon resolves. Never the value: nothing in the receipt or the config
      // repeats the credential.
      const stored = await createDaemonConfigClient(verbs).get(configKey);
      expect(String(stored)).toContain('goodvibes://secrets/');
      expect(String(stored)).not.toContain('e2e-not-a-real-token');
      expect(JSON.stringify(receipt)).not.toContain('e2e-not-a-real-token');

      await credentials.clear(configKey);
    });

    test('S11 tasks: the union reader reaches the daemon and keeps the local half separable', async () => {
      // Driven through the product's own union client, so what is exercised is
      // the verb id, the wrapper key the tasks array actually arrives under,
      // and the local-wins dedupe — not a hand-rolled fetch that could be right
      // while the product is wrong.
      const localOnly = { id: 'local-only', kind: 'agent', title: 'this terminal', status: 'running',
        owner: 'tui', cancellable: true, childTaskIds: [], queuedAt: Date.now() } as never;
      const client = createTasksClient({
        local: { list: () => [localOnly], get: (id: string) => (id === 'local-only' ? localOnly : null) },
        verbs,
      });
      const result = await client.list();
      // The daemon answered, so the union is complete rather than degraded.
      expect(result.daemonUnavailable).toBeNull();
      const local = result.tasks.filter((entry) => entry.origin === 'local');
      expect(local.map((entry) => entry.task.id)).toEqual(['local-only']);
      // Every row the daemon contributed is labelled as the daemon's, which is
      // what decides whether a lifecycle act may be applied locally.
      for (const entry of result.tasks.filter((e) => e.origin === 'daemon')) {
        expect(typeof entry.task.id).toBe('string');
      }
    });

    test('S10 fleet: the union read model folds the daemon\'s rows in over the wire', async () => {
      const localNode = { id: 'local-agent', kind: 'agent', label: 'this terminal', state: 'thinking',
        elapsedMs: 0, costState: 'unpriced',
        capabilities: { interruptible: false, resumable: false, killable: false, steerable: false } } as never;
      const union = createFleetUnionReadModel({
        local: createStaticFleetReadModel(buildFleetSnapshot([localNode], Date.now())),
        verbs,
      });
      // A real fleet.snapshot round trip: this is a ws-declared verb, so it also
      // proves the generic-gateway fallback carries the fleet reads.
      await union.refresh();
      const ids = union.getSnapshot().rows.map((row) => row.node.id);
      // The local row survives the merge whatever the daemon returned; a fresh
      // daemon contributes none, and that is an honest empty rather than a
      // failure.
      expect(ids).toContain('local-agent');
      // Steering a row this terminal does not own refuses with a reason.
      const refusal = union.steer('not-a-local-row', 'stop');
      expect(refusal.queued).toBe(false);
      if (refusal.queued === false) expect(refusal.reason).toContain('daemon');
      union.stop();
    });

    test('S12 devices: the device verbs answer, with no paired phone on a fresh home', async () => {
      const rows = await createDevicesClient(verbs).listNodes();
      expect(rows).toEqual([]);
    });

    test('S12 devices: a capability request reaches the runtime and its refusal is an ANSWER', async () => {
      // A fresh home has no paired phone, so the runtime refuses. That refusal
      // is the point: it proves the request reached the real capability service
      // (wrong verb id or wrong argument names would have thrown instead), and
      // it proves the shape a decline comes back in.
      const outcome = await createDevicesClient(verbs).requestCapability({
        nodeId: 'phone-that-is-not-paired',
        capabilityId: 'device.clipboard.read',
        reason: 'end-to-end check',
      });
      expect(outcome.ok).toBe(false);
      // The runtime's own code and words, not a transport error dressed up.
      expect(String(outcome.refusal ?? '')).not.toBe('');
      expect(String(outcome.detail ?? '')).not.toBe('');

      // And through the TOOL, which is what the model sees: a refusal is a
      // SUCCESSFUL tool result saying it was refused, never a failed call the
      // model would retry by prompting the person again.
      const tool = createClientPhoneTool(createDevicesClient(verbs));
      const result = await tool.execute({
        action: 'run',
        capabilityId: 'device.clipboard.read',
        nodeId: 'phone-that-is-not-paired',
        reason: 'end-to-end check',
      });
      const payload = JSON.parse(String(result.output ?? '{}')) as Record<string, unknown>;
      // With nothing paired the tool refuses before the round trip, naming the
      // absent phone — which is the honest answer and not an invented refusal.
      expect(String(payload['error'] ?? payload['detail'] ?? '')).not.toBe('');
    });

    test('S12 devices: retained captures list over the wire on a fresh home', async () => {
      const listed = await createDevicesClient(verbs).listArtifacts({ limit: 5 });
      expect(listed.artifacts).toEqual([]);
      // The retention window is the daemon's policy, reported rather than
      // guessed — a zero here would mean the verb did not answer at all.
      expect(listed.retentionHours).toBeGreaterThan(0);
    });

    test('S15 rewind: a conversation-scope rewind driven daemon-side is answered by THIS surface', async () => {
      const hostedSession = `e2e-rewind-${Date.now()}`;
      const host = createConversationRewindHost({
        verbs,
        // Stands in for this process's conversation with a known message count,
        // which is what makes the daemon's answer checkable.
        // Only preview/rewind are RewindConversationPort's members — the host
        // never calls restoreBefore/restoreAfter (the TUI's own /undo-/redo
        // accessors), so this stand-in stub carries only what it is asked for.
        port: {
          preview: async () => ({ messagesToDrop: 3, messagesRemaining: 9 }),
          rewind: async () => ({ droppedMessages: 3, undoSnapshotId: 'rwc_e2e' }),
        },
        hosts: (sessionId) => sessionId === hostedSession,
        label: 'the terminal app (e2e)',
        waitMs: 0,
      });

      // Before the offer: the daemon holds no conversation for this session and
      // must say so rather than answering zero. This is the exact regression the
      // surface-hosted contract exists to close — the old behaviour returned a
      // confident 0 here, indistinguishable from a real one.
      const beforeOffer = await verbs.invoke<Record<string, unknown>>('rewind.plan', {
        sessionId: hostedSession, scope: 'conversation',
      });
      const beforeConversation = findConversationPart(beforeOffer);
      expect(beforeConversation?.['available']).toBe(false);
      // Not merely a false flag: the plan carries a warning saying WHY, so the
      // zeroes beside it cannot be read as a real count by anything downstream.
      expect(JSON.stringify(beforeOffer['warnings'] ?? [])).toContain('conversation rewind unavailable');

      host.offer(hostedSession);
      await host.pump();
      expect(host.hostId()).toBeTruthy();

      // Now drive the rewind from the DAEMON side, exactly as another surface
      // would, and answer it from here while the call is in flight.
      const planned = verbs.invoke<Record<string, unknown>>('rewind.plan', {
        sessionId: hostedSession, scope: 'conversation',
      });
      // The question is raised by the call above; one pump takes and answers it.
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      await host.pump();
      const plan = await planned;

      // The counts came from THIS process's port and nothing else could have
      // produced them: the daemon has no conversation for this session, and
      // 3-of-12 is a shape it could not have guessed. Read out of the plan's
      // conversation part by name rather than by string search, so a plan that
      // merely happened to contain a 3 somewhere cannot pass this.
      const conversation = findConversationPart(plan);
      expect(conversation).toBeTruthy();
      expect(conversation?.['messagesToDrop']).toBe(3);
      expect(conversation?.['messagesRemaining']).toBe(9);
      expect(conversation?.['available']).not.toBe(false);

      await host.stop();
    });

    test('S15 checkpoints: the checkpoint list is answered by the daemon', async () => {
      const rows = readList<unknown>(await verbs.invoke('checkpoints.list', {}), 'checkpoints');
      expect(Array.isArray(rows)).toBe(true);
    });

    // ── Phase B: sessions the daemon HOSTS ────────────────────────────────
    //
    // Everything below drives the real binary through the whole hosted story:
    // create, one turn that calls a real (stubbed) model, the stream this
    // terminal renders from, detach under BOTH policies, reattach with history
    // and a resumed stream, and an approval the hosted run itself raised
    // arriving on the push channel the raiser now subscribes to.
    describe('hosted sessions', () => {
      let killPolicySessionId = '';
      let survivorSessionId = '';

      test('create composes a session in the named workspace, under the shipped kill default', async () => {
        const config = createDaemonConfigClient(verbs);
        await config.set('hostedSessions.detachPolicy', 'kill');
        const client = createHostedSessionsClient(verbs);

        const record = await client.create({
          workspaceRoot: join(daemon.home, 'work'),
          title: 'the adopt e2e hosted session',
          modelId: `${STUB_PROVIDER_NAME}:${STUB_MODEL_NAME}`,
        });
        killPolicySessionId = record.id;

        expect(record.status).toBe('idle');
        // The DAEMON's answer about what leaving would do — not this client's
        // memory of a setting it wrote a moment ago.
        expect(record.effectiveDetachPolicy).toBe('kill');
        expect(record.detachPolicy).toBeNull();
        expect(record.workspaceRoot).toBe(join(daemon.home, 'work'));
        expect(record.attachedClients).toContain(terminalHostedClientId());

        const listed = await client.list();
        expect(listed.map((entry) => entry.id)).toContain(record.id);
      });

      test('a relative workspace root is refused rather than resolved against the daemon\'s own directory', async () => {
        let refusal: unknown = null;
        try {
          await createHostedSessionsClient(verbs).create({ workspaceRoot: 'relative/path' });
        } catch (error) {
          refusal = error;
        }
        expect(String((refusal as Error | null)?.message ?? '')).toContain('absolute');
      });

      test('a turn driven by sessions.steer calls a real model, and its output arrives on the stream this panel renders from', async () => {
        stubNextReply = { content: 'the hosted session answered over the wire' };
        const callsBefore = stubCalls;
        const client = createHostedSessionsClient(verbs);
        const feed = new HostedSessionFeed();

        // The product's own subscription — the same one `/hosted attach` opens,
        // narrowed to turn/tools/session and filtered on this session id.
        const subscription = await watchHostedSession({
          baseUrl: daemon.baseUrl,
          sessionId: killPolicySessionId,
          getAuthToken: () => daemon.token,
          onEvent: (event) => feed.apply(event),
          onLifecycle: (update) => feed.applyLifecycle(update),
        });
        expect(subscription).not.toBeNull();
        feed.attach((await client.attach(killPolicySessionId)).session, []);

        // `sessions.steer` — the ORDINARY verb, resolving a hosted id.
        await client.steer(killPolicySessionId, 'say something for the record');

        expect(await waitFor(() => stubCalls > callsBefore), daemonLog.join('').slice(-2000)).toBe(true);
        // The turn's text reached this process over SSE, folded into the rows
        // the Hosted Session panel draws.
        expect(await waitFor(() => feed.getState().rows.some(
          (row) => row.kind === 'assistant' && row.text.includes('answered over the wire'),
        )), daemonLog.join('').slice(-2000)).toBe(true);

        subscription?.close();
      }, 60_000);

      test('detach under the kill default ends the session, and the record says why', async () => {
        const record = await createHostedSessionsClient(verbs).detach(killPolicySessionId);
        expect(record.status).toBe('terminated');
        // A hosted session never simply disappears: the reason is on the record.
        expect(record.terminatedReason).toBe('detached');

        // And it is gone from the live list while still answerable with --all.
        const client = createHostedSessionsClient(verbs);
        expect((await client.list()).map((entry) => entry.id)).not.toContain(killPolicySessionId);
        expect((await client.list({ includeTerminated: true })).map((entry) => entry.id))
          .toContain(killPolicySessionId);
      });

      test('detach under survive leaves it idle, and reattaching backfills the history and resumes the stream', async () => {
        await createDaemonConfigClient(verbs).set('hostedSessions.detachPolicy', 'survive');
        const client = createHostedSessionsClient(verbs);
        const survivor = await client.create({
          workspaceRoot: join(daemon.home, 'work'),
          title: 'the survivor',
          modelId: `${STUB_PROVIDER_NAME}:${STUB_MODEL_NAME}`,
        });
        survivorSessionId = survivor.id;
        expect(survivor.effectiveDetachPolicy).toBe('survive');

        stubNextReply = { content: 'said before the terminal walked away' };
        const callsBefore = stubCalls;
        await client.steer(survivorSessionId, 'say something before I go');
        expect(await waitFor(() => stubCalls > callsBefore)).toBe(true);

        const detached = await client.detach(survivorSessionId);
        expect(detached.status).not.toBe('terminated');
        expect(detached.attachedClients).not.toContain(terminalHostedClientId());

        // Reattach: the transcript comes back, which is the whole point of a
        // session outliving the window that started it.
        const reattached = await client.attach(survivorSessionId);
        expect(reattached.session.id).toBe(survivorSessionId);
        expect(reattached.session.status).not.toBe('terminated');
        expect(reattached.history.length).toBeGreaterThan(0);
        expect(JSON.stringify(reattached.history)).toContain('before the terminal walked away');

        // And the live stream resumes: a turn steered AFTER the reattach lands
        // on the newly opened subscription, not only in the backfill.
        const feed = new HostedSessionFeed();
        feed.attach(reattached.session, reattached.history);
        const subscription = await watchHostedSession({
          baseUrl: daemon.baseUrl,
          sessionId: survivorSessionId,
          getAuthToken: () => daemon.token,
          onEvent: (event) => feed.apply(event),
        });
        expect(subscription).not.toBeNull();

        stubNextReply = { content: 'and this is after the reattach' };
        await client.steer(survivorSessionId, 'say something now that I am back');
        expect(await waitFor(() => feed.getState().rows.some(
          (row) => row.text.includes('after the reattach'),
        ))).toBe(true);
        subscription?.close();
      }, 90_000);

      test('a per-session kill override beats a survive setting', async () => {
        const client = createHostedSessionsClient(verbs);
        const overridden = await client.create({
          workspaceRoot: join(daemon.home, 'work'),
          detachPolicy: 'kill',
        });
        expect(overridden.detachPolicy).toBe('kill');
        expect(overridden.effectiveDetachPolicy).toBe('kill');
        const after = await client.detach(overridden.id);
        expect(after.status).toBe('terminated');
        expect(after.terminatedReason).toBe('detached');
      });

      test('an approval raised BY the hosted run arrives on the SSE channel the raiser now subscribes to', async () => {
        // The subscriber is the product's own seam — the one wired into
        // createClientApprovalRaiser in runtime/services.ts — so what this
        // exercises is the base-URL derivation, the token read and the
        // permissions-domain narrowing that ship, not a hand-rolled stream.
        const configManager = new ConfigManager({
          surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
          configDir: join(daemon.home, 'client-config'),
          workingDir: join(daemon.home, 'work'),
          homeDir: daemon.home,
        });
        configManager.setDynamic('daemon.enabled' as never, true as never);
        configManager.setDynamic('controlPlane.host' as never, '127.0.0.1' as never);
        configManager.setDynamic('controlPlane.port' as never, E2E_PORT as never);
        const seen: string[] = [];
        const subscription = await createTerminalApprovalUpdateSubscriber({
          configManager, homeDirectory: daemon.home,
        })((notice) => { seen.push(String(notice.approval['status'] ?? '')); });
        expect(subscription).not.toBeNull();

        // Now make the hosted run ASK. A tool call in a workspace whose trust is
        // still undecided raises the trust question as an ordinary approval
        // record — the daemon has no screen, so asking IS publishing on this
        // channel. Nothing else in this suite has decided this workspace.
        stubNextReply = { toolCall: { name: 'exec', args: { commands: ['echo hosted'] } } };
        await createHostedSessionsClient(verbs).steer(survivorSessionId, 'run a command for me');

        expect(await waitFor(() => seen.length > 0, 45_000)).toBe(true);
        // Pending is what a raise publishes; a decision would publish again.
        expect(seen[0]).toBe('pending');

        // The daemon's own list agrees — the record is real, not a frame this
        // process invented.
        const rows = readList<{ status: string }>(
          await verbs.invoke('approvals.list', { includeResolved: true }), 'approvals');
        expect(rows.some((row) => row.status === 'pending')).toBe(true);

        subscription?.close();
        stubNextReply = { content: 'back to plain answers' };
      }, 90_000);

      test('kill ends a session regardless of policy, and the record keeps its reason', async () => {
        const record = await createHostedSessionsClient(verbs).kill(survivorSessionId);
        expect(record.status).toBe('terminated');
        expect(record.terminatedReason).toBe('killed');
      });
    });

    test('S6 voice: speech-to-text refuses honestly when no local provider is provisioned', async () => {
      // The refusal path matters more than the happy path here: a fresh home
      // has no whisper model, and what the surface must get back is a stated
      // reason rather than an empty transcript it would paste into the
      // composer as if the user had said nothing.
      let refusal: unknown = null;
      try {
        await verbs.invoke('voice.stt', { audio: { data: '', mimeType: 'audio/wav' } });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).not.toBeNull();
      expect(String((refusal as Error).message).length).toBeGreaterThan(0);
    });
  });
}
