import { parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit } from '../helpers.ts';
import type { SurfaceAdapterContext } from '../types.ts';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export async function handleSignalSurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const configuredToken =
    String(context.configManager.get('surfaces.signal.token') ?? '')
    || await context.serviceRegistry.resolveSecret('signal', 'primary')
    || process.env.SIGNAL_BRIDGE_TOKEN
    || '';
  if (configuredToken) {
    const providedToken = readBearerOrHeaderToken(req, 'x-goodvibes-signal-token');
    if (providedToken !== configuredToken) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  const body = parseJsonRecord(rawBody);
  if (body instanceof Response) return body;
  const payload = readRecord(body);
  if (!payload) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  const recipient = readString(payload.recipient) ?? readString(payload.source) ?? readString(payload.phoneNumber);
  const message = readString(payload.message) ?? readString(payload.text) ?? '';
  if (!recipient) return Response.json({ error: 'Missing recipient/source' }, { status: 400 });

  const policy = await context.authorizeSurfaceIngress({
    surface: 'signal',
    userId: recipient,
    channelId: recipient,
    groupId: recipient,
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
    surfaceKind: 'signal',
    surfaceId: readString(payload.account) ?? readString(context.configManager.get('surfaces.signal.account')) ?? 'signal',
    externalId: readString(payload.threadId) ?? recipient,
    channelId: recipient,
    threadId: readString(payload.threadId),
    title: recipient,
    metadata: { ...payload },
  });
  if (!message) {
    return Response.json({ acknowledged: true, queued: false, bindingId: binding.id });
  }

  const submission = await context.sessionBroker.submitMessage({
    routeId: binding.id,
    surfaceKind: 'signal',
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    threadId: binding.threadId ?? binding.channelId,
    userId: recipient,
    displayName: recipient,
    title: recipient,
    body: message,
    metadata: payload,
  });
  if (submission.mode === 'continued-live') {
    return Response.json({ acknowledged: true, continued: true, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null });
  }

  const spawnResult = context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleSignalSurfaceWebhook',
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
