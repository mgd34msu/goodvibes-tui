import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config/schema';
import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers/registry';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';

const TTS_CONFIG_KEYS = new Set(['provider', 'voice', 'llm-provider', 'llm-model']);

export function registerTtsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'tts',
    description: 'Submit a normal prompt and play the assistant response through live TTS',
    usage: '<prompt>|stop',
    handler(args, ctx) {
      const first = (args[0] ?? '').toLowerCase();
      if (first === 'stop' || first === 'cancel') {
        ctx.stopSpokenOutput?.();
        ctx.print('Live TTS playback stopped.');
        return;
      }

      const prompt = args.join(' ').trim();
      if (!prompt) {
        ctx.print('Usage: /tts <prompt> or /tts stop');
        return;
      }
      if (!ctx.submitSpokenInput) {
        ctx.print('Live TTS is not available in this runtime.');
        return;
      }
      ctx.submitSpokenInput(prompt);
    },
  });

  registry.register({
    name: 'config-tts',
    aliases: ['tts-config'],
    description: 'Configure live TTS provider, voice, and optional spoken-turn LLM overrides',
    usage: '[show|providers|voices [provider]|provider <id|clear>|voice <id|clear>|llm|llm clear|llm-provider <id|clear>|llm-model <id|clear>]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'show').toLowerCase();
      if (sub === 'show') {
        if (args.length === 0 && openTtsConfigModal(ctx)) return;
        ctx.print(formatTtsConfig(ctx));
        return;
      }
      if (sub === 'providers') {
        if (openTtsProviderPicker(ctx)) return;
        printTtsProviders(ctx);
        return;
      }
      if (sub === 'voices') {
        if (await openTtsVoicePicker(ctx, args[1])) return;
        await printTtsVoices(ctx, args[1]);
        return;
      }
      if (sub === 'llm' || sub === 'model') {
        const action = (args[1] ?? '').toLowerCase();
        if (action === 'clear' || action === 'default') {
          setTtsConfigValue(ctx, 'tts.llmProvider', '');
          setTtsConfigValue(ctx, 'tts.llmModel', '');
          ctx.print('TTS LLM override cleared. /tts will use the current chat model.');
          return;
        }
        if (openTtsLlmPicker(ctx)) return;
        ctx.print('TTS LLM picker is not available in this runtime. Use /config-tts llm-provider <id> and /config-tts llm-model <model>.');
        return;
      }
      if (TTS_CONFIG_KEYS.has(sub)) {
        const value = args.slice(1).join(' ').trim();
        if (!value) {
          if ((sub === 'llm-provider' || sub === 'llm-model') && openTtsLlmPicker(ctx)) return;
          ctx.print(`Usage: /config-tts ${sub} <value|clear>`);
          return;
        }
        const key = ttsConfigKeyForSubcommand(sub);
        const nextValue = value.toLowerCase() === 'clear' ? '' : value;
        const previousProvider = key === 'tts.provider'
          ? String(ctx.platform.configManager.get('tts.provider') ?? '').trim()
          : '';
        if (key === 'tts.llmProvider') {
          setTtsLlmProvider(ctx, nextValue);
          return;
        }
        if (key === 'tts.llmModel') {
          setTtsLlmModel(ctx, nextValue);
          return;
        }
        setTtsConfigValue(ctx, key, nextValue);
        if (key === 'tts.provider' && previousProvider && previousProvider !== nextValue) {
          setTtsConfigValue(ctx, 'tts.voice', '');
        }
        ctx.print(`${key} ${nextValue ? `set to ${nextValue}` : 'cleared'}.`);
        return;
      }
      ctx.print('Usage: /config-tts [show|providers|voices [provider]|provider <id|clear>|voice <id|clear>|llm|llm clear|llm-provider <id|clear>|llm-model <id|clear>]');
    },
  });
}

function ttsConfigKeyForSubcommand(subcommand: string): ConfigKey {
  switch (subcommand) {
    case 'provider': return 'tts.provider';
    case 'voice': return 'tts.voice';
    case 'llm-provider': return 'tts.llmProvider';
    case 'llm-model': return 'tts.llmModel';
    default: throw new Error(`Unknown TTS config key: ${subcommand}`);
  }
}

function formatTtsConfig(ctx: CommandContext): string {
  const cm = ctx.platform.configManager;
  const llmProvider = String(cm.get('tts.llmProvider') ?? '').trim();
  const llmModel = String(cm.get('tts.llmModel') ?? '').trim();
  return [
    'TTS Configuration',
    `  provider: ${formatValue(cm.get('tts.provider'))}`,
    `  voice: ${formatValue(cm.get('tts.voice'))}`,
    `  spoken-turn llm provider override: ${llmProvider || '(current chat provider)'}`,
    `  spoken-turn llm model override: ${llmModel || '(current chat model)'}`,
    '  playback: live streaming through local mpv or ffplay',
    '  commands: /tts <prompt>, /tts stop, /config-tts, /config-tts providers, /config-tts voices [provider], /config-tts llm',
  ].join('\n');
}

function openTtsConfigModal(ctx: CommandContext): boolean {
  if (!ctx.openSelection) return false;
  const cm = ctx.platform.configManager;
  const provider = String(cm.get('tts.provider') ?? '').trim() || '(default)';
  const voice = String(cm.get('tts.voice') ?? '').trim() || '(provider default)';
  const llmProvider = String(cm.get('tts.llmProvider') ?? '').trim();
  const llmModel = String(cm.get('tts.llmModel') ?? '').trim();
  const llmProviderLabel = llmProvider || '(current chat provider)';
  const llmModelLabel = llmModel || '(current chat model)';
  const items: SelectionItem[] = [
    {
      id: 'provider',
      label: 'TTS provider',
      detail: provider,
      category: 'speech output',
      primaryAction: 'select',
      actions: '[Enter] choose',
    },
    {
      id: 'voice',
      label: 'TTS voice',
      detail: voice,
      category: 'speech output',
      primaryAction: 'select',
      actions: '[Enter] choose',
    },
    {
      id: 'llm-provider',
      label: 'TTS LLM provider',
      detail: llmProviderLabel,
      category: 'response generation',
      primaryAction: 'select',
      actions: '[Enter] choose provider and model',
    },
    {
      id: 'llm-model',
      label: 'TTS LLM model',
      detail: llmModelLabel,
      category: 'response generation',
      primaryAction: 'select',
      actions: '[Enter] choose provider and model',
    },
    {
      id: 'clear-voice',
      label: 'Use provider default voice',
      detail: 'clears tts.voice',
      category: 'clear values',
      primaryAction: 'select',
    },
    {
      id: 'clear-llm',
      label: 'Use current chat model for /tts',
      detail: 'clears tts.llmProvider and tts.llmModel',
      category: 'clear values',
      primaryAction: 'select',
    },
  ];

  ctx.openSelection('TTS Configuration', items, { allowSearch: true }, (result) => {
    if (!result) return;
    if (result.item.id === 'provider') {
      openTtsProviderPicker(ctx);
      return;
    }
    if (result.item.id === 'voice') {
      void openTtsVoicePicker(ctx);
      return;
    }
    if (result.item.id === 'llm-provider') {
      openTtsLlmPicker(ctx);
      return;
    }
    if (result.item.id === 'llm-model') {
      openTtsLlmPicker(ctx);
      return;
    }
    if (result.item.id === 'clear-voice') {
      setTtsConfigValue(ctx, 'tts.voice', '');
      ctx.print('TTS voice cleared. The provider default voice will be used.');
      return;
    }
    if (result.item.id === 'clear-llm') {
      setTtsConfigValue(ctx, 'tts.llmProvider', '');
      setTtsConfigValue(ctx, 'tts.llmModel', '');
      ctx.print('TTS LLM override cleared. /tts will use the current chat model.');
    }
  });
  return true;
}

function openTtsLlmPicker(ctx: CommandContext): boolean {
  if (ctx.openProviderModelPickerWithTarget?.('tts')) return true;
  return ctx.openModelPickerWithTarget?.('tts') ?? false;
}

function getStreamingTtsProviders(ctx: CommandContext): Array<{ id: string; label: string; capabilities: readonly string[] }> {
  const registry = ctx.platform.voiceProviderRegistry;
  if (!registry) {
    return [];
  }
  return registry.list().filter((provider) => provider.capabilities.includes('tts-stream'));
}

function openTtsProviderPicker(ctx: CommandContext): boolean {
  if (!ctx.openSelection) return false;
  const registry = ctx.platform.voiceProviderRegistry;
  if (!registry) {
    ctx.print('Voice provider registry is not available in this runtime.');
    return true;
  }
  const providers = getStreamingTtsProviders(ctx);
  if (providers.length === 0) {
    ctx.print('No streaming TTS providers are registered.');
    return true;
  }
  const current = String(ctx.platform.configManager.get('tts.provider') ?? '').trim();
  const items: SelectionItem[] = providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    detail: provider.id === current ? `${provider.id}  (current)` : provider.id,
    category: 'streaming TTS providers',
    primaryAction: 'select',
    actions: '[Enter] set provider',
  }));
  ctx.openSelection('Choose TTS Provider', items, { preSelectId: current, allowSearch: true }, (result) => {
    if (!result) return;
    const previous = String(ctx.platform.configManager.get('tts.provider') ?? '').trim();
    setTtsConfigValue(ctx, 'tts.provider', result.item.id);
    if (previous && previous !== result.item.id) {
      setTtsConfigValue(ctx, 'tts.voice', '');
      ctx.print(`TTS provider set to ${result.item.id}. TTS voice was cleared because voices are provider-specific.`);
    } else {
      ctx.print(`TTS provider set to ${result.item.id}.`);
    }
  });
  return true;
}

function printTtsProviders(ctx: CommandContext): void {
  const registry = ctx.platform.voiceProviderRegistry;
  if (!registry) {
    ctx.print('Voice provider registry is not available in this runtime.');
    return;
  }
  const providers = getStreamingTtsProviders(ctx);
  if (providers.length === 0) {
    ctx.print('No streaming TTS providers are registered.');
    return;
  }
  ctx.print([
    'Streaming TTS Providers',
    ...providers.map((provider) => `  ${provider.id}: ${provider.label}`),
    '',
    'Set provider: /config-tts provider <provider-id>',
  ].join('\n'));
}

function getSelectableLlmModels(ctx: CommandContext): ModelDefinition[] {
  const registry = ctx.provider.providerRegistry as Partial<Pick<typeof ctx.provider.providerRegistry, 'getSelectableModels' | 'listModels'>>;
  if (typeof registry.getSelectableModels === 'function') return registry.getSelectableModels();
  if (typeof registry.listModels === 'function') return registry.listModels().filter((model) => model.selectable !== false);
  return [];
}

function setTtsLlmProvider(ctx: CommandContext, nextValue: string): void {
  if (!nextValue) {
    setTtsConfigValue(ctx, 'tts.llmProvider', '');
    setTtsConfigValue(ctx, 'tts.llmModel', '');
    ctx.print('TTS LLM override cleared. /tts will use the current chat model.');
    return;
  }
  const previousProvider = String(ctx.platform.configManager.get('tts.llmProvider') ?? '').trim();
  setTtsConfigValue(ctx, 'tts.llmProvider', nextValue);
  if (previousProvider && previousProvider !== nextValue) {
    setTtsConfigValue(ctx, 'tts.llmModel', '');
    ctx.print(`TTS LLM provider set to ${nextValue}. TTS LLM model was cleared because models are provider-specific.`);
    return;
  }
  ctx.print(`TTS LLM provider set to ${nextValue}.`);
}

function setTtsLlmModel(ctx: CommandContext, nextValue: string): void {
  if (!nextValue) {
    setTtsConfigValue(ctx, 'tts.llmModel', '');
    ctx.print('TTS LLM model override cleared. /tts will use the current chat model unless a model is selected.');
    return;
  }
  const preferredProvider = String(ctx.platform.configManager.get('tts.llmProvider') ?? '').trim() || undefined;
  const selected = findSelectableLlmModel(ctx, nextValue, preferredProvider);
  if (selected) {
    setTtsConfigValue(ctx, 'tts.llmProvider', selected.provider);
    setTtsConfigValue(ctx, 'tts.llmModel', getModelRegistryKey(selected));
    ctx.print(`TTS LLM set to ${selected.displayName} (${selected.provider}).`);
    return;
  }
  setTtsConfigValue(ctx, 'tts.llmModel', nextValue);
  ctx.print(`tts.llmModel set to ${nextValue}.`);
}

function findSelectableLlmModel(ctx: CommandContext, ref: string, preferredProvider?: string): ModelDefinition | undefined {
  const matches = getSelectableLlmModels(ctx).filter((model) =>
    model.registryKey === ref || model.id === ref || model.displayName === ref,
  );
  if (preferredProvider) {
    const providerMatch = matches.find((model) => model.provider === preferredProvider);
    if (providerMatch) return providerMatch;
  }
  return matches[0];
}

function getModelRegistryKey(model: ModelDefinition): string {
  return model.registryKey ?? `${model.provider}:${model.id}`;
}

async function openTtsVoicePicker(ctx: CommandContext, providerArg?: string): Promise<boolean> {
  if (!ctx.openSelection) return false;
  const service = ctx.platform.voiceService;
  if (!service) {
    ctx.print('Voice service is not available in this runtime.');
    return true;
  }
  const providerId = (providerArg ?? String(ctx.platform.configManager.get('tts.provider') ?? '')).trim() || undefined;
  try {
    const voices = await service.listVoices(providerId);
    if (voices.length === 0) {
      ctx.print(providerId ? `No voices returned for ${providerId}.` : 'No TTS voices returned.');
      return true;
    }
    const current = String(ctx.platform.configManager.get('tts.voice') ?? '').trim();
    const items: SelectionItem[] = [
      {
        id: '__default__',
        label: 'Use provider default voice',
        detail: current ? 'clears tts.voice' : '(current)',
        category: 'voice',
        primaryAction: 'select',
      },
      ...voices.map((voice) => ({
        id: voice.id,
        label: voice.label || voice.id,
        detail: voice.id === current ? `${voice.id}  (current)` : voice.id,
        category: providerId ?? 'voices',
        primaryAction: 'select' as const,
        actions: '[Enter] set voice',
      })),
    ];
    ctx.openSelection(`Choose TTS Voice${providerId ? ` (${providerId})` : ''}`, items, { preSelectId: current || '__default__', allowSearch: true }, (result) => {
      if (!result) return;
      const nextVoice = result.item.id === '__default__' ? '' : result.item.id;
      setTtsConfigValue(ctx, 'tts.voice', nextVoice);
      ctx.print(nextVoice ? `TTS voice set to ${nextVoice}.` : 'TTS voice cleared. The provider default voice will be used.');
    });
    return true;
  } catch (error) {
    ctx.print(`Unable to list TTS voices: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}

async function printTtsVoices(ctx: CommandContext, providerArg?: string): Promise<void> {
  const service = ctx.platform.voiceService;
  if (!service) {
    ctx.print('Voice service is not available in this runtime.');
    return;
  }
  const providerId = (providerArg ?? String(ctx.platform.configManager.get('tts.provider') ?? '')).trim() || undefined;
  try {
    const voices = await service.listVoices(providerId);
    if (voices.length === 0) {
      ctx.print(providerId ? `No voices returned for ${providerId}.` : 'No TTS voices returned.');
      return;
    }
    ctx.print([
      `TTS Voices${providerId ? ` (${providerId})` : ''}`,
      ...voices.slice(0, 60).map((voice) => `  ${voice.id}: ${voice.label}`),
      ...(voices.length > 60 ? [`  ... ${voices.length - 60} more`] : []),
      '',
      'Set voice: /config-tts voice <voice-id>',
      'Use provider default voice: /config-tts voice clear',
    ].join('\n'));
  } catch (error) {
    ctx.print(`Unable to list TTS voices: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function setTtsConfigValue(ctx: CommandContext, key: ConfigKey, value: string): void {
  ctx.platform.configManager.setDynamic(key, value);
}

function formatValue(value: unknown): string {
  const text = String(value ?? '').trim();
  return text || '(default)';
}
