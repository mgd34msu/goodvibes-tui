import { describe, expect, test } from 'bun:test';
import { createDeferredStartupCoordinator } from '@pellux/goodvibes-sdk/platform/runtime/deferred-startup';

describe('createDeferredStartupCoordinator', () => {
  test('runs tasks asynchronously after scheduling', async () => {
    const events: string[] = [];
    const coordinator = createDeferredStartupCoordinator();

    const task = coordinator.schedule({
      label: 'async-task',
      run: () => {
        events.push('ran');
      },
    });

    events.push('scheduled');
    expect(events).toEqual(['scheduled']);

    await task;
    expect(events).toEqual(['scheduled', 'ran']);
  });

  test('captures task errors without rejecting drain', async () => {
    const errors: string[] = [];
    const coordinator = createDeferredStartupCoordinator();

    await coordinator.schedule({
      label: 'broken-task',
      run: () => {
        throw new Error('boom');
      },
      onError: (error) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    });

    await expect(coordinator.drain()).resolves.toBeUndefined();
    expect(errors).toEqual(['boom']);
  });

  test('drain waits for all scheduled tasks', async () => {
    const events: string[] = [];
    const coordinator = createDeferredStartupCoordinator();

    coordinator.schedule({
      label: 'first',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push('first');
      },
    });
    coordinator.schedule({
      label: 'second',
      run: () => {
        events.push('second');
      },
    });

    await coordinator.drain();
    expect(events.sort()).toEqual(['first', 'second']);
  });
});
