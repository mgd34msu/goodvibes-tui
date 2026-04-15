import { afterEach, describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { providerCommand } from '../../input/commands/provider.ts';
import { createRuntimeProviderApi } from '@pellux/goodvibes-sdk/platform/runtime/runtime-provider-api';
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
});
