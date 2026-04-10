import { createDomainDispatch } from '../runtime/store/index.ts';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.ts';
import type { SurfaceRecord } from '../runtime/store/domains/surfaces.ts';
import { ConfigManager } from '../config/manager.ts';
import type { ChannelPluginRegistry } from './plugin-registry.ts';

function now(): number {
  return Date.now();
}

export class SurfaceRegistry {
  private static instance: SurfaceRegistry | null = null;

  private readonly configManager: ConfigManager;
  private readonly surfaces = new Map<string, SurfaceRecord>();
  private runtimeDispatch: DomainDispatch | null = null;
  private pluginRegistry: ChannelPluginRegistry | null = null;

  constructor(configManager: ConfigManager = new ConfigManager(), runtimeStore?: RuntimeStore) {
    this.configManager = configManager;
    if (runtimeStore) this.runtimeDispatch = createDomainDispatch(runtimeStore);
  }

  static getInstance(): SurfaceRegistry {
    if (!SurfaceRegistry.instance) {
      SurfaceRegistry.instance = new SurfaceRegistry();
    }
    return SurfaceRegistry.instance;
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
    const records: SurfaceRecord[] = pluginDescriptors.length > 0 ? pluginDescriptors.map((descriptor) => ({
      id: `surface:${descriptor.surface}`,
      kind: descriptor.surface,
      label: descriptor.displayName,
      enabled: descriptor.surface === 'tui'
        ? true
        : descriptor.surface === 'web'
          ? Boolean(this.configManager.get('web.enabled') || this.configManager.get('controlPlane.enabled'))
          : descriptor.surface === 'slack'
            ? Boolean(this.configManager.get('surfaces.slack.enabled'))
            : descriptor.surface === 'discord'
              ? Boolean(this.configManager.get('surfaces.discord.enabled'))
              : descriptor.surface === 'ntfy'
                ? Boolean(this.configManager.get('surfaces.ntfy.enabled'))
                : Boolean(
                    this.configManager.get('surfaces.webhook.enabled')
                    || this.configManager.get('surfaces.webhook.defaultTarget')
                    || this.configManager.get('surfaces.webhook.secret'),
                  ),
      state: descriptor.surface === 'tui'
        ? 'healthy'
        : descriptor.surface === 'web'
          ? this.configManager.get('web.enabled') || this.configManager.get('controlPlane.enabled') ? 'healthy' : 'disabled'
          : descriptor.surface === 'slack'
            ? this.configManager.get('surfaces.slack.enabled') ? 'healthy' : 'disabled'
            : descriptor.surface === 'discord'
              ? this.configManager.get('surfaces.discord.enabled') ? 'healthy' : 'disabled'
              : descriptor.surface === 'ntfy'
                ? this.configManager.get('surfaces.ntfy.enabled') ? 'healthy' : 'disabled'
                : this.configManager.get('surfaces.webhook.enabled')
                  || this.configManager.get('surfaces.webhook.defaultTarget')
                  || this.configManager.get('surfaces.webhook.secret')
                  ? 'healthy'
                  : 'disabled',
      configuredAt,
      lastSeenAt: configuredAt,
      ...(descriptor.surface === 'slack' ? { accountId: String(this.configManager.get('surfaces.slack.workspaceId') || '') } : {}),
      ...(descriptor.surface === 'discord' ? { accountId: String(this.configManager.get('surfaces.discord.applicationId') || '') } : {}),
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
