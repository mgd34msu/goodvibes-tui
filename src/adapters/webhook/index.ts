import { timingSafeEqual } from 'node:crypto';
import type { GenericWebhookAdapterContext } from '@pellux/goodvibes-sdk/platform/adapters/types';
import { validatePublicWebhookUrl } from '@pellux/goodvibes-sdk/platform/utils/url-safety';

function parseJsonRecord(rawBody: string): Record<string, unknown> | Response {
  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}

export async function handleGenericWebhookSurface(req: Request, context: GenericWebhookAdapterContext): Promise<Response> {
  const configuredSecret = String(context.configManager.get('surfaces.webhook.secret') ?? '');
  const enabled = Boolean(context.configManager.get('surfaces.webhook.enabled'));
  if (!enabled || !configuredSecret) {
    return Response.json({ error: 'Webhook ingress is not configured' }, { status: 503 });
  }
  const rawBody = await req.text();
  const providedSignature = req.headers.get('x-goodvibes-signature') ?? '';
  const providedSecret = req.headers.get('x-goodvibes-webhook-secret')
    ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? '';
  const computedSignature = context.signWebhookPayload(rawBody, configuredSecret);
  const signatureValid =
    providedSignature.length === computedSignature.length
    && timingSafeEqual(Buffer.from(providedSignature), Buffer.from(computedSignature));
  if ((!providedSecret || providedSecret !== configuredSecret) && !signatureValid) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    const parsed = parseJsonRecord(rawBody);
    if (parsed instanceof Response) return parsed;
    body = parsed;
  } else if (rawBody.trim().length > 0) {
    body = { message: rawBody.trim() };
  }

  const url = new URL(req.url);
  const surfaceId = typeof body.surfaceId === 'string' && body.surfaceId.trim().length > 0
    ? body.surfaceId.trim()
    : 'webhook';
  const threadId = typeof body.threadId === 'string' ? body.threadId : undefined;
  const channelId = typeof body.channelId === 'string' ? body.channelId : undefined;
  const externalId = typeof body.externalId === 'string' && body.externalId.trim().length > 0
    ? body.externalId.trim()
    : url.searchParams.get('externalId')
      ?? threadId
      ?? channelId
      ?? surfaceId;
  let callbackUrl = typeof body.callbackUrl === 'string' ? body.callbackUrl : undefined;
  if (callbackUrl) {
    const validation = validatePublicWebhookUrl(callbackUrl);
    if (!validation.ok) {
      return Response.json({ error: validation.error }, { status: 400 });
    }
    callbackUrl = validation.url;
  }
  const correlationId = typeof body.correlationId === 'string'
    ? body.correlationId
    : req.headers.get('x-goodvibes-correlation-id') ?? undefined;
  const task = typeof body.task === 'string'
    ? body.task.trim()
    : typeof body.message === 'string'
      ? body.message.trim()
      : typeof body.text === 'string'
        ? body.text.trim()
        : '';
  const policy = await context.authorizeSurfaceIngress({
    surface: 'webhook',
    userId: typeof body.userId === 'string' ? body.userId : undefined,
    channelId,
    groupId: typeof body.groupId === 'string' ? body.groupId : channelId,
    threadId,
    workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
    conversationKind: typeof body.conversationKind === 'string'
      ? body.conversationKind as import('../../channels/index.ts').ChannelConversationKind
      : threadId
        ? 'thread'
        : channelId
          ? 'channel'
          : 'service',
    hasAnyMention: typeof body.hasAnyMention === 'boolean' ? body.hasAnyMention : undefined,
    text: task,
    mentioned: typeof body.mentioned === 'boolean' ? body.mentioned : true,
    controlCommand: typeof body.controlCommand === 'string' ? body.controlCommand : undefined,
    metadata: body,
  });
  if (!policy.allowed) {
    return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }

  const binding = await context.routeBindings.upsertBinding({
    kind: threadId ? 'thread' : channelId ? 'channel' : 'message',
    surfaceKind: 'webhook',
    surfaceId,
    externalId,
    threadId,
    channelId,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    title: typeof body.title === 'string' ? body.title : externalId,
    metadata: {
      ...body,
      ...(callbackUrl ? { callbackUrl } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(typeof body.callbackSignature === 'string' ? { callbackSignature: body.callbackSignature } : {}),
    },
  });

  if (!task) {
    return Response.json({
      acknowledged: true,
      queued: false,
      bindingId: binding.id,
    });
  }

  const submission = await context.sessionBroker.submitMessage({
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    routeId: binding.id,
    surfaceKind: 'webhook',
    surfaceId,
    externalId,
    threadId,
    userId: typeof body.userId === 'string' ? body.userId : undefined,
    displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
    title: typeof body.title === 'string' ? body.title : externalId,
    body: task,
    metadata: typeof body.metadata === 'object' && body.metadata !== null
      ? { ...body.metadata as Record<string, unknown>, ...(correlationId ? { correlationId } : {}) }
      : { ...(correlationId ? { correlationId } : {}) },
  });
  if (submission.mode === 'continued-live') {
    return Response.json({
      acknowledged: true,
      queued: true,
      continued: true,
      bindingId: binding.id,
      sessionId: submission.session.id,
      agentId: submission.activeAgentId ?? null,
      callbackUrl: callbackUrl ?? null,
      correlationId: correlationId ?? null,
    });
  }

  const spawnResult = context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleGenericWebhookSurface',
    submission.session.id,
  );
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
  if (callbackUrl && context.surfaceDeliveryEnabled('webhook')) {
    context.queueWebhookReply({
      agentId: spawnResult.id,
      task,
      sessionId: submission.session.id,
      routeId: binding.id,
      callbackUrl,
      callbackCorrelationId: correlationId,
      callbackSignature: typeof body.callbackSignature === 'string'
        ? body.callbackSignature as 'shared-secret' | 'hmac-sha256'
        : undefined,
    });
  }

  return Response.json({
    acknowledged: true,
    queued: true,
    bindingId: binding.id,
    sessionId: submission.session.id,
    agentId: spawnResult.id,
    callbackUrl: callbackUrl ?? null,
    correlationId: correlationId ?? null,
  });
}
