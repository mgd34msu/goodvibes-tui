import { parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit } from '@pellux/goodvibes-sdk/platform/adapters/helpers';
import type { SurfaceAdapterContext } from '@pellux/goodvibes-sdk/platform/adapters/types';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function conversationKindForChatGuid(chatGuid?: string, isGroup?: boolean): import('../../channels/index.ts').ChannelConversationKind {
  if (isGroup) return 'group';
  if (chatGuid?.includes(';+;')) return 'group';
  return 'direct';
}

export async function handleBlueBubblesSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const configuredPassword =
    String(context.configManager.get('surfaces.bluebubbles.password') ?? '')
    || await context.serviceRegistry.resolveSecret('bluebubbles', 'password')
    || process.env.BLUEBUBBLES_PASSWORD
    || '';
  const url = new URL(req.url);
  const providedPassword = url.searchParams.get('password')
    ?? readBearerOrHeaderToken(req, 'x-goodvibes-bluebubbles-token')
    ?? '';
  if (configuredPassword && providedPassword !== configuredPassword) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  const body = parseJsonRecord(rawBody);
  if (body instanceof Response) return body;
  const payload = readRecord(body);
  if (!payload) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const message = readRecord(payload.message) ?? payload;
  const text = readString(message.text) ?? readString(message.message) ?? '';
  const chatGuid = readString(message.chatGuid) ?? readString(message.chat_guid) ?? readString(payload.chatGuid);
  const senderId = readString(message.senderId)
    ?? readString(message.sender)
    ?? readString(message.handle)
    ?? readString(payload.senderId);
  const messageId = readString(message.guid) ?? readString(message.messageId) ?? readString(payload.guid);
  const isFromMe = Boolean(message.isFromMe ?? message.fromMe ?? payload.isFromMe ?? payload.fromMe);
  if (isFromMe) {
    return Response.json({ ok: true, ignored: true, reason: 'from-me' });
  }
  const conversationId = chatGuid ?? senderId;
  if (!conversationId) return Response.json({ error: 'Missing BlueBubbles chat identifier' }, { status: 400 });

  const policy = await context.authorizeSurfaceIngress({
    surface: 'bluebubbles',
    userId: senderId,
    channelId: conversationId,
    groupId: conversationId,
    conversationKind: conversationKindForChatGuid(chatGuid, Boolean(message.isGroup ?? payload.isGroup)),
    text,
    mentioned: true,
    metadata: payload,
  });
  if (!policy.allowed) {
    return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }

  const binding = await context.routeBindings.upsertBinding({
    kind: 'channel',
    surfaceKind: 'bluebubbles',
    surfaceId: readString(payload.account)
      ?? readString(context.configManager.get('surfaces.bluebubbles.account'))
      ?? 'bluebubbles',
    externalId: conversationId,
    channelId: conversationId,
    title: senderId ?? conversationId,
    metadata: {
      ...payload,
      ...(messageId ? { messageId } : {}),
      ...(chatGuid ? { chatGuid } : {}),
      ...(senderId ? { senderId } : {}),
    },
  });
  if (!text) {
    return Response.json({ ok: true, acknowledged: true, bindingId: binding.id });
  }

  const controlCommand = context.parseSurfaceControlCommand(text);
  if (controlCommand) {
    const message = await context.performSurfaceControlCommand(controlCommand);
    return Response.json({ ok: true, acknowledged: true, message });
  }

  const submission = await context.sessionBroker.submitMessage({
    routeId: binding.id,
    surfaceKind: 'bluebubbles',
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    threadId: binding.channelId,
    userId: senderId ?? conversationId,
    displayName: senderId ?? conversationId,
    title: binding.title ?? 'BlueBubbles',
    body: text,
    metadata: binding.metadata,
  });
  if (submission.mode === 'continued-live') {
    return Response.json({ ok: true, continued: true, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null });
  }

  const spawnResult = context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleBlueBubblesSurfaceWebhook',
    submission.session.id,
  );
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
  context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
    agentId: spawnResult.id,
    task: text,
    sessionId: submission.session.id,
  });
  return Response.json({
    ok: true,
    queued: true,
    bindingId: binding.id,
    sessionId: submission.session.id,
    agentId: spawnResult.id,
  });
}
