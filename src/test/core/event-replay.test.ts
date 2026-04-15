import { describe, test, expect, beforeEach } from 'bun:test';
import { EventReplayQueue } from '../../core/event-replay.ts';
import { RuntimeEventBus } from '../../runtime/events/index.ts';
import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';

describe('EventReplayQueue', () => {
  let runtimeBus: RuntimeEventBus;
  let queue: EventReplayQueue;

  beforeEach(() => {
    runtimeBus = new RuntimeEventBus();
    queue = new EventReplayQueue();
  });

  // ---------------------------------------------------------------------------
  // enqueue
  // ---------------------------------------------------------------------------
  describe('enqueue', () => {
    test('returns a unique string ID', () => {
      const id1 = queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      const id2 = queue.enqueue('AGENT_COMPLETED', { id: 'a2' });
      expect(typeof id1).toBe('string');
      expect(id1.length).toBeGreaterThan(0);
      expect(id1).not.toBe(id2);
    });

    test('enqueued event shows in stats as pending', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      const stats = queue.getStats();
      expect(stats.queued).toBe(1);
      expect(stats.pending).toBe(1);
      expect(stats.acknowledged).toBe(0);
    });

    test('multiple events accumulate', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.enqueue('AGENT_FAILED', { id: 'a2', error: new Error('boom') });
      queue.enqueue('WORKFLOW_CHAIN_FAILED', { chainId: 'w1', reason: 'timeout' });
      expect(queue.getStats().queued).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // acknowledge
  // ---------------------------------------------------------------------------
  describe('acknowledge', () => {
    test('marks event as acknowledged by ID', () => {
      const id = queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.acknowledge(id);
      const stats = queue.getStats();
      expect(stats.acknowledged).toBe(1);
      expect(stats.pending).toBe(0);
    });

    test('acknowledge with unknown ID does not throw', () => {
      expect(() => queue.acknowledge('nonexistent-id')).not.toThrow();
    });

    test('acknowledging twice is idempotent', () => {
      const id = queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.acknowledge(id);
      queue.acknowledge(id);
      expect(queue.getStats().acknowledged).toBe(1);
    });

    test('acknowledged events are not returned by onTurnComplete', () => {
      const id = queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.acknowledge(id);
      queue.onTurnComplete(); // turn 1 — past grace
      queue.onTurnComplete(); // turn 2
      const replays = queue.onTurnComplete();
      expect(replays).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // acknowledgeWhere
  // ---------------------------------------------------------------------------
  describe('acknowledgeWhere', () => {
    test('acknowledges matching events and returns count', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'agent-abc' });
      queue.enqueue('AGENT_COMPLETED', { id: 'agent-def' });
      queue.enqueue('WORKFLOW_CHAIN_FAILED', { chainId: 'w1', reason: 'err' });

      const count = queue.acknowledgeWhere((e) => {
        const payload = e.payload as Record<string, unknown>;
        return payload.id === 'agent-abc';
      });

      expect(count).toBe(1);
      expect(queue.getStats().acknowledged).toBe(1);
      expect(queue.getStats().pending).toBe(2);
    });

    test('returns 0 when no events match', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'agent-abc' });
      const count = queue.acknowledgeWhere(() => false);
      expect(count).toBe(0);
    });

    test('already-acknowledged events are skipped in count', () => {
      const id = queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.acknowledge(id);
      const count = queue.acknowledgeWhere(() => true);
      expect(count).toBe(0); // already acknowledged, not counted again
    });

    test('can acknowledge by chainId predicate', () => {
      queue.enqueue('WORKFLOW_STATE_CHANGED', { chainId: 'chain-123', from: 'engineering', to: 'reviewing' });
      queue.enqueue('WORKFLOW_CHAIN_FAILED', { chainId: 'chain-456', reason: 'err' });

      const count = queue.acknowledgeWhere((e) => {
        const payload = e.payload as Record<string, unknown>;
        return payload.chainId === 'chain-123';
      });
      expect(count).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // onTurnComplete — turn mechanics
  // ---------------------------------------------------------------------------
  describe('onTurnComplete', () => {
    test('no replays returned within grace period (turn 1, grace=1)', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      // Turn 1: only 1 turn elapsed = grace period, no replay
      const replays = queue.onTurnComplete();
      expect(replays).toHaveLength(0);
    });

    test('replay returned after grace period expires (turn 2)', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.onTurnComplete(); // turn 1: grace
      const replays = queue.onTurnComplete(); // turn 2: replay
      expect(replays).toHaveLength(1);
      expect(replays[0].eventName).toBe('AGENT_COMPLETED');
    });

    test('increments replayCount on each replay', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.onTurnComplete(); // grace
      const r1 = queue.onTurnComplete(); // replay 1
      expect(r1[0].replayCount).toBe(1);
      const r2 = queue.onTurnComplete(); // replay 2
      expect(r2[0].replayCount).toBe(2);
    });

    test('only unacknowledged events are replayed', () => {
      const id1 = queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.enqueue('AGENT_FAILED', { id: 'a2', error: new Error('x') });
      queue.acknowledge(id1);
      queue.onTurnComplete(); // grace
      const replays = queue.onTurnComplete();
      expect(replays).toHaveLength(1);
      expect((replays[0].payload as Record<string, unknown>).id).toBe('a2');
    });

    test('custom graceTurns=2 delays replay by 2 turns', () => {
      const slowQueue = new EventReplayQueue(3, 2);
      slowQueue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      slowQueue.onTurnComplete(); // turn 1: within grace
      const r1 = slowQueue.onTurnComplete(); // turn 2: within grace
      expect(r1).toHaveLength(0);
      const r2 = slowQueue.onTurnComplete(); // turn 3: past grace
      expect(r2).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // replay limits and dropping
  // ---------------------------------------------------------------------------
  describe('replay limits', () => {
    test('event is dropped after maxReplays (default 3)', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.onTurnComplete(); // grace
      queue.onTurnComplete(); // replay 1
      queue.onTurnComplete(); // replay 2
      queue.onTurnComplete(); // replay 3
      // On the next turn, event has replayCount=3=maxReplays, so it gets dropped
      const replays = queue.onTurnComplete();
      expect(replays).toHaveLength(0);
      expect(queue.getStats().dropped).toBe(1);
      expect(queue.getStats().queued).toBe(0);
    });

    test('custom maxReplays=1 drops after single replay', () => {
      const strictQueue = new EventReplayQueue(1, 1);
      strictQueue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      strictQueue.onTurnComplete(); // grace
      strictQueue.onTurnComplete(); // replay 1 (replayCount becomes 1 = maxReplays)
      // next turn: replayCount >= maxReplays, drop
      strictQueue.onTurnComplete();
      expect(strictQueue.getStats().dropped).toBe(1);
      expect(strictQueue.getStats().queued).toBe(0);
    });

    test('dropped events do not re-appear in future turns', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.onTurnComplete(); // grace
      for (let i = 0; i < 5; i++) queue.onTurnComplete(); // exhaust and drop
      // Many more turns — should never return this event again
      const late = queue.onTurnComplete();
      expect(late).toHaveLength(0);
    });

    test('droppedCount accumulates across multiple events', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.enqueue('AGENT_FAILED', { id: 'a2', error: new Error('x') });
      queue.onTurnComplete(); // grace for both
      for (let i = 0; i < 4; i++) queue.onTurnComplete(); // exhaust both
      expect(queue.getStats().dropped).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // formatReplays
  // ---------------------------------------------------------------------------
  describe('formatReplays', () => {
    test('first replay has [Replay] prefix only', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'agent-fa247908' });
      queue.onTurnComplete(); // grace
      const replays = queue.onTurnComplete(); // replay 1
      const msgs = queue.formatReplays(replays);
      expect(msgs[0]).toMatch(/^\[Replay\] /);
      expect(msgs[0]).not.toMatch(/URGENT|Action Required/);
    });

    test('second replay has [Replay][Action Required] prefix', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.onTurnComplete(); // grace
      queue.onTurnComplete(); // replay 1
      const replays = queue.onTurnComplete(); // replay 2
      const msgs = queue.formatReplays(replays);
      expect(msgs[0]).toMatch(/^\[Replay\]\[Action Required\]/);
    });

    test('third replay has [Replay][URGENT] prefix', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.onTurnComplete(); // grace
      queue.onTurnComplete(); // replay 1
      queue.onTurnComplete(); // replay 2
      const replays = queue.onTurnComplete(); // replay 3
      const msgs = queue.formatReplays(replays);
      expect(msgs[0]).toMatch(/^\[Replay\]\[URGENT\]/);
    });

    test('AGENT_COMPLETED message includes agent ID', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'agent-fa247908' });
      queue.onTurnComplete();
      const replays = queue.onTurnComplete();
      const msgs = queue.formatReplays(replays);
      expect(msgs[0]).toContain('agent-fa247908');
      expect(msgs[0]).toContain('completed');
    });

    test('AGENT_FAILED message includes agent ID and error', () => {
      queue.enqueue('AGENT_FAILED', { id: 'agent-err', error: new Error('disk full') });
      queue.onTurnComplete();
      const replays = queue.onTurnComplete();
      const msgs = queue.formatReplays(replays);
      expect(msgs[0]).toContain('agent-err');
      expect(msgs[0]).toContain('disk full');
      expect(msgs[0]).toContain('failed');
    });

    test('WORKFLOW_STATE_CHANGED message includes chainId, from, to', () => {
      queue.enqueue('WORKFLOW_STATE_CHANGED', { chainId: 'wrfc-f00ef799', from: 'engineering', to: 'reviewing' });
      queue.onTurnComplete();
      const replays = queue.onTurnComplete();
      const msgs = queue.formatReplays(replays);
      expect(msgs[0]).toContain('wrfc-f00ef799');
      expect(msgs[0]).toContain('engineering');
      expect(msgs[0]).toContain('reviewing');
    });

    test('WORKFLOW_CHAIN_PASSED message includes chainId', () => {
      queue.enqueue('WORKFLOW_CHAIN_PASSED', { chainId: 'wrfc-abc' });
      queue.onTurnComplete();
      const replays = queue.onTurnComplete();
      const msgs = queue.formatReplays(replays);
      expect(msgs[0]).toContain('wrfc-abc');
      expect(msgs[0]).toContain('passed');
    });

    test('WORKFLOW_CHAIN_FAILED message includes chainId and reason', () => {
      queue.enqueue('WORKFLOW_CHAIN_FAILED', { chainId: 'wrfc-f00ef799', reason: 'max attempts exceeded' });
      queue.onTurnComplete();
      const replays = queue.onTurnComplete();
      const msgs = queue.formatReplays(replays);
      expect(msgs[0]).toContain('wrfc-f00ef799');
      expect(msgs[0]).toContain('max attempts exceeded');
    });

    test('message includes turns-ago count', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.onTurnComplete(); // turn 1
      queue.onTurnComplete(); // turn 2 — replay 1 (2 turns elapsed)
      const replays = queue.onTurnComplete(); // turn 3 — replay 2 (3 turns elapsed)
      const msgs = queue.formatReplays(replays);
      expect(msgs[0]).toContain('turns ago');
    });

    test('formatReplays with empty array returns empty array', () => {
      expect(queue.formatReplays([])).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getStats
  // ---------------------------------------------------------------------------
  describe('getStats', () => {
    test('initial stats are all zero', () => {
      expect(queue.getStats()).toEqual({
        queued: 0,
        acknowledged: 0,
        pending: 0,
        replayed: 0,
        dropped: 0,
      });
    });

    test('replayed count tracks events that have been replayed at least once', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.onTurnComplete(); // grace
      queue.onTurnComplete(); // replay 1
      expect(queue.getStats().replayed).toBe(1);
    });

    test('stats remain consistent across multiple enqueue/ack cycles', () => {
      const id1 = queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.enqueue('AGENT_FAILED', { id: 'a2', error: new Error('x') });
      queue.acknowledge(id1);

      const stats = queue.getStats();
      expect(stats.queued).toBe(2);
      expect(stats.acknowledged).toBe(1);
      expect(stats.pending).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------
  describe('clear', () => {
    test('clear resets all state', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      queue.onTurnComplete();
      queue.onTurnComplete();
      queue.clear();

      expect(queue.getStats()).toEqual({
        queued: 0,
        acknowledged: 0,
        pending: 0,
        replayed: 0,
        dropped: 0,
      });
    });

    test('after clear, new events start fresh', () => {
      queue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      for (let i = 0; i < 5; i++) queue.onTurnComplete();
      queue.clear();

      queue.enqueue('AGENT_COMPLETED', { id: 'a2' });
      // Grace period restarts from turn 0
      const r1 = queue.onTurnComplete();
      expect(r1).toHaveLength(0);
      const r2 = queue.onTurnComplete();
      expect(r2).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // EventReplayQueue.attachToRuntimeBus
  // ---------------------------------------------------------------------------
  describe('attachToRuntimeBus', () => {
    test('auto-enqueues AGENT_COMPLETED events from runtime bus', () => {
      const detach = EventReplayQueue.attachToRuntimeBus(runtimeBus, queue);
      runtimeBus.emit('agents', createEventEnvelope('AGENT_COMPLETED', {
        type: 'AGENT_COMPLETED',
        agentId: 'agent-123',
        durationMs: 0,
        output: 'done',
        toolCallsMade: 0,
      }, {
        sessionId: 'test-session',
        traceId: 'test-trace',
        source: 'event-replay.test',
      }));
      expect(queue.getStats().queued).toBe(1);
      detach();
    });

    test('auto-enqueues AGENT_FAILED events from runtime bus', () => {
      const detach = EventReplayQueue.attachToRuntimeBus(runtimeBus, queue);
      runtimeBus.emit('agents', createEventEnvelope('AGENT_FAILED', {
        type: 'AGENT_FAILED',
        agentId: 'agent-err',
        error: 'fail',
        durationMs: 0,
      }, {
        sessionId: 'test-session',
        traceId: 'test-trace',
        source: 'event-replay.test',
      }));
      expect(queue.getStats().queued).toBe(1);
      detach();
    });

    test('detach function stops further enqueuing', () => {
      const detach = EventReplayQueue.attachToRuntimeBus(runtimeBus, queue);
      detach();
      runtimeBus.emit('agents', createEventEnvelope('AGENT_COMPLETED', {
        type: 'AGENT_COMPLETED',
        agentId: 'agent-late',
        durationMs: 0,
        output: 'done',
        toolCallsMade: 0,
      }, {
        sessionId: 'test-session',
        traceId: 'test-trace',
        source: 'event-replay.test',
      }));
      expect(queue.getStats().queued).toBe(0);
    });

    test('multiple tracked events each enqueue independently', () => {
      const detach = EventReplayQueue.attachToRuntimeBus(runtimeBus, queue);
      runtimeBus.emit('agents', createEventEnvelope('AGENT_COMPLETED', {
        type: 'AGENT_COMPLETED',
        agentId: 'a1',
        durationMs: 0,
        output: 'done',
        toolCallsMade: 0,
      }, {
        sessionId: 'test-session',
        traceId: 'test-trace',
        source: 'event-replay.test',
      }));
      runtimeBus.emit('agents', createEventEnvelope('AGENT_FAILED', {
        type: 'AGENT_FAILED',
        agentId: 'a2',
        error: 'x',
        durationMs: 0,
      }, {
        sessionId: 'test-session',
        traceId: 'test-trace',
        source: 'event-replay.test',
      }));
      expect(queue.getStats().queued).toBe(2);
      detach();
    });
  });

  // ---------------------------------------------------------------------------
  // formatReplays — low maxReplays
  // ---------------------------------------------------------------------------
  describe('formatReplays with low maxReplays', () => {
    test('maxReplays=1: first replay has [Replay] prefix (replayCount=1 >= URGENT threshold)', () => {
      // With maxReplays=1: URGENT threshold = 1, Action Required = ceil(1*2/3)=1
      // Both thresholds equal 1, so URGENT wins
      const strictQueue = new EventReplayQueue(1, 1);
      strictQueue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      strictQueue.onTurnComplete(); // grace
      const replays = strictQueue.onTurnComplete(); // replay 1
      const msgs = strictQueue.formatReplays(replays);
      expect(msgs[0]).toMatch(/^\[Replay\]\[URGENT\]/);
    });

    test('maxReplays=2: first replay has [Replay] prefix, second has [Action Required]', () => {
      // With maxReplays=2: URGENT threshold=2, Action Required=ceil(2*2/3)=ceil(1.33)=2
      // Both equal 2 — first replay (replayCount=1) gets plain [Replay]
      const twoQueue = new EventReplayQueue(2, 1);
      twoQueue.enqueue('AGENT_COMPLETED', { id: 'a1' });
      twoQueue.onTurnComplete(); // grace
      const r1 = twoQueue.onTurnComplete(); // replay 1 (replayCount=1)
      const msgs1 = twoQueue.formatReplays(r1);
      expect(msgs1[0]).toMatch(/^\[Replay\] /);
      expect(msgs1[0]).not.toMatch(/URGENT|Action Required/);
      const r2 = twoQueue.onTurnComplete(); // replay 2 (replayCount=2)
      const msgs2 = twoQueue.formatReplays(r2);
      expect(msgs2[0]).toMatch(/^\[Replay\]\[URGENT\]/);
    });
  });
});
