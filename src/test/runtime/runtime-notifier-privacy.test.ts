/**
 * The Slack and Discord notifier the TUI attaches to its runtime bus names the
 * agent's or workstream's task, and follows behavior.notificationsMetadataOnly
 * (default off), read at send time so a settings change applies without a
 * restart (owner rulings 2026-09-29).
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { SlackIntegration } from '@pellux/goodvibes-sdk/platform/integrations';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeNotifier } from '../../runtime/bootstrap-notifier-sync.ts';

const ctx = { sessionId: 's1', traceId: 't', source: 'test' };

describe('the TUI Slack/Discord notifier', () => {
  let spy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => { spy?.mockRestore(); spy = null; });

  test('names the work while the privacy setting is off, and drops it the moment it is turned on', async () => {
    const sent: string[] = [];
    spy = spyOn(SlackIntegration.prototype, 'postWebhook').mockImplementation(async (text: string) => { sent.push(text); });
    const settings: Record<string, unknown> = {};
    const registry = { resolveSecret: async (service: string, key: string) => (service === 'slack' && key === 'webhookUrl' ? 'https://hooks.slack.example/x' : null) };
    const notifier = await createRuntimeNotifier(registry as never, (key) => settings[key]);
    const bus = new RuntimeEventBus();
    notifier.attachToRuntimeBus(bus);
    try {
      bus.emit('workflows', { type: 'WORKFLOW_CHAIN_CREATED', payload: { type: 'WORKFLOW_CHAIN_CREATED', chainId: 'c1', task: 'Rewrite the retry backoff' }, ...ctx } as never);
      bus.emit('workflows', { type: 'WORKFLOW_CHAIN_FAILED', payload: { type: 'WORKFLOW_CHAIN_FAILED', chainId: 'c1', reason: 'review score 4/10' }, ...ctx } as never);
      await new Promise((resolve) => setTimeout(resolve, 10));
      settings['behavior.notificationsMetadataOnly'] = true;
      bus.emit('workflows', { type: 'WORKFLOW_CHAIN_CREATED', payload: { type: 'WORKFLOW_CHAIN_CREATED', chainId: 'c2', task: 'Split the parser module' }, ...ctx } as never);
      bus.emit('workflows', { type: 'WORKFLOW_CHAIN_FAILED', payload: { type: 'WORKFLOW_CHAIN_FAILED', chainId: 'c2', reason: 'private reason' }, ...ctx } as never);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      notifier.detach();
      notifier.dispose();
    }
    expect(sent).toEqual([
      'Workstream could not be finished: Rewrite the retry backoff\nreview score 4/10',
      'A workstream could not be finished.',
    ]);
  });
});
