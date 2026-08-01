// ---------------------------------------------------------------------------
// onboarding-wizard-external-surfaces.ts
//
// The channel setup FIELD SET is owned by the SDK: getBuiltinSetupSchema is the
// single source of truth for which fields each surface has, their config keys,
// and their input kind. This module no longer re-authors that schema. Instead it
// builds the onboarding ExternalSurfaceSpec[] by reading the SDK schema and
// layering a clearly-separated, genuinely-TUI-only PRESENTATION overlay on top:
//   • onboarding field-id namespace (`external-services.<surface>.<field>`),
//   • curated per-field label / hint / placeholder wording,
//   • the per-surface auto-start enablement model (see the auto-start helpers),
//   • numeric UI bounds (min/max) the SDK schema does not carry,
//   • radio option copy (with hints) for select fields.
// Everything else — a field's existence, its config key, its input kind, and its
// default value — is derived from the SDK schema + DEFAULT_CONFIG, so the two can
// never silently drift. A field the overlay names that the SDK no longer defines
// is a loud build error; a field the SDK adds that the overlay has not curated is
// appended automatically with SDK-derived presentation.
//
// Two fields are genuine TUI-only extras the onboarding exposes but the SDK setup
// schema intentionally omits (surfaces.ntfy.defaultPriority, surfaces.webhook.
// timeoutMs). They are declared with `tuiOnly` and are not matched to the SDK.
// ---------------------------------------------------------------------------

import {
  GOODVIBES_NTFY_AGENT_TOPIC,
  GOODVIBES_NTFY_CHAT_TOPIC,
  GOODVIBES_NTFY_REMOTE_TOPIC,
  resolveGoodVibesNtfyTopics,
} from '@pellux/goodvibes-sdk/platform/integrations';
import { getBuiltinSetupSchema } from '@pellux/goodvibes-sdk/platform/channels';
import type {
  ChannelSetupFieldDescriptor,
  ChannelSetupFieldKind,
  ChannelSurface,
} from '@pellux/goodvibes-sdk/platform/channels';
import { DEFAULT_CONFIG, type ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import type { OnboardingSnapshotState } from '../../runtime/onboarding/index.ts';
import { TELEGRAM_MODE_OPTIONS, WHATSAPP_PROVIDER_OPTIONS } from './onboarding-wizard-constants.ts';
import type { ExternalSurfaceSetupFieldSpec, ExternalSurfaceSpec, OnboardingWizardRadioOption } from './onboarding-wizard-types.ts';

export type { ExternalSurfaceSetupFieldSpec, ExternalSurfaceSpec };

function normalizeConfigValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function readConfigPath(config: unknown, key: ConfigKey): unknown {
  return key.split('.').reduce<unknown>((cursor, part) => (
    typeof cursor === 'object' && cursor !== null && part in cursor
      ? (cursor as Record<string, unknown>)[part]
      : undefined
  ), config);
}

function getDefaultConfigValue(key: ConfigKey): unknown {
  return readConfigPath(DEFAULT_CONFIG, key);
}

/** camelCase / kebab-in → kebab-case (for onboarding field ids). */
function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * The default value shown for a field. Derived, not hand-authored: the current
 * snapshot value if present, otherwise the config default (DEFAULT_CONFIG) — which
 * is exactly what the previous per-field literals returned. Numbers stringify.
 */
function readFieldDefault(configKey: ConfigKey, snapshot: OnboardingSnapshotState | null): string {
  const fromSnapshot = snapshot ? readConfigPath(snapshot.config, configKey) : undefined;
  const chosen = fromSnapshot ?? getDefaultConfigValue(configKey);
  return chosen === null || chosen === undefined ? '' : String(chosen);
}

/** Map an SDK setup-field kind to an onboarding input kind. */
function mapSdkKind(kind: ChannelSetupFieldKind): 'text' | 'masked' | 'radio' {
  if (kind === 'secret') return 'masked';
  if (kind === 'select') return 'radio';
  return 'text'; // string | url | number | boolean → text (boolean=enabled is handled separately)
}

// ---- the TUI-only presentation overlay -----------------------------------

interface SurfaceFieldOverlay {
  /** Join key to the SDK schema (and the config path). */
  readonly configKey: ConfigKey;
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
  /** Radio option copy (with hints) for a select field. */
  readonly options?: readonly OnboardingWizardRadioOption[];
  /** Numeric UI bounds the SDK schema does not carry. */
  readonly defaultNumber?: number;
  readonly min?: number;
  readonly max?: number;
  /** Set only for a field the SDK setup schema does not define (TUI-only extra). */
  readonly tuiOnly?: { readonly kind: 'text' | 'masked'; readonly valueType?: 'number' };
}

interface SurfaceOverlay {
  /** ExternalSurfaceSpec.id and the `surfaces.<id>.*` config segment (camelCase for google chat). */
  readonly onboardingId: string;
  /** The SDK ChannelSurface whose setup schema owns this surface's field set. */
  readonly sdkSurface: ChannelSurface;
  readonly label: string;
  readonly hint: string;
  /** Fields in onboarding display order; each references an SDK field by configKey (or a tuiOnly extra). */
  readonly fields: readonly SurfaceFieldOverlay[];
}

const SURFACE_OVERLAYS: readonly SurfaceOverlay[] = [
  {
    onboardingId: 'slack',
    sdkSurface: 'slack',
    label: 'Slack surface',
    hint: 'Enable Slack messages, slash-command/event handling, and thread-aware replies.',
    fields: [
      { configKey: 'surfaces.slack.botToken', label: 'Slack bot token', hint: 'Token used by the Slack bot integration.', placeholder: 'xoxb-...' },
      { configKey: 'surfaces.slack.appToken', label: 'Slack app token', hint: 'Optional app-level token for Socket Mode deployments.', placeholder: 'xapp-...' },
      { configKey: 'surfaces.slack.signingSecret', label: 'Slack signing secret', hint: 'Signing secret used to verify inbound Slack events.', placeholder: 'signing secret' },
      { configKey: 'surfaces.slack.workspaceId', label: 'Slack workspace ID', hint: 'Workspace/team ID used to scope Slack routing.', placeholder: 'T...' },
      { configKey: 'surfaces.slack.defaultChannel', label: 'Slack default channel', hint: 'Fallback Slack channel for messages that do not specify a target.', placeholder: '#goodvibes' },
    ],
  },
  {
    onboardingId: 'discord',
    sdkSurface: 'discord',
    label: 'Discord surface',
    hint: 'Enable Discord command/event handling and channel replies.',
    fields: [
      { configKey: 'surfaces.discord.botToken', label: 'Discord bot token', hint: 'Token used by the Discord bot integration.', placeholder: 'bot token' },
      { configKey: 'surfaces.discord.publicKey', label: 'Discord public key', hint: 'Application public key for verifying interaction signatures.', placeholder: 'public key' },
      { configKey: 'surfaces.discord.applicationId', label: 'Discord application ID', hint: 'Application/client ID for the Discord integration.', placeholder: 'application id' },
      { configKey: 'surfaces.discord.guildId', label: 'Discord guild ID', hint: 'Optional default server/guild ID.', placeholder: 'guild id' },
      { configKey: 'surfaces.discord.defaultChannelId', label: 'Discord default channel ID', hint: 'Fallback Discord channel for outbound messages.', placeholder: 'channel id' },
    ],
  },
  {
    onboardingId: 'telegram',
    sdkSurface: 'telegram',
    label: 'Telegram surface',
    hint: 'Enable Telegram bot messaging and event handling.',
    fields: [
      { configKey: 'surfaces.telegram.botToken', label: 'Telegram bot token', hint: 'Token issued by BotFather.', placeholder: 'bot token' },
      { configKey: 'surfaces.telegram.webhookSecret', label: 'Telegram webhook secret', hint: 'Secret token used to verify Telegram webhook requests.', placeholder: 'webhook secret' },
      { configKey: 'surfaces.telegram.defaultChatId', label: 'Telegram default chat ID', hint: 'Fallback chat ID for outbound Telegram messages.', placeholder: 'chat id' },
      { configKey: 'surfaces.telegram.botUsername', label: 'Telegram bot username', hint: 'Bot username used in visible routing labels.', placeholder: '@goodvibes_bot' },
      { configKey: 'surfaces.telegram.mode', label: 'Telegram delivery mode', hint: 'Choose webhook or polling transport.', placeholder: 'webhook', options: TELEGRAM_MODE_OPTIONS },
    ],
  },
  {
    onboardingId: 'ntfy',
    sdkSurface: 'ntfy',
    label: 'ntfy surface',
    hint: 'Configure ntfy chat, agent, remote-session, and notification delivery topics.',
    fields: [
      { configKey: 'surfaces.ntfy.baseUrl', label: 'ntfy base URL', hint: 'Base URL of the ntfy server.', placeholder: 'https://ntfy.sh' },
      { configKey: 'surfaces.ntfy.chatTopic', label: 'ntfy chat topic', hint: 'Messages sent here attach to the active terminal TUI session and reply back to ntfy.', placeholder: GOODVIBES_NTFY_CHAT_TOPIC },
      { configKey: 'surfaces.ntfy.agentTopic', label: 'ntfy agent topic', hint: 'Messages sent here start agent work attached to the active TUI session.', placeholder: GOODVIBES_NTFY_AGENT_TOPIC },
      { configKey: 'surfaces.ntfy.remoteTopic', label: 'ntfy daemon-only remote topic', hint: 'Messages sent here start an ntfy remote session in the daemon and do not appear in the TUI.', placeholder: GOODVIBES_NTFY_REMOTE_TOPIC },
      { configKey: 'surfaces.ntfy.topic', label: 'ntfy default delivery topic', hint: 'Optional outbound notification topic. It does not control chat, agent, or daemon-only remote routing.', placeholder: 'goodvibes' },
      { configKey: 'surfaces.ntfy.token', label: 'ntfy token', hint: 'Optional token for authenticated ntfy servers.', placeholder: 'empty for anonymous ntfy' },
      { configKey: 'surfaces.ntfy.defaultPriority', label: 'ntfy default priority', hint: 'Default ntfy priority from 1 to 5.', placeholder: '3', defaultNumber: 3, min: 1, max: 5, tuiOnly: { kind: 'text', valueType: 'number' } },
    ],
  },
  {
    onboardingId: 'webhook',
    sdkSurface: 'webhook',
    label: 'Outbound webhook surface',
    hint: 'Enable outbound webhook delivery targets.',
    fields: [
      { configKey: 'surfaces.webhook.defaultTarget', label: 'Default webhook target', hint: 'Fallback URL used for outbound webhook deliveries.', placeholder: 'https://example.com/goodvibes' },
      { configKey: 'surfaces.webhook.secret', label: 'Webhook signing secret', hint: 'Secret used to sign outbound webhook payloads.', placeholder: 'secret' },
      { configKey: 'surfaces.webhook.timeoutMs', label: 'Webhook timeout ms', hint: 'Request timeout for outbound webhook deliveries.', placeholder: '10000', defaultNumber: 10000, min: 1000, max: 60000, tuiOnly: { kind: 'text', valueType: 'number' } },
    ],
  },
  {
    onboardingId: 'homeassistant',
    sdkSurface: 'homeassistant',
    label: 'Home Assistant surface',
    hint: 'Enable the Home Assistant companion surface, daemon callbacks, and event delivery.',
    fields: [
      { configKey: 'surfaces.homeassistant.instanceUrl', label: 'Home Assistant URL', hint: 'Base URL of the Home Assistant instance.', placeholder: 'http://homeassistant.local:8123' },
      { configKey: 'surfaces.homeassistant.accessToken', label: 'Home Assistant access token', hint: 'Long-lived Home Assistant access token or goodvibes:// secret reference.', placeholder: 'long-lived access token' },
      { configKey: 'surfaces.homeassistant.webhookSecret', label: 'Home Assistant webhook secret', hint: 'Shared secret used to verify inbound Home Assistant callbacks.', placeholder: 'webhook secret' },
      { configKey: 'surfaces.homeassistant.defaultConversationId', label: 'Default conversation ID', hint: 'Default Home Assistant conversation id used for route binding.', placeholder: 'goodvibes' },
      { configKey: 'surfaces.homeassistant.remoteSessionTtlMs', label: 'Remote session idle TTL ms', hint: 'How long an idle Home Assistant remote conversation session remains open before the daemon closes it.', placeholder: '1200000', defaultNumber: 1_200_000, min: 60_000, max: 86_400_000 },
      { configKey: 'surfaces.homeassistant.deviceId', label: 'Home Assistant device ID', hint: 'Stable device identifier exposed by the GoodVibes daemon.', placeholder: 'goodvibes-daemon' },
      { configKey: 'surfaces.homeassistant.deviceName', label: 'Home Assistant device name', hint: 'Display name for the GoodVibes daemon device in Home Assistant.', placeholder: 'GoodVibes Daemon' },
      { configKey: 'surfaces.homeassistant.eventType', label: 'Home Assistant event type', hint: 'Event type used for daemon-to-Home Assistant deliveries.', placeholder: 'goodvibes_message' },
    ],
  },
  {
    onboardingId: 'googleChat',
    sdkSurface: 'google-chat',
    label: 'Google Chat surface',
    hint: 'Enable Google Chat webhook and app routing.',
    fields: [
      { configKey: 'surfaces.googleChat.webhookUrl', label: 'Google Chat webhook URL', hint: 'Incoming webhook URL for Google Chat space delivery.', placeholder: 'webhook URL' },
      { configKey: 'surfaces.googleChat.verificationToken', label: 'Google Chat verification token', hint: 'Token used to verify inbound Google Chat events.', placeholder: 'verification token' },
      { configKey: 'surfaces.googleChat.appId', label: 'Google Chat app ID', hint: 'Google Chat app identifier.', placeholder: 'app id' },
      { configKey: 'surfaces.googleChat.spaceId', label: 'Google Chat space ID', hint: 'Default Google Chat space for outbound messages.', placeholder: 'space id' },
    ],
  },
  {
    onboardingId: 'signal',
    sdkSurface: 'signal',
    label: 'Signal surface',
    hint: 'Enable Signal bridge messaging.',
    fields: [
      { configKey: 'surfaces.signal.bridgeUrl', label: 'Signal bridge URL', hint: 'Base URL for the Signal bridge service.', placeholder: 'https://signal-bridge.local' },
      { configKey: 'surfaces.signal.account', label: 'Signal account', hint: 'Signal account identifier used by the bridge.', placeholder: '+15551234567' },
      { configKey: 'surfaces.signal.token', label: 'Signal bridge token', hint: 'Authentication token for the Signal bridge.', placeholder: 'token' },
      { configKey: 'surfaces.signal.defaultRecipient', label: 'Signal default recipient', hint: 'Fallback Signal recipient for outbound messages.', placeholder: '+15551234567' },
    ],
  },
  {
    onboardingId: 'whatsapp',
    sdkSurface: 'whatsapp',
    label: 'WhatsApp surface',
    hint: 'Enable WhatsApp Cloud API or bridge messaging.',
    fields: [
      { configKey: 'surfaces.whatsapp.provider', label: 'WhatsApp provider', hint: 'Choose Meta Cloud API or a bridge provider.', placeholder: 'meta-cloud', options: WHATSAPP_PROVIDER_OPTIONS },
      { configKey: 'surfaces.whatsapp.accessToken', label: 'WhatsApp access token', hint: 'Access token for the WhatsApp provider.', placeholder: 'access token' },
      { configKey: 'surfaces.whatsapp.verifyToken', label: 'WhatsApp verify token', hint: 'Verification token for webhook setup.', placeholder: 'verify token' },
      { configKey: 'surfaces.whatsapp.signingSecret', label: 'WhatsApp signing secret', hint: 'Secret used to verify signed WhatsApp events.', placeholder: 'signing secret' },
      { configKey: 'surfaces.whatsapp.phoneNumberId', label: 'WhatsApp phone number ID', hint: 'Phone number ID used by the WhatsApp Cloud API.', placeholder: 'phone number id' },
      { configKey: 'surfaces.whatsapp.businessAccountId', label: 'WhatsApp business account ID', hint: 'Business account ID for Cloud API routing.', placeholder: 'business account id' },
      { configKey: 'surfaces.whatsapp.defaultRecipient', label: 'WhatsApp default recipient', hint: 'Fallback recipient for outbound WhatsApp messages.', placeholder: '+15551234567' },
    ],
  },
  {
    onboardingId: 'imessage',
    sdkSurface: 'imessage',
    label: 'iMessage surface',
    hint: 'Enable iMessage bridge messaging.',
    fields: [
      { configKey: 'surfaces.imessage.bridgeUrl', label: 'iMessage bridge URL', hint: 'Base URL for the iMessage bridge.', placeholder: 'https://imessage-bridge.local' },
      { configKey: 'surfaces.imessage.account', label: 'iMessage account', hint: 'Bridge account identifier.', placeholder: 'account' },
      { configKey: 'surfaces.imessage.token', label: 'iMessage bridge token', hint: 'Authentication token for the iMessage bridge.', placeholder: 'token' },
      { configKey: 'surfaces.imessage.defaultChatId', label: 'iMessage default chat ID', hint: 'Fallback chat ID for outbound iMessage delivery.', placeholder: 'chat id' },
    ],
  },
  {
    onboardingId: 'msteams',
    sdkSurface: 'msteams',
    label: 'Microsoft Teams surface',
    hint: 'Enable Microsoft Teams bot conversations and channel replies.',
    fields: [
      { configKey: 'surfaces.msteams.appId', label: 'Teams app ID', hint: 'Application ID for the Teams bot registration.', placeholder: 'app id' },
      { configKey: 'surfaces.msteams.appPassword', label: 'Teams app password', hint: 'Client secret for the Teams bot registration.', placeholder: 'app password' },
      { configKey: 'surfaces.msteams.tenantId', label: 'Teams tenant ID', hint: 'Tenant ID that owns the Teams bot registration.', placeholder: 'tenant id' },
      { configKey: 'surfaces.msteams.serviceUrl', label: 'Teams service URL', hint: 'Optional Bot Framework service URL for replies.', placeholder: 'https://smba.trafficmanager.net/amer/' },
      { configKey: 'surfaces.msteams.botId', label: 'Teams bot ID', hint: 'Optional bot ID when it differs from the app ID.', placeholder: 'bot id' },
      { configKey: 'surfaces.msteams.defaultConversationId', label: 'Teams default conversation ID', hint: 'Fallback Teams conversation for outbound messages.', placeholder: 'conversation id' },
      { configKey: 'surfaces.msteams.defaultChannelId', label: 'Teams default channel ID', hint: 'Fallback Teams channel for outbound messages.', placeholder: 'channel id' },
    ],
  },
  {
    onboardingId: 'bluebubbles',
    sdkSurface: 'bluebubbles',
    label: 'BlueBubbles surface',
    hint: 'Enable BlueBubbles bridge messaging for iMessage-compatible deployments.',
    fields: [
      { configKey: 'surfaces.bluebubbles.serverUrl', label: 'BlueBubbles server URL', hint: 'Base URL of the BlueBubbles server.', placeholder: 'https://bluebubbles.local' },
      { configKey: 'surfaces.bluebubbles.password', label: 'BlueBubbles password', hint: 'Password used to authenticate with BlueBubbles.', placeholder: 'password' },
      { configKey: 'surfaces.bluebubbles.account', label: 'BlueBubbles account', hint: 'Optional account identifier used by the bridge.', placeholder: 'account' },
      { configKey: 'surfaces.bluebubbles.defaultChatGuid', label: 'BlueBubbles default chat GUID', hint: 'Fallback chat GUID for outbound BlueBubbles delivery.', placeholder: 'chat guid' },
    ],
  },
  {
    onboardingId: 'mattermost',
    sdkSurface: 'mattermost',
    label: 'Mattermost surface',
    hint: 'Enable Mattermost bot messaging and channel replies.',
    fields: [
      { configKey: 'surfaces.mattermost.baseUrl', label: 'Mattermost base URL', hint: 'Base URL of the Mattermost server.', placeholder: 'https://mattermost.example.com' },
      { configKey: 'surfaces.mattermost.botToken', label: 'Mattermost bot token', hint: 'Bot token used for Mattermost API calls.', placeholder: 'bot token' },
      { configKey: 'surfaces.mattermost.teamId', label: 'Mattermost team ID', hint: 'Optional default team for routing.', placeholder: 'team id' },
      { configKey: 'surfaces.mattermost.defaultChannelId', label: 'Mattermost default channel ID', hint: 'Fallback Mattermost channel for outbound messages.', placeholder: 'channel id' },
    ],
  },
  {
    onboardingId: 'telephony',
    sdkSurface: 'telephony',
    label: 'Telephony surface',
    hint: 'Enable SMS/voice notification delivery — direct Twilio, or a self-hosted bridge.',
    fields: [
      { configKey: 'surfaces.telephony.provider', label: 'Telephony provider', hint: 'twilio for direct Twilio delivery, bridge for a self-hosted telephony bridge.', placeholder: 'twilio' },
      { configKey: 'surfaces.telephony.mode', label: 'Telephony mode', hint: 'sms, voice (call with spoken text), or bridge.', placeholder: 'sms' },
      { configKey: 'surfaces.telephony.accountSid', label: 'Twilio account SID', hint: 'Account SID for direct Twilio delivery.', placeholder: 'AC...' },
      { configKey: 'surfaces.telephony.authToken', label: 'Twilio auth token', hint: 'Auth token for direct Twilio delivery.', placeholder: 'auth token' },
      { configKey: 'surfaces.telephony.fromNumber', label: 'From number', hint: 'The E.164 number outbound SMS/calls originate from.', placeholder: '+15551234567' },
      { configKey: 'surfaces.telephony.defaultRecipient', label: 'Default recipient', hint: 'Fallback E.164 number for outbound delivery.', placeholder: '+15557654321' },
      { configKey: 'surfaces.telephony.bridgeUrl', label: 'Bridge URL', hint: 'Base URL of the self-hosted telephony bridge (bridge provider only).', placeholder: 'https://telephony-bridge.example.test' },
      { configKey: 'surfaces.telephony.token', label: 'Bridge token', hint: 'Token used to authenticate with the telephony bridge.', placeholder: 'bridge token' },
      { configKey: 'surfaces.telephony.webhookSecret', label: 'Webhook secret', hint: 'Secret used to verify inbound telephony webhooks.', placeholder: 'webhook secret' },
    ],
  },
  {
    onboardingId: 'matrix',
    sdkSurface: 'matrix',
    label: 'Matrix surface',
    hint: 'Enable Matrix bot messaging and room replies.',
    fields: [
      { configKey: 'surfaces.matrix.homeserverUrl', label: 'Matrix homeserver URL', hint: 'Base URL of the Matrix homeserver.', placeholder: 'https://matrix.example.com' },
      { configKey: 'surfaces.matrix.accessToken', label: 'Matrix access token', hint: 'Access token for the Matrix bot user.', placeholder: 'access token' },
      { configKey: 'surfaces.matrix.userId', label: 'Matrix user ID', hint: 'Matrix user ID for the bot account.', placeholder: '@goodvibes:example.com' },
      { configKey: 'surfaces.matrix.defaultRoomId', label: 'Matrix default room ID', hint: 'Fallback Matrix room for outbound messages.', placeholder: '!room:example.com' },
    ],
  },
];

// ---- the builder: SDK schema (source of truth) + overlay (presentation) ---

function buildFieldFromOverlay(
  sdkSurface: ChannelSurface,
  sdkFields: ReadonlyMap<string, ChannelSetupFieldDescriptor>,
  overlay: SurfaceFieldOverlay,
): ExternalSurfaceSetupFieldSpec {
  const lastSegment = overlay.configKey.split('.').pop() ?? overlay.configKey;
  const id = `external-services.${kebab(sdkSurface)}.${kebab(lastSegment)}`;

  let kind: 'text' | 'masked' | 'radio';
  let valueType: 'number' | undefined;
  if (overlay.tuiOnly) {
    kind = overlay.tuiOnly.kind;
    valueType = overlay.tuiOnly.valueType;
  } else {
    const sdkField = sdkFields.get(overlay.configKey);
    if (!sdkField) {
      throw new Error(`onboarding overlay references ${overlay.configKey}, which the SDK setup schema for ${sdkSurface} no longer defines`);
    }
    kind = mapSdkKind(sdkField.kind);
    valueType = sdkField.kind === 'number' ? 'number' : undefined;
  }

  return {
    id,
    configKey: overlay.configKey,
    kind,
    label: overlay.label,
    hint: overlay.hint,
    placeholder: overlay.placeholder,
    ...(valueType ? { valueType } : {}),
    ...(overlay.options ? { options: overlay.options } : {}),
    ...(overlay.defaultNumber !== undefined ? { defaultNumber: overlay.defaultNumber } : {}),
    ...(overlay.min !== undefined ? { min: overlay.min } : {}),
    ...(overlay.max !== undefined ? { max: overlay.max } : {}),
    defaultValue: (snapshot) => readFieldDefault(overlay.configKey, snapshot),
  };
}

/** Append any SDK setup field the overlay has not curated, with SDK-derived presentation. */
function buildUncoveredSdkField(
  sdkSurface: ChannelSurface,
  sdkField: ChannelSetupFieldDescriptor,
): ExternalSurfaceSetupFieldSpec {
  const lastSegment = (sdkField.configKey ?? sdkField.id).split('.').pop() ?? sdkField.id;
  return {
    id: `external-services.${kebab(sdkSurface)}.${kebab(lastSegment)}`,
    configKey: (sdkField.configKey ?? '') as ConfigKey,
    kind: mapSdkKind(sdkField.kind),
    label: sdkField.label,
    hint: sdkField.detail ?? sdkField.label,
    placeholder: sdkField.placeholder ?? '',
    ...(sdkField.kind === 'number' ? { valueType: 'number' as const } : {}),
    ...(sdkField.options ? { options: sdkField.options.map((o) => ({ id: o.value, label: o.label, hint: o.label })) } : {}),
    defaultValue: (snapshot) => readFieldDefault((sdkField.configKey ?? '') as ConfigKey, snapshot),
  };
}

function buildSurfaceSpec(overlay: SurfaceOverlay): ExternalSurfaceSpec {
  const schema = getBuiltinSetupSchema(overlay.sdkSurface);
  const sdkFields = new Map<string, ChannelSetupFieldDescriptor>();
  for (const f of schema.fields) {
    if (f.configKey) sdkFields.set(f.configKey, f);
  }

  const curated = overlay.fields.map((f) => buildFieldFromOverlay(overlay.sdkSurface, sdkFields, f));

  // Auto-include any SDK field (other than the enabled toggle) the overlay did
  // not curate, so a new SDK channel field surfaces in onboarding automatically.
  const coveredKeys = new Set<string>(overlay.fields.filter((f) => !f.tuiOnly).map((f) => f.configKey));
  const enabledKey = `surfaces.${overlay.onboardingId}.enabled`;
  const appended: ExternalSurfaceSetupFieldSpec[] = [];
  for (const sdkField of schema.fields) {
    if (!sdkField.configKey) continue;
    if (sdkField.kind === 'boolean' || sdkField.configKey === enabledKey) continue;
    if (coveredKeys.has(sdkField.configKey)) continue;
    appended.push(buildUncoveredSdkField(overlay.sdkSurface, sdkField));
  }

  return {
    id: overlay.onboardingId,
    enabledFieldId: `external-services.${kebab(overlay.sdkSurface)}`,
    enabledConfigKey: `${enabledKey}` as ConfigKey,
    label: overlay.label,
    hint: overlay.hint,
    defaultEnabled: (snapshot) => Boolean(snapshot ? readConfigPath(snapshot.config, enabledKey as ConfigKey) : false),
    fields: [...curated, ...appended],
  };
}

export const EXTERNAL_SURFACE_SPECS: readonly ExternalSurfaceSpec[] = SURFACE_OVERLAYS.map(buildSurfaceSpec);

// ---- helpers (unchanged behavior) ----------------------------------------

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
