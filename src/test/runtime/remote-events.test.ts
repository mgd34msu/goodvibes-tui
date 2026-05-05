import { describe, expect, test } from 'bun:test';
import { createEventEnvelope, createRemoteRuntimeEvents, createRemoteUiRuntimeEvents } from '@/runtime/index.ts';
import { createWebSocketConnector } from '@/runtime/index.ts';

describe('remote runtime transport events', () => {
  test('disconnects an async event stream if listeners unsubscribe before connect resolves', async () => {
    let cleanupCalls = 0;
    let resolveConnect: ((cleanup: () => void) => void) | null = null;

    const events = createRemoteUiRuntimeEvents(async () => {
      const cleanup = await new Promise<() => void>((resolve) => {
        resolveConnect = resolve;
      });
      return cleanup;
    });

    const unsubscribe = events.agents.on('AGENT_SPAWNING', () => {});
    unsubscribe();

    expect(resolveConnect).not.toBeNull();
    resolveConnect!(() => {
      cleanupCalls += 1;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(cleanupCalls).toBe(1);
  });

  test('creates feeds for every runtime domain from the canonical vocabulary', () => {
    const events = createRemoteRuntimeEvents(async () => () => {});

    expect(events.domains).toContain('agents');
    expect(typeof events.domain('agents').on).toBe('function');
    expect(typeof events.domain('control-plane').onEnvelope).toBe('function');
    expect(typeof events.agents.on).toBe('function');
    expect(typeof events.knowledge.onEnvelope).toBe('function');
  });

  test('reconnects websocket runtime connectors when the socket closes', async () => {
    type FakeOpenEvent = { readonly type: 'open' };
    type FakeCloseEvent = { readonly type: 'close' };
    type FakeMessageEvent = { readonly data: string };
    type FakeSocketEvent = FakeOpenEvent | FakeCloseEvent | FakeMessageEvent;

    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      private readonly listeners = new Map<string, Set<(event: FakeSocketEvent) => void>>();

      constructor(public readonly url: string) {
        FakeWebSocket.instances.push(this);
        const instanceNumber = FakeWebSocket.instances.length;
        setTimeout(() => {
          this.emit('open', { type: 'open' });
          if (instanceNumber === 1) {
            this.emit('close', { type: 'close' });
            return;
          }
          this.emit('message', {
            data: JSON.stringify({
              type: 'event',
              event: 'agents',
              payload: createEventEnvelope('AGENT_COMPLETED', {
                type: 'AGENT_COMPLETED',
                ok: true,
              }, {
                source: 'remote-events-test',
                sessionId: 'session-1',
              }),
            }),
          });
        }, 0);
      }

      addEventListener(type: string, listener: (event: FakeSocketEvent) => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: FakeSocketEvent) => void): void {
        this.listeners.get(type)?.delete(listener);
      }

      send(_data: string): void {}

      close(): void {}

      private emit(type: string, event: FakeSocketEvent): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }
    }

    const envelopes: unknown[] = [];
    const disconnect = await createWebSocketConnector(
      'https://goodvibes.example.com',
      'token-123',
      FakeWebSocket as unknown as typeof WebSocket,
      {
        reconnect: {
          enabled: true,
          maxAttempts: 3,
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
      },
    )('agents', (envelope) => {
      envelopes.push(envelope);
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    disconnect?.();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      type: 'AGENT_COMPLETED',
      payload: {
        type: 'AGENT_COMPLETED',
        ok: true,
      },
      source: 'remote-events-test',
      sessionId: 'session-1',
    });
  });
});
