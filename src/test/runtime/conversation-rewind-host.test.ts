/**
 * conversation-rewind-host.test.ts — this surface answering the daemon's
 * questions about a conversation only it is holding.
 *
 * ── The failure being closed ──────────────────────────────────────────────
 *
 * Files rewind works from anywhere; the messages do not. Once the surfaces
 * became pure clients, a rewind driven from the web app asked the daemon, the
 * daemon looked in a conversation registry nothing outside it could populate,
 * and answered "0 messages to drop". Not an error — a confident number, and
 * indistinguishable from a real zero.
 *
 * So the assertions that matter are about which answer comes back for which
 * situation: a real count when this surface IS holding the conversation, and
 * `unavailable` with a reason when it is not. Never a zero standing in for
 * "I could not reach it".
 *
 * ── Driven against the real broker ────────────────────────────────────────
 *
 * The daemon side here is the SDK's own `ConversationRewindHostBroker` behind
 * its own route handlers, so the lease, the take/answer pairing and the
 * refusals are the real ones. Only the transport is local.
 */
import { describe, expect, test } from 'bun:test';
import {
  GatewayMethodCatalog,
  createConversationRewindHostBroker,
  registerRewindConversationHostGatewayMethods,
} from '@pellux/goodvibes-sdk/platform/control-plane';
import { createConversationRewindHost } from '../../runtime/client/conversation-rewind-host.ts';
import type { ConversationRewindPort } from '../../runtime/conversation-rewind-port.ts';
import type { DaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';

const SESSION = 'session-under-test';

/** A port standing in for this process's conversation, with a known message count. */
function port(counts: { toDrop: number; remaining: number }, options: { throws?: boolean } = {}): ConversationRewindPort {
  return {
    preview: async () => {
      if (options.throws) throw new Error('the conversation is mid-compaction');
      return { messagesToDrop: counts.toDrop, messagesRemaining: counts.remaining };
    },
    rewind: async () => ({ droppedMessages: counts.toDrop, undoSnapshotId: 'rwc_test_snapshot' }),
    restoreBefore: () => true,
    restoreAfter: () => true,
  };
}

function harness(options: { hosts?: boolean; port?: ConversationRewindPort } = {}) {
  const broker = createConversationRewindHostBroker();
  const catalog = new GatewayMethodCatalog();
  registerRewindConversationHostGatewayMethods(catalog, broker);
  const verbs: DaemonVerbCaller = {
    probe: () => ({ available: true, sdk: {} as never }),
    invoke: async <T,>(methodId: string, input?: unknown): Promise<T> =>
      await catalog.invoke(methodId as never, { context: { admin: true }, body: input ?? {} } as never) as T,
  };
  const host = createConversationRewindHost({
    verbs,
    port: options.port ?? port({ toDrop: 4, remaining: 11 }),
    hosts: () => options.hosts ?? true,
    label: 'the terminal app',
    // Driven by pump() rather than the loop, so nothing here waits on a clock.
    waitMs: 0,
  });
  return { broker, host };
}

describe('the surface holding a conversation is the one that answers for it', () => {
  test('a preview the daemon raises is answered with this surface\'s real counts', async () => {
    const { broker, host } = harness();
    // `offer` + `pump` rather than `start`: the cycles are driven by hand here,
    // so nothing races the background loop's own take on the same host id.
    host.offer(SESSION);
    await host.pump();
    expect(host.hostId()).toBeTruthy();

    // The daemon side: a rewind.plan reaching the port the broker implements.
    const preview = broker.preview({ sessionId: SESSION, turnId: 'turn-7' } as never);
    await host.pump();
    const answered = await preview;
    expect(answered).toMatchObject({ messagesToDrop: 4, messagesRemaining: 11 });
    await host.stop();
  });

  test('a rewind is answered with the drop count and an undo id', async () => {
    const { broker, host } = harness();
    host.offer(SESSION);
    await host.pump();
    const applied = broker.rewind({ sessionId: SESSION, turnId: 'turn-7' } as never);
    await host.pump();
    expect(await applied).toMatchObject({ droppedMessages: 4, undoSnapshotId: 'rwc_test_snapshot' });
    await host.stop();
  });

  test('a session this surface is NOT holding is unavailable, never zero', async () => {
    // The registration is live but the conversation has gone (a session swap, a
    // close). A zero here would be a lie a caller cannot detect.
    const { broker, host } = harness({ hosts: false });
    host.offer(SESSION);
    await host.pump();
    const preview = broker.preview({ sessionId: SESSION } as never);
    await host.pump();
    const answered = await preview as unknown as Record<string, unknown>;
    expect(answered['available']).toBe(false);
    expect(String(answered['unavailableReason'])).toContain('no longer holding');
    await host.stop();
  });

  test('a port that throws is reported as unavailable rather than left to time out', async () => {
    const { broker, host } = harness({ port: port({ toDrop: 0, remaining: 0 }, { throws: true }) });
    host.offer(SESSION);
    await host.pump();
    const preview = broker.preview({ sessionId: SESSION } as never);
    await host.pump();
    const answered = await preview as unknown as Record<string, unknown>;
    // A rewind.plan is waiting on this; a reason reaches the person faster and
    // more usefully than a stall does.
    expect(answered['available']).toBe(false);
    expect(String(answered['unavailableReason'])).toContain('mid-compaction');
    await host.stop();
  });

  test('a session nobody registered is unavailable with its own reason', async () => {
    const { broker } = harness();
    const answered = await broker.preview({ sessionId: 'nobody-hosts-this' } as never) as unknown as Record<string, unknown>;
    expect(answered['available']).toBe(false);
    expect(String(answered['unavailableReason']).length).toBeGreaterThan(0);
  });

  test('releasing withdraws the offer, so later questions are unavailable', async () => {
    const { broker, host } = harness();
    host.offer(SESSION);
    await host.pump();
    await host.stop();
    expect(host.hostId()).toBeNull();
    const answered = await broker.preview({ sessionId: SESSION } as never) as unknown as Record<string, unknown>;
    expect(answered['available']).toBe(false);
  });

  test('polling is what renews the lease — a live host stays registered across cycles', async () => {
    const { broker, host } = harness();
    host.offer(SESSION);
    await host.pump();
    const registered = host.hostId();
    await host.pump();
    await host.pump();
    // Same registration, not a re-claim: a surface that is polling is a surface
    // that is alive, so there is no separate keepalive to fall out of step.
    expect(host.hostId()).toBe(registered);
    expect(broker.listHosts().map((entry) => entry.hostId)).toEqual([registered!]);
    await host.stop();
  });
});
