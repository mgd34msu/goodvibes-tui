import { describe, expect, test } from 'bun:test';
import { ChannelPluginRegistry } from '../../channels/index.ts';

describe('ChannelPluginRegistry', () => {
  test('aggregates capabilities, tools, and actions across registered plugins', async () => {
    const registry = new ChannelPluginRegistry();
    registry.register({
      id: 'surface:slack',
      surface: 'slack',
      displayName: 'Slack',
      capabilities: ['ingress', 'egress'],
      listCapabilities: () => [{
        id: 'slack-cap',
        surface: 'slack',
        label: 'Slack ingress',
        scope: 'surface',
        supported: true,
        detail: 'Slack ingress supported',
        metadata: {},
      }],
      listTools: () => [{
        id: 'slack:directory',
        surface: 'slack',
        name: 'slack_directory',
        description: 'Slack directory lookup',
        actionIds: ['list-directory'],
        metadata: {},
      }],
      listOperatorActions: () => [{
        id: 'list-directory',
        surface: 'slack',
        label: 'List directory',
        description: 'List directory',
        dangerous: false,
        metadata: {},
      }],
    });
    registry.register({
      id: 'surface:webhook',
      surface: 'webhook',
      displayName: 'Webhook',
      capabilities: ['ingress'],
      listCapabilities: () => [{
        id: 'webhook-cap',
        surface: 'webhook',
        label: 'Webhook ingress',
        scope: 'surface',
        supported: true,
        detail: 'Webhook ingress supported',
        metadata: {},
      }],
      listTools: () => [{
        id: 'webhook:inspect',
        surface: 'webhook',
        name: 'webhook_inspect',
        description: 'Webhook inspect',
        actionIds: ['inspect'],
        metadata: {},
      }],
      listOperatorActions: () => [{
        id: 'inspect',
        surface: 'webhook',
        label: 'Inspect',
        description: 'Inspect webhook',
        dangerous: false,
        metadata: {},
      }],
    });

    const capabilities = await registry.listCapabilities();
    expect(capabilities.map((entry) => entry.id)).toEqual(['slack-cap', 'webhook-cap']);

    const tools = await registry.listTools();
    expect(tools.map((entry) => entry.id)).toEqual(['slack:directory', 'webhook:inspect']);

    const actions = await registry.listOperatorActions();
    expect(actions.map((entry) => entry.id)).toEqual(['list-directory', 'inspect']);
  });

  test('dispatches channel-owned tool and operator action execution', async () => {
    const registry = new ChannelPluginRegistry();
    registry.register({
      id: 'surface:web',
      surface: 'web',
      displayName: 'Web',
      capabilities: ['ingress'],
      runTool: async (toolId, input) => ({ kind: 'tool', toolId, input }),
      runOperatorAction: async (actionId, input) => ({ kind: 'action', actionId, input }),
    });

    const toolResult = await registry.runTool('web', 'web:inspect', { verbose: true });
    expect(toolResult).toEqual({ kind: 'tool', toolId: 'web:inspect', input: { verbose: true } });

    const actionResult = await registry.runOperatorAction('web', 'inspect-status', { verbose: false });
    expect(actionResult).toEqual({ kind: 'action', actionId: 'inspect-status', input: { verbose: false } });

    await expect(registry.runTool('slack', 'slack:inspect')).resolves.toBeNull();
    await expect(registry.runOperatorAction('slack', 'inspect-status')).resolves.toBeNull();
  });

  test('dispatches lifecycle, target, authorization, and direct agent tool hooks', async () => {
    const registry = new ChannelPluginRegistry();
    registry.register({
      id: 'surface:webhook',
      surface: 'webhook',
      displayName: 'Webhook',
      capabilities: ['ingress', 'account_lifecycle', 'target_resolution', 'agent_tools'],
      listAccounts: async () => [{
        id: 'acct-1',
        surface: 'webhook',
        label: 'Webhook Account',
        enabled: true,
        configured: true,
        linked: true,
        state: 'healthy',
        authState: 'linked',
        accountId: 'acct-1',
        secrets: [],
        actions: [{ id: 'inspect', label: 'Inspect', kind: 'inspect', available: true }],
        metadata: {},
      }],
      runAccountAction: async (action, accountId) => ({
        surface: 'webhook',
        accountId,
        action,
        ok: true,
        message: 'ran',
        metadata: {},
      }),
      resolveTarget: async (options) => ({
        surface: 'webhook',
        input: options.input,
        normalized: options.input.toLowerCase(),
        kind: 'service',
        to: options.input,
        sessionTarget: `channel:webhook:${options.input.toLowerCase()}`,
        source: 'synthetic',
        metadata: {},
      }),
      authorizeActorAction: async (request) => ({
        allowed: request.actionId === 'inspect',
        reason: 'checked',
        actionAvailable: true,
        metadata: {},
      }),
      listAgentTools: () => [{
        definition: {
          name: 'webhook_direct',
          description: 'Direct webhook tool',
          parameters: { type: 'object' },
        },
        execute: async () => ({ success: true, output: 'ok' }),
      }],
    });

    await expect(registry.runAccountAction('webhook', 'retest', 'acct-1')).resolves.toMatchObject({
      action: 'retest',
      ok: true,
    });
    await expect(registry.resolveTarget('webhook', { input: 'ops' })).resolves.toMatchObject({
      to: 'ops',
      source: 'synthetic',
    });
    await expect(registry.authorizeActorAction('webhook', { actionId: 'inspect' })).resolves.toMatchObject({
      allowed: true,
    });
    expect(registry.listAgentTools('webhook').map((tool) => tool.definition.name)).toEqual(['webhook_direct']);
  });
});
