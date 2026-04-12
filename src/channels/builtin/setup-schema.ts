import type {
  ChannelSecretTargetDescriptor,
  ChannelSetupFieldDescriptor,
  ChannelSetupSchema,
  ChannelSurface,
} from '../types.ts';
import {
  CHANNEL_SETUP_VERSION,
  DEFAULT_SECRET_BACKENDS,
} from './shared.ts';

export function getBuiltinSetupSchema(surface: ChannelSurface): ChannelSetupSchema {
  switch (surface) {
    case 'tui':
      return {
        surface,
        version: CHANNEL_SETUP_VERSION,
        label: 'Terminal UI',
        setupMode: 'config',
        description: 'The terminal surface is local-only and available whenever the TUI is running.',
        fields: [],
        secretTargets: [],
        externalSteps: [
          'Launch goodvibes-tui locally.',
          'Use route bindings if you want automation or remote systems to target the current TUI session.',
        ],
        metadata: {},
      };
    case 'web':
      return {
        surface,
        version: CHANNEL_SETUP_VERSION,
        label: 'Web control plane',
        setupMode: 'config',
        description: 'The embedded web/control-plane surface exposes HTTP, SSE, and WebSocket contracts for future clients.',
        fields: [
          setupField('enabled', 'Enabled', 'boolean', false, { configKey: 'web.enabled', defaultValue: false }),
          setupField('publicBaseUrl', 'Public base URL', 'url', false, { configKey: 'web.publicBaseUrl', placeholder: 'https://goodvibes.example.test' }),
        ],
        secretTargets: [],
        externalSteps: [
          'Enable the web/control-plane surface.',
          'Point external clients at the control-plane base URL and use daemon auth/session tokens.',
        ],
        metadata: {},
      };
    case 'slack':
      return {
        surface,
        version: CHANNEL_SETUP_VERSION,
        label: 'Slack',
        setupMode: 'oauth',
        description: 'Slack supports bot-token or OAuth-based setup with optional app-level token and signing secret.',
        fields: [
          setupField('enabled', 'Enabled', 'boolean', false, { configKey: 'surfaces.slack.enabled', defaultValue: false }),
          setupField('defaultChannel', 'Default channel', 'string', false, { configKey: 'surfaces.slack.defaultChannel', placeholder: '#ops' }),
          setupField('workspaceId', 'Workspace id', 'string', false, { configKey: 'surfaces.slack.workspaceId' }),
          setupField('botToken', 'Bot token', 'secret', false, { configKey: 'surfaces.slack.botToken', secretTargetId: 'primary' }),
          setupField('signingSecret', 'Signing secret', 'secret', false, { configKey: 'surfaces.slack.signingSecret', secretTargetId: 'signingSecret' }),
          setupField('appToken', 'App token', 'secret', false, { configKey: 'surfaces.slack.appToken', secretTargetId: 'appToken' }),
        ],
        secretTargets: [
          secretTarget(surface, 'primary', 'Bot token', false, 'Used for API delivery and provider-backed live directory operations.', {
            serviceName: 'slack',
            serviceField: 'primary',
            envKeys: ['SLACK_BOT_TOKEN'],
            configKeys: ['surfaces.slack.botToken'],
          }),
          secretTarget(surface, 'signingSecret', 'Signing secret', false, 'Used to verify inbound Slack requests.', {
            serviceName: 'slack',
            serviceField: 'signingSecret',
            envKeys: ['SLACK_SIGNING_SECRET'],
            configKeys: ['surfaces.slack.signingSecret'],
          }),
          secretTarget(surface, 'appToken', 'App token', false, 'Used for Slack app socket/runtime flows.', {
            envKeys: ['SLACK_APP_TOKEN'],
            configKeys: ['surfaces.slack.appToken'],
          }),
        ],
        externalSteps: [
          'Create or install the Slack app with the required bot scopes.',
          'Store the bot token and signing secret in env, GoodVibes secrets, or an external secret reference.',
          'Optional: generate an OAuth install URL through the provider channel actions.',
        ],
        metadata: {},
      };
    case 'discord':
      return {
        surface,
        version: CHANNEL_SETUP_VERSION,
        label: 'Discord',
        setupMode: 'oauth',
        description: 'Discord uses a bot token plus application metadata and can register slash commands through the provider actions.',
        fields: [
          setupField('enabled', 'Enabled', 'boolean', false, { configKey: 'surfaces.discord.enabled', defaultValue: false }),
          setupField('applicationId', 'Application id', 'string', false, { configKey: 'surfaces.discord.applicationId' }),
          setupField('guildId', 'Guild id', 'string', false, { configKey: 'surfaces.discord.guildId' }),
          setupField('defaultChannelId', 'Default channel id', 'string', false, { configKey: 'surfaces.discord.defaultChannelId' }),
          setupField('botToken', 'Bot token', 'secret', false, { configKey: 'surfaces.discord.botToken', secretTargetId: 'primary' }),
          setupField('publicKey', 'Public key', 'secret', false, { configKey: 'surfaces.discord.publicKey', secretTargetId: 'publicKey' }),
        ],
        secretTargets: [
          secretTarget(surface, 'primary', 'Bot token', false, 'Used for outbound delivery and provider-backed Discord API operations.', {
            serviceName: 'discord',
            serviceField: 'primary',
            envKeys: ['DISCORD_BOT_TOKEN'],
            configKeys: ['surfaces.discord.botToken'],
          }),
          secretTarget(surface, 'publicKey', 'Public key', false, 'Used to verify inbound Discord interaction signatures.', {
            serviceName: 'discord',
            serviceField: 'publicKey',
            envKeys: ['DISCORD_PUBLIC_KEY'],
            configKeys: ['surfaces.discord.publicKey'],
          }),
        ],
        externalSteps: [
          'Create a Discord application and bot.',
          'Store the bot token and public key.',
          'Install the app into a guild and optionally register slash commands.',
        ],
        metadata: {},
      };
    case 'ntfy':
      return {
        surface,
        version: CHANNEL_SETUP_VERSION,
        label: 'ntfy',
        setupMode: 'webhook',
        description: 'ntfy is a notification surface backed by a topic, optional token, and subscription URLs.',
        fields: [
          setupField('enabled', 'Enabled', 'boolean', false, { configKey: 'surfaces.ntfy.enabled', defaultValue: false }),
          setupField('baseUrl', 'Base URL', 'url', false, { configKey: 'surfaces.ntfy.baseUrl', placeholder: 'https://ntfy.sh' }),
          setupField('topic', 'Topic', 'string', true, { configKey: 'surfaces.ntfy.topic' }),
          setupField('token', 'Access token', 'secret', false, { configKey: 'surfaces.ntfy.token', secretTargetId: 'primary' }),
        ],
        secretTargets: [
          secretTarget(surface, 'primary', 'Access token', false, 'Used for authenticated ntfy delivery and polling.', {
            serviceName: 'ntfy',
            serviceField: 'primary',
            envKeys: ['NTFY_ACCESS_TOKEN'],
            configKeys: ['surfaces.ntfy.token'],
          }),
        ],
        externalSteps: [
          'Choose or create an ntfy topic.',
          'Optionally configure an authenticated ntfy token.',
          'Use provider actions to inspect subscribe and poll URLs.',
        ],
        metadata: {},
      };
    case 'webhook':
      return {
        surface,
        version: CHANNEL_SETUP_VERSION,
        label: 'Generic webhook',
        setupMode: 'webhook',
        description: 'Generic webhook is the universal JSON delivery contract for future clients and bridge services.',
        fields: [
          setupField('enabled', 'Enabled', 'boolean', false, { configKey: 'surfaces.webhook.enabled', defaultValue: false }),
          setupField('defaultTarget', 'Default target', 'url', false, { configKey: 'surfaces.webhook.defaultTarget' }),
          setupField('secret', 'Shared secret', 'secret', false, { configKey: 'surfaces.webhook.secret', secretTargetId: 'signingSecret' }),
        ],
        secretTargets: [
          secretTarget(surface, 'signingSecret', 'Shared secret', false, 'Used to sign or verify webhook payloads.', {
            configKeys: ['surfaces.webhook.secret'],
          }),
        ],
        externalSteps: [
          'Point the surface at a public webhook target that can receive GoodVibes JSON payloads.',
          'Optionally configure a shared secret for callback signing and verification.',
        ],
        metadata: {},
      };
    case 'telegram':
      return {
        surface,
        version: CHANNEL_SETUP_VERSION,
        label: 'Telegram',
        setupMode: 'bot',
        description: 'Telegram uses a bot token plus either webhook or polling mode and can route into a default chat or channel.',
        fields: [
          setupField('enabled', 'Enabled', 'boolean', false, { configKey: 'surfaces.telegram.enabled', defaultValue: false }),
          setupField('mode', 'Mode', 'select', true, {
            configKey: 'surfaces.telegram.mode',
            options: [{ value: 'webhook', label: 'Webhook' }, { value: 'polling', label: 'Polling' }],
          }),
          setupField('botUsername', 'Bot username', 'string', false, { configKey: 'surfaces.telegram.botUsername', placeholder: '@goodvibes_bot' }),
          setupField('defaultChatId', 'Default chat id', 'string', false, { configKey: 'surfaces.telegram.defaultChatId', placeholder: '-1001234567890' }),
          setupField('botToken', 'Bot token', 'secret', true, { configKey: 'surfaces.telegram.botToken', secretTargetId: 'primary' }),
          setupField('webhookSecret', 'Webhook secret', 'secret', false, { configKey: 'surfaces.telegram.webhookSecret', secretTargetId: 'signingSecret' }),
        ],
        secretTargets: [
          secretTarget(surface, 'primary', 'Bot token', true, 'Used for Telegram bot API calls and inbound verification.', {
            serviceName: 'telegram',
            serviceField: 'primary',
            envKeys: ['TELEGRAM_BOT_TOKEN'],
            configKeys: ['surfaces.telegram.botToken'],
          }),
          secretTarget(surface, 'signingSecret', 'Webhook secret', false, 'Used to validate webhook callbacks when Telegram is in webhook mode.', {
            serviceName: 'telegram',
            serviceField: 'signingSecret',
            envKeys: ['TELEGRAM_WEBHOOK_SECRET'],
            configKeys: ['surfaces.telegram.webhookSecret'],
          }),
        ],
        externalSteps: [
          'Create a Telegram bot with BotFather.',
          'Store the bot token and optional webhook secret.',
          'Choose webhook or polling mode and set the default chat/group/channel if you want direct delivery.',
        ],
        metadata: {},
      };
    case 'google-chat':
      return {
        surface,
        version: CHANNEL_SETUP_VERSION,
        label: 'Google Chat',
        setupMode: 'webhook',
        description: 'Google Chat can use app callbacks or webhook-style delivery into a default space.',
        fields: [
          setupField('enabled', 'Enabled', 'boolean', false, { configKey: 'surfaces.googleChat.enabled', defaultValue: false }),
          setupField('appId', 'App id', 'string', false, { configKey: 'surfaces.googleChat.appId' }),
          setupField('spaceId', 'Default space id', 'string', false, { configKey: 'surfaces.googleChat.spaceId' }),
          setupField('webhookUrl', 'Webhook URL', 'secret', false, { configKey: 'surfaces.googleChat.webhookUrl', secretTargetId: 'webhookUrl' }),
          setupField('verificationToken', 'Verification token', 'secret', false, { configKey: 'surfaces.googleChat.verificationToken', secretTargetId: 'signingSecret' }),
        ],
        secretTargets: [
          secretTarget(surface, 'webhookUrl', 'Webhook URL', false, 'Used for outbound delivery into Google Chat spaces.', {
            serviceName: 'google-chat',
            serviceField: 'webhookUrl',
            envKeys: ['GOOGLE_CHAT_WEBHOOK_URL'],
            configKeys: ['surfaces.googleChat.webhookUrl'],
          }),
          secretTarget(surface, 'signingSecret', 'Verification token', false, 'Used to verify inbound Google Chat events.', {
            serviceName: 'google-chat',
            serviceField: 'signingSecret',
            envKeys: ['GOOGLE_CHAT_VERIFICATION_TOKEN'],
            configKeys: ['surfaces.googleChat.verificationToken'],
          }),
        ],
        externalSteps: [
          'Create a Google Chat app or webhook in the target workspace.',
          'Store the webhook URL and verification token if the app receives events.',
          'Set a default space id if you want direct delivery routing.',
        ],
        metadata: {},
      };
    case 'signal':
      return {
        surface,
        version: CHANNEL_SETUP_VERSION,
        label: 'Signal',
        setupMode: 'bridge',
        description: 'Signal relies on a trusted bridge or relay with an account identifier and access token.',
        fields: [
          setupField('enabled', 'Enabled', 'boolean', false, { configKey: 'surfaces.signal.enabled', defaultValue: false }),
          setupField('bridgeUrl', 'Bridge URL', 'url', true, { configKey: 'surfaces.signal.bridgeUrl', placeholder: 'https://signal-bridge.example.test' }),
          setupField('account', 'Account', 'string', true, { configKey: 'surfaces.signal.account' }),
          setupField('defaultRecipient', 'Default recipient', 'string', false, { configKey: 'surfaces.signal.defaultRecipient' }),
          setupField('token', 'Bridge token', 'secret', false, { configKey: 'surfaces.signal.token', secretTargetId: 'primary' }),
        ],
        secretTargets: [
          secretTarget(surface, 'primary', 'Bridge token', false, 'Used to authenticate against the Signal bridge.', {
            serviceName: 'signal',
            serviceField: 'primary',
            envKeys: ['SIGNAL_BRIDGE_TOKEN'],
            configKeys: ['surfaces.signal.token'],
          }),
        ],
        externalSteps: [
          'Deploy or point at a trusted Signal bridge.',
          'Pair the bridge with the Signal account used by GoodVibes.',
          'Store the bridge URL, account identifier, and access token if required.',
        ],
        metadata: {},
      };
    case 'whatsapp':
      return {
        surface,
        version: CHANNEL_SETUP_VERSION,
        label: 'WhatsApp',
        setupMode: 'bot',
        description: 'WhatsApp supports Meta Cloud API mode or a bridge-backed mode with provider verification and recipient routing.',
        fields: [
          setupField('enabled', 'Enabled', 'boolean', false, { configKey: 'surfaces.whatsapp.enabled', defaultValue: false }),
          setupField('provider', 'Provider', 'select', true, {
            configKey: 'surfaces.whatsapp.provider',
            options: [{ value: 'meta-cloud', label: 'Meta Cloud API' }, { value: 'bridge', label: 'Bridge' }],
          }),
          setupField('phoneNumberId', 'Phone number id', 'string', false, { configKey: 'surfaces.whatsapp.phoneNumberId' }),
          setupField('businessAccountId', 'Business account id', 'string', false, { configKey: 'surfaces.whatsapp.businessAccountId' }),
          setupField('defaultRecipient', 'Default recipient', 'string', false, { configKey: 'surfaces.whatsapp.defaultRecipient' }),
          setupField('accessToken', 'Access token', 'secret', true, { configKey: 'surfaces.whatsapp.accessToken', secretTargetId: 'primary' }),
          setupField('verifyToken', 'Verify token', 'secret', false, { configKey: 'surfaces.whatsapp.verifyToken', secretTargetId: 'signingSecret' }),
        ],
        secretTargets: [
          secretTarget(surface, 'primary', 'Access token', true, 'Used for WhatsApp provider API calls.', {
            serviceName: 'whatsapp',
            serviceField: 'primary',
            envKeys: ['WHATSAPP_ACCESS_TOKEN'],
            configKeys: ['surfaces.whatsapp.accessToken'],
          }),
          secretTarget(surface, 'signingSecret', 'Verify token', false, 'Used for inbound webhook or provider verification.', {
            serviceName: 'whatsapp',
            serviceField: 'signingSecret',
            envKeys: ['WHATSAPP_VERIFY_TOKEN'],
            configKeys: ['surfaces.whatsapp.verifyToken'],
          }),
        ],
        externalSteps: [
          'Choose Meta Cloud API or a bridge-backed deployment.',
          'Store the access token and any verify token required by the provider.',
          'Set the phone number id, business account id, and default recipient if you want direct routing.',
        ],
        metadata: {},
      };
    case 'imessage':
      return {
        surface,
        version: CHANNEL_SETUP_VERSION,
        label: 'iMessage',
        setupMode: 'bridge',
        description: 'iMessage is bridge-backed and expects a local or hosted companion that owns platform-native message delivery.',
        fields: [
          setupField('enabled', 'Enabled', 'boolean', false, { configKey: 'surfaces.imessage.enabled', defaultValue: false }),
          setupField('bridgeUrl', 'Bridge URL', 'url', true, { configKey: 'surfaces.imessage.bridgeUrl', placeholder: 'https://imessage-bridge.example.test' }),
          setupField('account', 'Account', 'string', true, { configKey: 'surfaces.imessage.account' }),
          setupField('defaultChatId', 'Default chat id', 'string', false, { configKey: 'surfaces.imessage.defaultChatId' }),
          setupField('token', 'Bridge token', 'secret', false, { configKey: 'surfaces.imessage.token', secretTargetId: 'primary' }),
        ],
        secretTargets: [
          secretTarget(surface, 'primary', 'Bridge token', false, 'Used to authenticate against the iMessage bridge.', {
            serviceName: 'imessage',
            serviceField: 'primary',
            envKeys: ['IMESSAGE_BRIDGE_TOKEN'],
            configKeys: ['surfaces.imessage.token'],
          }),
        ],
        externalSteps: [
          'Run or connect to a trusted iMessage bridge or local companion.',
          'Store the bridge URL and account identifier.',
          'Configure a bridge token if the companion requires authenticated delivery.',
        ],
        metadata: {},
      };
    case 'msteams':
      return {
        surface,
        version: CHANNEL_SETUP_VERSION,
        label: 'Microsoft Teams',
        setupMode: 'bot',
        description: 'Microsoft Teams uses a Bot Framework application identity and conversation references for proactive delivery.',
        fields: [
          setupField('enabled', 'Enabled', 'boolean', false, { configKey: 'surfaces.msteams.enabled', defaultValue: false }),
          setupField('appId', 'App id', 'string', true, { configKey: 'surfaces.msteams.appId' }),
          setupField('appPassword', 'App password', 'secret', true, { configKey: 'surfaces.msteams.appPassword', secretTargetId: 'password' }),
          setupField('tenantId', 'Tenant id', 'string', false, { configKey: 'surfaces.msteams.tenantId', placeholder: 'botframework.com' }),
          setupField('botId', 'Bot id', 'string', false, { configKey: 'surfaces.msteams.botId' }),
          setupField('serviceUrl', 'Service URL', 'url', false, { configKey: 'surfaces.msteams.serviceUrl', placeholder: 'https://smba.trafficmanager.net/teams/' }),
          setupField('defaultConversationId', 'Default conversation id', 'string', false, { configKey: 'surfaces.msteams.defaultConversationId' }),
          setupField('defaultChannelId', 'Default channel id', 'string', false, { configKey: 'surfaces.msteams.defaultChannelId' }),
        ],
        secretTargets: [
          secretTarget(surface, 'password', 'App password', true, 'Used to request Bot Framework access tokens for outbound Teams delivery.', {
            serviceName: 'msteams',
            serviceField: 'password',
            envKeys: ['MSTEAMS_APP_PASSWORD'],
            configKeys: ['surfaces.msteams.appPassword'],
          }),
        ],
        externalSteps: [
          'Register a Microsoft Teams / Bot Framework app and capture the app id and password.',
          'Expose the GoodVibes Teams webhook endpoint to Azure Bot Service.',
          'Send at least one inbound message from each target conversation to seed proactive reply routing, or configure a default conversation id and service URL.',
        ],
        metadata: {},
      };
    case 'bluebubbles':
      return {
        surface,
        version: CHANNEL_SETUP_VERSION,
        label: 'BlueBubbles',
        setupMode: 'bridge',
        description: 'BlueBubbles provides a richer iMessage bridge with server password auth and chat-guid based delivery.',
        fields: [
          setupField('enabled', 'Enabled', 'boolean', false, { configKey: 'surfaces.bluebubbles.enabled', defaultValue: false }),
          setupField('serverUrl', 'Server URL', 'url', true, { configKey: 'surfaces.bluebubbles.serverUrl', placeholder: 'https://bluebubbles.example.test' }),
          setupField('password', 'Server password', 'secret', true, { configKey: 'surfaces.bluebubbles.password', secretTargetId: 'password' }),
          setupField('account', 'Account', 'string', false, { configKey: 'surfaces.bluebubbles.account' }),
          setupField('defaultChatGuid', 'Default chat guid', 'string', false, { configKey: 'surfaces.bluebubbles.defaultChatGuid', placeholder: 'iMessage;-;+15551234567' }),
        ],
        secretTargets: [
          secretTarget(surface, 'password', 'Server password', true, 'Used to authenticate against the BlueBubbles server.', {
            serviceName: 'bluebubbles',
            serviceField: 'password',
            envKeys: ['BLUEBUBBLES_PASSWORD'],
            configKeys: ['surfaces.bluebubbles.password'],
          }),
        ],
        externalSteps: [
          'Run BlueBubbles Server and configure its webhook to point at the GoodVibes BlueBubbles endpoint.',
          'Store the BlueBubbles server URL and password.',
          'Set a default chat guid if you want direct proactive delivery.',
        ],
        metadata: {},
      };
    case 'mattermost':
      return {
        surface,
        version: CHANNEL_SETUP_VERSION,
        label: 'Mattermost',
        setupMode: 'bot',
        description: 'Mattermost uses a bot token and base URL, with direct post delivery and optional slash-command style webhook ingress.',
        fields: [
          setupField('enabled', 'Enabled', 'boolean', false, { configKey: 'surfaces.mattermost.enabled', defaultValue: false }),
          setupField('baseUrl', 'Base URL', 'url', true, { configKey: 'surfaces.mattermost.baseUrl', placeholder: 'https://mattermost.example.test' }),
          setupField('botToken', 'Bot token', 'secret', true, { configKey: 'surfaces.mattermost.botToken', secretTargetId: 'primary' }),
          setupField('teamId', 'Team id', 'string', false, { configKey: 'surfaces.mattermost.teamId' }),
          setupField('defaultChannelId', 'Default channel id', 'string', false, { configKey: 'surfaces.mattermost.defaultChannelId' }),
        ],
        secretTargets: [
          secretTarget(surface, 'primary', 'Bot token', true, 'Used for Mattermost API calls and authenticated webhook ingress.', {
            serviceName: 'mattermost',
            serviceField: 'primary',
            envKeys: ['MATTERMOST_BOT_TOKEN'],
            configKeys: ['surfaces.mattermost.botToken'],
          }),
        ],
        externalSteps: [
          'Create a Mattermost bot and store its token.',
          'Set the Mattermost base URL and default channel id if you want direct proactive delivery.',
          'Optionally point a slash command or trusted webhook relay at the GoodVibes Mattermost endpoint.',
        ],
        metadata: {},
      };
    case 'matrix':
      return {
        surface,
        version: CHANNEL_SETUP_VERSION,
        label: 'Matrix',
        setupMode: 'bot',
        description: 'Matrix uses a homeserver URL plus access token, with room-id based delivery and webhook-friendly inbound normalization.',
        fields: [
          setupField('enabled', 'Enabled', 'boolean', false, { configKey: 'surfaces.matrix.enabled', defaultValue: false }),
          setupField('homeserverUrl', 'Homeserver URL', 'url', true, { configKey: 'surfaces.matrix.homeserverUrl', placeholder: 'https://matrix.example.org' }),
          setupField('accessToken', 'Access token', 'secret', true, { configKey: 'surfaces.matrix.accessToken', secretTargetId: 'primary' }),
          setupField('userId', 'User id', 'string', false, { configKey: 'surfaces.matrix.userId', placeholder: '@goodvibes:example.org' }),
          setupField('defaultRoomId', 'Default room id', 'string', false, { configKey: 'surfaces.matrix.defaultRoomId', placeholder: '!roomid:example.org' }),
        ],
        secretTargets: [
          secretTarget(surface, 'primary', 'Access token', true, 'Used for Matrix homeserver API calls and trusted webhook ingress.', {
            serviceName: 'matrix',
            serviceField: 'primary',
            envKeys: ['MATRIX_ACCESS_TOKEN'],
            configKeys: ['surfaces.matrix.accessToken'],
          }),
        ],
        externalSteps: [
          'Create or provision a Matrix bot user and access token on the target homeserver.',
          'Store the homeserver URL, access token, and default room id if you want direct proactive delivery.',
          'Forward Matrix events into the GoodVibes Matrix endpoint or pair a future sync worker against the same API contract.',
        ],
        metadata: {},
      };
  }
}

function secretTarget(
  surface: ChannelSurface,
  id: string,
  label: string,
  required: boolean,
  detail: string,
  input: Partial<ChannelSecretTargetDescriptor> = {},
): ChannelSecretTargetDescriptor {
  return {
    id,
    surface,
    label,
    required,
    supports: DEFAULT_SECRET_BACKENDS,
    detail,
    metadata: {},
    ...input,
  };
}

function setupField(
  id: string,
  label: string,
  kind: ChannelSetupFieldDescriptor['kind'],
  required: boolean,
  input: Partial<ChannelSetupFieldDescriptor> = {},
): ChannelSetupFieldDescriptor {
  return {
    id,
    label,
    kind,
    required,
    metadata: {},
    ...input,
  };
}
