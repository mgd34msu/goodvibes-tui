import type { ServiceSecretField } from '../../config/service-registry.ts';
import type { ProviderRuntimeSurface } from '../provider-runtime.ts';
import type {
  ChannelAccountAction,
  ChannelAccountRecord,
  ChannelSecretStatus,
  ChannelSurface,
} from '../types.ts';
import type { BuiltinChannelRuntimeDeps } from './shared.ts';

interface BuiltinAccountContext {
  readonly deps: BuiltinChannelRuntimeDeps;
  readonly providerRuntimeStatus: (surface: ProviderRuntimeSurface) => unknown;
}

export async function buildBuiltinAccount(
  context: BuiltinAccountContext,
  surface: ChannelSurface,
): Promise<ChannelAccountRecord> {
  switch (surface) {
    case 'tui':
      return finalizeBuiltinChannelAccount({
        surface,
        label: 'Terminal UI',
        enabled: true,
        accountId: 'surface:tui',
        secrets: [],
        metadata: { managed: 'local' },
      });
    case 'web':
      return finalizeBuiltinChannelAccount({
        surface,
        label: 'Web control plane',
        enabled: Boolean(context.deps.configManager.get('web.enabled') || context.deps.configManager.get('controlPlane.enabled')),
        accountId: 'surface:web',
        secrets: [],
        metadata: {
          baseUrl: context.deps.configManager.get('web.publicBaseUrl'),
          port: context.deps.configManager.get('web.port'),
        },
      });
    case 'slack': {
      const workspaceId = String(context.deps.configManager.get('surfaces.slack.workspaceId') || '') || undefined;
      const secrets = await Promise.all([
        describeBuiltinSecret(context.deps, 'primary', 'Bot token', context.deps.configManager.get('surfaces.slack.botToken'), ['SLACK_BOT_TOKEN'], 'slack', 'primary'),
        describeBuiltinSecret(context.deps, 'signingSecret', 'Signing secret', context.deps.configManager.get('surfaces.slack.signingSecret'), ['SLACK_SIGNING_SECRET'], 'slack', 'signingSecret'),
        describeBuiltinSecret(context.deps, 'appToken', 'App token', context.deps.configManager.get('surfaces.slack.appToken'), ['SLACK_APP_TOKEN']),
        describeBuiltinSecret(context.deps, 'webhookUrl', 'Webhook URL', undefined, ['SLACK_WEBHOOK_URL'], 'slack', 'webhookUrl'),
      ]);
      return finalizeBuiltinChannelAccount({
        surface,
        label: 'Slack',
        enabled: context.deps.surfaceDeliveryEnabled('slack'),
        accountId: workspaceId ?? 'surface:slack',
        workspaceId,
        secrets,
        metadata: {
          defaultChannel: context.deps.configManager.get('surfaces.slack.defaultChannel'),
          providerRuntime: context.providerRuntimeStatus('slack'),
        },
      });
    }
    case 'discord': {
      const applicationId = String(context.deps.configManager.get('surfaces.discord.applicationId') || '') || undefined;
      const secrets = await Promise.all([
        describeBuiltinSecret(context.deps, 'primary', 'Bot token', context.deps.configManager.get('surfaces.discord.botToken'), ['DISCORD_BOT_TOKEN'], 'discord', 'primary'),
        describeBuiltinSecret(context.deps, 'publicKey', 'Public key', context.deps.configManager.get('surfaces.discord.publicKey'), ['DISCORD_PUBLIC_KEY'], 'discord', 'publicKey'),
        describeBuiltinSecret(context.deps, 'webhookUrl', 'Webhook URL', undefined, ['DISCORD_WEBHOOK_URL'], 'discord', 'webhookUrl'),
      ]);
      return finalizeBuiltinChannelAccount({
        surface,
        label: 'Discord',
        enabled: context.deps.surfaceDeliveryEnabled('discord'),
        accountId: applicationId ?? 'surface:discord',
        workspaceId: String(context.deps.configManager.get('surfaces.discord.guildId') || '') || undefined,
        secrets,
        metadata: {
          applicationId,
          defaultChannelId: context.deps.configManager.get('surfaces.discord.defaultChannelId'),
          providerRuntime: context.providerRuntimeStatus('discord'),
        },
      });
    }
    case 'ntfy': {
      const secrets = await Promise.all([
        describeBuiltinSecret(context.deps, 'primary', 'Access token', undefined, ['NTFY_ACCESS_TOKEN'], 'ntfy', 'primary'),
      ]);
      return finalizeBuiltinChannelAccount({
        surface,
        label: 'ntfy',
        enabled: context.deps.surfaceDeliveryEnabled('ntfy'),
        accountId: String(context.deps.configManager.get('surfaces.ntfy.topic') || '') || 'surface:ntfy',
        secrets,
        metadata: {
          baseUrl: context.deps.configManager.get('surfaces.ntfy.baseUrl'),
          topic: context.deps.configManager.get('surfaces.ntfy.topic'),
          providerRuntime: context.providerRuntimeStatus('ntfy'),
        },
      });
    }
    case 'webhook': {
      const secrets = await Promise.all([
        describeBuiltinSecret(context.deps, 'secret', 'Shared secret', context.deps.configManager.get('surfaces.webhook.secret')),
        describeBuiltinSecret(context.deps, 'defaultTarget', 'Default target', context.deps.configManager.get('surfaces.webhook.defaultTarget')),
      ]);
      return finalizeBuiltinChannelAccount({
        surface,
        label: 'Generic webhook',
        enabled: context.deps.surfaceDeliveryEnabled('webhook'),
        accountId: 'surface:webhook',
        secrets,
        metadata: {
          defaultTarget: context.deps.configManager.get('surfaces.webhook.defaultTarget'),
          timeoutMs: context.deps.configManager.get('surfaces.webhook.timeoutMs'),
        },
      });
    }
    case 'telegram': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await Promise.all([
        describeBuiltinSecret(context.deps, 'primary', 'Bot token', surfaces.telegram.botToken, ['TELEGRAM_BOT_TOKEN'], 'telegram', 'primary'),
        describeBuiltinSecret(context.deps, 'webhookSecret', 'Webhook secret', surfaces.telegram.webhookSecret, ['TELEGRAM_WEBHOOK_SECRET'], 'telegram', 'signingSecret'),
      ]);
      return finalizeBuiltinChannelAccount({
        surface,
        label: 'Telegram',
        enabled: context.deps.surfaceDeliveryEnabled('telegram'),
        accountId: surfaces.telegram.botUsername || surfaces.telegram.defaultChatId || 'surface:telegram',
        secrets,
        metadata: {
          botUsername: surfaces.telegram.botUsername,
          defaultChatId: surfaces.telegram.defaultChatId,
          mode: surfaces.telegram.mode,
          setupVersion: surfaces.telegram.setupVersion,
        },
      });
    }
    case 'google-chat': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await Promise.all([
        describeBuiltinSecret(context.deps, 'webhookUrl', 'Webhook URL', surfaces.googleChat.webhookUrl, ['GOOGLE_CHAT_WEBHOOK_URL'], 'google-chat', 'webhookUrl'),
        describeBuiltinSecret(context.deps, 'verificationToken', 'Verification token', surfaces.googleChat.verificationToken, ['GOOGLE_CHAT_VERIFICATION_TOKEN'], 'google-chat', 'signingSecret'),
      ]);
      return finalizeBuiltinChannelAccount({
        surface,
        label: 'Google Chat',
        enabled: context.deps.surfaceDeliveryEnabled('google-chat'),
        accountId: surfaces.googleChat.appId || surfaces.googleChat.spaceId || 'surface:google-chat',
        secrets,
        metadata: {
          appId: surfaces.googleChat.appId,
          spaceId: surfaces.googleChat.spaceId,
          setupVersion: surfaces.googleChat.setupVersion,
        },
      });
    }
    case 'signal': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await Promise.all([
        describeBuiltinSecret(context.deps, 'primary', 'Bridge token', surfaces.signal.token, ['SIGNAL_BRIDGE_TOKEN'], 'signal', 'primary'),
      ]);
      return finalizeBuiltinChannelAccount({
        surface,
        label: 'Signal',
        enabled: context.deps.surfaceDeliveryEnabled('signal'),
        accountId: surfaces.signal.account || surfaces.signal.defaultRecipient || 'surface:signal',
        secrets,
        metadata: {
          bridgeUrl: surfaces.signal.bridgeUrl,
          account: surfaces.signal.account,
          defaultRecipient: surfaces.signal.defaultRecipient,
          setupVersion: surfaces.signal.setupVersion,
        },
      });
    }
    case 'whatsapp': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await Promise.all([
        describeBuiltinSecret(context.deps, 'primary', 'Access token', surfaces.whatsapp.accessToken, ['WHATSAPP_ACCESS_TOKEN'], 'whatsapp', 'primary'),
        describeBuiltinSecret(context.deps, 'verifyToken', 'Verify token', surfaces.whatsapp.verifyToken, ['WHATSAPP_VERIFY_TOKEN'], 'whatsapp', 'signingSecret'),
      ]);
      return finalizeBuiltinChannelAccount({
        surface,
        label: 'WhatsApp',
        enabled: context.deps.surfaceDeliveryEnabled('whatsapp'),
        accountId: surfaces.whatsapp.phoneNumberId || surfaces.whatsapp.defaultRecipient || 'surface:whatsapp',
        secrets,
        metadata: {
          provider: surfaces.whatsapp.provider,
          phoneNumberId: surfaces.whatsapp.phoneNumberId,
          businessAccountId: surfaces.whatsapp.businessAccountId,
          defaultRecipient: surfaces.whatsapp.defaultRecipient,
          setupVersion: surfaces.whatsapp.setupVersion,
        },
      });
    }
    case 'imessage': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await Promise.all([
        describeBuiltinSecret(context.deps, 'primary', 'Bridge token', surfaces.imessage.token, ['IMESSAGE_BRIDGE_TOKEN'], 'imessage', 'primary'),
      ]);
      return finalizeBuiltinChannelAccount({
        surface,
        label: 'iMessage',
        enabled: context.deps.surfaceDeliveryEnabled('imessage'),
        accountId: surfaces.imessage.account || surfaces.imessage.defaultChatId || 'surface:imessage',
        secrets,
        metadata: {
          bridgeUrl: surfaces.imessage.bridgeUrl,
          account: surfaces.imessage.account,
          defaultChatId: surfaces.imessage.defaultChatId,
          setupVersion: surfaces.imessage.setupVersion,
        },
      });
    }
    case 'msteams': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await Promise.all([
        describeBuiltinSecret(context.deps, 'appPassword', 'App password', surfaces.msteams.appPassword, ['MSTEAMS_APP_PASSWORD'], 'msteams', 'password'),
      ]);
      return finalizeBuiltinChannelAccount({
        surface,
        label: 'Microsoft Teams',
        enabled: context.deps.surfaceDeliveryEnabled('msteams'),
        accountId: surfaces.msteams.defaultConversationId || surfaces.msteams.botId || surfaces.msteams.appId || 'surface:msteams',
        secrets,
        metadata: {
          appId: surfaces.msteams.appId,
          tenantId: surfaces.msteams.tenantId,
          serviceUrl: surfaces.msteams.serviceUrl,
          botId: surfaces.msteams.botId,
          defaultConversationId: surfaces.msteams.defaultConversationId,
          defaultChannelId: surfaces.msteams.defaultChannelId,
          setupVersion: surfaces.msteams.setupVersion,
        },
      });
    }
    case 'bluebubbles': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await Promise.all([
        describeBuiltinSecret(context.deps, 'password', 'Server password', surfaces.bluebubbles.password, ['BLUEBUBBLES_PASSWORD'], 'bluebubbles', 'password'),
      ]);
      return finalizeBuiltinChannelAccount({
        surface,
        label: 'BlueBubbles',
        enabled: context.deps.surfaceDeliveryEnabled('bluebubbles'),
        accountId: surfaces.bluebubbles.account || surfaces.bluebubbles.defaultChatGuid || 'surface:bluebubbles',
        secrets,
        metadata: {
          serverUrl: surfaces.bluebubbles.serverUrl,
          account: surfaces.bluebubbles.account,
          defaultChatGuid: surfaces.bluebubbles.defaultChatGuid,
          setupVersion: surfaces.bluebubbles.setupVersion,
        },
      });
    }
    case 'mattermost': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await Promise.all([
        describeBuiltinSecret(context.deps, 'primary', 'Bot token', surfaces.mattermost.botToken, ['MATTERMOST_BOT_TOKEN'], 'mattermost', 'primary'),
      ]);
      return finalizeBuiltinChannelAccount({
        surface,
        label: 'Mattermost',
        enabled: context.deps.surfaceDeliveryEnabled('mattermost'),
        accountId: surfaces.mattermost.teamId || surfaces.mattermost.defaultChannelId || 'surface:mattermost',
        secrets,
        metadata: {
          baseUrl: surfaces.mattermost.baseUrl,
          teamId: surfaces.mattermost.teamId,
          defaultChannelId: surfaces.mattermost.defaultChannelId,
          setupVersion: surfaces.mattermost.setupVersion,
        },
      });
    }
    case 'matrix': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await Promise.all([
        describeBuiltinSecret(context.deps, 'primary', 'Access token', surfaces.matrix.accessToken, ['MATRIX_ACCESS_TOKEN'], 'matrix', 'primary'),
      ]);
      return finalizeBuiltinChannelAccount({
        surface,
        label: 'Matrix',
        enabled: context.deps.surfaceDeliveryEnabled('matrix'),
        accountId: surfaces.matrix.userId || surfaces.matrix.defaultRoomId || 'surface:matrix',
        secrets,
        metadata: {
          homeserverUrl: surfaces.matrix.homeserverUrl,
          userId: surfaces.matrix.userId,
          defaultRoomId: surfaces.matrix.defaultRoomId,
          setupVersion: surfaces.matrix.setupVersion,
        },
      });
    }
  }
  throw new Error(`Unsupported built-in surface: ${surface}`);
}

export async function resolveBuiltinAccount(
  context: BuiltinAccountContext,
  surface: ChannelSurface,
  accountId: string,
): Promise<ChannelAccountRecord | null> {
  const record = await buildBuiltinAccount(context, surface);
  return record.id === accountId || record.accountId === accountId || record.workspaceId === accountId
    ? record
    : null;
}

async function describeBuiltinSecret(
  deps: BuiltinChannelRuntimeDeps,
  field: string,
  label: string,
  configValue: unknown,
  envKeys: readonly string[] = [],
  serviceName?: string,
  serviceField?: ServiceSecretField,
): Promise<ChannelSecretStatus> {
  const serviceValue = serviceName && serviceField
    ? await deps.serviceRegistry.resolveSecret(serviceName, serviceField)
    : null;
  const configPresent = hasConfiguredValue(configValue);
  const envPresent = envKeys.some((key) => hasConfiguredValue(process.env[key]));
  return {
    field,
    label,
    configured: Boolean(serviceValue || configPresent || envPresent),
    source: serviceValue
      ? 'service-registry'
      : configPresent
        ? 'config'
        : envPresent
          ? 'env'
          : 'missing',
  };
}

function hasConfiguredValue(value: unknown): boolean {
  return typeof value === 'string'
    ? value.trim().length > 0
    : Array.isArray(value)
      ? value.length > 0
      : Boolean(value);
}

function buildBuiltinAccountActions(configured: boolean, linked: boolean): readonly ChannelAccountAction[] {
  return [
    {
      id: 'inspect',
      label: 'Inspect account',
      kind: 'inspect',
      available: true,
    },
    {
      id: configured ? 'retest' : 'setup',
      label: configured ? 'Retest credentials' : 'Configure surface',
      kind: configured ? 'retest' : 'setup',
      available: true,
    },
    {
      id: linked ? 'disconnect' : 'connect',
      label: linked ? 'Disconnect surface' : 'Connect surface',
      kind: linked ? 'disconnect' : 'connect',
      available: configured,
    },
    {
      id: 'start',
      label: 'Start surface',
      kind: 'start',
      available: configured,
    },
    {
      id: 'stop',
      label: 'Stop surface',
      kind: 'stop',
      available: configured,
    },
    {
      id: linked ? 'logout' : 'login',
      label: linked ? 'Logout account' : 'Login account',
      kind: linked ? 'logout' : 'login',
      available: configured,
    },
    {
      id: 'wait_login',
      label: 'Wait for login',
      kind: 'wait_login',
      available: false,
    },
  ];
}

function finalizeBuiltinChannelAccount(input: {
  surface: ChannelSurface;
  label: string;
  enabled: boolean;
  accountId?: string;
  workspaceId?: string;
  secrets: readonly ChannelSecretStatus[];
  metadata: Record<string, unknown>;
}): ChannelAccountRecord {
  const configured = Boolean(input.accountId || input.workspaceId || input.secrets.some((entry) => entry.configured));
  const linked = input.secrets.some((entry) => entry.configured);
  const state = !configured
    ? input.enabled ? 'unconfigured' : 'disabled'
    : input.enabled
      ? linked ? 'healthy' : 'degraded'
      : 'disabled';
  const authState = !configured
    ? 'not-configured'
    : linked
      ? 'linked'
      : input.enabled
        ? 'degraded'
        : 'configured';
  const id = input.accountId || input.workspaceId || `surface:${input.surface}`;
  return {
    id,
    surface: input.surface,
    label: input.label,
    enabled: input.enabled,
    configured,
    linked,
    state,
    authState,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    secrets: input.secrets,
    actions: buildBuiltinAccountActions(configured, linked),
    metadata: input.metadata,
  };
}
