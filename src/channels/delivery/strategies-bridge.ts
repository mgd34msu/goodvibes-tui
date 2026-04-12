import { ArtifactStore } from '../../artifacts/index.ts';
import { ConfigManager } from '../../config/manager.ts';
import { ServiceRegistry } from '../../config/service-registry.ts';
import type { ChannelDeliveryStrategy } from './types.ts';
import {
  appendAttachmentSummary,
  extractResponseId,
  firstNonEmpty,
  normalizeBaseUrl,
  postBridgePayload,
  requireOkResponse,
  resolveAttachments,
  resolveChannelDeliverySurfaceKind,
  success,
  trimForSurface,
} from './shared.ts';

export function createSignalDeliveryStrategy(
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

export function createWhatsAppDeliveryStrategy(
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
      const response = await fetch(`${normalizeBaseUrl(apiBaseUrl)}/${encodeURIComponent(phoneNumberId)}/messages`, {
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

export function createIMessageDeliveryStrategy(
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

export function createBlueBubblesDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:bluebubbles',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'bluebubbles';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager, 128 * 1024);
      const serverUrl = firstNonEmpty(
        String(configManager.get('surfaces.bluebubbles.serverUrl') ?? ''),
        serviceRegistry.get('bluebubbles')?.baseUrl,
        process.env.BLUEBUBBLES_SERVER_URL,
      );
      const password = firstNonEmpty(
        await serviceRegistry.resolveSecret('bluebubbles', 'password'),
        String(configManager.get('surfaces.bluebubbles.password') ?? ''),
        process.env.BLUEBUBBLES_PASSWORD,
      );
      const chatGuid = firstNonEmpty(
        request.target.address,
        typeof request.binding?.metadata.chatGuid === 'string' ? request.binding.metadata.chatGuid : undefined,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.bluebubbles.defaultChatGuid') ?? ''),
      );
      if (!serverUrl) throw new Error('Missing BlueBubbles server URL');
      if (!password) throw new Error('Missing BlueBubbles password');
      if (!chatGuid) throw new Error('Missing BlueBubbles chat guid');
      const response = await fetch(`${normalizeBaseUrl(serverUrl)}/api/v1/message/text?password=${encodeURIComponent(password)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatGuid,
          tempGuid: crypto.randomUUID(),
          message: trimForSurface(appendAttachmentSummary(request.body, attachments), 8_000),
        }),
      });
      const payload = await requireOkResponse('BlueBubbles delivery failed', response);
      return success(extractResponseId(payload) ?? chatGuid);
    },
  };
}
