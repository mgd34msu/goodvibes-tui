/**
 * session-inbound-inputs.test.ts
 *
 * D3 unit coverage for the TUI's INBOUND steer poller (SessionInboundInputPoller):
 * it collects QUEUED steer/follow-up inputs for ITS session, injects each via the
 * onSteer callback, acks delivery on the wire, and is per-session isolated. Uses a
 * stub inbound client (no daemon) — the real-daemon end-to-end proof lives in
 * session-inbound-steer-daemon-integration.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import {
  SessionInboundInputPoller,
  narrateInboundSteer,
  type InboundSteer,
  type SpineInboundInputsClient,
} from '../../runtime/session-inbound-inputs.ts';

const SILENT = { debug: () => {}, info: () => {} };

interface StubInput {
  id: string;
  sessionId: string;
  intent: 'steer' | 'follow-up' | 'submit';
  state: 'queued' | 'delivered' | 'completed';
  body: string;
  createdAt: number;
  surfaceKind?: string;
  surfaceId?: string;
  displayName?: string;
}

function makeStub(inputsBySession: Record<string, StubInput[]>): {
  client: SpineInboundInputsClient;
  delivered: Array<{ sessionId: string; inputId: string; consumed: boolean | undefined }>;
  listCalls: Array<{ sessionId: string; since: number | undefined; state: string | undefined }>;
} {
  const delivered: Array<{ sessionId: string; inputId: string; consumed: boolean | undefined }> = [];
  const listCalls: Array<{ sessionId: string; since: number | undefined; state: string | undefined }> = [];
  const client: SpineInboundInputsClient = {
    listInputs: async (sessionId, options) => {
      listCalls.push({ sessionId, since: options.since, state: options.state });
      const all = inputsBySession[sessionId] ?? [];
      const filtered = all.filter((i) => {
        if (options.state !== undefined && i.state !== options.state) return false;
        if (options.since !== undefined && i.createdAt <= options.since) return false;
        return true;
      });
      return { inputs: filtered as unknown as Awaited<ReturnType<SpineInboundInputsClient['listInputs']>>['inputs'] };
    },
    deliverInput: async (sessionId, inputId, options) => {
      delivered.push({ sessionId, inputId, consumed: options?.consumed });
      // Reflect the state transition so a subsequent poll does not re-pick it.
      const bucket = inputsBySession[sessionId] ?? [];
      const entry = bucket.find((i) => i.id === inputId);
      if (entry && entry.state === 'queued') entry.state = 'delivered';
      return {};
    },
  };
  return { client, delivered, listCalls };
}

describe('SessionInboundInputPoller — collect, inject, ack', () => {
  test('a queued webui steer is injected and acked queued->delivered', async () => {
    const { client, delivered } = makeStub({
      's1': [{ id: 'in-1', sessionId: 's1', intent: 'steer', state: 'queued', body: 'resize the panel', createdAt: 100, surfaceKind: 'webui', surfaceId: 'surface:webui', displayName: 'Alice' }],
    });
    const received: InboundSteer[] = [];
    const poller = new SessionInboundInputPoller({
      sessionId: () => 's1',
      onSteer: (s) => received.push(s),
      log: SILENT,
    });
    poller.activate(client);

    const count = await poller.pollOnce();

    expect(count).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]!.body).toBe('resize the panel');
    expect(received[0]!.surfaceKind).toBe('webui');
    expect(delivered).toEqual([{ sessionId: 's1', inputId: 'in-1', consumed: false }]);
    poller.dispose();
  });

  test('the same queued input is not injected twice across polls (deliver de-dups)', async () => {
    const { client } = makeStub({
      's1': [{ id: 'in-1', sessionId: 's1', intent: 'steer', state: 'queued', body: 'x', createdAt: 100, surfaceId: 'surface:webui' }],
    });
    const received: InboundSteer[] = [];
    const poller = new SessionInboundInputPoller({ sessionId: () => 's1', onSteer: (s) => received.push(s), log: SILENT });
    poller.activate(client);
    await poller.pollOnce();
    await poller.pollOnce();
    expect(received).toHaveLength(1);
    poller.dispose();
  });

  test("the surface's OWN submissions are skipped (never re-injected)", async () => {
    const { client, delivered } = makeStub({
      's1': [{ id: 'in-own', sessionId: 's1', intent: 'steer', state: 'queued', body: 'mine', createdAt: 100, surfaceId: 'surface:tui' }],
    });
    const received: InboundSteer[] = [];
    const poller = new SessionInboundInputPoller({ sessionId: () => 's1', onSteer: (s) => received.push(s), log: SILENT });
    poller.activate(client);
    const count = await poller.pollOnce();
    expect(count).toBe(0);
    expect(received).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    poller.dispose();
  });

  test('non-steer intents (submit) are ignored', async () => {
    const { client } = makeStub({
      's1': [{ id: 'in-sub', sessionId: 's1', intent: 'submit', state: 'queued', body: 'submit', createdAt: 100, surfaceId: 'surface:webui' }],
    });
    const received: InboundSteer[] = [];
    const poller = new SessionInboundInputPoller({ sessionId: () => 's1', onSteer: (s) => received.push(s), log: SILENT });
    poller.activate(client);
    expect(await poller.pollOnce()).toBe(0);
    expect(received).toHaveLength(0);
    poller.dispose();
  });

  test('D7b — per-session isolation: a steer to each of two sessions lands only in the right poller', async () => {
    const { client } = makeStub({
      'proj-a': [{ id: 'a-1', sessionId: 'proj-a', intent: 'steer', state: 'queued', body: 'for A', createdAt: 10, surfaceId: 'surface:webui' }],
      'proj-b': [{ id: 'b-1', sessionId: 'proj-b', intent: 'steer', state: 'queued', body: 'for B', createdAt: 20, surfaceId: 'surface:webui' }],
    });
    const recA: InboundSteer[] = [];
    const recB: InboundSteer[] = [];
    const pollerA = new SessionInboundInputPoller({ sessionId: () => 'proj-a', onSteer: (s) => recA.push(s), log: SILENT });
    const pollerB = new SessionInboundInputPoller({ sessionId: () => 'proj-b', onSteer: (s) => recB.push(s), log: SILENT });
    pollerA.activate(client);
    pollerB.activate(client);

    await pollerA.pollOnce();
    await pollerB.pollOnce();

    expect(recA.map((s) => s.body)).toEqual(['for A']);
    expect(recB.map((s) => s.body)).toEqual(['for B']);
    pollerA.dispose();
    pollerB.dispose();
  });

  test('an onSteer that throws still acks delivery and does not wedge the loop', async () => {
    const { client, delivered } = makeStub({
      's1': [
        { id: 'in-1', sessionId: 's1', intent: 'steer', state: 'queued', body: 'boom', createdAt: 100, surfaceId: 'surface:webui' },
        { id: 'in-2', sessionId: 's1', intent: 'steer', state: 'queued', body: 'next', createdAt: 101, surfaceId: 'surface:webui' },
      ],
    });
    const received: InboundSteer[] = [];
    const poller = new SessionInboundInputPoller({
      sessionId: () => 's1',
      onSteer: (s) => { received.push(s); if (s.body === 'boom') throw new Error('inject failed'); },
      log: SILENT,
    });
    poller.activate(client);
    const count = await poller.pollOnce();
    expect(count).toBe(2); // both acked despite the throw on the first
    expect(received.map((s) => s.body)).toEqual(['boom', 'next']);
    expect(delivered.map((d) => d.inputId)).toEqual(['in-1', 'in-2']);
    poller.dispose();
  });

  test('no session yet -> poll is a no-op', async () => {
    const { client, listCalls } = makeStub({});
    const poller = new SessionInboundInputPoller({ sessionId: () => null, onSteer: () => {}, log: SILENT });
    poller.activate(client);
    expect(await poller.pollOnce()).toBe(0);
    expect(listCalls).toHaveLength(0);
    poller.dispose();
  });
});

describe('narrateInboundSteer', () => {
  test('names the surface and body', () => {
    expect(narrateInboundSteer({ inputId: 'i', sessionId: 's', intent: 'steer', body: 'hello', surfaceKind: 'webui', surfaceId: 'surface:webui', displayName: 'Alice' }))
      .toBe('steer received from webui (Alice): hello');
  });
  test('follow-up phrasing, no displayName', () => {
    expect(narrateInboundSteer({ inputId: 'i', sessionId: 's', intent: 'follow-up', body: 'later', surfaceKind: 'slack', surfaceId: undefined, displayName: undefined }))
      .toBe('follow-up received from slack: later');
  });
});
