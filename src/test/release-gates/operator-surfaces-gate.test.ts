import { beforeEach, describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { registerBuiltinPanels } from '../../panels/builtin-panels.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import { RuntimeEventBus } from '../../runtime/events/index.ts';
import { ForensicsRegistry } from '../../runtime/forensics/registry.ts';
import { getPolicyRuntimeState, resetPolicyRuntimeStateForTests } from '../../runtime/permissions/policy-runtime.ts';

describe('operator surfaces gate', () => {
  beforeEach(() => {
    resetPolicyRuntimeStateForTests();
  });

  test('built-in strategic operator panels are registered on the active runtime surface', () => {
    const manager = new PanelManager();
    registerBuiltinPanels(manager, {
      runtimeBus: new RuntimeEventBus(),
      forensicsRegistry: new ForensicsRegistry(),
      policyRuntimeState: getPolicyRuntimeState(),
    });
    const ids = manager.getRegisteredTypes().map((entry) => entry.id);

    expect(ids).toContain('policy');
    expect(ids).toContain('forensics');
    expect(ids).toContain('providers');
    expect(ids).toContain('sessions');
    expect(ids).toContain('ops');
  });

  test('command registry exposes the provider, policy, and session control surfaces', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    expect(registry.get('policy')).toBeDefined();
    expect(registry.get('provider')).toBeDefined();
    expect(registry.get('session')).toBeDefined();
  });

  test('policy command opens the policy panel when no subcommand is supplied', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const policy = registry.get('policy');
    expect(policy).toBeDefined();

    let opened = false;
    await policy!.handler([], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-operator-surfaces',
      },
      renderRequest: () => {},
      print: () => {},
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      openPolicyPanel: () => {
        opened = true;
      },
      policyRegistry: getPolicyRuntimeState().getRegistry(),
    });

    expect(opened).toBe(true);
  });
});
