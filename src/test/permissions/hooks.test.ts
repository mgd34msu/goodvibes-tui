import { afterEach, describe, expect, test } from 'bun:test';
import { PermissionManager } from '@pellux/goodvibes-sdk/platform/permissions';
import { createHookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks';
import { PolicyRuntimeState } from '@/runtime/index.ts';

describe('PermissionManager hook coverage', () => {
  let dispatcher = createHookDispatcher();

  afterEach(() => {
    dispatcher = createHookDispatcher();
  });

  test('fires pre and post permission hooks around approval decisions', async () => {
    const seen: string[] = [];
    dispatcher.register('Pre:permission:request', {
      match: 'Pre:permission:request',
      type: 'command',
      name: 'pre-permission-observer',
      matcher: '*',
      command: 'echo noop',
    });
    dispatcher.register('Post:permission:decision', {
      match: 'Post:permission:decision',
      type: 'command',
      name: 'post-permission-observer',
      matcher: '*',
      command: 'echo noop',
    });

    const originalFire = dispatcher.fire.bind(dispatcher);
    dispatcher.fire = async (event) => {
      seen.push(event.path);
      return originalFire(event);
    };

    const policyRuntimeState = new PolicyRuntimeState();
    const manager = new PermissionManager(async () => ({ approved: true, remember: false }), {
      isAutoApproveEnabled: () => false,
      getSnapshot: () => ({
        permissions: { mode: 'prompt', tools: {} },
      }) as never,
      getWorkingDirectory: () => '/tmp/goodvibes-hooks-test',
    }, policyRuntimeState, dispatcher);

    const result = await manager.checkDetailed('edit', { path: 'src/file.ts' });
    expect(result.approved).toBe(true);
    expect(seen).toContain('Pre:permission:request');
    expect(seen).toContain('Post:permission:decision');
  });
});
