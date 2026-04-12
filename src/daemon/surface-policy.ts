import type { ConfigManager } from '../config/manager.ts';

type SurfaceDeliveryTarget =
  | 'slack'
  | 'discord'
  | 'ntfy'
  | 'webhook'
  | 'telegram'
  | 'google-chat'
  | 'signal'
  | 'whatsapp'
  | 'imessage'
  | 'msteams'
  | 'bluebubbles'
  | 'mattermost'
  | 'matrix';

export function isSurfaceDeliveryEnabled(
  configManager: ConfigManager,
  surface: SurfaceDeliveryTarget,
): boolean {
  if (surface === 'slack') {
    return Boolean(configManager.get('surfaces.slack.enabled') || process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN || process.env.SLACK_WEBHOOK_URL);
  }
  if (surface === 'discord') {
    return Boolean(configManager.get('surfaces.discord.enabled') || process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_WEBHOOK_URL);
  }
  if (surface === 'webhook') {
    return Boolean(configManager.get('surfaces.webhook.enabled') || configManager.get('surfaces.webhook.defaultTarget'));
  }
  if (surface === 'ntfy') {
    return Boolean(configManager.get('surfaces.ntfy.enabled') || configManager.get('surfaces.ntfy.topic') || process.env.NTFY_ACCESS_TOKEN);
  }
  const surfaces = configManager.getCategory('surfaces');
  if (surface === 'telegram') {
    return Boolean(surfaces.telegram.enabled || surfaces.telegram.botToken || surfaces.telegram.defaultChatId || process.env.TELEGRAM_BOT_TOKEN);
  }
  if (surface === 'google-chat') {
    return Boolean(surfaces.googleChat.enabled || surfaces.googleChat.webhookUrl || surfaces.googleChat.spaceId || process.env.GOOGLE_CHAT_WEBHOOK_URL);
  }
  if (surface === 'signal') {
    return Boolean(surfaces.signal.enabled || surfaces.signal.bridgeUrl || surfaces.signal.account || process.env.SIGNAL_BRIDGE_TOKEN);
  }
  if (surface === 'whatsapp') {
    return Boolean(surfaces.whatsapp.enabled || surfaces.whatsapp.accessToken || surfaces.whatsapp.phoneNumberId || process.env.WHATSAPP_ACCESS_TOKEN);
  }
  if (surface === 'imessage') {
    return Boolean(surfaces.imessage.enabled || surfaces.imessage.bridgeUrl || surfaces.imessage.account || process.env.IMESSAGE_BRIDGE_TOKEN);
  }
  if (surface === 'msteams') {
    return Boolean(surfaces.msteams.enabled || surfaces.msteams.appId || surfaces.msteams.defaultConversationId || process.env.MSTEAMS_APP_ID);
  }
  if (surface === 'bluebubbles') {
    return Boolean(surfaces.bluebubbles.enabled || surfaces.bluebubbles.serverUrl || surfaces.bluebubbles.defaultChatGuid || process.env.BLUEBUBBLES_SERVER_URL);
  }
  if (surface === 'mattermost') {
    return Boolean(surfaces.mattermost.enabled || surfaces.mattermost.baseUrl || surfaces.mattermost.defaultChannelId || process.env.MATTERMOST_BASE_URL);
  }
  return Boolean(surfaces.matrix.enabled || surfaces.matrix.homeserverUrl || surfaces.matrix.defaultRoomId || process.env.MATRIX_HOMESERVER);
}
