/**
 * Gate: the fleet "needs-input" push fan-out — a fleet node blocked on the
 * operator pushes an "Input needed" notification carrying the session/node
 * deep link to every registered device, suppressed while an operator surface
 * is already attached to that node's session (see the SDK's
 * push/service.ts's attachFleetNeedsInputSource).
 *
 * Fork-drift context: commit 0d327ef4 threaded channelDeliveryRouter /
 * providerRegistry / automationManager / sessionLister into the TUI's
 * attachWsOnlyGatewayVerbHandlers call site (services.ts) so the check-in
 * verb family would register live, but deliberately left `runtimeBus` and
 * `sessionPresence` unthreaded — the two deps registerGatewayVerbGroups gates
 * the needs-input push source on (see the SDK's
 * routes/register-gateway-verb-groups.js: "Second event source... Only when
 * the runtime bus is wired."). Absent those two deps, the source is simply
 * never constructed — a silent graceful-degrade, not a 501, so nothing short
 * of an end-to-end push test catches it.
 *
 * A second, independent gap sits upstream of that: fleet lifecycle deltas
 * (FLEET_NODE_BLOCKED_ON_USER etc.) only reach the runtime bus's 'fleet'
 * domain via attachFleetEmitBridge, diffing the process registry's own
 * snapshot tick. createArchivableFleetRegistry (terminal-shell) builds the
 * registry but never attaches that bridge — the composition root owns that.
 * Both gaps are closed together in src/runtime/fleet-needs-input-push.ts's
 * wireFleetNeedsInputPush, threaded into the same attachWsOnlyGatewayVerbHandlers
 * call site services.ts already had.
 *
 * These tests prove the fan-out is REAL, not just descriptor-present:
 *  - a synthetic FLEET_NODE_BLOCKED_ON_USER envelope on the runtime bus's
 *    'fleet' domain (the exact wire shape attachFleetEmitBridge produces)
 *    results in a genuinely encrypted web-push POST landing at a local sink;
 *  - presence suppression is honored end to end: no push while an operator
 *    surface is attached to the session, a real push when none is;
 *  - wireFleetNeedsInputPush itself really calls attachFleetEmitBridge with
 *    the given registry/bus pair (unit-level, deterministic — no real fleet
 *    activity needed to prove the bridge attaches).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { createEventEnvelope } from '@pellux/goodvibes-transport-core';
import { getTestRuntimeServices } from '../helpers/runtime-services.ts';
import { wireFleetNeedsInputPush } from '../../runtime/fleet-needs-input-push.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';

// ---------------------------------------------------------------------------
// A local fake push sink standing in for a browser vendor's push service —
// never the real network. Mirrors the SDK's own web-push-daemon-wire.test.ts.
// ---------------------------------------------------------------------------
interface CapturedPush {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}
const captured: CapturedPush[] = [];
const sink = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = Buffer.from(await req.arrayBuffer());
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => { headers[key] = value; });
    captured.push({ path: url.pathname, headers, body });
    return new Response(null, { status: 201 });
  },
});
const sinkOrigin = `http://127.0.0.1:${sink.port}`;

afterAll(() => {
  sink.stop(true);
});

// A stable client (receiver) keypair so the test can decrypt what the daemon sends.
const client = createECDH('prime256v1');
client.generateKeys();
const clientPublic = client.getPublicKey();
const authSecret = randomBytes(16);
const p256dh = clientPublic.toString('base64url');
const auth = authSecret.toString('base64url');

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const okm = createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest();
  return okm.subarray(0, length);
}

/** Decrypt an aes128gcm web-push body back to its JSON payload (RFC 8291 receiver side). */
function decryptPush(body: Buffer): { title: string; body: string; data?: Record<string, unknown> } {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const sharedSecret = client.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), clientPublic, senderPublic]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const payload = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
  const json = plaintext.subarray(0, plaintext.length - 1).toString('utf8'); // strip trailing 0x02 record delimiter
  return JSON.parse(json) as { title: string; body: string; data?: Record<string, unknown> };
}

async function waitForPush(predicate: (p: CapturedPush) => boolean, timeoutMs = 3000): Promise<CapturedPush | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = captured.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

/** Emit the exact wire shape attachFleetEmitBridge produces for a blocked node. */
function emitBlockedOnUser(bus: RuntimeEventBus, nodeId: string, sessionId: string): void {
  const envelope = createEventEnvelope(
    'FLEET_NODE_BLOCKED_ON_USER',
    { type: 'FLEET_NODE_BLOCKED_ON_USER', nodeId, kind: 'agent', reason: 'input', label: `task-${nodeId}`, sessionId },
    { sessionId, source: 'fleet-registry' },
  );
  bus.emit('fleet', envelope as never);
}

describe('fleet needs-input push fan-out (composed daemon)', () => {
  test('a fleet node blocked on the operator delivers a real encrypted needs-input push when no surface is attached', async () => {
    const services = getTestRuntimeServices();
    const devicePath = '/push/needs-input-no-presence';
    await services.gatewayMethods.invoke('push.subscriptions.create', {
      methodId: 'push.subscriptions.create',
      body: { endpoint: `${sinkOrigin}${devicePath}`, keys: { p256dh, auth } },
      context: { principalId: 'test-operator' },
    } as never);

    emitBlockedOnUser(services.runtimeBus, 'node-no-presence', 'session-no-presence');

    const push = await waitForPush((p) => p.path === devicePath);
    expect(push).not.toBeNull();
    expect(push!.headers['content-encoding']).toBe('aes128gcm');
    const decrypted = decryptPush(push!.body);
    expect(decrypted.title).toBe('Input needed');
    expect(decrypted.data?.kind).toBe('needs-input');
    expect(decrypted.data?.sessionId).toBe('session-no-presence');
    expect(decrypted.data?.nodeId).toBe('node-no-presence');
  });

  test('presence suppression: no push when an operator surface is attached to the session, and a sibling block without presence still pushes', async () => {
    const services = getTestRuntimeServices();
    const devicePath = '/push/needs-input-presence';
    await services.gatewayMethods.invoke('push.subscriptions.create', {
      methodId: 'push.subscriptions.create',
      body: { endpoint: `${sinkOrigin}${devicePath}`, keys: { p256dh, auth } },
      context: { principalId: 'test-operator' },
    } as never);

    // An operator surface heartbeats onto this session — sessionPresence.isAttached
    // must read this back true (see fleet-needs-input-push.ts's freshness window).
    await services.sessionBroker.register({
      sessionId: 'session-with-presence',
      participant: { surfaceKind: 'tui', surfaceId: 'test-surface', lastSeenAt: Date.now() },
    });

    const before = captured.filter((p) => p.path === devicePath).length;
    emitBlockedOnUser(services.runtimeBus, 'node-with-presence', 'session-with-presence');
    // Grace period: no positive event to await, so poll a short fixed window —
    // the sibling assertion below proves the pipeline is alive, ruling out a
    // false pass from a dead pipe rather than genuine suppression.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterSuppressed = captured.filter((p) => p.path === devicePath).length;
    expect(afterSuppressed).toBe(before);

    emitBlockedOnUser(services.runtimeBus, 'node-without-presence', 'session-without-presence-sibling');
    const push = await waitForPush((p) => p.path === devicePath);
    expect(push).not.toBeNull();
    const decrypted = decryptPush(push!.body);
    expect(decrypted.data?.nodeId).toBe('node-without-presence');
  });
});

describe('wireFleetNeedsInputPush', () => {
  test('attaches the fleet emit-bridge to the given registry/bus: a blocked-node snapshot transition reaches the bus fleet domain', async () => {
    const bus = new RuntimeEventBus();
    let snapshotListener: ((snapshot: { capturedAt: number; nodes: unknown[] }) => void) | null = null;
    const fakeRegistry = {
      subscribe: (listener: (snapshot: { capturedAt: number; nodes: unknown[] }) => void) => {
        snapshotListener = listener;
        return () => { snapshotListener = null; };
      },
    };
    const fakeSessionBroker = { getSession: () => null };

    wireFleetNeedsInputPush({
      registry: fakeRegistry as never,
      runtimeBus: bus,
      sessionBroker: fakeSessionBroker as never,
    });
    expect(snapshotListener).not.toBeNull();

    const received: unknown[] = [];
    bus.onDomain('fleet', (envelope) => received.push(envelope.payload));

    const node = { id: 'n1', kind: 'agent', label: 'task', state: 'idle' };
    // First snapshot only seeds the prior-state table (no fleet activity yet).
    snapshotListener!({ capturedAt: Date.now(), nodes: [node] });
    // Second snapshot: the node picks up attention -> FLEET_NODE_BLOCKED_ON_USER.
    snapshotListener!({
      capturedAt: Date.now(),
      nodes: [{ ...node, state: 'awaiting-approval', needsAttention: { reason: 'input' }, sessionRef: { sessionId: 's1' } }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'FLEET_NODE_BLOCKED_ON_USER', nodeId: 'n1', sessionId: 's1' });
  });

  test('sessionPresence.isAttached mirrors the SDK daemon composition: true for a freshly-seen participant, false otherwise', () => {
    const now = Date.now();
    const attachedSession = { participants: [{ surfaceKind: 'tui', surfaceId: 's', lastSeenAt: now }] };
    const staleSession = { participants: [{ surfaceKind: 'tui', surfaceId: 's', lastSeenAt: now - 10 * 60 * 1000 }] };
    const fakeSessionBroker = {
      getSession: (id: string) => (id === 'attached' ? attachedSession : id === 'stale' ? staleSession : null),
    };
    const deps = wireFleetNeedsInputPush({
      registry: { subscribe: () => () => {} } as never,
      runtimeBus: new RuntimeEventBus(),
      sessionBroker: fakeSessionBroker as never,
    });

    expect(deps.sessionPresence.isAttached('attached')).toBe(true);
    expect(deps.sessionPresence.isAttached('stale')).toBe(false);
    expect(deps.sessionPresence.isAttached('unknown-session')).toBe(false);
  });
});
