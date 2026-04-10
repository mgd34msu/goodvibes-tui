import { ConfigManager } from '../config/manager.ts';
import { ServiceRegistry } from '../config/service-registry.ts';
import { ControlPlaneGateway } from '../control-plane/gateway.ts';
import { DiscordIntegration, NtfyIntegration, SlackIntegration } from '../integrations/index.ts';
import type { RouteSurfaceKind } from '../runtime/events/routes.ts';
import { validatePublicWebhookUrl } from '../utils/url-safety.ts';

export type ChannelDeliverySurfaceKind = RouteSurfaceKind;
export type ChannelDeliveryTargetKind = 'none' | 'webhook' | 'surface' | 'integration' | 'link';

export interface ChannelDeliveryTarget {
  readonly kind: ChannelDeliveryTargetKind;
  readonly surfaceKind?: ChannelDeliverySurfaceKind;
  readonly address?: string;
  readonly routeId?: string;
  readonly label?: string;
}

export interface ChannelDeliveryRouteBinding {
  readonly id: string;
  readonly surfaceKind: ChannelDeliverySurfaceKind;
  readonly surfaceId: string;
  readonly externalId: string;
  readonly threadId?: string;
  readonly channelId?: string;
  readonly title?: string;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelDeliveryRequest {
  readonly target: ChannelDeliveryTarget;
  readonly body: string;
  readonly title: string;
  readonly jobId: string;
  readonly runId: string;
  readonly agentId?: string;
  readonly status?: string;
  readonly includeLinks: boolean;
  readonly binding?: ChannelDeliveryRouteBinding;
}

export interface ChannelDeliveryResult {
  readonly responseId?: string;
}

export interface ChannelDeliveryStrategy {
  readonly id: string;
  canHandle(request: ChannelDeliveryRequest): boolean;
  deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult>;
}

export interface ChannelDeliveryRouterConfig {
  readonly configManager?: ConfigManager;
  readonly serviceRegistry?: ServiceRegistry;
  readonly strategies?: readonly ChannelDeliveryStrategy[];
}

export function resolveChannelDeliverySurfaceKind(
  target: ChannelDeliveryTarget,
): ChannelDeliverySurfaceKind | undefined {
  return target.surfaceKind ?? (target.kind === 'webhook' ? 'webhook' : undefined);
}

function titleFromBody(body: string): string {
  const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? 'goodvibes automation';
  return firstLine.slice(0, 80);
}

function success(responseId?: string): ChannelDeliveryResult {
  return responseId === undefined ? {} : { responseId };
}

function createWebhookDeliveryStrategy(configManager: ConfigManager): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:webhook',
    canHandle(request) {
      return request.target.kind === 'webhook' || resolveChannelDeliverySurfaceKind(request.target) === 'webhook';
    },
    async deliver(request) {
      const address = request.target.address ?? String(configManager.get('surfaces.webhook.defaultTarget') ?? '');
      if (!address) throw new Error('Missing webhook delivery target');
      const validation = validatePublicWebhookUrl(address);
      if (!validation.ok) throw new Error(validation.error);
      const timeoutMs = Number(configManager.get('surfaces.webhook.timeoutMs') ?? 15_000);
      const response = await fetch(validation.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          text: request.body,
          message: request.body,
          title: request.title,
          jobId: request.jobId,
          runId: request.runId,
          routeId: request.binding?.id,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => '')}`);
      }
      return success(validation.url);
    },
  };
}

function createSlackDeliveryStrategy(serviceRegistry: ServiceRegistry): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:slack',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'slack';
    },
    async deliver(request) {
      const webhookUrl =
        await serviceRegistry.resolveSecret('slack', 'webhookUrl')
        ?? process.env.SLACK_WEBHOOK_URL;
      const botToken =
        await serviceRegistry.resolveSecret('slack', 'primary')
        ?? process.env.SLACK_BOT_TOKEN;
      const slack = new SlackIntegration(webhookUrl ?? undefined, botToken ?? undefined);
      const responseUrl = typeof request.binding?.metadata.responseUrl === 'string'
        ? request.binding.metadata.responseUrl
        : undefined;
      if (responseUrl?.startsWith('https://hooks.slack.com/')) {
        await fetch(responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type: 'in_channel',
            blocks: slack.formatAgentResult(request.agentId ?? request.runId, request.title, request.body),
          }),
        });
        return success(responseUrl);
      }
      if (request.target.address?.startsWith('https://')) {
        await slack.postWebhook(request.body, undefined, request.target.address);
        return success(request.target.address);
      }
      if (request.target.address) {
        await slack.postMessage(request.target.address, request.body);
        return success(request.target.address);
      }
      await slack.postWebhook(request.body);
      return success(webhookUrl ?? undefined);
    },
  };
}

function createDiscordDeliveryStrategy(serviceRegistry: ServiceRegistry): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:discord',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'discord';
    },
    async deliver(request) {
      const webhookUrl =
        await serviceRegistry.resolveSecret('discord', 'webhookUrl')
        ?? process.env.DISCORD_WEBHOOK_URL;
      const botToken =
        await serviceRegistry.resolveSecret('discord', 'primary')
        ?? process.env.DISCORD_BOT_TOKEN;
      const discord = new DiscordIntegration(webhookUrl ?? undefined, botToken ?? undefined);
      const applicationId = typeof request.binding?.metadata.applicationId === 'string'
        ? request.binding.metadata.applicationId
        : undefined;
      const interactionToken = typeof request.binding?.metadata.interactionToken === 'string'
        ? request.binding.metadata.interactionToken
        : undefined;
      if (applicationId && interactionToken) {
        await discord.editOriginalResponse(
          applicationId,
          interactionToken,
          '',
          [discord.formatAgentResult(request.agentId ?? request.runId, request.title, request.body)],
        );
        return success(`${applicationId}:${interactionToken}`);
      }
      if (request.target.address?.startsWith('https://')) {
        await discord.postWebhook(request.body, undefined, request.target.address);
        return success(request.target.address);
      }
      if (request.target.address) {
        await discord.postMessage(request.target.address, request.body);
        return success(request.target.address);
      }
      await discord.postWebhook(request.body);
      return success(webhookUrl ?? undefined);
    },
  };
}

function createNtfyDeliveryStrategy(configManager: ConfigManager, serviceRegistry: ServiceRegistry): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:ntfy',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'ntfy';
    },
    async deliver(request) {
      const baseUrl = String(configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh');
      const token = await serviceRegistry.resolveSecret('ntfy', 'primary') ?? process.env.NTFY_ACCESS_TOKEN;
      const topic = request.target.address ?? String(configManager.get('surfaces.ntfy.topic') ?? '');
      if (!topic) throw new Error('Missing ntfy topic');
      const ntfy = new NtfyIntegration(baseUrl, token ?? undefined);
      const baseUrlHint = String(configManager.get('controlPlane.baseUrl') ?? configManager.get('web.publicBaseUrl') ?? '');
      await ntfy.publish(topic, request.body, {
        title: request.target.label ?? titleFromBody(request.body),
        ...(request.includeLinks && baseUrlHint ? { click: `${baseUrlHint.replace(/\/+$/, '')}/api/control-plane/web` } : {}),
      });
      return success(topic);
    },
  };
}

function createWebControlPlaneDeliveryStrategy(): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:web-control-plane',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'web';
    },
    async deliver(request) {
      const gateway = ControlPlaneGateway.getActive();
      if (!gateway) {
        throw new Error('Web control-plane gateway unavailable');
      }
      const published = gateway.publishSurfaceMessage({
        surface: 'web',
        title: request.target.label ?? request.title,
        body: request.body,
        level: request.status === 'failed' ? 'error' : request.status === 'completed' ? 'success' : 'info',
        routeId: request.binding?.id ?? request.target.routeId,
        surfaceId: request.binding?.surfaceId,
        metadata: {
          jobId: request.jobId,
          runId: request.runId,
          agentId: request.agentId,
        },
      });
      return success(published.id);
    },
  };
}

export function createDefaultChannelDeliveryStrategies(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
): ChannelDeliveryStrategy[] {
  return [
    createWebhookDeliveryStrategy(configManager),
    createSlackDeliveryStrategy(serviceRegistry),
    createDiscordDeliveryStrategy(serviceRegistry),
    createNtfyDeliveryStrategy(configManager, serviceRegistry),
    createWebControlPlaneDeliveryStrategy(),
  ];
}

export class ChannelDeliveryRouter {
  private readonly strategies: ChannelDeliveryStrategy[];

  constructor(config: ChannelDeliveryRouterConfig = {}) {
    const configManager = config.configManager ?? new ConfigManager();
    const serviceRegistry = config.serviceRegistry ?? new ServiceRegistry();
    this.strategies = [
      ...(config.strategies ?? createDefaultChannelDeliveryStrategies(configManager, serviceRegistry)),
    ];
  }

  listStrategies(): readonly ChannelDeliveryStrategy[] {
    return [...this.strategies];
  }

  registerStrategy(strategy: ChannelDeliveryStrategy, options: { readonly replace?: boolean } = {}): void {
    const existingIndex = this.strategies.findIndex((entry) => entry.id === strategy.id);
    if (existingIndex >= 0) {
      if (!options.replace) {
        throw new Error(`Channel delivery strategy already registered: ${strategy.id}`);
      }
      this.strategies.splice(existingIndex, 1, strategy);
      return;
    }
    this.strategies.push(strategy);
  }

  async deliver(request: ChannelDeliveryRequest): Promise<string | undefined> {
    const strategy = this.strategies.find((entry) => entry.canHandle(request));
    if (!strategy) {
      const surfaceKind = resolveChannelDeliverySurfaceKind(request.target);
      throw new Error(`Unsupported channel delivery target: ${request.target.kind}:${surfaceKind ?? 'unknown'}`);
    }
    const result = await strategy.deliver(request);
    return result.responseId;
  }
}
