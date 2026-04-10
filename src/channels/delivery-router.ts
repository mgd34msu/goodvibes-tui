import { ArtifactStore, type ArtifactAttachment, type ArtifactReference } from '../artifacts/index.ts';
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
  readonly attachments?: readonly ArtifactReference[];
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
  readonly artifactStore?: ArtifactStore;
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

function buildArtifactContentPath(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/content`;
}

function buildArtifactContentUrl(configManager: ConfigManager, artifactId: string): string | undefined {
  const baseUrl = String(configManager.get('controlPlane.baseUrl') ?? configManager.get('web.publicBaseUrl') ?? '').trim();
  if (!baseUrl) return undefined;
  return new URL(buildArtifactContentPath(artifactId), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function resolveAttachments(
  request: ChannelDeliveryRequest,
  artifactStore: ArtifactStore,
  configManager: ConfigManager,
  inlineLimitBytes?: number,
): Promise<ArtifactAttachment[]> {
  const references = request.attachments ?? [];
  const attachments: ArtifactAttachment[] = [];
  for (const reference of references) {
    attachments.push(await artifactStore.toAttachment(reference, {
      contentUrl: buildArtifactContentUrl(configManager, reference.artifactId),
      ...(typeof inlineLimitBytes === 'number' ? { includeBase64IfSmallerThan: inlineLimitBytes } : {}),
    }));
  }
  return attachments;
}

function appendAttachmentSummary(body: string, attachments: readonly ArtifactAttachment[]): string {
  if (attachments.length === 0) return body;
  const lines = attachments.map((attachment) => {
    const target = attachment.contentUrl ?? attachment.contentPath;
    const name = attachment.filename ?? attachment.label ?? attachment.artifactId;
    return `- ${name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes): ${target}`;
  });
  return `${body.trimEnd()}\n\nAttachments:\n${lines.join('\n')}`;
}

function trimForSurface(body: string, maxChars: number): string {
  const normalized = body.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function extractResponseId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const direct = record.id;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
  if (typeof direct === 'number' && Number.isFinite(direct)) return String(direct);
  const name = record.name;
  if (typeof name === 'string' && name.trim().length > 0) return name.trim();
  const messageId = record.message_id;
  if (typeof messageId === 'number' && Number.isFinite(messageId)) return String(messageId);
  if (typeof messageId === 'string' && messageId.trim().length > 0) return messageId.trim();
  const result = record.result;
  if (result && typeof result === 'object') return extractResponseId(result);
  return undefined;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  try {
    const text = await response.text();
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function requireOkResponse(label: string, response: Response): Promise<unknown> {
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    const detail = typeof payload === 'string'
      ? payload
      : payload && typeof payload === 'object'
        ? JSON.stringify(payload)
        : '';
    throw new Error(`${label} HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return payload;
}

async function postBridgePayload(
  bridgeUrl: string,
  payload: Record<string, unknown>,
  options: {
    readonly label: string;
    readonly token?: string;
  },
): Promise<string | undefined> {
  const response = await fetch(bridgeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      'X-GoodVibes-Channel': String(payload.surface ?? 'bridge'),
    },
    body: JSON.stringify(payload),
  });
  const result = await requireOkResponse(options.label, response);
  return extractResponseId(result) ?? bridgeUrl;
}

function createWebhookDeliveryStrategy(configManager: ConfigManager, artifactStore: ArtifactStore): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:webhook',
    canHandle(request) {
      return request.target.kind === 'webhook' || resolveChannelDeliverySurfaceKind(request.target) === 'webhook';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager, 128 * 1024);
      const address = request.target.address
        ?? (typeof request.binding?.metadata.callbackUrl === 'string' ? request.binding.metadata.callbackUrl : undefined)
        ?? String(configManager.get('surfaces.webhook.defaultTarget') ?? '');
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
          attachments,
          artifacts: attachments,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => '')}`);
      }
      return success(validation.url);
    },
  };
}

function createSlackDeliveryStrategy(
  serviceRegistry: ServiceRegistry,
  configManager: ConfigManager,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:slack',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'slack';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const bodyWithAttachments = appendAttachmentSummary(request.body, attachments);
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
            blocks: slack.formatAgentResult(request.agentId ?? request.runId, request.title, bodyWithAttachments),
          }),
        });
        return success(responseUrl);
      }
      if (request.target.address?.startsWith('https://')) {
        await slack.postWebhook(bodyWithAttachments, undefined, request.target.address);
        return success(request.target.address);
      }
      if (request.target.address) {
        await slack.postMessage(request.target.address, bodyWithAttachments);
        return success(request.target.address);
      }
      await slack.postWebhook(bodyWithAttachments);
      return success(webhookUrl ?? undefined);
    },
  };
}

function createDiscordDeliveryStrategy(
  serviceRegistry: ServiceRegistry,
  configManager: ConfigManager,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:discord',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'discord';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const bodyWithAttachments = appendAttachmentSummary(request.body, attachments);
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
          [discord.formatAgentResult(request.agentId ?? request.runId, request.title, bodyWithAttachments)],
        );
        return success(`${applicationId}:${interactionToken}`);
      }
      if (request.target.address?.startsWith('https://')) {
        await discord.postWebhook(bodyWithAttachments, undefined, request.target.address);
        return success(request.target.address);
      }
      if (request.target.address) {
        await discord.postMessage(request.target.address, bodyWithAttachments);
        return success(request.target.address);
      }
      await discord.postWebhook(bodyWithAttachments);
      return success(webhookUrl ?? undefined);
    },
  };
}

function createNtfyDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:ntfy',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'ntfy';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const baseUrl = String(configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh');
      const token = await serviceRegistry.resolveSecret('ntfy', 'primary') ?? process.env.NTFY_ACCESS_TOKEN;
      const topic = request.target.address ?? String(configManager.get('surfaces.ntfy.topic') ?? '');
      if (!topic) throw new Error('Missing ntfy topic');
      const ntfy = new NtfyIntegration(baseUrl, token ?? undefined);
      const baseUrlHint = String(configManager.get('controlPlane.baseUrl') ?? configManager.get('web.publicBaseUrl') ?? '');
      const primaryAttachment = attachments[0];
      await ntfy.publish(topic, appendAttachmentSummary(request.body, attachments), {
        title: request.target.label ?? titleFromBody(request.body),
        ...(request.includeLinks && baseUrlHint ? { click: `${baseUrlHint.replace(/\/+$/, '')}/api/control-plane/web` } : {}),
        ...(primaryAttachment?.contentUrl ? { attach: primaryAttachment.contentUrl } : {}),
      });
      return success(topic);
    },
  };
}

function createWebControlPlaneDeliveryStrategy(
  configManager: ConfigManager,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:web-control-plane',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'web';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
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
        attachments,
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

function createTelegramDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:telegram',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'telegram';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const token = firstNonEmpty(
        await serviceRegistry.resolveSecret('telegram', 'primary'),
        String(configManager.get('surfaces.telegram.botToken') ?? ''),
        process.env.TELEGRAM_BOT_TOKEN,
      );
      const chatId = firstNonEmpty(
        request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.telegram.defaultChatId') ?? ''),
      );
      if (!token) throw new Error('Missing Telegram bot token');
      if (!chatId) throw new Error('Missing Telegram chat id');
      const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: trimForSurface(appendAttachmentSummary(request.body, attachments), 4_096),
          disable_web_page_preview: true,
          ...(request.binding?.threadId && /^\d+$/.test(request.binding.threadId)
            ? { message_thread_id: Number(request.binding.threadId) }
            : {}),
        }),
      });
      const payload = await requireOkResponse('Telegram delivery failed', response);
      return success(extractResponseId(payload) ?? chatId);
    },
  };
}

function createGoogleChatDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:google-chat',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'google-chat';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const webhookUrl = firstNonEmpty(
        request.target.address?.startsWith('https://') ? request.target.address : undefined,
        await serviceRegistry.resolveSecret('google-chat', 'webhookUrl'),
        serviceRegistry.get('google-chat')?.baseUrl,
        String(configManager.get('surfaces.googleChat.webhookUrl') ?? ''),
        process.env.GOOGLE_CHAT_WEBHOOK_URL,
      );
      if (!webhookUrl) {
        throw new Error('Missing Google Chat webhook URL');
      }
      const threadKey = firstNonEmpty(request.binding?.threadId, request.binding?.channelId, request.binding?.externalId);
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({
          text: trimForSurface(appendAttachmentSummary(request.body, attachments), 4_000),
          ...(threadKey ? { thread: { threadKey } } : {}),
        }),
      });
      const payload = await requireOkResponse('Google Chat delivery failed', response);
      return success(extractResponseId(payload) ?? webhookUrl);
    },
  };
}

function createSignalDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:signal',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'signal';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const bridgeUrl = firstNonEmpty(
        request.target.address?.startsWith('https://') ? request.target.address : undefined,
        String(configManager.get('surfaces.signal.bridgeUrl') ?? ''),
        serviceRegistry.get('signal')?.baseUrl,
        process.env.SIGNAL_BRIDGE_URL,
      );
      const recipient = firstNonEmpty(
        request.target.address?.startsWith('https://') ? undefined : request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.signal.defaultRecipient') ?? ''),
      );
      if (!bridgeUrl) throw new Error('Missing Signal bridge URL');
      if (!recipient) throw new Error('Missing Signal recipient');
      const token = firstNonEmpty(
        await serviceRegistry.resolveSecret('signal', 'primary'),
        String(configManager.get('surfaces.signal.token') ?? ''),
        process.env.SIGNAL_BRIDGE_TOKEN,
      );
      const responseId = await postBridgePayload(bridgeUrl, {
        surface: 'signal',
        account: firstNonEmpty(String(configManager.get('surfaces.signal.account') ?? '')),
        recipient,
        text: trimForSurface(appendAttachmentSummary(request.body, attachments), 8_000),
        title: request.title,
        jobId: request.jobId,
        runId: request.runId,
        routeId: request.binding?.id,
        threadId: request.binding?.threadId,
        attachments,
      }, {
        label: 'Signal bridge delivery failed',
        token,
      });
      return success(responseId ?? recipient);
    },
  };
}

function createWhatsAppDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:whatsapp',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'whatsapp';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const provider = firstNonEmpty(String(configManager.get('surfaces.whatsapp.provider') ?? ''), 'meta-cloud') ?? 'meta-cloud';
      const recipient = firstNonEmpty(
        request.target.address?.startsWith('https://') ? undefined : request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.whatsapp.defaultRecipient') ?? ''),
      );
      if (!recipient) throw new Error('Missing WhatsApp recipient');
      if (provider === 'bridge') {
        const bridgeUrl = firstNonEmpty(
          request.target.address?.startsWith('https://') ? request.target.address : undefined,
          serviceRegistry.get('whatsapp')?.baseUrl,
          process.env.WHATSAPP_BRIDGE_URL,
        );
        if (!bridgeUrl) throw new Error('Missing WhatsApp bridge URL');
        const token = firstNonEmpty(
          await serviceRegistry.resolveSecret('whatsapp', 'primary'),
          String(configManager.get('surfaces.whatsapp.accessToken') ?? ''),
          process.env.WHATSAPP_ACCESS_TOKEN,
        );
        const responseId = await postBridgePayload(bridgeUrl, {
          surface: 'whatsapp',
          provider,
          recipient,
          text: trimForSurface(appendAttachmentSummary(request.body, attachments), 4_096),
          title: request.title,
          jobId: request.jobId,
          runId: request.runId,
          routeId: request.binding?.id,
          attachments,
        }, {
          label: 'WhatsApp bridge delivery failed',
          token,
        });
        return success(responseId ?? recipient);
      }

      const phoneNumberId = firstNonEmpty(String(configManager.get('surfaces.whatsapp.phoneNumberId') ?? ''));
      const accessToken = firstNonEmpty(
        await serviceRegistry.resolveSecret('whatsapp', 'primary'),
        String(configManager.get('surfaces.whatsapp.accessToken') ?? ''),
        process.env.WHATSAPP_ACCESS_TOKEN,
      );
      if (!phoneNumberId) throw new Error('Missing WhatsApp phone number id');
      if (!accessToken) throw new Error('Missing WhatsApp access token');
      const apiBaseUrl = firstNonEmpty(process.env.WHATSAPP_BASE_URL, 'https://graph.facebook.com/v17.0')!;
      const response = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(phoneNumberId)}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipient,
          type: 'text',
          text: {
            preview_url: true,
            body: trimForSurface(appendAttachmentSummary(request.body, attachments), 4_096),
          },
        }),
      });
      const payload = await requireOkResponse('WhatsApp delivery failed', response);
      return success(extractResponseId(payload) ?? recipient);
    },
  };
}

function createIMessageDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:imessage',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'imessage';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const bridgeUrl = firstNonEmpty(
        request.target.address?.startsWith('https://') ? request.target.address : undefined,
        String(configManager.get('surfaces.imessage.bridgeUrl') ?? ''),
        serviceRegistry.get('imessage')?.baseUrl,
        process.env.IMESSAGE_BRIDGE_URL,
      );
      const chatId = firstNonEmpty(
        request.target.address?.startsWith('https://') ? undefined : request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.imessage.defaultChatId') ?? ''),
      );
      if (!bridgeUrl) throw new Error('Missing iMessage bridge URL');
      if (!chatId) throw new Error('Missing iMessage chat id');
      const token = firstNonEmpty(
        await serviceRegistry.resolveSecret('imessage', 'primary'),
        String(configManager.get('surfaces.imessage.token') ?? ''),
        process.env.IMESSAGE_BRIDGE_TOKEN,
      );
      const responseId = await postBridgePayload(bridgeUrl, {
        surface: 'imessage',
        account: firstNonEmpty(String(configManager.get('surfaces.imessage.account') ?? '')),
        chatId,
        text: trimForSurface(appendAttachmentSummary(request.body, attachments), 8_000),
        title: request.title,
        jobId: request.jobId,
        runId: request.runId,
        routeId: request.binding?.id,
        threadId: request.binding?.threadId,
        attachments,
      }, {
        label: 'iMessage bridge delivery failed',
        token,
      });
      return success(responseId ?? chatId);
    },
  };
}

export function createDefaultChannelDeliveryStrategies(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy[] {
  return [
    createWebhookDeliveryStrategy(configManager, artifactStore),
    createSlackDeliveryStrategy(serviceRegistry, configManager, artifactStore),
    createDiscordDeliveryStrategy(serviceRegistry, configManager, artifactStore),
    createNtfyDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createWebControlPlaneDeliveryStrategy(configManager, artifactStore),
    createTelegramDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createGoogleChatDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createSignalDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createWhatsAppDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createIMessageDeliveryStrategy(configManager, serviceRegistry, artifactStore),
  ];
}

export class ChannelDeliveryRouter {
  private static active: ChannelDeliveryRouter | null = null;
  private readonly strategies: ChannelDeliveryStrategy[];

  constructor(config: ChannelDeliveryRouterConfig = {}) {
    const configManager = config.configManager ?? new ConfigManager();
    const serviceRegistry = config.serviceRegistry ?? new ServiceRegistry();
    const artifactStore = config.artifactStore ?? ArtifactStore.getActive({ configManager });
    this.strategies = [
      ...(config.strategies ?? createDefaultChannelDeliveryStrategies(configManager, serviceRegistry, artifactStore)),
    ];
    ChannelDeliveryRouter.active = this;
  }

  static getActive(): ChannelDeliveryRouter | null {
    return ChannelDeliveryRouter.active;
  }

  static resetActiveForTesting(): void {
    ChannelDeliveryRouter.active = null;
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

  unregisterStrategy(strategyId: string): boolean {
    const existingIndex = this.strategies.findIndex((entry) => entry.id === strategyId);
    if (existingIndex < 0) return false;
    this.strategies.splice(existingIndex, 1);
    return true;
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
