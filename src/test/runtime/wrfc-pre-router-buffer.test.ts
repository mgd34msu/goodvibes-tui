import { describe, test, expect, mock } from 'bun:test';
import { WrfcPreRouterBuffer } from '../../runtime/bootstrap-core.ts';
import type { SystemMessageRouter } from '../../core/system-message-router.ts';

// ---------------------------------------------------------------------------
// Minimal SystemMessageRouter stub
// ---------------------------------------------------------------------------

function makeRouterStub(): {
  router: SystemMessageRouter;
  calls: Array<{ message: string; priority: string }>;
} {
  const calls: Array<{ message: string; priority: string }> = [];
  const router = {
    wrfc: (message: string, priority: string) => {
      calls.push({ message, priority });
    },
  } as unknown as SystemMessageRouter;
  return { router, calls };
}

// ---------------------------------------------------------------------------
// WrfcPreRouterBuffer
// ---------------------------------------------------------------------------

describe('WrfcPreRouterBuffer', () => {
  describe('basic push and flush', () => {
    test('flush delivers messages in push order', () => {
      const buf = new WrfcPreRouterBuffer();
      const { router, calls } = makeRouterStub();

      buf.push('msg-1', 'low');
      buf.push('msg-2', 'low');
      buf.push('msg-3', 'high');
      buf.flush(router);

      expect(calls).toHaveLength(3);
      expect(calls[0]!.message).toBe('msg-1');
      expect(calls[1]!.message).toBe('msg-2');
      expect(calls[2]!.message).toBe('msg-3');
    });

    test('flush preserves priority per message', () => {
      const buf = new WrfcPreRouterBuffer();
      const { router, calls } = makeRouterStub();

      buf.push('low-msg', 'low');
      buf.push('high-msg', 'high');
      buf.flush(router);

      expect(calls[0]!.priority).toBe('low');
      expect(calls[1]!.priority).toBe('high');
    });

    test('flush clears the buffer (second flush is a no-op)', () => {
      const buf = new WrfcPreRouterBuffer();
      const { router, calls } = makeRouterStub();

      buf.push('once', 'low');
      buf.flush(router);
      buf.flush(router);

      // Only 1 message delivered across both flushes
      expect(calls.filter((c) => c.message === 'once')).toHaveLength(1);
    });

    test('size reflects current queue depth', () => {
      const buf = new WrfcPreRouterBuffer();
      expect(buf.size).toBe(0);
      buf.push('a', 'low');
      buf.push('b', 'low');
      expect(buf.size).toBe(2);
    });

    test('size is 0 after flush', () => {
      const buf = new WrfcPreRouterBuffer();
      const { router } = makeRouterStub();
      buf.push('a', 'low');
      buf.flush(router);
      expect(buf.size).toBe(0);
    });

    test('empty buffer flush is a no-op (calls nothing)', () => {
      const buf = new WrfcPreRouterBuffer();
      const { router, calls } = makeRouterStub();
      buf.flush(router);
      expect(calls).toHaveLength(0);
    });
  });

  describe('overflow behavior (cap = 100)', () => {
    test('accepts exactly 100 entries without dropping', () => {
      const buf = new WrfcPreRouterBuffer();
      const { router, calls } = makeRouterStub();

      for (let i = 0; i < 100; i++) {
        buf.push(`msg-${i}`, 'low');
      }
      buf.flush(router);

      // No overflow summary + 100 data messages
      expect(calls).toHaveLength(100);
      expect(calls[0]!.message).toBe('msg-0');
      expect(calls[99]!.message).toBe('msg-99');
    });

    test('101st entry evicts the oldest (msg-0 dropped)', () => {
      const buf = new WrfcPreRouterBuffer();
      const { router, calls } = makeRouterStub();

      for (let i = 0; i < 101; i++) {
        buf.push(`msg-${i}`, 'low');
      }
      buf.flush(router);

      // 1 overflow summary + 100 data messages
      expect(calls).toHaveLength(101);
      const summary = calls[0]!;
      expect(summary.message).toContain('overflow');
      expect(summary.message).toContain('1');
      // msg-0 was dropped; msg-1 is the first data message
      expect(calls[1]!.message).toBe('msg-1');
      expect(calls[100]!.message).toBe('msg-100');
    });

    test('overflow count accumulates across multiple evictions', () => {
      const buf = new WrfcPreRouterBuffer();
      const { router, calls } = makeRouterStub();

      // Push 150: first 50 will be evicted
      for (let i = 0; i < 150; i++) {
        buf.push(`msg-${i}`, 'low');
      }
      buf.flush(router);

      // 1 overflow summary + 100 data messages
      expect(calls).toHaveLength(101);
      const summary = calls[0]!;
      expect(summary.message).toContain('50');
      // After eviction the queue holds msg-50..msg-149
      expect(calls[1]!.message).toBe('msg-50');
      expect(calls[100]!.message).toBe('msg-149');
    });

    test('overflow summary is low priority', () => {
      const buf = new WrfcPreRouterBuffer();
      const { router, calls } = makeRouterStub();

      for (let i = 0; i < 101; i++) {
        buf.push(`msg-${i}`, 'low');
      }
      buf.flush(router);

      expect(calls[0]!.priority).toBe('low');
    });

    test('overflow counter resets after flush (subsequent overflow independent)', () => {
      const buf = new WrfcPreRouterBuffer();
      const { router, calls } = makeRouterStub();

      // First overflow batch
      for (let i = 0; i < 101; i++) buf.push(`a-${i}`, 'low');
      buf.flush(router);

      const firstFlushCount = calls.length;

      // Second overflow batch — fresh overflow counter
      for (let i = 0; i < 101; i++) buf.push(`b-${i}`, 'low');
      buf.flush(router);

      const secondFlushCalls = calls.slice(firstFlushCount);
      // The second flush also emits 1 summary + 100 data
      expect(secondFlushCalls).toHaveLength(101);
      expect(secondFlushCalls[0]!.message).toContain('1');
      expect(secondFlushCalls[1]!.message).toBe('b-1');
    });
  });

  describe('smart ref flush-on-attach integration', () => {
    test('messages buffered before attach are flushed when .value is set', () => {
      // Simulate the smart ref pattern used in bootstrap-core
      const buf = new WrfcPreRouterBuffer();
      const { router, calls } = makeRouterStub();

      // Buffer some messages before router is ready
      buf.push('[WRFC] Guard: task judged implementation-like - task: "x" (spawn-forced-wrfc)', 'low');
      buf.push('[WRFC] Engineer enumerated 2 constraints for chain abc123', 'low');

      expect(buf.size).toBe(2);

      // Simulate smart ref .set: flush buffer
      buf.flush(router);

      expect(buf.size).toBe(0);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.message).toContain('spawn-forced-wrfc');
      expect(calls[1]!.message).toContain('constraints');
    });

    test('messages pushed after flush go directly to router (no re-buffer)', () => {
      const buf = new WrfcPreRouterBuffer();
      const { router, calls } = makeRouterStub();

      buf.push('pre-attach', 'low');
      buf.flush(router);

      // After flush the buffer is empty; new messages pushed and then flushed again
      buf.push('post-attach', 'low');
      buf.flush(router);

      expect(calls).toHaveLength(2);
      expect(calls[0]!.message).toBe('pre-attach');
      expect(calls[1]!.message).toBe('post-attach');
    });
  });
});
