import type { SurfaceAdapterContext } from '../types.ts';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export async function handleIMessageSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const configuredToken =
    String(context.configManager.get('surfaces.imessage.token') ?? '')
    || await context.serviceRegistry.resolveSecret('imessage', 'primary')
    || process.env.IMESSAGE_BRIDGE_TOKEN
    || '';
  if (configuredToken) {
    const providedToken = req.headers.get('x-goodvibes-imessage-token')
      ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
      ?? '';
    if (providedToken !== configuredToken) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  const body = await req.json().catch(() => null);
  const payload = readRecord(body);
  if (!payload) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const chatId = readString(payload.chatId) ?? readString(payload.conversationId) ?? readString(payload.source);
  const message = readString(payload.message) ?? readString(payload.text) ?? '';
  if (!chatId) return Response.json({ error: 'Missing chatId' }, { status: 400 });

  const policy = await context.authorizeSurfaceIngress({
    surface: 'imessage',
    userId: chatId,
    channelId: chatId,
    groupId: chatId,
    threadId: readString(payload.threadId),
    conversationKind: readString(payload.threadId) ? 'thread' : 'direct',
    text: message,
    mentioned: true,
    metadata: payload,
  });
  if (!policy.allowed) {
    return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }

  const binding = await context.routeBindings.upsertBinding({
    kind: readString(payload.threadId) ? 'thread' : 'channel',
    surfaceKind: 'imessage',
    surfaceId: readString(payload.account) ?? readString(context.configManager.get('surfaces.imessage.account')) ?? 'imessage',
    externalId: readString(payload.threadId) ?? chatId,
    channelId: chatId,
    threadId: readString(payload.threadId),
    title: chatId,
    metadata: { ...payload },
  });
  if (!message) {
    return Response.json({ acknowledged: true, queued: false, bindingId: binding.id });
  }

  const submission = await context.sessionBroker.submitMessage({
    routeId: binding.id,
    surfaceKind: 'imessage',
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    threadId: binding.threadId ?? binding.channelId,
    userId: chatId,
    displayName: chatId,
    title: chatId,
    body: message,
    metadata: payload,
  });
  if (submission.mode === 'continued-live') {
    return Response.json({ acknowledged: true, continued: true, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null });
  }

  const spawnResult = context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleIMessageSurfaceWebhook',
    submission.session.id,
  );
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
  context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
    agentId: spawnResult.id,
    task: message,
    sessionId: submission.session.id,
  });
  return Response.json({ acknowledged: true, queued: true, bindingId: binding.id, sessionId: submission.session.id, agentId: spawnResult.id });
}
