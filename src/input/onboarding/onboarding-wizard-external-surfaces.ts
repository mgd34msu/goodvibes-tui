import {
  GOODVIBES_NTFY_AGENT_TOPIC,
  GOODVIBES_NTFY_CHAT_TOPIC,
  GOODVIBES_NTFY_REMOTE_TOPIC,
  resolveGoodVibesNtfyTopics,
} from '@pellux/goodvibes-sdk/platform/integrations/ntfy';
import { DEFAULT_CONFIG, type ConfigKey } from '../../config/index.ts';
import type { OnboardingSnapshotState } from '../../runtime/onboarding/index.ts';
import { TELEGRAM_MODE_OPTIONS, WHATSAPP_PROVIDER_OPTIONS } from './onboarding-wizard-constants.ts';
import { HOME_ASSISTANT_SURFACE_SPEC, WEBHOOK_SURFACE_SPEC } from './onboarding-wizard-external-surface-extra-specs.ts';
import type { OnboardingWizardRadioOption } from './onboarding-wizard-types.ts';

export interface ExternalSurfaceSetupFieldSpec {
  readonly id: string;
  readonly configKey: ConfigKey;
  readonly kind: 'text' | 'masked' | 'radio';
  readonly valueType?: 'string' | 'number';
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
  readonly options?: readonly OnboardingWizardRadioOption[];
  readonly defaultNumber?: number;
  readonly min?: number;
  readonly max?: number;
  readonly defaultValue: (snapshot: OnboardingSnapshotState | null) => string;
}

export interface ExternalSurfaceSpec {
  readonly id: string;
  readonly enabledFieldId: string;
  readonly enabledConfigKey: ConfigKey;
  readonly label: string;
  readonly hint: string;
  /**
   * Existing SDK config key. In onboarding this maps to the per-surface
   * auto-start choice, not to whether setup fields are shown.
   */
  readonly defaultEnabled: (snapshot: OnboardingSnapshotState | null) => boolean;
  readonly fields: readonly ExternalSurfaceSetupFieldSpec[];
}

function normalizeConfigValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function getDefaultConfigValue(key: ConfigKey): unknown {
  return key.split('.').reduce<unknown>((cursor, part) => (
    typeof cursor === 'object' && cursor !== null && part in cursor
      ? (cursor as Record<string, unknown>)[part]
      : undefined
  ), DEFAULT_CONFIG);
}

export function getExternalSurfaceAutoStartFieldId(surface: ExternalSurfaceSpec): string {
  return `${surface.enabledFieldId}.auto-start`;
}

export function getExternalSurfaceAutoStartDefaultValue(
  surface: ExternalSurfaceSpec,
  snapshot: OnboardingSnapshotState | null,
): 'yes' | 'no' {
  return surface.defaultEnabled(snapshot) ? 'yes' : 'no';
}

export function isExternalSurfaceSelectedByDefault(
  surface: ExternalSurfaceSpec,
  snapshot: OnboardingSnapshotState | null,
): boolean {
  if (surface.defaultEnabled(snapshot)) return true;
  if (!snapshot) return false;

  return surface.fields.some((field) => {
    const current = normalizeConfigValue(field.defaultValue(snapshot));
    const defaultValue = normalizeConfigValue(getDefaultConfigValue(field.configKey));
    return current.length > 0 && current !== defaultValue;
  });
}

export function getNtfyProtocolTopicLines(snapshot: OnboardingSnapshotState | null): readonly string[] {
  const topics = resolveGoodVibesNtfyTopics({
    chatTopic: snapshot?.config.surfaces.ntfy.chatTopic,
    agentTopic: snapshot?.config.surfaces.ntfy.agentTopic,
    remoteTopic: snapshot?.config.surfaces.ntfy.remoteTopic,
  });
  return [
    `Chat topic: ${topics.chatTopic}`,
    `Agent topic: ${topics.agentTopic}`,
    `Daemon-only remote topic: ${topics.remoteTopic}`,
  ];
}

export const EXTERNAL_SURFACE_SPECS: readonly ExternalSurfaceSpec[] = [
  {
    id: 'slack',
    enabledFieldId: 'external-services.slack',
    enabledConfigKey: 'surfaces.slack.enabled',
    label: 'Slack surface',
    hint: 'Enable Slack messages, slash-command/event handling, and thread-aware replies.',
    defaultEnabled: (snapshot) => snapshot?.config.surfaces.slack.enabled ?? false,
    fields: [
      {
        id: 'external-services.slack.bot-token',
        configKey: 'surfaces.slack.botToken',
        kind: 'masked',
        label: 'Slack bot token',
        hint: 'Token used by the Slack bot integration.',
        placeholder: 'xoxb-...',
        defaultValue: (snapshot) => snapshot?.config.surfaces.slack.botToken ?? '',
      },
      {
        id: 'external-services.slack.app-token',
        configKey: 'surfaces.slack.appToken',
        kind: 'masked',
        label: 'Slack app token',
        hint: 'Optional app-level token for Socket Mode deployments.',
        placeholder: 'xapp-...',
        defaultValue: (snapshot) => snapshot?.config.surfaces.slack.appToken ?? '',
      },
      {
        id: 'external-services.slack.signing-secret',
        configKey: 'surfaces.slack.signingSecret',
        kind: 'masked',
        label: 'Slack signing secret',
        hint: 'Signing secret used to verify inbound Slack events.',
        placeholder: 'signing secret',
        defaultValue: (snapshot) => snapshot?.config.surfaces.slack.signingSecret ?? '',
      },
      {
        id: 'external-services.slack.workspace-id',
        configKey: 'surfaces.slack.workspaceId',
        kind: 'text',
        label: 'Slack workspace ID',
        hint: 'Workspace/team ID used to scope Slack routing.',
        placeholder: 'T...',
        defaultValue: (snapshot) => snapshot?.config.surfaces.slack.workspaceId ?? '',
      },
      {
        id: 'external-services.slack.default-channel',
        configKey: 'surfaces.slack.defaultChannel',
        kind: 'text',
        label: 'Slack default channel',
        hint: 'Fallback Slack channel for messages that do not specify a target.',
        placeholder: '#goodvibes',
        defaultValue: (snapshot) => snapshot?.config.surfaces.slack.defaultChannel ?? '',
      },
    ],
  },
  {
    id: 'discord',
    enabledFieldId: 'external-services.discord',
    enabledConfigKey: 'surfaces.discord.enabled',
    label: 'Discord surface',
    hint: 'Enable Discord command/event handling and channel replies.',
    defaultEnabled: (snapshot) => snapshot?.config.surfaces.discord.enabled ?? false,
    fields: [
      {
        id: 'external-services.discord.bot-token',
        configKey: 'surfaces.discord.botToken',
        kind: 'masked',
        label: 'Discord bot token',
        hint: 'Token used by the Discord bot integration.',
        placeholder: 'bot token',
        defaultValue: (snapshot) => snapshot?.config.surfaces.discord.botToken ?? '',
      },
      {
        id: 'external-services.discord.public-key',
        configKey: 'surfaces.discord.publicKey',
        kind: 'masked',
        label: 'Discord public key',
        hint: 'Application public key for verifying interaction signatures.',
        placeholder: 'public key',
        defaultValue: (snapshot) => snapshot?.config.surfaces.discord.publicKey ?? '',
      },
      {
        id: 'external-services.discord.application-id',
        configKey: 'surfaces.discord.applicationId',
        kind: 'text',
        label: 'Discord application ID',
        hint: 'Application/client ID for the Discord integration.',
        placeholder: 'application id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.discord.applicationId ?? '',
      },
      {
        id: 'external-services.discord.guild-id',
        configKey: 'surfaces.discord.guildId',
        kind: 'text',
        label: 'Discord guild ID',
        hint: 'Optional default server/guild ID.',
        placeholder: 'guild id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.discord.guildId ?? '',
      },
      {
        id: 'external-services.discord.default-channel-id',
        configKey: 'surfaces.discord.defaultChannelId',
        kind: 'text',
        label: 'Discord default channel ID',
        hint: 'Fallback Discord channel for outbound messages.',
        placeholder: 'channel id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.discord.defaultChannelId ?? '',
      },
    ],
  },
  {
    id: 'telegram',
    enabledFieldId: 'external-services.telegram',
    enabledConfigKey: 'surfaces.telegram.enabled',
    label: 'Telegram surface',
    hint: 'Enable Telegram bot messaging and event handling.',
    defaultEnabled: (snapshot) => snapshot?.config.surfaces.telegram.enabled ?? false,
    fields: [
      {
        id: 'external-services.telegram.bot-token',
        configKey: 'surfaces.telegram.botToken',
        kind: 'masked',
        label: 'Telegram bot token',
        hint: 'Token issued by BotFather.',
        placeholder: 'bot token',
        defaultValue: (snapshot) => snapshot?.config.surfaces.telegram.botToken ?? '',
      },
      {
        id: 'external-services.telegram.webhook-secret',
        configKey: 'surfaces.telegram.webhookSecret',
        kind: 'masked',
        label: 'Telegram webhook secret',
        hint: 'Secret token used to verify Telegram webhook requests.',
        placeholder: 'webhook secret',
        defaultValue: (snapshot) => snapshot?.config.surfaces.telegram.webhookSecret ?? '',
      },
      {
        id: 'external-services.telegram.default-chat-id',
        configKey: 'surfaces.telegram.defaultChatId',
        kind: 'text',
        label: 'Telegram default chat ID',
        hint: 'Fallback chat ID for outbound Telegram messages.',
        placeholder: 'chat id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.telegram.defaultChatId ?? '',
      },
      {
        id: 'external-services.telegram.bot-username',
        configKey: 'surfaces.telegram.botUsername',
        kind: 'text',
        label: 'Telegram bot username',
        hint: 'Bot username used in visible routing labels.',
        placeholder: '@goodvibes_bot',
        defaultValue: (snapshot) => snapshot?.config.surfaces.telegram.botUsername ?? '',
      },
      {
        id: 'external-services.telegram.mode',
        configKey: 'surfaces.telegram.mode',
        kind: 'radio',
        label: 'Telegram delivery mode',
        hint: 'Choose webhook or polling transport.',
        placeholder: 'webhook',
        options: TELEGRAM_MODE_OPTIONS,
        defaultValue: (snapshot) => snapshot?.config.surfaces.telegram.mode ?? 'webhook',
      },
    ],
  },
  {
    id: 'ntfy',
    enabledFieldId: 'external-services.ntfy',
    enabledConfigKey: 'surfaces.ntfy.enabled',
    label: 'ntfy surface',
    hint: 'Configure ntfy chat, agent, remote-session, and notification delivery topics.',
    defaultEnabled: (snapshot) => snapshot?.config.surfaces.ntfy.enabled ?? false,
    fields: [
      {
        id: 'external-services.ntfy.base-url',
        configKey: 'surfaces.ntfy.baseUrl',
        kind: 'text',
        label: 'ntfy base URL',
        hint: 'Base URL of the ntfy server.',
        placeholder: 'https://ntfy.sh',
        defaultValue: (snapshot) => snapshot?.config.surfaces.ntfy.baseUrl ?? 'https://ntfy.sh',
      },
      {
        id: 'external-services.ntfy.chat-topic',
        configKey: 'surfaces.ntfy.chatTopic',
        kind: 'text',
        label: 'ntfy chat topic',
        hint: 'Messages sent here attach to the active terminal TUI session and reply back to ntfy.',
        placeholder: GOODVIBES_NTFY_CHAT_TOPIC,
        defaultValue: (snapshot) => snapshot?.config.surfaces.ntfy.chatTopic ?? GOODVIBES_NTFY_CHAT_TOPIC,
      },
      {
        id: 'external-services.ntfy.agent-topic',
        configKey: 'surfaces.ntfy.agentTopic',
        kind: 'text',
        label: 'ntfy agent topic',
        hint: 'Messages sent here start agent work attached to the active TUI session.',
        placeholder: GOODVIBES_NTFY_AGENT_TOPIC,
        defaultValue: (snapshot) => snapshot?.config.surfaces.ntfy.agentTopic ?? GOODVIBES_NTFY_AGENT_TOPIC,
      },
      {
        id: 'external-services.ntfy.remote-topic',
        configKey: 'surfaces.ntfy.remoteTopic',
        kind: 'text',
        label: 'ntfy daemon-only remote topic',
        hint: 'Messages sent here start an ntfy remote session in the daemon and do not appear in the TUI.',
        placeholder: GOODVIBES_NTFY_REMOTE_TOPIC,
        defaultValue: (snapshot) => snapshot?.config.surfaces.ntfy.remoteTopic ?? GOODVIBES_NTFY_REMOTE_TOPIC,
      },
      {
        id: 'external-services.ntfy.topic',
        configKey: 'surfaces.ntfy.topic',
        kind: 'text',
        label: 'ntfy default delivery topic',
        hint: 'Optional outbound notification topic. It does not control chat, agent, or daemon-only remote routing.',
        placeholder: 'goodvibes',
        defaultValue: (snapshot) => snapshot?.config.surfaces.ntfy.topic ?? '',
      },
      {
        id: 'external-services.ntfy.token',
        configKey: 'surfaces.ntfy.token',
        kind: 'masked',
        label: 'ntfy token',
        hint: 'Optional token for authenticated ntfy servers.',
        placeholder: 'empty for anonymous ntfy',
        defaultValue: (snapshot) => snapshot?.config.surfaces.ntfy.token ?? '',
      },
      {
        id: 'external-services.ntfy.default-priority',
        configKey: 'surfaces.ntfy.defaultPriority',
        kind: 'text',
        valueType: 'number',
        label: 'ntfy default priority',
        hint: 'Default ntfy priority from 1 to 5.',
        placeholder: '3',
        defaultNumber: 3,
        min: 1,
        max: 5,
        defaultValue: (snapshot) => String(snapshot?.config.surfaces.ntfy.defaultPriority ?? 3),
      },
    ],
  },
  WEBHOOK_SURFACE_SPEC,
  HOME_ASSISTANT_SURFACE_SPEC,
  {
    id: 'googleChat',
    enabledFieldId: 'external-services.google-chat',
    enabledConfigKey: 'surfaces.googleChat.enabled',
    label: 'Google Chat surface',
    hint: 'Enable Google Chat webhook and app routing.',
    defaultEnabled: (snapshot) => snapshot?.config.surfaces.googleChat.enabled ?? false,
    fields: [
      {
        id: 'external-services.google-chat.webhook-url',
        configKey: 'surfaces.googleChat.webhookUrl',
        kind: 'masked',
        label: 'Google Chat webhook URL',
        hint: 'Incoming webhook URL for Google Chat space delivery.',
        placeholder: 'webhook URL',
        defaultValue: (snapshot) => snapshot?.config.surfaces.googleChat.webhookUrl ?? '',
      },
      {
        id: 'external-services.google-chat.verification-token',
        configKey: 'surfaces.googleChat.verificationToken',
        kind: 'masked',
        label: 'Google Chat verification token',
        hint: 'Token used to verify inbound Google Chat events.',
        placeholder: 'verification token',
        defaultValue: (snapshot) => snapshot?.config.surfaces.googleChat.verificationToken ?? '',
      },
      {
        id: 'external-services.google-chat.app-id',
        configKey: 'surfaces.googleChat.appId',
        kind: 'text',
        label: 'Google Chat app ID',
        hint: 'Google Chat app identifier.',
        placeholder: 'app id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.googleChat.appId ?? '',
      },
      {
        id: 'external-services.google-chat.space-id',
        configKey: 'surfaces.googleChat.spaceId',
        kind: 'text',
        label: 'Google Chat space ID',
        hint: 'Default Google Chat space for outbound messages.',
        placeholder: 'space id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.googleChat.spaceId ?? '',
      },
    ],
  },
  {
    id: 'signal',
    enabledFieldId: 'external-services.signal',
    enabledConfigKey: 'surfaces.signal.enabled',
    label: 'Signal surface',
    hint: 'Enable Signal bridge messaging.',
    defaultEnabled: (snapshot) => snapshot?.config.surfaces.signal.enabled ?? false,
    fields: [
      {
        id: 'external-services.signal.bridge-url',
        configKey: 'surfaces.signal.bridgeUrl',
        kind: 'text',
        label: 'Signal bridge URL',
        hint: 'Base URL for the Signal bridge service.',
        placeholder: 'https://signal-bridge.local',
        defaultValue: (snapshot) => snapshot?.config.surfaces.signal.bridgeUrl ?? '',
      },
      {
        id: 'external-services.signal.account',
        configKey: 'surfaces.signal.account',
        kind: 'text',
        label: 'Signal account',
        hint: 'Signal account identifier used by the bridge.',
        placeholder: '+15551234567',
        defaultValue: (snapshot) => snapshot?.config.surfaces.signal.account ?? '',
      },
      {
        id: 'external-services.signal.token',
        configKey: 'surfaces.signal.token',
        kind: 'masked',
        label: 'Signal bridge token',
        hint: 'Authentication token for the Signal bridge.',
        placeholder: 'token',
        defaultValue: (snapshot) => snapshot?.config.surfaces.signal.token ?? '',
      },
      {
        id: 'external-services.signal.default-recipient',
        configKey: 'surfaces.signal.defaultRecipient',
        kind: 'text',
        label: 'Signal default recipient',
        hint: 'Fallback Signal recipient for outbound messages.',
        placeholder: '+15551234567',
        defaultValue: (snapshot) => snapshot?.config.surfaces.signal.defaultRecipient ?? '',
      },
    ],
  },
  {
    id: 'whatsapp',
    enabledFieldId: 'external-services.whatsapp',
    enabledConfigKey: 'surfaces.whatsapp.enabled',
    label: 'WhatsApp surface',
    hint: 'Enable WhatsApp Cloud API or bridge messaging.',
    defaultEnabled: (snapshot) => snapshot?.config.surfaces.whatsapp.enabled ?? false,
    fields: [
      {
        id: 'external-services.whatsapp.provider',
        configKey: 'surfaces.whatsapp.provider',
        kind: 'radio',
        label: 'WhatsApp provider',
        hint: 'Choose Meta Cloud API or a bridge provider.',
        placeholder: 'meta-cloud',
        options: WHATSAPP_PROVIDER_OPTIONS,
        defaultValue: (snapshot) => snapshot?.config.surfaces.whatsapp.provider ?? 'meta-cloud',
      },
      {
        id: 'external-services.whatsapp.access-token',
        configKey: 'surfaces.whatsapp.accessToken',
        kind: 'masked',
        label: 'WhatsApp access token',
        hint: 'Access token for the WhatsApp provider.',
        placeholder: 'access token',
        defaultValue: (snapshot) => snapshot?.config.surfaces.whatsapp.accessToken ?? '',
      },
      {
        id: 'external-services.whatsapp.verify-token',
        configKey: 'surfaces.whatsapp.verifyToken',
        kind: 'masked',
        label: 'WhatsApp verify token',
        hint: 'Verification token for webhook setup.',
        placeholder: 'verify token',
        defaultValue: (snapshot) => snapshot?.config.surfaces.whatsapp.verifyToken ?? '',
      },
      {
        id: 'external-services.whatsapp.signing-secret',
        configKey: 'surfaces.whatsapp.signingSecret',
        kind: 'masked',
        label: 'WhatsApp signing secret',
        hint: 'Secret used to verify signed WhatsApp events.',
        placeholder: 'signing secret',
        defaultValue: (snapshot) => snapshot?.config.surfaces.whatsapp.signingSecret ?? '',
      },
      {
        id: 'external-services.whatsapp.phone-number-id',
        configKey: 'surfaces.whatsapp.phoneNumberId',
        kind: 'text',
        label: 'WhatsApp phone number ID',
        hint: 'Phone number ID used by the WhatsApp Cloud API.',
        placeholder: 'phone number id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.whatsapp.phoneNumberId ?? '',
      },
      {
        id: 'external-services.whatsapp.business-account-id',
        configKey: 'surfaces.whatsapp.businessAccountId',
        kind: 'text',
        label: 'WhatsApp business account ID',
        hint: 'Business account ID for Cloud API routing.',
        placeholder: 'business account id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.whatsapp.businessAccountId ?? '',
      },
      {
        id: 'external-services.whatsapp.default-recipient',
        configKey: 'surfaces.whatsapp.defaultRecipient',
        kind: 'text',
        label: 'WhatsApp default recipient',
        hint: 'Fallback recipient for outbound WhatsApp messages.',
        placeholder: '+15551234567',
        defaultValue: (snapshot) => snapshot?.config.surfaces.whatsapp.defaultRecipient ?? '',
      },
    ],
  },
  {
    id: 'imessage',
    enabledFieldId: 'external-services.imessage',
    enabledConfigKey: 'surfaces.imessage.enabled',
    label: 'iMessage surface',
    hint: 'Enable iMessage bridge messaging.',
    defaultEnabled: (snapshot) => snapshot?.config.surfaces.imessage.enabled ?? false,
    fields: [
      {
        id: 'external-services.imessage.bridge-url',
        configKey: 'surfaces.imessage.bridgeUrl',
        kind: 'text',
        label: 'iMessage bridge URL',
        hint: 'Base URL for the iMessage bridge.',
        placeholder: 'https://imessage-bridge.local',
        defaultValue: (snapshot) => snapshot?.config.surfaces.imessage.bridgeUrl ?? '',
      },
      {
        id: 'external-services.imessage.account',
        configKey: 'surfaces.imessage.account',
        kind: 'text',
        label: 'iMessage account',
        hint: 'Bridge account identifier.',
        placeholder: 'account',
        defaultValue: (snapshot) => snapshot?.config.surfaces.imessage.account ?? '',
      },
      {
        id: 'external-services.imessage.token',
        configKey: 'surfaces.imessage.token',
        kind: 'masked',
        label: 'iMessage bridge token',
        hint: 'Authentication token for the iMessage bridge.',
        placeholder: 'token',
        defaultValue: (snapshot) => snapshot?.config.surfaces.imessage.token ?? '',
      },
      {
        id: 'external-services.imessage.default-chat-id',
        configKey: 'surfaces.imessage.defaultChatId',
        kind: 'text',
        label: 'iMessage default chat ID',
        hint: 'Fallback chat ID for outbound iMessage delivery.',
        placeholder: 'chat id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.imessage.defaultChatId ?? '',
      },
    ],
  },
  {
    id: 'msteams',
    enabledFieldId: 'external-services.msteams',
    enabledConfigKey: 'surfaces.msteams.enabled',
    label: 'Microsoft Teams surface',
    hint: 'Enable Microsoft Teams bot conversations and channel replies.',
    defaultEnabled: (snapshot) => snapshot?.config.surfaces.msteams.enabled ?? false,
    fields: [
      {
        id: 'external-services.msteams.app-id',
        configKey: 'surfaces.msteams.appId',
        kind: 'text',
        label: 'Teams app ID',
        hint: 'Application ID for the Teams bot registration.',
        placeholder: 'app id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.msteams.appId ?? '',
      },
      {
        id: 'external-services.msteams.app-password',
        configKey: 'surfaces.msteams.appPassword',
        kind: 'masked',
        label: 'Teams app password',
        hint: 'Client secret for the Teams bot registration.',
        placeholder: 'app password',
        defaultValue: (snapshot) => snapshot?.config.surfaces.msteams.appPassword ?? '',
      },
      {
        id: 'external-services.msteams.tenant-id',
        configKey: 'surfaces.msteams.tenantId',
        kind: 'text',
        label: 'Teams tenant ID',
        hint: 'Tenant ID that owns the Teams bot registration.',
        placeholder: 'tenant id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.msteams.tenantId ?? '',
      },
      {
        id: 'external-services.msteams.service-url',
        configKey: 'surfaces.msteams.serviceUrl',
        kind: 'text',
        label: 'Teams service URL',
        hint: 'Optional Bot Framework service URL for replies.',
        placeholder: 'https://smba.trafficmanager.net/amer/',
        defaultValue: (snapshot) => snapshot?.config.surfaces.msteams.serviceUrl ?? '',
      },
      {
        id: 'external-services.msteams.bot-id',
        configKey: 'surfaces.msteams.botId',
        kind: 'text',
        label: 'Teams bot ID',
        hint: 'Optional bot ID when it differs from the app ID.',
        placeholder: 'bot id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.msteams.botId ?? '',
      },
      {
        id: 'external-services.msteams.default-conversation-id',
        configKey: 'surfaces.msteams.defaultConversationId',
        kind: 'text',
        label: 'Teams default conversation ID',
        hint: 'Fallback Teams conversation for outbound messages.',
        placeholder: 'conversation id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.msteams.defaultConversationId ?? '',
      },
      {
        id: 'external-services.msteams.default-channel-id',
        configKey: 'surfaces.msteams.defaultChannelId',
        kind: 'text',
        label: 'Teams default channel ID',
        hint: 'Fallback Teams channel for outbound messages.',
        placeholder: 'channel id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.msteams.defaultChannelId ?? '',
      },
    ],
  },
  {
    id: 'bluebubbles',
    enabledFieldId: 'external-services.bluebubbles',
    enabledConfigKey: 'surfaces.bluebubbles.enabled',
    label: 'BlueBubbles surface',
    hint: 'Enable BlueBubbles bridge messaging for iMessage-compatible deployments.',
    defaultEnabled: (snapshot) => snapshot?.config.surfaces.bluebubbles.enabled ?? false,
    fields: [
      {
        id: 'external-services.bluebubbles.server-url',
        configKey: 'surfaces.bluebubbles.serverUrl',
        kind: 'text',
        label: 'BlueBubbles server URL',
        hint: 'Base URL of the BlueBubbles server.',
        placeholder: 'https://bluebubbles.local',
        defaultValue: (snapshot) => snapshot?.config.surfaces.bluebubbles.serverUrl ?? '',
      },
      {
        id: 'external-services.bluebubbles.password',
        configKey: 'surfaces.bluebubbles.password',
        kind: 'masked',
        label: 'BlueBubbles password',
        hint: 'Password used to authenticate with BlueBubbles.',
        placeholder: 'password',
        defaultValue: (snapshot) => snapshot?.config.surfaces.bluebubbles.password ?? '',
      },
      {
        id: 'external-services.bluebubbles.account',
        configKey: 'surfaces.bluebubbles.account',
        kind: 'text',
        label: 'BlueBubbles account',
        hint: 'Optional account identifier used by the bridge.',
        placeholder: 'account',
        defaultValue: (snapshot) => snapshot?.config.surfaces.bluebubbles.account ?? '',
      },
      {
        id: 'external-services.bluebubbles.default-chat-guid',
        configKey: 'surfaces.bluebubbles.defaultChatGuid',
        kind: 'text',
        label: 'BlueBubbles default chat GUID',
        hint: 'Fallback chat GUID for outbound BlueBubbles delivery.',
        placeholder: 'chat guid',
        defaultValue: (snapshot) => snapshot?.config.surfaces.bluebubbles.defaultChatGuid ?? '',
      },
    ],
  },
  {
    id: 'mattermost',
    enabledFieldId: 'external-services.mattermost',
    enabledConfigKey: 'surfaces.mattermost.enabled',
    label: 'Mattermost surface',
    hint: 'Enable Mattermost bot messaging and channel replies.',
    defaultEnabled: (snapshot) => snapshot?.config.surfaces.mattermost.enabled ?? false,
    fields: [
      {
        id: 'external-services.mattermost.base-url',
        configKey: 'surfaces.mattermost.baseUrl',
        kind: 'text',
        label: 'Mattermost base URL',
        hint: 'Base URL of the Mattermost server.',
        placeholder: 'https://mattermost.example.com',
        defaultValue: (snapshot) => snapshot?.config.surfaces.mattermost.baseUrl ?? '',
      },
      {
        id: 'external-services.mattermost.bot-token',
        configKey: 'surfaces.mattermost.botToken',
        kind: 'masked',
        label: 'Mattermost bot token',
        hint: 'Bot token used for Mattermost API calls.',
        placeholder: 'bot token',
        defaultValue: (snapshot) => snapshot?.config.surfaces.mattermost.botToken ?? '',
      },
      {
        id: 'external-services.mattermost.team-id',
        configKey: 'surfaces.mattermost.teamId',
        kind: 'text',
        label: 'Mattermost team ID',
        hint: 'Optional default team for routing.',
        placeholder: 'team id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.mattermost.teamId ?? '',
      },
      {
        id: 'external-services.mattermost.default-channel-id',
        configKey: 'surfaces.mattermost.defaultChannelId',
        kind: 'text',
        label: 'Mattermost default channel ID',
        hint: 'Fallback Mattermost channel for outbound messages.',
        placeholder: 'channel id',
        defaultValue: (snapshot) => snapshot?.config.surfaces.mattermost.defaultChannelId ?? '',
      },
    ],
  },
  {
    id: 'matrix',
    enabledFieldId: 'external-services.matrix',
    enabledConfigKey: 'surfaces.matrix.enabled',
    label: 'Matrix surface',
    hint: 'Enable Matrix bot messaging and room replies.',
    defaultEnabled: (snapshot) => snapshot?.config.surfaces.matrix.enabled ?? false,
    fields: [
      {
        id: 'external-services.matrix.homeserver-url',
        configKey: 'surfaces.matrix.homeserverUrl',
        kind: 'text',
        label: 'Matrix homeserver URL',
        hint: 'Base URL of the Matrix homeserver.',
        placeholder: 'https://matrix.example.com',
        defaultValue: (snapshot) => snapshot?.config.surfaces.matrix.homeserverUrl ?? '',
      },
      {
        id: 'external-services.matrix.access-token',
        configKey: 'surfaces.matrix.accessToken',
        kind: 'masked',
        label: 'Matrix access token',
        hint: 'Access token for the Matrix bot user.',
        placeholder: 'access token',
        defaultValue: (snapshot) => snapshot?.config.surfaces.matrix.accessToken ?? '',
      },
      {
        id: 'external-services.matrix.user-id',
        configKey: 'surfaces.matrix.userId',
        kind: 'text',
        label: 'Matrix user ID',
        hint: 'Matrix user ID for the bot account.',
        placeholder: '@goodvibes:example.com',
        defaultValue: (snapshot) => snapshot?.config.surfaces.matrix.userId ?? '',
      },
      {
        id: 'external-services.matrix.default-room-id',
        configKey: 'surfaces.matrix.defaultRoomId',
        kind: 'text',
        label: 'Matrix default room ID',
        hint: 'Fallback Matrix room for outbound messages.',
        placeholder: '!room:example.com',
        defaultValue: (snapshot) => snapshot?.config.surfaces.matrix.defaultRoomId ?? '',
      },
    ],
  },
];
