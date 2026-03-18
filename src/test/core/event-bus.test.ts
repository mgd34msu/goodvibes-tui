import { describe, test, expect, beforeEach } from 'bun:test';
import { EventBus } from '../../core/event-bus.ts';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe('on / emit', () => {
    test('listener receives emitted event data', () => {
      const received: string[] = [];
      bus.on('turn:complete', ({ response }) => received.push(response));
      bus.emit('turn:complete', { response: 'hello' });
      expect(received).toEqual(['hello']);
    });

    test('multiple listeners all receive the event', () => {
      const calls: number[] = [];
      bus.on('turn:complete', () => calls.push(1));
      bus.on('turn:complete', () => calls.push(2));
      bus.emit('turn:complete', { response: 'x' });
      expect(calls).toEqual([1, 2]);
    });

    test('listener not called before emit', () => {
      let called = false;
      bus.on('turn:complete', () => { called = true; });
      expect(called).toBe(false);
    });

    test('emitting event with no listeners does not throw', () => {
      expect(() => bus.emit('turn:complete', { response: 'x' })).not.toThrow();
    });

    test('void events emit without data argument', () => {
      let called = false;
      bus.on('render:request', () => { called = true; });
      bus.emit('render:request');
      expect(called).toBe(true);
    });

    test('listener receives correct event data shape', () => {
      let received: { callId: string; tool: string; args: Record<string, unknown> } | null = null;
      bus.on('turn:tool-executing', (data) => { received = data; });
      bus.emit('turn:tool-executing', { callId: 'c1', tool: 'file_read', args: { path: '/tmp' } });
      expect(received).not.toBeNull();
      expect(received!.callId).toBe('c1');
      expect(received!.tool).toBe('file_read');
    });
  });

  describe('off', () => {
    test('removed listener is not called after off()', () => {
      let count = 0;
      const listener = () => { count++; };
      bus.on('turn:complete', listener);
      bus.emit('turn:complete', { response: 'a' });
      bus.off('turn:complete', listener);
      bus.emit('turn:complete', { response: 'b' });
      expect(count).toBe(1);
    });

    test('off() on unregistered listener does not throw', () => {
      const listener = () => {};
      expect(() => bus.off('turn:complete', listener)).not.toThrow();
    });

    test('on() returns unsubscribe function that removes the listener', () => {
      let count = 0;
      const unsub = bus.on('turn:complete', () => { count++; });
      bus.emit('turn:complete', { response: 'a' });
      unsub();
      bus.emit('turn:complete', { response: 'b' });
      expect(count).toBe(1);
    });
  });

  describe('once', () => {
    test('once() listener is called exactly once', () => {
      let count = 0;
      bus.once('turn:complete', () => { count++; });
      bus.emit('turn:complete', { response: 'a' });
      bus.emit('turn:complete', { response: 'b' });
      bus.emit('turn:complete', { response: 'c' });
      expect(count).toBe(1);
    });

    test('once() listener receives event data', () => {
      let received = '';
      bus.once('turn:complete', ({ response }) => { received = response; });
      bus.emit('turn:complete', { response: 'only-this' });
      expect(received).toBe('only-this');
    });

    test('once() for void event fires and cleans up', () => {
      let count = 0;
      bus.once('render:request', () => { count++; });
      bus.emit('render:request');
      bus.emit('render:request');
      expect(count).toBe(1);
    });
  });

  describe('event isolation', () => {
    test('listeners on different events do not cross-trigger', () => {
      let startCount = 0;
      let completeCount = 0;
      bus.on('turn:start', () => { startCount++; });
      bus.on('turn:complete', () => { completeCount++; });
      bus.emit('turn:start', { prompt: 'hi' });
      expect(startCount).toBe(1);
      expect(completeCount).toBe(0);
    });

    test('error events carry Error objects', () => {
      let err: Error | undefined = undefined;
      bus.on('turn:error', ({ error }) => { err = error; });
      const testError = new Error('boom');
      bus.emit('turn:error', { error: testError });
      expect(err!).toBe(testError);
    });
  });
});
