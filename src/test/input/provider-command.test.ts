import { afterEach, describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { providerCommand } from '../../input/commands/provider.ts';
import { isFeatureFlagEnabled } from '../../runtime/surface-feature-flags.ts';
import { createRuntimeProviderApi } from '@/runtime/index.ts';
import {
  getTestRuntimeServices,
  resetTestRuntimeServices,
} from '../helpers/runtime-services.ts';

function createProviderCommandContext(output: string[]): CommandContext {
  const runtimeServices = getTestRuntimeServices();
  runtimeServices.providerRegistry.initModelLimits();
  runtimeServices.providerRegistry.initCatalog();
  return {
    session: {
      conversationManager: {} as never,
      runtime: {
        model: runtimeServices.providerRegistry.getCurrentModel().registryKey,
        provider: runtimeServices.providerRegistry.getCurrentModel().provider,
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-provider-command',
      },
    },
    provider: {
      providerRegistry: runtimeServices.providerRegistry,
      providerOptimizer: runtimeServices.providerOptimizer,
      favoritesStore: runtimeServices.favoritesStore,
      benchmarkStore: runtimeServices.benchmarkStore,
    },
    workspace: {},
    platform: {
      config: runtimeServices.configManager.getAll(),
      configManager: runtimeServices.configManager,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
    },
    clients: {
      providerApi: createRuntimeProviderApi(runtimeServices),
    },
    renderRequest: () => {},
    print: (text: string) => {
      output.push(text);
    },
    exit: () => {},
  };
}

describe('/provider-opt', () => {
  afterEach(() => {
    resetTestRuntimeServices();
  });

  test('explains the current route through the provider api surface', async () => {
    const output: string[] = [];
    const context = createProviderCommandContext(output);
    const currentModel = await context.clients!.providerApi!.getCurrentModel();

    await providerCommand.handler(['explain-route'], context);

    expect(output.join('\n')).toContain(
      `Route explanation for current model: ${currentModel.providerId}/${currentModel.modelId}`,
    );
    expect(output.join('\n')).toContain('Optimizer:');
  });

  test('pins using provider api model records rather than raw registry enumeration', async () => {
    const output: string[] = [];
    const context = createProviderCommandContext(output);
    const target = await context.clients!.providerApi!.getCurrentModel();

    await providerCommand.handler(['pin', target!.registryKey], context);

    expect(output.join('\n')).toContain(`Pinned → ${target!.providerId}/${target!.modelId}`);
    expect(context.provider.providerOptimizer?.pinnedTarget).toEqual({
      providerId: target!.providerId,
      modelId: target!.modelId,
    });
  });

  test('optimizer on enables the optimizer and persists to config', async () => {
    const output: string[] = [];
    const context = createProviderCommandContext(output);
    const runtimeServices = getTestRuntimeServices();

    // Optimizer starts disabled (no feature flag set)
    expect(context.provider.providerOptimizer?.enabled).toBe(false);

    await providerCommand.handler(['optimizer', 'on'], context);

    expect(context.provider.providerOptimizer?.enabled).toBe(true);
    expect(output.join('\n')).toContain('Optimizer enabled');
    expect(output.join('\n')).toContain('Intelligent failover is now active');
    // Config persisted so restart picks it up
    expect(isFeatureFlagEnabled(runtimeServices.configManager, 'provider-optimizer')).toBe(true);
  });

  test('optimizer off disables the optimizer and persists to config', async () => {
    const output: string[] = [];
    const context = createProviderCommandContext(output);
    const runtimeServices = getTestRuntimeServices();

    // Enable first so we can test the off path
    await providerCommand.handler(['optimizer', 'on'], context);
    output.length = 0;

    await providerCommand.handler(['optimizer', 'off'], context);

    expect(context.provider.providerOptimizer?.enabled).toBe(false);
    expect(output.join('\n')).toContain('Optimizer disabled');
    expect(output.join('\n')).toContain('manual-only mode');
    expect(isFeatureFlagEnabled(runtimeServices.configManager, 'provider-optimizer')).toBe(false);
  });

  test('optimizer on when already enabled reports no-change', async () => {
    const output: string[] = [];
    const context = createProviderCommandContext(output);

    // Enable once
    await providerCommand.handler(['optimizer', 'on'], context);
    output.length = 0;

    // Enable again
    await providerCommand.handler(['optimizer', 'on'], context);

    expect(output.join('\n')).toContain('already enabled');
    expect(context.provider.providerOptimizer?.enabled).toBe(true);
  });

  test('optimizer with invalid subcommand shows usage', async () => {
    const output: string[] = [];
    const context = createProviderCommandContext(output);

    await providerCommand.handler(['optimizer', 'maybe'], context);

    expect(output.join('\n')).toContain('Usage: /provider optimizer on|off');
  });

  test('route auto when optimizer is off records mode and explains it is off', async () => {
    const output: string[] = [];
    const context = createProviderCommandContext(output);

    // optimizer starts disabled
    await providerCommand.handler(['route', 'auto'], context);

    const joined = output.join('\n');
    // Mode is recorded
    expect(context.provider.providerOptimizer?.mode).toBe('auto');
    // Honest UX: explains the optimizer is off
    expect(joined).toContain('Optimizer is off');
    expect(joined).toContain('/provider optimizer on');
  });
});
