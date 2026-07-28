/**
 * channels.ts — which channels `goodvibes-daemon send` can reach, and which one
 * it uses when the operator names none.
 *
 * The surface list, labels and required-setup keys are IMPORTED from
 * `src/cli/surface-command.ts` rather than restated, so `goodvibes surfaces
 * list` and `goodvibes-daemon send --list` can never disagree about what a
 * channel is called or what it needs. What this module adds on top is the two
 * facts that command needs and `SURFACE_CONFIGS` does not carry: the routable
 * `ChannelDeliverySurfaceKind` for each surface id (they differ in case —
 * `googleChat` vs `google-chat`), and the settings key holding each surface's
 * default destination.
 */

import type { ConfigKey, ConfigManager } from '../../config/index.ts';
import type { ChannelDeliverySurfaceKind } from '@pellux/goodvibes-sdk/platform/channels';
import { SURFACE_CONFIGS } from '../../cli/surface-command.ts';
import { canRenderInert } from './inert-text.ts';

/**
 * The settings key holding each supported surface's default destination — the
 * chat, channel, topic or URL a message goes to when `--to` is not given.
 *
 * These are the SAME keys the delivery strategies in the SDK's
 * `strategies-core.ts` fall back to (`surfaces.telegram.defaultChatId`,
 * `surfaces.discord.defaultChannelId`, …). Only surfaces with a verified inert
 * transform appear; see inert-text.ts for why the rest are refused rather than
 * sent to.
 */
const DESTINATION_KEY_BY_SURFACE_ID = {
  telegram: 'surfaces.telegram.defaultChatId',
  ntfy: 'surfaces.ntfy.topic',
  discord: 'surfaces.discord.defaultChannelId',
  slack: 'surfaces.slack.defaultChannel',
  googleChat: 'surfaces.googleChat.webhookUrl',
  webhook: 'surfaces.webhook.defaultTarget',
  signal: 'surfaces.signal.defaultRecipient',
  whatsapp: 'surfaces.whatsapp.defaultRecipient',
  imessage: 'surfaces.imessage.defaultChatId',
  msteams: 'surfaces.msteams.defaultConversationId',
  bluebubbles: 'surfaces.bluebubbles.defaultChatGuid',
  mattermost: 'surfaces.mattermost.defaultChannelId',
  matrix: 'surfaces.matrix.defaultRoomId',
  // Not cast: every value is checked against the real ConfigKey union, so a
  // key that is renamed or misspelled in the schema fails the build here
  // instead of reading `undefined` at send time and reporting the channel as
  // unconfigured.
} as const satisfies Readonly<Record<string, ConfigKey>>;

/** Surface ids whose routable kind is not simply the id itself. */
const SURFACE_KIND_BY_ID: Readonly<Record<string, ChannelDeliverySurfaceKind>> = {
  googleChat: 'google-chat',
};

/**
 * What `--to` addresses on each channel, in that channel's own vocabulary.
 *
 * This is naming, not a scheme: `--to` becomes `ChannelDeliveryTarget.address`,
 * which is the first thing every strategy in `strategies-core.ts`,
 * `strategies-bridge.ts` and `strategies-enterprise.ts` already checks before
 * falling back to its configured default. Nothing new is invented — the label
 * exists so `--list` and the help can say "topic" where the channel says topic
 * and "chat id" where it says chat id, rather than making the operator work out
 * what an "address" is for ntfy.
 */
const ADDRESS_LABEL_BY_SURFACE_ID: Readonly<Record<string, string>> = {
  telegram: 'chat id',
  ntfy: 'topic',
  discord: 'channel id',
  slack: 'channel id',
  googleChat: 'webhook URL',
  webhook: 'URL',
  signal: 'recipient',
  whatsapp: 'recipient',
  imessage: 'chat id',
  msteams: 'conversation id',
  bluebubbles: 'chat GUID',
  mattermost: 'channel id',
  matrix: 'room id',
};

export interface SendChannel {
  /** The id an operator types after `--channel`, e.g. `telegram`. */
  readonly id: string;
  /** Human label, shared with `goodvibes surfaces list`. */
  readonly label: string;
  /** The kind the channel delivery router routes on. */
  readonly surfaceKind: ChannelDeliverySurfaceKind;
  /** `surfaces.<id>.enabled`. */
  readonly enabledKey: ConfigKey;
  /** The settings key holding this channel's default destination. */
  readonly destinationKey: ConfigKey;
  /** What `--to` names on this channel, in the channel's own words ("topic"). */
  readonly addressLabel: string;
}

/**
 * Every channel this command can deliver to. Derived, not restated: a surface
 * that gains a delivery strategy and an inert transform appears here by adding
 * its destination key above, and a surface that loses its entry in
 * `SURFACE_CONFIGS` disappears from both commands at once.
 */
const destinationKeys: Readonly<Record<string, ConfigKey>> = DESTINATION_KEY_BY_SURFACE_ID;

export const SEND_CHANNELS: readonly SendChannel[] = SURFACE_CONFIGS
  .flatMap(([id, label]): SendChannel[] => {
    const destinationKey = destinationKeys[id];
    if (!destinationKey) return [];
    const surfaceKind = SURFACE_KIND_BY_ID[id] ?? (id as ChannelDeliverySurfaceKind);
    if (!canRenderInert(surfaceKind)) return [];
    return [{
      id,
      label,
      surfaceKind,
      enabledKey: `surfaces.${id}.enabled` as ConfigKey,
      destinationKey,
      addressLabel: ADDRESS_LABEL_BY_SURFACE_ID[id] ?? 'address',
    }];
  });

/**
 * Look a channel up by the id an operator typed, accepting either the settings
 * id (`googleChat`) or the routable kind (`google-chat`) — the two spellings
 * are both visible in this product's own output, and making the operator
 * remember which one this command wants would be a trap.
 */
export function findSendChannel(name: string): SendChannel | undefined {
  const wanted = name.trim().toLowerCase();
  return SEND_CHANNELS.find((channel) =>
    channel.id.toLowerCase() === wanted || channel.surfaceKind.toLowerCase() === wanted);
}

export interface ChannelReadiness {
  readonly channel: SendChannel;
  /** `surfaces.<id>.enabled` is true. */
  readonly enabled: boolean;
  /** The configured default destination, or null when the key is blank. */
  readonly destination: string | null;
}

function readSetting(config: Pick<ConfigManager, 'get'>, key: ConfigKey): string {
  const value = config.get(key);
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
}

/**
 * Read every channel's live state from config.
 *
 * The `ConfigManager` handed in must be one built with a `homeDir`, because
 * every `surfaces.*` key is daemon-owned: the manager overlays
 * `<home>/.goodvibes/daemon/settings.json` LAST, which is the only reason a
 * client process can see a bot token the daemon owns. A manager built without
 * that overlay reads a surface silo holding nothing but `setupVersion` and
 * reports every channel as unconfigured.
 */
export function readChannelReadiness(config: Pick<ConfigManager, 'get'>): readonly ChannelReadiness[] {
  return SEND_CHANNELS.map((channel) => {
    const destination = readSetting(config, channel.destinationKey);
    return {
      channel,
      enabled: config.get(channel.enabledKey) === true,
      destination: destination.length > 0 ? destination : null,
    };
  });
}

export type DefaultChannelResolution =
  | { readonly kind: 'resolved'; readonly channel: SendChannel; readonly destination: string; readonly reason: string }
  | { readonly kind: 'none'; readonly candidates: readonly ChannelReadiness[] }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly ChannelReadiness[] };

/**
 * Which channel a `send` with no `--channel` goes to.
 *
 * A channel qualifies when it is switched on AND has a destination configured —
 * "enabled" alone is not enough, because an enabled surface with a blank
 * destination is a channel that would throw at the provider rather than deliver.
 *
 * **Ambiguity refuses; it never picks.** With two qualifying channels there is
 * no non-arbitrary winner, and this command has an outward effect: sending the
 * owner's message to the wrong one of his channels is worse than printing the
 * list and exiting non-zero. There is deliberately no priority order here to
 * silently break that tie — a preference ordering baked into this file would be
 * an invisible decision about where his messages go.
 */
export function resolveDefaultChannel(config: Pick<ConfigManager, 'get'>): DefaultChannelResolution {
  const readiness = readChannelReadiness(config);
  const qualifying = readiness.filter((entry) => entry.enabled && entry.destination !== null);
  if (qualifying.length === 1) {
    const only = qualifying[0]!;
    return {
      kind: 'resolved',
      channel: only.channel,
      destination: only.destination!,
      reason: 'the only channel that is switched on and has a destination configured',
    };
  }
  if (qualifying.length === 0) return { kind: 'none', candidates: readiness };
  return { kind: 'ambiguous', candidates: qualifying };
}
