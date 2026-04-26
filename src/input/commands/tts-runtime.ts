import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config/schema';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

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
    usage: '[show|providers|voices [provider]|provider <id|clear>|voice <id|clear>|llm-provider <id|clear>|llm-model <id|clear>]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'show').toLowerCase();
      if (sub === 'show') {
        ctx.print(formatTtsConfig(ctx));
        return;
      }
      if (sub === 'providers') {
        await printTtsProviders(ctx);
        return;
      }
      if (sub === 'voices') {
        await printTtsVoices(ctx, args[1]);
        return;
      }
      if (TTS_CONFIG_KEYS.has(sub)) {
        const value = args.slice(1).join(' ').trim();
        if (!value) {
          ctx.print(`Usage: /config-tts ${sub} <value|clear>`);
          return;
        }
        const key = ttsConfigKeyForSubcommand(sub);
        const nextValue = value.toLowerCase() === 'clear' ? '' : value;
        ctx.platform.configManager.setDynamic(key, nextValue);
        ctx.print(`${key} ${nextValue ? `set to ${nextValue}` : 'cleared'}.`);
        return;
      }
      ctx.print('Usage: /config-tts [show|providers|voices [provider]|provider <id|clear>|voice <id|clear>|llm-provider <id|clear>|llm-model <id|clear>]');
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
    '  commands: /tts <prompt>, /tts stop, /config-tts providers, /config-tts voices [provider]',
  ].join('\n');
}

async function printTtsProviders(ctx: CommandContext): Promise<void> {
  const registry = ctx.platform.voiceProviderRegistry;
  if (!registry) {
    ctx.print('Voice provider registry is not available in this runtime.');
    return;
  }
  const providers = registry.list().filter((provider) => provider.capabilities.includes('tts-stream'));
  if (providers.length === 0) {
    ctx.print('No streaming TTS providers are registered.');
    return;
  }
  ctx.print([
    'Streaming TTS Providers',
    ...providers.map((provider) => `  ${provider.id}: ${provider.label}`),
  ].join('\n'));
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
    ].join('\n'));
  } catch (error) {
    ctx.print(`Unable to list TTS voices: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatValue(value: unknown): string {
  const text = String(value ?? '').trim();
  return text || '(default)';
}
