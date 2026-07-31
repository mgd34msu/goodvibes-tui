/**
 * wire-session-dispatch.test.ts — work that arrives for a session this surface
 * hosts reaches the loop, and reaches it exactly once.
 *
 * ── Why this seam exists ──────────────────────────────────────────────────
 *
 * The composition used to own a persisting session broker, which was both the
 * register (who hosts what) and the dispatcher (deliver this to whoever hosts
 * it). As a client it owns neither: the daemon holds the register, and this
 * surface only needs to RECEIVE dispatch for the sessions it is running.
 *
 * The failure that matters is not "nothing arrives" — that is visible. It is a
 * message being CONSUMED without being run: acknowledged on the wire, removed
 * from the queue, and never answered. Whoever sent it sees delivered and waits
 * forever. So the ordering here is run-then-acknowledge, and a runner that
 * throws leaves the input queued for the next tick.
 */
import { describe, expect, test } from 'bun:test';
import { createWireSessionDispatch } from '../../runtime/client/session-dispatch.ts';

interface QueuedInput { id: string; intent: string; body: string }

function fakeInputs(inputs: QueuedInput[]) {
  const delivered: string[] = [];
  return {
    delivered,
    listInputs: async () => ({ inputs: inputs.filter((i) => !delivered.includes(i.id)) }),
    deliverInput: async (_sessionId: string, inputId: string) => { delivered.push(inputId); },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 15); });

describe('inbound continuation dispatch over the adopted daemon', () => {
  test('nothing is dispatched before a daemon is adopted', async () => {
    const ran: string[] = [];
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], intervalMs: 5 });
    dispatch.setContinuationRunner(({ task }) => { ran.push(task); return { agentId: 'a1' }; });
    await tick();
    // Holding a runner with no wire is the honest offline posture, not a
    // missing dependency: this surface simply has nowhere to be dispatched from.
    expect(ran).toEqual([]);
    dispatch.stop();
  });

  test('a submitted message reaches the runner and is acknowledged after it runs', async () => {
    const ran: string[] = [];
    const wire = fakeInputs([{ id: 'i1', intent: 'submit', body: 'do the thing' }]);
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], intervalMs: 5 });
    dispatch.setContinuationRunner(({ task }) => { ran.push(task); return { agentId: 'a1' }; });
    dispatch.activate(wire as never);
    await tick();
    expect(ran).toEqual(['do the thing']);
    expect(wire.delivered).toEqual(['i1']);
    dispatch.stop();
  });

  test('a steer is left for the live-turn poller, not started as a new run', async () => {
    const ran: string[] = [];
    const wire = fakeInputs([{ id: 'i1', intent: 'steer', body: 'actually, stop' }]);
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], intervalMs: 5 });
    dispatch.setContinuationRunner(({ task }) => { ran.push(task); return { agentId: 'a1' }; });
    dispatch.activate(wire as never);
    await tick();
    // A steer belongs to the turn already in flight (session-inbound-inputs.ts
    // injects it). Starting a second run for it would answer the same message
    // twice, from two agents, into one conversation.
    expect(ran).toEqual([]);
    expect(wire.delivered).toEqual([]);
    dispatch.stop();
  });

  test('a runner that throws leaves the input queued rather than consuming it', async () => {
    const wire = fakeInputs([{ id: 'i1', intent: 'submit', body: 'do the thing' }]);
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], intervalMs: 5 });
    dispatch.setContinuationRunner(() => { throw new Error('spawn refused'); });
    dispatch.activate(wire as never);
    await tick();
    // Acknowledged-but-unanswered is the worst outcome available: the sender
    // sees delivered and waits forever. A transient failure must retry.
    expect(wire.delivered).toEqual([]);
    dispatch.stop();
  });

  test('detaching stops dispatch but keeps the runner for a re-adopted daemon', async () => {
    const ran: string[] = [];
    const wire = fakeInputs([{ id: 'i1', intent: 'submit', body: 'first' }]);
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], intervalMs: 5 });
    dispatch.setContinuationRunner(({ task }) => { ran.push(task); return { agentId: 'a1' }; });
    dispatch.deactivate('daemon went away');
    await tick();
    expect(ran).toEqual([]);
    dispatch.activate(wire as never);
    await tick();
    expect(ran).toEqual(['first']);
    dispatch.stop();
  });
});
