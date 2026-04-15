import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { ServiceRegistry } from '../config/service-registry.ts';
import {
  DiscordGatewayClient,
  DiscordIntegration,
  NtfyIntegration,
  SlackIntegration,
  SlackSocketModeClient,
  type DiscordGatewayDispatch,
  type NtfyMessage,
  type SlackSocketModeEnvelope,
} from '@pellux/goodvibes-sdk/platform/integrations/index';
import {
  type SurfaceAdapterContext,
  handleDiscordGatewayDispatchPayload,
  handleNtfySurfacePayload,
  handleSlackSurfacePayload,
} from '@pellux/goodvibes-sdk/platform/adapters/index';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

export type ProviderRuntimeSurface = 'slack' | 'discord' | 'ntfy';

export interface ProviderRuntimeStatus {
  readonly surface: ProviderRuntimeSurface;
  readonly running: boolean;
  readonly configured: boolean;
  readonly transport: 'socket-mode' | 'gateway' | 'json-stream';
  readonly lastStartedAt?: number;
  readonly lastStoppedAt?: number;
  readonly lastError?: string;
  readonly metadata: Record<string, unknown>;
}

export interface ProviderRuntimeActionResult {
  readonly ok: boolean;
  readonly surface: ProviderRuntimeSurface;
  readonly status: ProviderRuntimeStatus;
  readonly message: string;
}

interface ProviderRuntimeManagerDeps {
  readonly configManager: ConfigManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly buildSurfaceAdapterContext: () => SurfaceAdapterContext;
}

interface RuntimeState {
  running: boolean;
  lastStartedAt?: number;
  lastStoppedAt?: number;
  lastError?: string;
  metadata: Record<string, unknown>;
}

const DEFAULT_STATE: RuntimeState = {
  running: false,
  metadata: {},
};

export class ChannelProviderRuntimeManager {
  private slackClient: SlackSocketModeClient | null = null;
  private discordClient: DiscordGatewayClient | null = null;
  private ntfyAbort: AbortController | null = null;
  private readonly state: Record<ProviderRuntimeSurface, RuntimeState> = {
    slack: { ...DEFAULT_STATE, metadata: {} },
    discord: { ...DEFAULT_STATE, metadata: {} },
    ntfy: { ...DEFAULT_STATE, metadata: {} },
  };

  constructor(private readonly deps: ProviderRuntimeManagerDeps) {}

  async startConfigured(): Promise<ProviderRuntimeActionResult[]> {
    const results: ProviderRuntimeActionResult[] = [];
    if (this.deps.configManager.get('surfaces.slack.enabled') && await this.resolveSlackAppToken()) {
      results.push(await this.start('slack'));
    }
    if (this.deps.configManager.get('surfaces.discord.enabled') && await this.resolveDiscordBotToken()) {
      results.push(await this.start('discord'));
    }
    if (this.deps.configManager.get('surfaces.ntfy.enabled') && this.resolveNtfyTopic()) {
      results.push(await this.start('ntfy'));
    }
    return results;
  }

  async start(surface: ProviderRuntimeSurface): Promise<ProviderRuntimeActionResult> {
    if (surface === 'slack') return this.startSlack();
    if (surface === 'discord') return this.startDiscord();
    return this.startNtfy();
  }

  stop(surface: ProviderRuntimeSurface): ProviderRuntimeActionResult {
    if (surface === 'slack') {
      this.slackClient?.stop();
      this.slackClient = null;
      this.markStopped('slack');
      return this.result('slack', true, 'Slack Socket Mode runtime stopped.');
    }
    if (surface === 'discord') {
      this.discordClient?.stop();
      this.discordClient = null;
      this.markStopped('discord');
      return this.result('discord', true, 'Discord Gateway runtime stopped.');
    }
    this.ntfyAbort?.abort();
    this.ntfyAbort = null;
    this.markStopped('ntfy');
    return this.result('ntfy', true, 'ntfy JSON stream runtime stopped.');
  }

  stopAll(): void {
    this.stop('slack');
    this.stop('discord');
    this.stop('ntfy');
  }

  status(surface: ProviderRuntimeSurface): ProviderRuntimeStatus {
    const state = this.state[surface];
    return {
      surface,
      running: state.running,
      configured: this.isConfigured(surface),
      transport: surface === 'slack' ? 'socket-mode' : surface === 'discord' ? 'gateway' : 'json-stream',
      ...(state.lastStartedAt ? { lastStartedAt: state.lastStartedAt } : {}),
      ...(state.lastStoppedAt ? { lastStoppedAt: state.lastStoppedAt } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      metadata: { ...state.metadata },
    };
  }

  private async startSlack(): Promise<ProviderRuntimeActionResult> {
    if (this.slackClient?.isStarted) {
      return this.result('slack', true, 'Slack Socket Mode runtime is already running.');
    }
    const appToken = await this.resolveSlackAppToken();
    const botToken = await this.resolveSlackBotToken();
    if (!appToken) {
      this.markError('slack', 'Slack app-level token is required for Socket Mode.');
      return this.result('slack', false, 'Slack app-level token is required for Socket Mode.');
    }
    const slack = new SlackIntegration(
      await this.deps.serviceRegistry.resolveSecret('slack', 'webhookUrl') ?? process.env.SLACK_WEBHOOK_URL,
      botToken ?? undefined,
    );
    const client = new SlackSocketModeClient({
      appToken,
      integration: slack,
      onEnvelope: (envelope) => this.handleSlackEnvelope(envelope, slack),
    });
    try {
      const connection = await client.start();
      if (!connection.ok) {
        const message = connection.error ?? 'Slack Socket Mode connection failed.';
        this.markError('slack', message);
        return this.result('slack', false, message);
      }
      this.slackClient = client;
      this.markStarted('slack', { socketMode: true });
      return this.result('slack', true, 'Slack Socket Mode runtime started.');
    } catch (error) {
      const message = summarizeError(error);
      this.markError('slack', message);
      return this.result('slack', false, message);
    }
  }

  private async startDiscord(): Promise<ProviderRuntimeActionResult> {
    if (this.discordClient?.isStarted) {
      return this.result('discord', true, 'Discord Gateway runtime is already running.');
    }
    const botToken = await this.resolveDiscordBotToken();
    if (!botToken) {
      this.markError('discord', 'Discord bot token is required for Gateway runtime.');
      return this.result('discord', false, 'Discord bot token is required for Gateway runtime.');
    }
    const discord = new DiscordIntegration(
      await this.deps.serviceRegistry.resolveSecret('discord', 'webhookUrl') ?? process.env.DISCORD_WEBHOOK_URL,
      botToken,
    );
    const client = new DiscordGatewayClient({
      token: botToken,
      integration: discord,
      onDispatch: (dispatch) => this.handleDiscordDispatch(dispatch, discord),
    });
    try {
      const gateway = await client.start();
      this.discordClient = client;
      this.markStarted('discord', { gatewayUrl: gateway.url, shards: gateway.shards });
      return this.result('discord', true, 'Discord Gateway runtime started.');
    } catch (error) {
      const message = summarizeError(error);
      this.markError('discord', message);
      return this.result('discord', false, message);
    }
  }

  private async startNtfy(): Promise<ProviderRuntimeActionResult> {
    if (this.ntfyAbort) {
      return this.result('ntfy', true, 'ntfy JSON stream runtime is already running.');
    }
    const topic = this.resolveNtfyTopic();
    if (!topic) {
      this.markError('ntfy', 'ntfy topic is required for subscription runtime.');
      return this.result('ntfy', false, 'ntfy topic is required for subscription runtime.');
    }
    const abort = new AbortController();
    this.ntfyAbort = abort;
    const ntfy = new NtfyIntegration(
      String(this.deps.configManager.get('surfaces.ntfy.baseUrl') || 'https://ntfy.sh'),
      await this.resolveNtfyToken() ?? undefined,
    );
    this.markStarted('ntfy', { topic });
    void ntfy.subscribeJsonStream(topic, (message) => this.handleNtfyMessage(message), {
      since: 'latest',
      signal: abort.signal,
    }).catch((error: unknown) => {
      if (abort.signal.aborted) return;
      const message = summarizeError(error);
      this.ntfyAbort = null;
      this.markError('ntfy', message);
      logger.warn('ChannelProviderRuntimeManager: ntfy stream failed', { error: message });
    });
    return this.result('ntfy', true, 'ntfy JSON stream runtime started.');
  }

  private async handleSlackEnvelope(envelope: SlackSocketModeEnvelope, slack: SlackIntegration): Promise<void> {
    if (!envelope.payload || typeof envelope.payload !== 'object') return;
    await handleSlackSurfacePayload(envelope.payload, this.deps.buildSurfaceAdapterContext(), slack).catch((error: unknown) => {
      logger.warn('ChannelProviderRuntimeManager: Slack Socket Mode payload failed', {
        error: summarizeError(error),
      });
    });
  }

  private async handleDiscordDispatch(dispatch: DiscordGatewayDispatch, discord: DiscordIntegration): Promise<void> {
    await handleDiscordGatewayDispatchPayload(dispatch, this.deps.buildSurfaceAdapterContext(), discord).catch((error: unknown) => {
      logger.warn('ChannelProviderRuntimeManager: Discord Gateway dispatch failed', {
        eventType: dispatch.t,
        error: summarizeError(error),
      });
    });
  }

  private async handleNtfyMessage(message: NtfyMessage): Promise<void> {
    if (message.event !== 'message') return;
    await handleNtfySurfacePayload(message, this.deps.buildSurfaceAdapterContext()).catch((error: unknown) => {
      logger.warn('ChannelProviderRuntimeManager: ntfy message dispatch failed', {
        error: summarizeError(error),
      });
    });
  }

  private async resolveSlackBotToken(): Promise<string | null> {
    const serviceValue = await this.deps.serviceRegistry.resolveSecret('slack', 'primary');
    return serviceValue
      || String(this.deps.configManager.get('surfaces.slack.botToken') || '')
      || process.env.SLACK_BOT_TOKEN
      || null;
  }

  private async resolveSlackAppToken(): Promise<string | null> {
    return String(this.deps.configManager.get('surfaces.slack.appToken') || '')
      || process.env.SLACK_APP_TOKEN
      || null;
  }

  private async resolveDiscordBotToken(): Promise<string | null> {
    const serviceValue = await this.deps.serviceRegistry.resolveSecret('discord', 'primary');
    return serviceValue
      || String(this.deps.configManager.get('surfaces.discord.botToken') || '')
      || process.env.DISCORD_BOT_TOKEN
      || null;
  }

  private async resolveNtfyToken(): Promise<string | null> {
    const serviceValue = await this.deps.serviceRegistry.resolveSecret('ntfy', 'primary');
    return serviceValue
      || String(this.deps.configManager.get('surfaces.ntfy.token') || '')
      || process.env.NTFY_ACCESS_TOKEN
      || null;
  }

  private resolveNtfyTopic(): string {
    return String(this.deps.configManager.get('surfaces.ntfy.topic') || '').trim();
  }

  private isConfigured(surface: ProviderRuntimeSurface): boolean {
    if (surface === 'slack') {
      return Boolean(this.deps.configManager.get('surfaces.slack.appToken') || process.env.SLACK_APP_TOKEN);
    }
    if (surface === 'discord') {
      return Boolean(this.deps.configManager.get('surfaces.discord.botToken') || process.env.DISCORD_BOT_TOKEN);
    }
    return Boolean(this.resolveNtfyTopic());
  }

  private markStarted(surface: ProviderRuntimeSurface, metadata: Record<string, unknown>): void {
    this.state[surface] = {
      running: true,
      lastStartedAt: Date.now(),
      metadata,
    };
  }

  private markStopped(surface: ProviderRuntimeSurface): void {
    this.state[surface] = {
      ...this.state[surface],
      running: false,
      lastStoppedAt: Date.now(),
    };
  }

  private markError(surface: ProviderRuntimeSurface, error: string): void {
    this.state[surface] = {
      ...this.state[surface],
      running: false,
      lastError: error,
    };
  }

  private result(surface: ProviderRuntimeSurface, ok: boolean, message: string): ProviderRuntimeActionResult {
    return {
      ok,
      surface,
      status: this.status(surface),
      message,
    };
  }
}
