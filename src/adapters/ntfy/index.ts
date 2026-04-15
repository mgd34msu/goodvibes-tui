import { parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit } from '@pellux/goodvibes-sdk/platform/adapters/helpers';
import type { SurfaceAdapterContext } from '../types.ts';

export async function handleNtfySurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const enabled = Boolean(context.configManager.get('surfaces.ntfy.enabled'));
  const configuredToken =
    String(context.configManager.get('surfaces.ntfy.token') ?? '')
    || await context.serviceRegistry.resolveSecret('ntfy', 'primary')
    || process.env.NTFY_ACCESS_TOKEN
    || '';
  if (!enabled || !configuredToken) {
    return Response.json({ error: 'ntfy webhook ingress is not configured' }, { status: 503 });
  }
  const providedToken = req.headers.get('x-ntfy-token')
    ?? readBearerOrHeaderToken(req, 'x-goodvibes-ntfy-token')
    ?? '';
  if (providedToken !== configuredToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  let body: Record<string, unknown> = {};
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    const parsed = parseJsonRecord(rawBody);
    if (parsed instanceof Response) return parsed;
    body = parsed;
  } else if (rawBody.trim().length > 0) {
    body = { message: rawBody.trim() };
  }

  return handleNtfySurfacePayload(body, context, new URL(req.url));
}

export async function handleNtfySurfacePayload(
  body: Record<string, unknown>,
  context: SurfaceAdapterContext,
  url?: URL,
): Promise<Response> {
  const topic = typeof body.topic === 'string'
    ? body.topic
    : url?.searchParams.get('topic') ?? '';
  const message = typeof body.message === 'string'
    ? body.message
    : typeof body.text === 'string'
      ? body.text
      : '';
  if (!topic) {
    return Response.json({ error: 'Missing ntfy topic' }, { status: 400 });
  }
  const policy = await context.authorizeSurfaceIngress({
    surface: 'ntfy',
    channelId: topic,
    groupId: topic,
    conversationKind: 'channel',
    text: message,
    mentioned: true,
    metadata: body,
  });
  if (!policy.allowed) {
    return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }

  const binding = await context.routeBindings.upsertBinding({
    kind: 'channel',
    surfaceKind: 'ntfy',
    surfaceId: 'ntfy',
    externalId: topic,
    channelId: topic,
    title: typeof body.title === 'string' ? body.title : topic,
    metadata: body,
  });

  if (!message) {
    return Response.json({ acknowledged: true, queued: false, bindingId: binding.id });
  }

  const submission = await context.sessionBroker.submitMessage({
    routeId: binding.id,
    surfaceKind: 'ntfy',
    surfaceId: binding.surfaceId,
    externalId: topic,
    threadId: topic,
    title: typeof body.title === 'string' ? body.title : topic,
    body: message,
    metadata: body,
  });
  if (submission.mode === 'continued-live') {
    return Response.json({
      acknowledged: true,
      queued: true,
      continued: true,
      bindingId: binding.id,
      sessionId: submission.session.id,
      agentId: submission.activeAgentId,
    });
  }

  const spawnResult = context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleNtfySurfaceWebhook',
    submission.session.id,
  );
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
  context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
    agentId: spawnResult.id,
    task: message,
    sessionId: submission.session.id,
  });
  return Response.json({
    acknowledged: true,
    queued: true,
    bindingId: binding.id,
    topic,
    sessionId: submission.session.id,
    agentId: spawnResult.id,
  });
}
