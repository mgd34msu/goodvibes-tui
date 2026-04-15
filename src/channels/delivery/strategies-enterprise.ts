import { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts/index';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { ServiceRegistry } from '../../config/service-registry.ts';
import type { ChannelDeliveryStrategy } from '@pellux/goodvibes-sdk/platform/channels/delivery/types';
import {
  appendAttachmentSummary,
  extractResponseId,
  firstNonEmpty,
  normalizeBaseUrl,
  requireOkResponse,
  resolveAttachments,
  resolveChannelDeliverySurfaceKind,
  resolveMSTeamsAccessToken,
  success,
  trimForSurface,
} from '@pellux/goodvibes-sdk/platform/channels/delivery/shared';

export function createMSTeamsDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:msteams',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'msteams';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager, 128 * 1024);
      const serviceUrl = firstNonEmpty(
        typeof request.binding?.metadata.serviceUrl === 'string' ? request.binding.metadata.serviceUrl : undefined,
        String(configManager.get('surfaces.msteams.serviceUrl') ?? ''),
        process.env.MSTEAMS_SERVICE_URL,
      );
      const rawConversationId = firstNonEmpty(
        request.target.address,
        typeof request.binding?.metadata.conversationId === 'string' ? request.binding.metadata.conversationId : undefined,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.msteams.defaultConversationId') ?? ''),
      );
      if (!serviceUrl) throw new Error('Missing Microsoft Teams service URL');
      if (!rawConversationId) throw new Error('Missing Microsoft Teams conversation id');
      const threadId = firstNonEmpty(
        request.binding?.threadId,
        typeof request.binding?.metadata.replyToId === 'string' ? request.binding.metadata.replyToId : undefined,
      );
      const conversationId = threadId && !rawConversationId.includes(';messageid=')
        ? `${rawConversationId};messageid=${threadId}`
        : rawConversationId;
      const accessToken = await resolveMSTeamsAccessToken(configManager, serviceRegistry);
      const response = await fetch(`${normalizeBaseUrl(serviceUrl)}/v3/conversations/${encodeURIComponent(conversationId)}/activities`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          type: 'message',
          text: trimForSurface(appendAttachmentSummary(request.body, attachments), 4_000),
          textFormat: 'plain',
          ...(threadId ? { replyToId: threadId } : {}),
        }),
      });
      const payload = await requireOkResponse('Microsoft Teams delivery failed', response);
      return success(extractResponseId(payload) ?? conversationId);
    },
  };
}

export function createMattermostDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:mattermost',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'mattermost';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager, 128 * 1024);
      const baseUrl = firstNonEmpty(
        String(configManager.get('surfaces.mattermost.baseUrl') ?? ''),
        serviceRegistry.get('mattermost')?.baseUrl,
        process.env.MATTERMOST_BASE_URL,
      );
      const botToken = firstNonEmpty(
        await serviceRegistry.resolveSecret('mattermost', 'primary'),
        String(configManager.get('surfaces.mattermost.botToken') ?? ''),
        process.env.MATTERMOST_BOT_TOKEN,
      );
      const channelId = firstNonEmpty(
        request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.mattermost.defaultChannelId') ?? ''),
      );
      if (!baseUrl) throw new Error('Missing Mattermost base URL');
      if (!botToken) throw new Error('Missing Mattermost bot token');
      if (!channelId) throw new Error('Missing Mattermost channel id');
      const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/v4/posts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({
          channel_id: channelId,
          message: trimForSurface(appendAttachmentSummary(request.body, attachments), 12_000),
          ...(request.binding?.threadId ? { root_id: request.binding.threadId } : {}),
        }),
      });
      const payload = await requireOkResponse('Mattermost delivery failed', response);
      return success(extractResponseId(payload) ?? channelId);
    },
  };
}

export function createMatrixDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:matrix',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'matrix';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager, 128 * 1024);
      const homeserverUrl = firstNonEmpty(
        String(configManager.get('surfaces.matrix.homeserverUrl') ?? ''),
        serviceRegistry.get('matrix')?.baseUrl,
        process.env.MATRIX_HOMESERVER,
      );
      const accessToken = firstNonEmpty(
        await serviceRegistry.resolveSecret('matrix', 'primary'),
        String(configManager.get('surfaces.matrix.accessToken') ?? ''),
        process.env.MATRIX_ACCESS_TOKEN,
      );
      const roomId = firstNonEmpty(
        request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.matrix.defaultRoomId') ?? ''),
      );
      if (!homeserverUrl) throw new Error('Missing Matrix homeserver URL');
      if (!accessToken) throw new Error('Missing Matrix access token');
      if (!roomId) throw new Error('Missing Matrix room id');
      const txnId = crypto.randomUUID();
      const threadId = request.binding?.threadId;
      const response = await fetch(`${normalizeBaseUrl(homeserverUrl)}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          msgtype: 'm.text',
          body: trimForSurface(appendAttachmentSummary(request.body, attachments), 8_000),
          ...(threadId
            ? {
                'm.relates_to': {
                  rel_type: 'm.thread',
                  event_id: threadId,
                  is_falling_back: true,
                  'm.in_reply_to': { event_id: threadId },
                },
              }
            : {}),
        }),
      });
      const payload = await requireOkResponse('Matrix delivery failed', response);
      return success(extractResponseId(payload) ?? roomId);
    },
  };
}
