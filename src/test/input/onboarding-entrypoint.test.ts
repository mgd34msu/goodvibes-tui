import { afterEach, describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerGuidanceRuntimeCommands } from '../../input/commands/guidance-runtime.ts';
import { registerLocalSetupCommands } from '../../input/commands/local-setup.ts';
import { registerOnboardingRuntimeCommands } from '../../input/commands/onboarding-runtime.ts';
import type { OpenOnboardingWizardOptions } from '../../input/handler-ui-state.ts';
import { wireShellUiOpeners } from '../../shell/ui-openers.ts';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';

afterEach(() => {
  resetTestRuntimeServices();
});

function makeContext(out: string[]): CommandContext {
  return {
    print: (text: string) => {
      out.push(text);
    },
    renderRequest: () => {},
    exit: () => {},
    session: {
      conversationManager: {} as never,
      runtime: {
        model: 'model-1',
        provider: 'openai',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: 'medium',
        sessionId: 'sess-onboarding',
      },
    },
    provider: {
      providerRegistry: {} as never,
    },
    workspace: {},
    platform: {
      config: {} as never,
      configManager: {} as never,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
    },
  } as unknown as CommandContext;
}

function makeWiredContext(out: string[]): {
  ctx: CommandContext;
  inputState: { active: boolean; mode: 'new' | 'edit' | 'reopen' | undefined; modalStack: string[] };
} {
  const runtimeServices = getTestRuntimeServices();
  const inputState = {
    active: false,
    mode: undefined as 'new' | 'edit' | 'reopen' | undefined,
    modalStack: [] as string[],
  };
  const input = {
    openOnboardingWizard: (modeOrOptions?: 'new' | 'edit' | 'reopen' | OpenOnboardingWizardOptions) => {
      inputState.active = true;
      inputState.mode = typeof modeOrOptions === 'string'
        ? modeOrOptions
        : modeOrOptions?.mode ?? 'new';
      inputState.modalStack = ['onboarding'];
    },
  } as never;

  const ctx = makeContext(out);
  wireShellUiOpeners({
    commandContext: ctx,
    input,
    panelManager: runtimeServices.panelManager,
    conversation: {
      setSplashSuppressed: () => {},
      rebuildHistory: () => {},
    } as never,
    configManager: runtimeServices.configManager,
    providerRegistry: runtimeServices.providerRegistry,
    runtime: ctx.session.runtime as never,
    featureFlags: runtimeServices.featureFlags,
    mcpRegistry: runtimeServices.mcpRegistry,
    subscriptionManager: runtimeServices.subscriptionManager,
    serviceRegistry: runtimeServices.serviceRegistry,
    memoryEmbeddingRegistry: runtimeServices.memoryEmbeddingRegistry,
    workingDirectory: '/tmp/goodvibes-tui-test-workspace',
    homeDirectory: '/tmp/goodvibes-tui-test-home',
    getConfiguredProviderIds: () => [],
    getPinned: async () => [],
    render: () => {},
    trustPromptRef: { requestTrustDecision: async () => 'restricted' as const },
  });

  return { ctx, inputState };
}

describe('onboarding entrypoints', () => {
  test('setup onboarding reaches the wizard through the shared shell opener seam', async () => {
    const registry = new CommandRegistry();
    registerLocalSetupCommands(registry);

    const out: string[] = [];
    const { ctx, inputState } = makeWiredContext(out);

    await expect(registry.execute('setup', ['onboarding'], ctx)).resolves.toBe(true);

    expect(inputState.active).toBe(true);
    expect(inputState.mode).toBe('edit');
    expect(inputState.modalStack).toEqual(['onboarding']);
    expect(out.join('\n')).toContain('Opening onboarding wizard.');
  });

  test('top-level onboarding command opens the same hydrated edit wizard path', async () => {
    const registry = new CommandRegistry();
    registerOnboardingRuntimeCommands(registry);

    const out: string[] = [];
    const { ctx, inputState } = makeWiredContext(out);

    await expect(registry.execute('onboarding', [], ctx)).resolves.toBe(true);

    expect(inputState.active).toBe(true);
    expect(inputState.mode).toBe('edit');
    expect(inputState.modalStack).toEqual(['onboarding']);
    expect(out.join('\n')).toContain('Opening onboarding wizard.');
  });

  test('setup onboarding fails loudly when the shell opener was not wired at bootstrap', async () => {
    const registry = new CommandRegistry();
    registerLocalSetupCommands(registry);

    await expect(registry.execute('setup', ['onboarding'], makeContext([]))).rejects.toThrow(
      'commandContext.openOnboardingWizard is required but was not wired at bootstrap',
    );
  });

  test('welcome print points users at the onboarding wizard path', () => {
    const registry = new CommandRegistry();
    registerGuidanceRuntimeCommands(registry);

    const out: string[] = [];
    registry.get('welcome')!.handler(['print'], makeContext(out));

    expect(out.join('\n')).toContain('/onboarding');
    expect(out.join('\n')).toContain('open the onboarding wizard');
    expect(out.join('\n')).not.toContain('first-run checklist');
  });
});
