import { describe, expect, test } from 'bun:test';
import { createRemoteUiRuntimeEvents } from '../../runtime/transports/shared.ts';

describe('transport shared helpers', () => {
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
});
