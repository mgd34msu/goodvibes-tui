import { createDomainDispatch } from '../runtime/store/index.ts';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.ts';
import type { SurfaceRecord } from '../runtime/store/domains/surfaces.ts';
import { ConfigManager } from '../config/manager.ts';
import type { ChannelPluginRegistry } from './plugin-registry.ts';

function now(): number {
  return Date.now();
}

export class SurfaceRegistry {
  private readonly configManager: ConfigManager;
  private readonly surfaces = new Map<string, SurfaceRecord>();
  private runtimeDispatch: DomainDispatch | null = null;
  private pluginRegistry: ChannelPluginRegistry | null = null;

  constructor(configManager: ConfigManager, runtimeStore?: RuntimeStore) {
    this.configManager = configManager;
    if (runtimeStore) this.runtimeDispatch = createDomainDispatch(runtimeStore);
  }

  attachRuntime(runtimeStore: RuntimeStore): void {
    this.runtimeDispatch = createDomainDispatch(runtimeStore);
    for (const surface of this.surfaces.values()) {
      this.runtimeDispatch.syncSurface(surface, 'surfaces.attach');
    }
  }

  attachPluginRegistry(pluginRegistry: ChannelPluginRegistry): void {
    this.pluginRegistry = pluginRegistry;
  }

  syncConfiguredSurfaces(): SurfaceRecord[] {
    const configuredAt = now();
    const pluginDescriptors = this.pluginRegistry?.listDescriptors() ?? [];
    const enabledForSurface = (surface: string): boolean => {
      if (surface === 'tui') return true;
      if (surface === 'web') return Boolean(this.configManager.get('web.enabled') || this.configManager.get('controlPlane.enabled'));
      if (surface === 'slack') return Boolean(this.configManager.get('surfaces.slack.enabled'));
      if (surface === 'discord') return Boolean(this.configManager.get('surfaces.discord.enabled'));
      if (surface === 'ntfy') return Boolean(this.configManager.get('surfaces.ntfy.enabled'));
      if (surface === 'webhook') {
        return Boolean(
          this.configManager.get('surfaces.webhook.enabled')
          || this.configManager.get('surfaces.webhook.defaultTarget')
          || this.configManager.get('surfaces.webhook.secret'),
        );
      }
      const surfaces = this.configManager.getCategory('surfaces');
      if (surface === 'telegram') return Boolean(surfaces.telegram.enabled || surfaces.telegram.botToken || surfaces.telegram.defaultChatId);
      if (surface === 'google-chat') return Boolean(surfaces.googleChat.enabled || surfaces.googleChat.webhookUrl || surfaces.googleChat.spaceId);
      if (surface === 'signal') return Boolean(surfaces.signal.enabled || surfaces.signal.bridgeUrl || surfaces.signal.account);
      if (surface === 'whatsapp') return Boolean(surfaces.whatsapp.enabled || surfaces.whatsapp.accessToken || surfaces.whatsapp.phoneNumberId);
      if (surface === 'imessage') return Boolean(surfaces.imessage.enabled || surfaces.imessage.bridgeUrl || surfaces.imessage.account);
      if (surface === 'msteams') return Boolean(surfaces.msteams.enabled || surfaces.msteams.appId || surfaces.msteams.defaultConversationId);
      if (surface === 'bluebubbles') return Boolean(surfaces.bluebubbles.enabled || surfaces.bluebubbles.serverUrl || surfaces.bluebubbles.defaultChatGuid);
      if (surface === 'mattermost') return Boolean(surfaces.mattermost.enabled || surfaces.mattermost.baseUrl || surfaces.mattermost.defaultChannelId);
      if (surface === 'matrix') return Boolean(surfaces.matrix.enabled || surfaces.matrix.homeserverUrl || surfaces.matrix.defaultRoomId);
      return false;
    };
    const accountIdForSurface = (surface: string): string | undefined => {
      const surfaces = this.configManager.getCategory('surfaces');
      if (surface === 'slack') return String(this.configManager.get('surfaces.slack.workspaceId') || '') || undefined;
      if (surface === 'discord') return String(this.configManager.get('surfaces.discord.applicationId') || '') || undefined;
      if (surface === 'telegram') return surfaces.telegram.botUsername || surfaces.telegram.defaultChatId || undefined;
      if (surface === 'google-chat') return surfaces.googleChat.appId || surfaces.googleChat.spaceId || undefined;
      if (surface === 'signal') return surfaces.signal.account || surfaces.signal.defaultRecipient || undefined;
      if (surface === 'whatsapp') return surfaces.whatsapp.phoneNumberId || surfaces.whatsapp.defaultRecipient || undefined;
      if (surface === 'imessage') return surfaces.imessage.account || surfaces.imessage.defaultChatId || undefined;
      if (surface === 'msteams') return surfaces.msteams.botId || surfaces.msteams.defaultConversationId || undefined;
      if (surface === 'bluebubbles') return surfaces.bluebubbles.account || surfaces.bluebubbles.defaultChatGuid || undefined;
      if (surface === 'mattermost') return surfaces.mattermost.teamId || surfaces.mattermost.defaultChannelId || undefined;
      if (surface === 'matrix') return surfaces.matrix.userId || surfaces.matrix.defaultRoomId || undefined;
      return undefined;
    };
    const records: SurfaceRecord[] = pluginDescriptors.length > 0 ? pluginDescriptors.map((descriptor) => ({
      id: `surface:${descriptor.surface}`,
      kind: descriptor.surface,
      label: descriptor.displayName,
      enabled: enabledForSurface(descriptor.surface),
      state: enabledForSurface(descriptor.surface) ? 'healthy' : 'disabled',
      configuredAt,
      lastSeenAt: configuredAt,
      ...(accountIdForSurface(descriptor.surface) ? { accountId: accountIdForSurface(descriptor.surface) } : {}),
      capabilities: [...descriptor.capabilities],
      metadata: {},
    })) : [
      {
        id: 'surface:tui',
        kind: 'tui',
        label: 'Terminal UI',
        enabled: true,
        state: 'healthy',
        configuredAt,
        lastSeenAt: configuredAt,
        capabilities: ['ingress', 'egress', 'session_binding'],
        metadata: {},
      },
      {
        id: 'surface:web',
        kind: 'web',
        label: 'Web control plane',
        enabled: Boolean(this.configManager.get('web.enabled') || this.configManager.get('controlPlane.enabled')),
        state: this.configManager.get('web.enabled') || this.configManager.get('controlPlane.enabled') ? 'healthy' : 'disabled',
        configuredAt,
        capabilities: ['ingress', 'egress', 'threaded_reply'],
        metadata: {
          port: this.configManager.get('web.port'),
          baseUrl: this.configManager.get('web.publicBaseUrl'),
        },
      },
      {
        id: 'surface:slack',
        kind: 'slack',
        label: 'Slack',
        enabled: Boolean(this.configManager.get('surfaces.slack.enabled')),
        state: this.configManager.get('surfaces.slack.enabled') ? 'healthy' : 'disabled',
        configuredAt,
        accountId: String(this.configManager.get('surfaces.slack.workspaceId') || ''),
        capabilities: ['ingress', 'egress', 'threaded_reply', 'interactive_actions'],
        metadata: {
          defaultChannel: this.configManager.get('surfaces.slack.defaultChannel'),
        },
      },
      {
        id: 'surface:discord',
        kind: 'discord',
        label: 'Discord',
        enabled: Boolean(this.configManager.get('surfaces.discord.enabled')),
        state: this.configManager.get('surfaces.discord.enabled') ? 'healthy' : 'disabled',
        configuredAt,
        accountId: String(this.configManager.get('surfaces.discord.applicationId') || ''),
        capabilities: ['ingress', 'egress', 'interactive_actions'],
        metadata: {
          defaultChannelId: this.configManager.get('surfaces.discord.defaultChannelId'),
          guildId: this.configManager.get('surfaces.discord.guildId'),
        },
      },
      {
        id: 'surface:ntfy',
        kind: 'ntfy',
        label: 'ntfy',
        enabled: Boolean(this.configManager.get('surfaces.ntfy.enabled')),
        state: this.configManager.get('surfaces.ntfy.enabled') ? 'healthy' : 'disabled',
        configuredAt,
        capabilities: ['ingress', 'egress', 'delivery_only'],
        metadata: {
          baseUrl: this.configManager.get('surfaces.ntfy.baseUrl'),
          topic: this.configManager.get('surfaces.ntfy.topic'),
        },
      },
      {
        id: 'surface:webhook',
        kind: 'webhook',
        label: 'Generic webhook',
        enabled: Boolean(
          this.configManager.get('surfaces.webhook.enabled')
          || this.configManager.get('surfaces.webhook.defaultTarget')
          || this.configManager.get('surfaces.webhook.secret'),
        ),
        state: this.configManager.get('surfaces.webhook.enabled')
          || this.configManager.get('surfaces.webhook.defaultTarget')
          || this.configManager.get('surfaces.webhook.secret')
          ? 'healthy'
          : 'disabled',
        configuredAt,
        capabilities: ['ingress', 'egress', 'delivery_only'],
        metadata: {
          defaultTarget: this.configManager.get('surfaces.webhook.defaultTarget'),
          timeoutMs: this.configManager.get('surfaces.webhook.timeoutMs'),
        },
      },
    ];

    this.surfaces.clear();
    for (const record of records) {
      this.surfaces.set(record.id, record);
      this.runtimeDispatch?.syncSurface(record, 'surfaces.sync');
    }
    return records;
  }

  list(): SurfaceRecord[] {
    return [...this.surfaces.values()].sort((a, b) => a.label.localeCompare(b.label));
  }
}
