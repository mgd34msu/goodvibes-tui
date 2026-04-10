import { describe, expect, test } from 'bun:test';
import { ChannelPluginRegistry } from '../../channels/index.ts';
import { channelTool } from '../../tools/channel/index.ts';

describe('channel tool', () => {
  test('lists channel capabilities and accounts from the active registry', async () => {
    const registry = new ChannelPluginRegistry();
    registry.register({
      id: 'surface:test',
      surface: 'webhook',
      displayName: 'Test Surface',
      capabilities: ['ingress', 'egress'],
      listAccounts: async () => [{
        id: 'acct-1',
        surface: 'webhook',
        label: 'Test Account',
        enabled: true,
        configured: true,
        linked: true,
        state: 'healthy',
        authState: 'linked',
        accountId: 'acct-1',
        secrets: [],
        actions: [],
        metadata: {},
      }],
      listCapabilities: async () => [{
        id: 'cap-1',
        surface: 'webhook',
        label: 'Inbound',
        scope: 'surface',
        supported: true,
        detail: 'Accepts inbound events',
        metadata: {},
      }],
      listOperatorActions: async () => [{
        id: 'inspect',
        surface: 'webhook',
        label: 'Inspect',
        description: 'Inspect the channel',
        dangerous: false,
        metadata: {},
      }],
      listTools: async () => [{
        id: 'webhook:inspect',
        surface: 'webhook',
        name: 'webhook_inspect',
        description: 'Inspect webhook state',
        actionIds: ['inspect'],
        metadata: {},
      }],
      runTool: async (toolId) => ({ toolId, ok: true }),
      runOperatorAction: async (actionId) => ({ actionId, ok: true }),
      runAccountAction: async (action, accountId) => ({
        surface: 'webhook',
        accountId,
        action,
        ok: true,
        metadata: {},
      }),
      resolveTarget: async (options) => ({
        surface: 'webhook',
        input: options.input,
        normalized: options.input.toLowerCase(),
        kind: 'service',
        to: options.input,
        source: 'synthetic',
        sessionTarget: `channel:webhook:${options.input.toLowerCase()}`,
        metadata: {},
      }),
      authorizeActorAction: async () => ({
        allowed: true,
        reason: 'allowed',
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

    const accounts = await channelTool.execute({ mode: 'accounts' });
    expect(accounts.success).toBe(true);
    expect(accounts.output).toContain('acct-1');

    const capabilities = await channelTool.execute({ mode: 'capabilities', surface: 'webhook' });
    expect(capabilities.success).toBe(true);
    expect(capabilities.output).toContain('Inbound');

    const actions = await channelTool.execute({ mode: 'actions', surface: 'webhook' });
    expect(actions.success).toBe(true);
    expect(actions.output).toContain('Inspect');

    const tools = await channelTool.execute({ mode: 'tools', surface: 'webhook' });
    expect(tools.success).toBe(true);
    expect(tools.output).toContain('webhook_inspect');

    const toolInvoke = await channelTool.execute({ mode: 'run_tool', surface: 'webhook', toolId: 'webhook:inspect' });
    expect(toolInvoke.success).toBe(true);
    expect(toolInvoke.output).toContain('"toolId": "webhook:inspect"');

    const invoke = await channelTool.execute({ mode: 'run_action', surface: 'webhook', actionId: 'inspect' });
    expect(invoke.success).toBe(true);
    expect(invoke.output).toContain('"ok": true');

    const accountAction = await channelTool.execute({ mode: 'account_action', surface: 'webhook', accountAction: 'retest', accountId: 'acct-1' });
    expect(accountAction.success).toBe(true);
    expect(accountAction.output).toContain('"action": "retest"');

    const target = await channelTool.execute({ mode: 'resolve_target', surface: 'webhook', target: 'https://example.com/hook' });
    expect(target.success).toBe(true);
    expect(target.output).toContain('"sessionTarget": "channel:webhook:https://example.com/hook"');

    const agentTools = await channelTool.execute({ mode: 'agent_tools', surface: 'webhook' });
    expect(agentTools.success).toBe(true);
    expect(agentTools.output).toContain('webhook_direct');

    const authorize = await channelTool.execute({ mode: 'authorize', surface: 'webhook', actionId: 'inspect' });
    expect(authorize.success).toBe(true);
    expect(authorize.output).toContain('"allowed": true');
  });

  test('returns a useful error when the active registry is missing or the request is invalid', async () => {
    const registry = new ChannelPluginRegistry();
    registry.register({
      id: 'surface:test-2',
      surface: 'slack',
      displayName: 'Slack Test',
      capabilities: ['ingress'],
    });

    const missingSurface = await channelTool.execute({ mode: 'directory' });
    expect(missingSurface.success).toBe(false);
    expect(missingSurface.error).toContain('requires "surface"');
  });
});
