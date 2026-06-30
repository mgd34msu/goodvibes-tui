import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import type { CommandContext } from './command-registry.ts';
import type { SelectionItem } from './selection-modal.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

function getStreamingTtsProviders(ctx: CommandContext): Array<{ id: string; label: string; capabilities: readonly string[] }> {
  const registry = ctx.platform.voiceProviderRegistry;
  if (!registry) return [];
  return registry.list().filter((provider) => provider.capabilities.includes('tts-stream'));
}

function setTtsConfigValue(ctx: CommandContext, key: ConfigKey, value: string): void {
  ctx.platform.configManager.setDynamic(key, value);
}

export function openTtsProviderPicker(ctx: CommandContext): boolean {
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
    ctx.renderRequest();
  });
  return true;
}

export async function openTtsVoicePicker(ctx: CommandContext, providerArg?: string): Promise<boolean> {
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
      ctx.renderRequest();
    });
    return true;
  } catch (error) {
    ctx.print(`Unable to list TTS voices: ${summarizeError(error)}`);
    return true;
  }
}
