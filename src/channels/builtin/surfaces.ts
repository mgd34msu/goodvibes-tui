import type { ProviderRuntimeSurface } from '../provider-runtime.ts';
import type { ChannelSurface } from '../types.ts';
import type { BuiltinChannelRuntimeDeps, ManagedSurface } from './shared.ts';

export function asProviderRuntimeSurface(surface: ChannelSurface): ProviderRuntimeSurface | null {
  return surface === 'slack' || surface === 'discord' || surface === 'ntfy' ? surface : null;
}

export function isManagedSurface(surface: ChannelSurface): surface is ManagedSurface {
  return surface === 'slack'
    || surface === 'discord'
    || surface === 'ntfy'
    || surface === 'webhook'
    || surface === 'telegram'
    || surface === 'google-chat'
    || surface === 'signal'
    || surface === 'whatsapp'
    || surface === 'imessage'
    || surface === 'msteams'
    || surface === 'bluebubbles'
    || surface === 'mattermost'
    || surface === 'matrix';
}

export function providerRuntimeStatus(deps: BuiltinChannelRuntimeDeps, surface: ProviderRuntimeSurface): unknown {
  return deps.providerRuntime?.status(surface) ?? null;
}

export function providerEnvBacked(surface: ProviderRuntimeSurface): boolean {
  if (surface === 'slack') return Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN);
  if (surface === 'discord') return Boolean(process.env.DISCORD_BOT_TOKEN);
  return Boolean(process.env.NTFY_ACCESS_TOKEN);
}

export async function resolveSlackBotToken(deps: BuiltinChannelRuntimeDeps): Promise<string | null> {
  const serviceValue = await deps.serviceRegistry.resolveSecret('slack', 'primary');
  return serviceValue
    || String(deps.configManager.get('surfaces.slack.botToken') || '')
    || process.env.SLACK_BOT_TOKEN
    || null;
}

export async function resolveDiscordBotToken(deps: BuiltinChannelRuntimeDeps): Promise<string | null> {
  const serviceValue = await deps.serviceRegistry.resolveSecret('discord', 'primary');
  return serviceValue
    || String(deps.configManager.get('surfaces.discord.botToken') || '')
    || process.env.DISCORD_BOT_TOKEN
    || null;
}

export async function resolveNtfyToken(deps: BuiltinChannelRuntimeDeps): Promise<string | null> {
  const serviceValue = await deps.serviceRegistry.resolveSecret('ntfy', 'primary');
  return serviceValue
    || String(deps.configManager.get('surfaces.ntfy.token') || '')
    || process.env.NTFY_ACCESS_TOKEN
    || null;
}
