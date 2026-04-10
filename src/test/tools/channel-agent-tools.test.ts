import { describe, expect, test } from 'bun:test';
import { ChannelPluginRegistry } from '../../channels/index.ts';
import { registerChannelAgentTools } from '../../tools/channel/agent-tools.ts';
import { ToolRegistry } from '../../tools/registry.ts';

describe('channel agent tools', () => {
  test('registers direct plugin-owned tools and skips duplicate names', () => {
    const channelRegistry = new ChannelPluginRegistry();
    channelRegistry.register({
      id: 'surface:webhook',
      surface: 'webhook',
      displayName: 'Webhook',
      capabilities: ['agent_tools'],
      listAgentTools: () => [
        {
          definition: {
            name: 'webhook_direct',
            description: 'Direct webhook tool',
            parameters: { type: 'object' },
          },
          execute: async () => ({ success: true, output: 'ok' }),
        },
        {
          definition: {
            name: 'channel',
            description: 'Duplicate channel tool',
            parameters: { type: 'object' },
          },
          execute: async () => ({ success: true, output: 'duplicate' }),
        },
      ],
    });

    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: 'channel',
        description: 'Existing channel tool',
        parameters: { type: 'object' },
      },
      execute: async () => ({ success: true, output: 'existing' }),
    });

    expect(registerChannelAgentTools(registry, channelRegistry)).toBe(1);
    expect(registry.has('webhook_direct')).toBe(true);
    expect(registry.list().map((tool) => tool.definition.name).sort()).toEqual(['channel', 'webhook_direct']);
  });
});
