import { describe, test, expect, beforeEach } from 'bun:test';
import { AgentMessageBus } from '@pellux/goodvibes-sdk/platform/agents';
import type { AgentMessage } from '@pellux/goodvibes-sdk/platform/agents';
import { getTestAgentMessageBus, resetTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

beforeEach(() => {
  resetTestRuntimeServices();
});

describe('runtime ownership', () => {
  test('test runtime exposes one message bus per runtime graph', () => {
    const a = getTestAgentMessageBus();
    const b = getTestAgentMessageBus();
    expect(a).toBe(b);
  });

  test('resetting the test runtime creates a fresh message bus', () => {
    const a = getTestAgentMessageBus();
    resetTestRuntimeServices();
    const b = getTestAgentMessageBus();
    expect(a).not.toBe(b);
  });
});

describe('send', () => {
  test('send stores message for recipient', () => {
    const bus = getTestAgentMessageBus();
    bus.send('agent-a', 'agent-b', 'Hello from A');
    const msgs = bus.getMessages('agent-b');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('Hello from A');
    expect(msgs[0].from).toBe('agent-a');
    expect(msgs[0].to).toBe('agent-b');
  });

  test('send assigns unique ID and timestamp', () => {
    const bus = getTestAgentMessageBus();
    bus.send('agent-a', 'agent-b', 'msg1');
    bus.send('agent-a', 'agent-b', 'msg2');
    const msgs = bus.getMessages('agent-b');
    expect(msgs[0].id).not.toBe(msgs[1].id);
    expect(typeof msgs[0].timestamp).toBe('number');
  });

  test('send delivers to active subscriber', () => {
    const bus = getTestAgentMessageBus();
    const received: AgentMessage[] = [];
    bus.subscribe('agent-b', (m) => received.push(m));
    bus.send('agent-a', 'agent-b', 'Ping');
    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('Ping');
  });

  test('send does not deliver to other agents subscribers', () => {
    const bus = getTestAgentMessageBus();
    const receivedC: AgentMessage[] = [];
    bus.subscribe('agent-c', (m) => receivedC.push(m));
    bus.send('agent-a', 'agent-b', 'Only for B');
    expect(receivedC).toHaveLength(0);
  });

  test('multiple messages are stored in order', () => {
    const bus = getTestAgentMessageBus();
    bus.send('agent-a', 'agent-b', 'first');
    bus.send('agent-a', 'agent-b', 'second');
    bus.send('agent-a', 'agent-b', 'third');
    const msgs = bus.getMessages('agent-b');
    expect(msgs).toHaveLength(3);
    expect(msgs.map((m) => m.content)).toEqual(['first', 'second', 'third']);
  });

  test('enforces direct-route policy when both sender and recipient are registered', () => {
    const bus = getTestAgentMessageBus();
    bus.registerAgent({ agentId: 'engineer-1', role: 'engineer', wrfcId: 'wrfc-1' });
    bus.registerAgent({ agentId: 'reviewer-1', role: 'reviewer', wrfcId: 'wrfc-1' });

    const allowed = bus.send('reviewer-1', 'engineer-1', 'Please address findings', {
      kind: 'review',
    });

    expect(allowed).toBe(true);
    const msgs = bus.getMessages('engineer-1');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.kind).toBe('review');
    expect(msgs[0]?.fromRole).toBe('reviewer');
    expect(msgs[0]?.toRole).toBe('engineer');
  });

  test('blocks direct routes outside the registered communication policy', () => {
    const bus = getTestAgentMessageBus();
    bus.registerAgent({ agentId: 'reviewer-1', role: 'reviewer', wrfcId: 'wrfc-1' });
    bus.registerAgent({ agentId: 'general-1', role: 'general', cohort: 'team-1' });

    const allowed = bus.send('reviewer-1', 'general-1', 'Broadcasting review detail sideways', {
      kind: 'review',
    });

    expect(allowed).toBe(false);
    expect(bus.getMessages('general-1')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// broadcast
// ---------------------------------------------------------------------------

describe('broadcast', () => {
  test('broadcast stores under wildcard', () => {
    const bus = getTestAgentMessageBus();
    bus.broadcast('agent-a', 'All hands');
    // All agents see broadcasts via getMessages
    const msgs = bus.getMessages('agent-b');
    expect(msgs.some((m) => m.content === 'All hands')).toBe(true);
    expect(msgs.find((m) => m.content === 'All hands')?.to).toBe('*');
  });

  test('broadcast delivers to all subscribers', () => {
    const bus = getTestAgentMessageBus();
    const receivedB: AgentMessage[] = [];
    const receivedC: AgentMessage[] = [];
    bus.subscribe('agent-b', (m) => receivedB.push(m));
    bus.subscribe('agent-c', (m) => receivedC.push(m));
    bus.broadcast('agent-a', 'Announcement');
    expect(receivedB).toHaveLength(1);
    expect(receivedC).toHaveLength(1);
    expect(receivedB[0].content).toBe('Announcement');
  });

  test('broadcast included in getMessages for any agent', () => {
    const bus = getTestAgentMessageBus();
    bus.broadcast('agent-a', 'Global');
    expect(bus.getMessages('agent-x').some((m) => m.content === 'Global')).toBe(true);
    expect(bus.getMessages('agent-y').some((m) => m.content === 'Global')).toBe(true);
  });

  test('blocks broadcast for registered roles outside broadcast policy', () => {
    const bus = getTestAgentMessageBus();
    bus.registerAgent({ agentId: 'reviewer-1', role: 'reviewer', wrfcId: 'wrfc-1' });

    const allowed = bus.broadcast('reviewer-1', 'Everyone listen up', {
      kind: 'status',
    });

    expect(allowed).toBe(false);
    expect(bus.getMessages('agent-b')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// subscribe / unsubscribe
// ---------------------------------------------------------------------------

describe('subscribe', () => {
  test('subscribe returns unsubscribe function', () => {
    const bus = getTestAgentMessageBus();
    const received: AgentMessage[] = [];
    const unsub = bus.subscribe('agent-b', (m) => received.push(m));
    bus.send('agent-a', 'agent-b', 'before unsub');
    unsub();
    bus.send('agent-a', 'agent-b', 'after unsub');
    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('before unsub');
  });

  test('multiple subscribers for same agent all receive messages', () => {
    const bus = getTestAgentMessageBus();
    const r1: AgentMessage[] = [];
    const r2: AgentMessage[] = [];
    bus.subscribe('agent-b', (m) => r1.push(m));
    bus.subscribe('agent-b', (m) => r2.push(m));
    bus.send('agent-a', 'agent-b', 'hello');
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });

  test('subscriber error does not crash the bus', () => {
    const bus = getTestAgentMessageBus();
    bus.subscribe('agent-b', () => {
      throw new Error('subscriber crash');
    });
    expect(() => bus.send('agent-a', 'agent-b', 'test')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getMessages
// ---------------------------------------------------------------------------

describe('getMessages', () => {
  test('returns empty array when no messages', () => {
    const bus = getTestAgentMessageBus();
    expect(bus.getMessages('agent-nobody')).toEqual([]);
  });

  test('returns direct messages and broadcasts combined', () => {
    const bus = getTestAgentMessageBus();
    bus.send('agent-a', 'agent-b', 'direct');
    bus.broadcast('agent-a', 'broadcast');
    const msgs = bus.getMessages('agent-b');
    expect(msgs.some((m) => m.content === 'direct')).toBe(true);
    expect(msgs.some((m) => m.content === 'broadcast')).toBe(true);
  });

  test('messages sorted by timestamp ascending', () => {
    const bus = getTestAgentMessageBus();
    bus.send('agent-a', 'agent-b', 'msg1');
    bus.send('agent-a', 'agent-b', 'msg2');
    const msgs = bus.getMessages('agent-b');
    expect(msgs[0].timestamp).toBeLessThanOrEqual(msgs[1].timestamp);
  });
});

// ---------------------------------------------------------------------------
// TTL / cleanup
// ---------------------------------------------------------------------------

describe('TTL and cleanup', () => {
  test('expired messages are not returned', () => {
    const bus = getTestAgentMessageBus();
    // Send with 0 ms TTL, already expired by the time we read
    bus.send('agent-a', 'agent-b', 'expired', 0);
    const msgs = bus.getMessages('agent-b');
    // TTL 0 means timestamp + 0 <= now, so it should be filtered out
    expect(msgs.filter((m) => m.content === 'expired')).toHaveLength(0);
  });

  test('non-expired messages survive cleanup', () => {
    const bus = getTestAgentMessageBus();
    bus.send('agent-a', 'agent-b', 'alive', 60_000);
    bus.cleanup();
    expect(bus.getMessages('agent-b').some((m) => m.content === 'alive')).toBe(true);
  });

  test('cleanup removes only expired messages', () => {
    const bus = getTestAgentMessageBus();
    bus.send('agent-a', 'agent-b', 'expired', 0);
    bus.send('agent-a', 'agent-b', 'alive', 60_000);
    bus.cleanup();
    const msgs = bus.getMessages('agent-b');
    expect(msgs.filter((m) => m.content === 'expired')).toHaveLength(0);
    expect(msgs.filter((m) => m.content === 'alive')).toHaveLength(1);
  });
});
